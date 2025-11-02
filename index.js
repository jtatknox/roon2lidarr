const RoonApi = require('node-roon-api');
const RoonApiBrowse = require('node-roon-api-browse');
const https = require('https');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');

class RoonLidarrIntegration {
    constructor() {
        this.albumCache = new Map();
        this.roon = null;
        this.core = null;
        this.cacheFile = path.join(__dirname, 'album_cache.json');
        this.lastCacheDate = null;
        
        // Lidarr configuration
        this.lidarrConfig = {
            baseUrl: process.env.LIDARR_URL || 'http://synology.local:8686',
            apiKey: process.env.LIDARR_API_KEY,
            rootFolderPath: process.env.LIDARR_ROOT_FOLDER || '/data/media/music',
            qualityProfileId: parseInt(process.env.LIDARR_QUALITY_PROFILE) || 1,
            metadataProfileId: parseInt(process.env.LIDARR_METADATA_PROFILE) || 1
        };
        
        if (!this.lidarrConfig.apiKey) {
            console.error('LIDARR_API_KEY environment variable is required');
            process.exit(1);
        }
        
        console.log(`Starting Roon-Lidarr Integration`);
        console.log(`Lidarr: ${this.lidarrConfig.baseUrl}`);
        console.log(`Root Folder: ${this.lidarrConfig.rootFolderPath}`);
        
        this.initializeCache();
        this.initializeRoon();
    }

    // Cache Management
    async initializeCache() {
        await this.loadCache();
    }

    async loadCache() {
        try {
            const cacheData = await fs.readFile(this.cacheFile, 'utf8');
            const cache = JSON.parse(cacheData);
            
            this.albumCache = new Map(cache.albums || []);
            this.lastCacheDate = cache.lastCacheDate;
            
            console.log(`Loaded cache with ${this.albumCache.size} albums`);
            console.log(`Last scan: ${this.lastCacheDate || 'Never'}`);
            
        } catch (error) {
            console.log('No existing cache file found, starting fresh');
            this.albumCache = new Map();
            this.lastCacheDate = null;
        }
    }

    async saveCache() {
        try {
            const cacheData = {
                albums: Array.from(this.albumCache.entries()),
                lastCacheDate: this.lastCacheDate
            };
            
            await fs.writeFile(this.cacheFile, JSON.stringify(cacheData, null, 2));
            console.log(`Cache saved (${this.albumCache.size} albums)`);
        } catch (error) {
            console.error('Error saving cache:', error);
        }
    }

    // Roon Integration
    initializeRoon() {
        this.roon = new RoonApi({
            extension_id: 'com.roon.lidarr.integration',
            display_name: 'Roon-Lidarr Integration',
            display_version: '1.0.0',
            publisher: 'Integration',
            email: 'integration@example.com',
            website: 'https://github.com/integration',

            core_paired: (core) => {
                console.log(`Paired with Roon Core: ${core.display_name}`);
                this.core = core;
                this.checkForNewAlbums();
                
                // Check every hour
                setInterval(() => {
                    this.checkForNewAlbums();
                }, 60 * 60 * 1000);
            },

            core_unpaired: (core) => {
                console.log(`Unpaired from Roon Core: ${core.display_name}`);
                this.core = null;
            }
        });

        this.roon.init_services({
            required_services: [RoonApiBrowse]
        });

        this.roon.start_discovery();
    }

    isNewDay() {
        const today = new Date().toDateString();
        return !this.lastCacheDate || this.lastCacheDate !== today;
    }

    async checkForNewAlbums() {
        if (!this.core) {
            console.log('No Roon Core connected');
            return;
        }

        if (!this.isNewDay()) {
            console.log('Already scanned today, skipping...');
            return;
        }

        console.log(`\n=== Scanning for new albums ===`);
        
        try {
            await this.scanRoonLibrary();
            this.lastCacheDate = new Date().toDateString();
            console.log('Scan completed successfully');
            
        } catch (error) {
            console.error('Scan failed:', error.message);
        }
    }

    async scanRoonLibrary() {
        // Double-check core connection before proceeding
        if (!this.core) {
            throw new Error('Roon Core not connected');
        }
        
        return new Promise((resolve, reject) => {
            this.core.services.RoonApiBrowse.browse({
                hierarchy: 'browse',
                pop_all: true
            }, async (err, result) => {
                if (err) {
                    reject(err);
                    return;
                }

                try {
                    await this.navigateToAlbums(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    async navigateToAlbums(browseResult) {
        // Check core connection at each step
        if (!this.core) {
            throw new Error('Roon Core disconnected during scan');
        }
        
        // Find Library - handle both immediate items and list response
        let items;
        if (browseResult.items) {
            items = browseResult.items;
        } else if (browseResult.action === 'list') {
            items = await this.loadBrowseItems(browseResult.list.level, 0);
        } else {
            throw new Error('Unexpected browse result structure');
        }
        
        const libraryItem = items.find(item => 
            item.title.toLowerCase().includes('library')
        );
        
        if (!libraryItem) {
            throw new Error('Library not found');
        }

        // Navigate to Albums in Library
        const libraryResult = await this.browseItem(libraryItem.item_key);
        
        let libraryItems;
        if (libraryResult.items) {
            libraryItems = libraryResult.items;
        } else if (libraryResult.action === 'list') {
            libraryItems = await this.loadBrowseItems(libraryResult.list.level, 0);
        } else {
            throw new Error('Unexpected library result structure');
        }
        
        const albumsItem = libraryItems.find(item => item.title === 'Albums');
        
        if (!albumsItem) {
            throw new Error('Albums section not found');
        }

        // Process all albums
        const albumsResult = await this.browseItem(albumsItem.item_key);
        await this.processAllAlbums(albumsResult);
    }

    async browseItem(itemKey) {
        if (!this.core) {
            throw new Error('Roon Core disconnected');
        }
        
        return new Promise((resolve, reject) => {
            // Add timeout to prevent hanging
            const timeout = setTimeout(() => {
                reject(new Error('Browse request timeout'));
            }, 30000);
            
            this.core.services.RoonApiBrowse.browse({
                hierarchy: 'browse',
                item_key: itemKey
            }, (err, result) => {
                clearTimeout(timeout);
                if (err) {
                    // Check if it's an invalid key error
                    if (err.toString().includes('invaliditemkey')) {
                        reject(new Error('Invalid browse key - navigation state expired'));
                    } else {
                        reject(err);
                    }
                } else {
                    resolve(result);
                }
            });
        });
    }

    async loadBrowseItems(level, offset) {
        if (!this.core) {
            throw new Error('Roon Core disconnected');
        }
        
        return new Promise((resolve, reject) => {
            // Add timeout to prevent hanging
            const timeout = setTimeout(() => {
                reject(new Error('Load request timeout'));
            }, 30000);
            
            this.core.services.RoonApiBrowse.load({
                hierarchy: 'browse',
                level: level,
                offset: offset,
                set_display_offset: 0
            }, (err, result) => {
                clearTimeout(timeout);
                if (err) {
                    if (err.toString().includes('invaliditemkey')) {
                        reject(new Error('Invalid browse key - navigation state expired'));
                    } else {
                        reject(err);
                    }
                } else {
                    resolve(result.items);
                }
            });
        });
    }

    async processAllAlbums(albumsResult) {
        if (albumsResult.action !== 'list') {
            throw new Error('Expected album list');
        }

        const totalAlbums = albumsResult.list.count;
        const level = albumsResult.list.level;
        console.log(`Processing ${totalAlbums} albums...`);

        const isFirstRun = this.albumCache.size === 0;
        const newAlbums = [];
        const batchSize = 100;
        
        for (let offset = 0; offset < totalAlbums; offset += batchSize) {
            const remaining = Math.min(batchSize, totalAlbums - offset);
            console.log(`Batch ${Math.floor(offset/batchSize) + 1}: ${offset + 1}-${offset + remaining} of ${totalAlbums}`);
            
            try {
                const items = await this.loadBrowseItems(level, offset);
                
                for (const album of items) {
                    const albumKey = `${album.subtitle || 'Unknown'}|${album.title}`;
                    
                    if (!this.albumCache.has(albumKey)) {
                        if (isFirstRun) {
                            this.albumCache.set(albumKey, {
                                musicBrainzId: null,
                                artistId: null,
                                dateFound: new Date().toISOString(),
                                initialCacheEntry: true
                            });
                        } else {
                            newAlbums.push({
                                title: album.title,
                                artist: album.subtitle || 'Unknown',
                                key: albumKey
                            });
                        }
                    }
                }
                
                await this.delay(100);
                
            } catch (error) {
                if (error.message.includes('Invalid browse key')) {
                    console.log(`  Browse session expired, attempting to restart scan...`);
                    throw new Error('Browse session expired - will retry on next scan');
                }
                throw error;
            }
        }

        if (isFirstRun) {
            console.log(`Initial scan: cached ${this.albumCache.size} albums`);
        } else if (newAlbums.length > 0) {
            console.log(`Found ${newAlbums.length} new albums`);
            await this.processNewAlbums(newAlbums);
        } else {
            console.log('No new albums found');
        }

        await this.saveCache();
    }

    async processNewAlbums(newAlbums) {
        console.log(`\n=== Processing ${newAlbums.length} new albums ===`);
        
        for (let i = 0; i < newAlbums.length; i++) {
            const album = newAlbums[i];
            console.log(`\n[${i + 1}/${newAlbums.length}] "${album.title}" by ${album.artist}`);

            try {
                const mbData = await this.lookupMusicBrainz(album.title, album.artist);
                
                // Initially cache with lidarrProcessed: false
                this.albumCache.set(album.key, {
                    musicBrainzId: mbData?.releaseGroupId || null,
                    artistId: mbData?.artistId || null,
                    dateFound: new Date().toISOString(),
                    initialCacheEntry: false,
                    lidarrProcessed: false // Track Lidarr processing separately
                });

                if (mbData) {
                    console.log(`  MusicBrainz: Artist ${mbData.artistId}, Album ${mbData.releaseGroupId}`);
                    
                    // Try Lidarr integration
                    const lidarrSuccess = await this.addToLidarr(mbData, album);
                    
                    // Update cache with Lidarr processing status
                    const cacheEntry = this.albumCache.get(album.key);
                    cacheEntry.lidarrProcessed = lidarrSuccess;
                    if (!lidarrSuccess) {
                        cacheEntry.lastRetry = new Date().toISOString();
                    }
                    this.albumCache.set(album.key, cacheEntry);
                    
                } else {
                    console.log(`  MusicBrainz: Not found - will retry in 7 days`);
                    // No MusicBrainz data yet - mark for retry later
                    const cacheEntry = this.albumCache.get(album.key);
                    cacheEntry.lidarrProcessed = false; // Retry later - might be added to MusicBrainz
                    cacheEntry.lastRetry = new Date().toISOString(); // Track when we last tried
                    this.albumCache.set(album.key, cacheEntry);
                }

            } catch (error) {
                console.error(`  Error: ${error.message}`);
                this.albumCache.set(album.key, {
                    musicBrainzId: null,
                    artistId: null,
                    dateFound: new Date().toISOString(),
                    initialCacheEntry: false,
                    lidarrProcessed: true // Don't retry failed lookups
                });
            }
            
            await this.delay(1200); // Rate limiting
        }
        
        // After processing new albums, check for any unprocessed albums from previous runs
        await this.retryFailedLidarrAlbums();
    }

    // New method to retry albums that failed Lidarr processing
    async retryFailedLidarrAlbums() {
        const unprocessedAlbums = [];
        const now = Date.now();
        const RETRY_DELAY_DAYS = 7; // Retry failed lookups after 7 days
        
        for (const [key, data] of this.albumCache) {
            if (!data.initialCacheEntry && !data.lidarrProcessed) {
                
                // Calculate days since last retry
                const daysSinceRetry = data.lastRetry ? 
                    (now - new Date(data.lastRetry)) / (1000 * 60 * 60 * 24) : 999;
                
                // Only retry if we haven't tried recently
                if (daysSinceRetry >= RETRY_DELAY_DAYS) {
                    const [artist, title] = key.split('|');
                    
                    // If no MusicBrainz IDs, need to do lookup again
                    if (!data.musicBrainzId || !data.artistId) {
                        unprocessedAlbums.push({
                            key,
                            title,
                            artist,
                            needsLookup: true
                        });
                    } else {
                        // Has MusicBrainz IDs, just needs Lidarr integration
                        unprocessedAlbums.push({
                            key,
                            title,
                            artist,
                            musicBrainzId: data.musicBrainzId,
                            artistId: data.artistId,
                            needsLookup: false
                        });
                    }
                }
            }
        }
        
        if (unprocessedAlbums.length > 0) {
            console.log(`\n=== Retrying ${unprocessedAlbums.length} albums that failed processing ===`);
            
            for (const album of unprocessedAlbums) {
                console.log(`\nRetrying: "${album.title}" by ${album.artist}`);
                
                if (album.needsLookup) {
                    // Need to lookup MusicBrainz again
                    console.log(`  Re-attempting MusicBrainz lookup...`);
                    const mbData = await this.lookupMusicBrainz(album.title, album.artist);
                    
                    if (mbData) {
                        console.log(`  MusicBrainz: Now found! Artist ${mbData.artistId}, Album ${mbData.releaseGroupId}`);
                        
                        // Update cache with new MusicBrainz data
                        const cacheEntry = this.albumCache.get(album.key);
                        cacheEntry.musicBrainzId = mbData.releaseGroupId;
                        cacheEntry.artistId = mbData.artistId;
                        
                        // Try Lidarr integration
                        const lidarrSuccess = await this.addToLidarr(mbData, album);
                        cacheEntry.lidarrProcessed = lidarrSuccess;
                        cacheEntry.lastRetry = new Date().toISOString();
                        this.albumCache.set(album.key, cacheEntry);
                    } else {
                        console.log(`  MusicBrainz: Still not found - will retry in ${RETRY_DELAY_DAYS} days`);
                        // Update lastRetry so we don't check again too soon
                        const cacheEntry = this.albumCache.get(album.key);
                        cacheEntry.lastRetry = new Date().toISOString();
                        this.albumCache.set(album.key, cacheEntry);
                    }
                } else {
                    // Has MusicBrainz IDs, retry Lidarr integration
                    const mbData = {
                        artistId: album.artistId,
                        releaseGroupId: album.musicBrainzId,
                        artistName: album.artist
                    };
                    
                    const lidarrSuccess = await this.addToLidarr(mbData, album);
                    
                    // Update cache with result
                    const cacheEntry = this.albumCache.get(album.key);
                    cacheEntry.lidarrProcessed = lidarrSuccess;
                    cacheEntry.lastRetry = new Date().toISOString();
                    this.albumCache.set(album.key, cacheEntry);
                }
                
                await this.delay(1200);
            }
        }
    }

    // Enhanced addToLidarr that returns success/failure status
    async addToLidarr(mbData, albumInfo) {
        try {
            // Test connection before proceeding
            const connected = await this.testLidarrConnection();
            if (!connected) {
                console.log(`  Lidarr unavailable, will retry later`);
                return false; // Return false to indicate failure
            }

            // Check if artist exists
            let artist = await this.getLidarrArtist(mbData.artistId);
            
            if (!artist) {
                console.log(`  Adding artist to Lidarr: ${mbData.artistName}`);
                artist = await this.addLidarrArtist(mbData.artistId, mbData.artistName);
                if (!artist) throw new Error('Failed to add artist');
            }

            // Check if album exists
            const album = await this.getLidarrAlbum(artist.id, mbData.releaseGroupId);
            
            if (album) {
                // Check if album already has files
                const hasFiles = this.albumHasFiles(album);
                const isMonitored = album.monitored;
                
                console.log(`  Album exists in Lidarr: monitored=${isMonitored}, hasFiles=${hasFiles}`);
                
                if (hasFiles) {
                    console.log(`  Album already has files, marking as complete`);
                    return true; // SUCCESS - album is already complete
                }
                
                if (isMonitored) {
                    console.log(`  Album already monitored but no files, triggering search`);
                    await this.searchAlbum(album.id);
                } else {
                    console.log(`  Setting album to monitored and searching`);
                    await this.setAlbumMonitoring(album.id, true);
                    await this.searchAlbum(album.id);
                }
                
            } else {
                console.log(`  Refreshing artist to discover album`);
                await this.refreshArtist(artist.id);
                await this.delay(3000);
                
                const newAlbum = await this.getLidarrAlbum(artist.id, mbData.releaseGroupId);
                if (newAlbum) {
                    const hasFiles = this.albumHasFiles(newAlbum);
                    
                    if (hasFiles) {
                        console.log(`  Discovered album already has files, marking as complete`);
                        return true; // SUCCESS - album is already complete
                    } else {
                        console.log(`  Setting discovered album to monitored and searching`);
                        await this.setAlbumMonitoring(newAlbum.id, true);
                        await this.searchAlbum(newAlbum.id);
                        return true; // SUCCESS - album set to monitored and search triggered
                    }
                } else {
                    console.log(`  Album not found after refresh, will retry later`);
                    return false; // Failed to find album, retry later
                }
            }
            
            return true; // Successfully processed
            
        } catch (error) {
            console.error(`  Lidarr integration failed: ${error.message}`);
            console.log(`  Will retry this album later`);
            return false; // Return false to indicate failure
        }
    }

    // MusicBrainz Integration with proper Lucene escaping
    async lookupMusicBrainz(albumTitle, artistName) {
        const escapedAlbum = this.escapeLuceneSpecialChars(albumTitle);
        const escapedArtist = this.escapeLuceneSpecialChars(artistName);
        
        const query = `release:${escapedAlbum} AND artist:${escapedArtist}`;
        const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(query)}&fmt=json&limit=10&inc=release-groups`;

        return new Promise((resolve) => {
            const req = https.get(url, {
                headers: { 'User-Agent': 'RoonLidarrIntegration/1.0.0 ( integration@example.com )' }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (result.releases?.length > 0) {
                            const match = this.findBestMatch(result.releases, albumTitle.toLowerCase(), artistName.toLowerCase());
                            if (match?.['release-group']) {
                                const artistId = match['artist-credit']?.[0]?.artist?.id;
                                const releaseGroupId = match['release-group'].id;
                                
                                if (artistId && releaseGroupId) {
                                    resolve({
                                        artistId,
                                        releaseGroupId,
                                        artistName: match['artist-credit'][0].artist.name
                                    });
                                    return;
                                }
                            }
                        }
                        resolve(null);
                    } catch (error) {
                        resolve(null);
                    }
                });
            });
            
            req.on('error', () => resolve(null));
            req.setTimeout(8000, () => {
                req.destroy();
                resolve(null);
            });
        });
    }

    // Proper Lucene special character escaping for MusicBrainz
    escapeLuceneSpecialChars(term) {
        return term.replace(/[+\-&|!(){}\[\]^"~*?:\\\/]/g, '\\$&');
    }

    findBestMatch(releases, targetAlbum, targetArtist) {
        const targetAlbumNormalized = this.normalizeForMatching(targetAlbum);
        const targetArtistNormalized = this.normalizeForMatching(targetArtist);

        let bestMatch = null;
        let bestScore = 0;

        for (const release of releases) {
            const releaseTitle = this.normalizeForMatching(release.title.toLowerCase());
            const releaseArtist = this.normalizeForMatching(release['artist-credit']?.[0]?.artist?.name?.toLowerCase() || '');
            
            let score = 0;
            
            // Album title scoring - more flexible with similarity matching
            if (releaseTitle === targetAlbumNormalized) {
                score += 20; // Perfect normalized match
            } else if (releaseTitle.includes(targetAlbumNormalized) || targetAlbumNormalized.includes(releaseTitle)) {
                score += 15; // Partial match
            } else if (this.calculateSimilarity(releaseTitle, targetAlbumNormalized) > 0.8) {
                score += 12; // High similarity
            } else if (this.calculateSimilarity(releaseTitle, targetAlbumNormalized) > 0.6) {
                score += 8; // Moderate similarity
            }
            
            // Artist scoring - more flexible
            if (releaseArtist === targetArtistNormalized) {
                score += 20; // Perfect normalized match
            } else if (releaseArtist.includes(targetArtistNormalized) || targetArtistNormalized.includes(releaseArtist)) {
                score += 15; // Partial match
            } else if (this.calculateSimilarity(releaseArtist, targetArtistNormalized) > 0.8) {
                score += 12; // High similarity
            }
            
            if (score > bestScore) {
                bestScore = score;
                bestMatch = release;
            }
        }

        // Lowered threshold from 15 to 12 for better edge case handling
        return bestScore >= 12 ? bestMatch : null;
    }

    // Normalize strings for comparison - removes punctuation and extra spaces
    normalizeForMatching(str) {
        if (!str) return '';
        return str
            .toLowerCase()
            .replace(/[^\w\s]/g, '') // Remove all punctuation
            .replace(/\s+/g, ' ')    // Normalize spaces
            .trim();
    }

    // Calculate string similarity using Levenshtein distance
    calculateSimilarity(str1, str2) {
        if (!str1 || !str2) return 0;
        
        const longer = str1.length > str2.length ? str1 : str2;
        const shorter = str1.length > str2.length ? str2 : str1;
        
        if (longer.length === 0) return 1.0;
        
        const distance = this.levenshteinDistance(longer, shorter);
        return (longer.length - distance) / longer.length;
    }

    // Levenshtein distance algorithm for fuzzy string matching
    levenshteinDistance(str1, str2) {
        const matrix = [];
        
        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }
        
        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }
        
        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }
        
        return matrix[str2.length][str1.length];
    }

    // Enhanced addToLidarr that returns success/failure status
    async addToLidarr(mbData, albumInfo) {
        try {
            // Test connection before proceeding
            const connected = await this.testLidarrConnection();
            if (!connected) {
                console.log(`  Lidarr unavailable, will retry later`);
                return false; // Return false to indicate failure
            }

            // Check if artist exists
            let artist = await this.getLidarrArtist(mbData.artistId);
            
            if (!artist) {
                console.log(`  Adding artist to Lidarr: ${mbData.artistName}`);
                artist = await this.addLidarrArtist(mbData.artistId, mbData.artistName);
                if (!artist) throw new Error('Failed to add artist');
            }

            // Check if album exists
            const album = await this.getLidarrAlbum(artist.id, mbData.releaseGroupId);
            
            if (album) {
                // Check if album already has files
                const hasFiles = this.albumHasFiles(album);
                const isMonitored = album.monitored;
                
                console.log(`  Album exists in Lidarr: monitored=${isMonitored}, hasFiles=${hasFiles}`);
                
                if (hasFiles) {
                    console.log(`  Album already has files, marking as complete`);
                    return true; // SUCCESS - album is already complete
                }
                
                if (isMonitored) {
                    console.log(`  Album already monitored but no files, triggering search`);
                    await this.searchAlbum(album.id);
                } else {
                    console.log(`  Setting album to monitored and searching`);
                    await this.setAlbumMonitoring(album.id, true);
                    await this.searchAlbum(album.id);
                }
                
            } else {
                console.log(`  Refreshing artist to discover album`);
                await this.refreshArtist(artist.id);
                await this.delay(3000);
                
                const newAlbum = await this.getLidarrAlbum(artist.id, mbData.releaseGroupId);
                if (newAlbum) {
                    const hasFiles = this.albumHasFiles(newAlbum);
                    
                    if (hasFiles) {
                        console.log(`  Discovered album already has files, marking as complete`);
                        return true; // SUCCESS - album is already complete
                    } else {
                        console.log(`  Setting discovered album to monitored and searching`);
                        await this.setAlbumMonitoring(newAlbum.id, true);
                        await this.searchAlbum(newAlbum.id);
                        return true; // SUCCESS - album set to monitored and search triggered
                    }
                } else {
                    console.log(`  Album not found after refresh, will retry later`);
                    return false; // Failed to find album, retry later
                }
            }
            
            return true; // Successfully processed
            
        } catch (error) {
            console.error(`  Lidarr integration failed: ${error.message}`);
            console.log(`  Will retry this album later`);
            return false; // Return false to indicate failure
        }
    }

    // Check if album has any downloaded files
    albumHasFiles(album) {
        // Check if any tracks have files
        if (album.tracks && album.tracks.length > 0) {
            return album.tracks.some(track => track.hasFile);
        }
        
        // Fallback: check statistics
        if (album.statistics) {
            return album.statistics.trackFileCount > 0;
        }
        
        // Another fallback: check if any tracks exist at all
        return album.trackCount > 0 && album.statistics?.percentOfTracks === 100;
    }

    async getLidarrAlbum(artistId, releaseGroupId) {
        // Request album with additional track and file information
        const albums = await this.makeLidarrRequest(`/album?artistId=${artistId}&includeAllArtistAlbums=true`);
        const album = albums.find(a => a.foreignAlbumId === releaseGroupId);
        
        if (album) {
            // Get detailed album info including tracks and files
            const detailedAlbum = await this.makeLidarrRequest(`/album/${album.id}`);
            return detailedAlbum;
        }
        
        return null;
    }

    async makeLidarrRequest(endpoint, method = 'GET', data = null, retries = 3) {
        const url = new URL(`${this.lidarrConfig.baseUrl}/api/v1${endpoint}`);
        const httpModule = url.protocol === 'https:' ? https : http;
        
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const result = await new Promise((resolve, reject) => {
                    const options = {
                        hostname: url.hostname,
                        port: url.port,
                        path: url.pathname + url.search,
                        method,
                        timeout: 10000, // 10 second timeout
                        headers: {
                            'X-Api-Key': this.lidarrConfig.apiKey,
                            'Content-Type': 'application/json'
                        }
                    };

                    const req = httpModule.request(options, (res) => {
                        let responseData = '';
                        res.on('data', chunk => responseData += chunk);
                        res.on('end', () => {
                            try {
                                const result = responseData ? JSON.parse(responseData) : null;
                                if (res.statusCode >= 200 && res.statusCode < 300) {
                                    resolve(result);
                                } else {
                                    reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
                                }
                            } catch (error) {
                                reject(error);
                            }
                        });
                    });

                    req.on('error', reject);
                    req.on('timeout', () => {
                        req.destroy();
                        reject(new Error('Request timeout'));
                    });
                    
                    if (data) req.write(JSON.stringify(data));
                    req.end();
                });
                
                return result; // Success - return result
                
            } catch (error) {
                console.error(`Lidarr request attempt ${attempt}/${retries} failed: ${error.message}`);
                
                if (attempt === retries) {
                    // Last attempt failed - throw error
                    throw new Error(`Lidarr request failed after ${retries} attempts: ${error.message}`);
                }
                
                // Wait before retry with exponential backoff
                const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
                console.log(`Retrying in ${backoffMs}ms...`);
                await this.delay(backoffMs);
            }
        }
    }

    // Add Lidarr connectivity check
    async testLidarrConnection() {
        try {
            await this.makeLidarrRequest('/system/status');
            return true;
        } catch (error) {
            console.error(`Lidarr connection test failed: ${error.message}`);
            return false;
        }
    }

    // Enhanced checkForNewAlbums with better error handling
    async checkForNewAlbums() {
        if (!this.core) {
            console.log('No Roon Core connected - waiting for connection...');
            return;
        }

        if (!this.isNewDay()) {
            console.log('Already scanned today, skipping...');
            return;
        }

        console.log(`\n=== Scanning for new albums ===`);
        
        // Test Lidarr connection before starting scan
        const lidarrConnected = await this.testLidarrConnection();
        if (!lidarrConnected) {
            console.log('Lidarr not available - will scan Roon but skip Lidarr integration');
        }
        
        try {
            await this.scanRoonLibrary();
            this.lastCacheDate = new Date().toDateString();
            console.log('Scan completed successfully');
            
        } catch (error) {
            if (error.message.includes('Roon Core')) {
                console.error('Roon connection lost during scan:', error.message);
                console.log('Waiting for Roon to reconnect...');
            } else {
                console.error('Scan failed:', error.message);
                console.log('Will retry on next hourly check');
            }
            // Don't set lastCacheDate so it will retry
        }
    }

    // Enhanced addToLidarr with connection checking
    async addToLidarr(mbData, albumInfo) {
        try {
            // Test connection before proceeding
            const connected = await this.testLidarrConnection();
            if (!connected) {
                console.log(`  Lidarr unavailable, skipping integration for now`);
                return;
            }

            // Check if artist exists
            let artist = await this.getLidarrArtist(mbData.artistId);
            
            if (!artist) {
                console.log(`  Adding artist to Lidarr: ${mbData.artistName}`);
                artist = await this.addLidarrArtist(mbData.artistId, mbData.artistName);
                if (!artist) throw new Error('Failed to add artist');
            }

            // Check if album exists
            const album = await this.getLidarrAlbum(artist.id, mbData.releaseGroupId);
            
            if (album) {
                // Check if album already has files
                const hasFiles = this.albumHasFiles(album);
                const isMonitored = album.monitored;
                
                console.log(`  Album exists in Lidarr: monitored=${isMonitored}, hasFiles=${hasFiles}`);
                
                if (hasFiles) {
                    console.log(`  Album already has files, skipping download`);
                    return; // Don't do anything if files already exist
                }
                
                if (isMonitored) {
                    console.log(`  Album already monitored but no files, triggering search`);
                    await this.searchAlbum(album.id);
                } else {
                    console.log(`  Setting album to monitored and searching`);
                    await this.setAlbumMonitoring(album.id, true);
                    await this.searchAlbum(album.id);
                }
                
            } else {
                console.log(`  Refreshing artist to discover album`);
                await this.refreshArtist(artist.id);
                await this.delay(3000);
                
                const newAlbum = await this.getLidarrAlbum(artist.id, mbData.releaseGroupId);
                if (newAlbum) {
                    const hasFiles = this.albumHasFiles(newAlbum);
                    
                    if (hasFiles) {
                        console.log(`  Discovered album already has files, skipping`);
                    } else {
                        console.log(`  Setting discovered album to monitored and searching`);
                        await this.setAlbumMonitoring(newAlbum.id, true);
                        await this.searchAlbum(newAlbum.id);
                    }
                } else {
                    console.log(`  Album not found after refresh`);
                }
            }
            
        } catch (error) {
            console.error(`  Lidarr integration failed: ${error.message}`);
            console.log(`  Will retry this album on next scan cycle`);
            // Don't throw - let other albums continue processing
        }
    }

    async getLidarrArtist(musicBrainzId) {
        const artists = await this.makeLidarrRequest('/artist');
        return artists.find(a => a.foreignArtistId === musicBrainzId);
    }

    async addLidarrArtist(musicBrainzId, artistName) {
        const artistData = {
            foreignArtistId: musicBrainzId,
            artistName,
            monitored: true,
            rootFolderPath: this.lidarrConfig.rootFolderPath,
            qualityProfileId: this.lidarrConfig.qualityProfileId,
            metadataProfileId: this.lidarrConfig.metadataProfileId,
            addOptions: { searchForMissingAlbums: false }
        };

        return await this.makeLidarrRequest('/artist', 'POST', artistData);
    }

    async getLidarrAlbum(artistId, releaseGroupId) {
        const albums = await this.makeLidarrRequest(`/album?artistId=${artistId}`);
        return albums.find(a => a.foreignAlbumId === releaseGroupId);
    }

    async setAlbumMonitoring(albumId, monitored) {
        const album = await this.makeLidarrRequest(`/album/${albumId}`);
        album.monitored = monitored;
        await this.makeLidarrRequest(`/album/${albumId}`, 'PUT', album);
    }

    async refreshArtist(artistId) {
        await this.makeLidarrRequest('/command', 'POST', {
            name: 'RefreshArtist',
            artistId
        });
    }

    async searchAlbum(albumId) {
        await this.makeLidarrRequest('/command', 'POST', {
            name: 'AlbumSearch',
            albumIds: [albumId]
        });
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Initialize
const integration = new RoonLidarrIntegration();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down...');
    if (integration.roon) integration.roon.stop_discovery();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Shutting down...');
    if (integration.roon) integration.roon.stop_discovery();
    process.exit(0);
});

module.exports = RoonLidarrIntegration;