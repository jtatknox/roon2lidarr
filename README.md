# roon2lidarr
Adds saved roon albums to lidarr on a daily basis with caching.

### Roon-Lidarr Integration

This Node.js service connects your **Roon music library** with **Lidarr**, automating the addition of newly discovered albums from Roon into Lidarr for download or management.

#### Overview

The script runs as a Roon extension using the official `node-roon-api` and `node-roon-api-browse` packages. Once paired with a Roon Core, it periodically scans the user’s Roon library for new albums, identifies them via the **MusicBrainz API**, and then adds or monitors them in **Lidarr** using its REST API.

#### Key Features

* **Automatic Discovery**: Detects new albums from the Roon library each day.
* **MusicBrainz Lookup**: Matches new albums to MusicBrainz release and artist IDs with Lucene-safe queries.
* **Lidarr Integration**: Adds new artists or albums to Lidarr, sets monitoring status, and triggers searches for missing files.
* **Resilient Caching**: Uses a JSON-based cache to track all known albums, preventing duplicates and allowing retries for failed lookups.
* **Daily and Retry Scheduling**: Scans once per day and retries failed albums every seven days.
* **Configurable via Environment Variables**:

  * `LIDARR_URL` – Base URL of the Lidarr instance
  * `LIDARR_API_KEY` – API key for authentication (required)
  * `LIDARR_ROOT_FOLDER` – Root folder path for music storage
  * `LIDARR_QUALITY_PROFILE` – Lidarr quality profile ID
  * `LIDARR_METADATA_PROFILE` – Lidarr metadata profile ID

#### Behavior Summary

1. On startup, the integration loads or creates a local cache file `album_cache.json`.
2. It discovers and pairs with a Roon Core.
3. Once connected, it performs an initial library scan and then repeats daily.
4. For each new album, it:

   * Looks up metadata in MusicBrainz.
   * Adds missing artists or albums to Lidarr.
   * Marks completion or schedules retries for unavailable entries.
5. Failed integrations are retried weekly until successful.

#### Requirements

* Node.js 18+
* Roon Core running on the same network
* Lidarr instance with API access

#### Purpose

This integration closes the gap between **Roon’s local music discovery** and **Lidarr’s automated collection management**, enabling a seamless loop from Roon detection to acquisition via Lidarr.
