FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy dependency files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy app source
COPY . .

# Expose port if needed (e.g. 3000)
EXPOSE 3000

# Run the application
CMD ["node", "index.js"]