require('dotenv').config();
const CatalogServer = require('./src/api/server');

// Get GitHub token from environment
const githubToken = process.env.GITHUB_TOKEN;

if (!githubToken) {
  console.warn('⚠️  Warning: GITHUB_TOKEN not set. Scraping will be disabled.');
  console.warn('   Create a .env file with: GITHUB_TOKEN=your_token_here');
}

// Create and start server
const server = new CatalogServer({
  port: process.env.PORT || 5000,
  githubToken: githubToken
});

server.start();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close();
  process.exit(0);
});
