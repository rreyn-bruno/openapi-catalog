const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const CatalogDatabase = require('../database/schema');
const GitHubScraper = require('../scraper/github-scraper');
const ConversionPipeline = require('../pipeline/converter');

class CatalogServer {
  constructor(options = {}) {
    this.app = express();
    this.port = options.port || 5000;
    this.db = new CatalogDatabase(options.dbPath);
    this.githubToken = options.githubToken;
    
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());
    
    // Serve static files (docs and frontend)
    this.app.use('/docs', express.static(path.join(__dirname, '../../data/docs')));
    this.app.use(express.static(path.join(__dirname, '../../public')));
    
    // Request logging
    this.app.use((req, res, next) => {
      console.log(`${req.method} ${req.path}`);
      next();
    });
  }

  setupRoutes() {
    // Health check
    this.app.get('/api/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Get all APIs
    this.app.get('/api/apis', (req, res) => {
      try {
        const { limit, offset, search, orderBy } = req.query;
        const apis = this.db.getAllApis({
          limit: parseInt(limit) || 50,
          offset: parseInt(offset) || 0,
          search: search || '',
          orderBy: orderBy || 'created_at DESC'
        });
        
        // Add tags to each API
        const apisWithTags = apis.map(api => ({
          ...api,
          tags: this.db.getApiTags(api.id)
        }));
        
        res.json({
          apis: apisWithTags,
          total: apis.length
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get single API
    this.app.get('/api/apis/:id', (req, res) => {
      try {
        const api = this.db.getApi(req.params.id);
        if (!api) {
          return res.status(404).json({ error: 'API not found' });
        }
        
        const tags = this.db.getApiTags(api.id);
        res.json({ ...api, tags });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get all tags
    this.app.get('/api/tags', (req, res) => {
      try {
        const tags = this.db.getAllTags();
        res.json({ tags });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get APIs by tag
    this.app.get('/api/tags/:tagName/apis', (req, res) => {
      try {
        const apis = this.db.getApisByTag(req.params.tagName);
        res.json({ apis });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get stats
    this.app.get('/api/stats', (req, res) => {
      try {
        const stats = this.db.getStats();
        res.json(stats);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Trigger scrape (admin endpoint)
    this.app.post('/api/scrape', async (req, res) => {
      if (!this.githubToken) {
        return res.status(400).json({ error: 'GitHub token not configured' });
      }

      try {
        const { minStars = 10, maxResults = 20 } = req.body;
        
        // Create scrape run
        const runId = uuidv4();
        this.db.createScrapeRun(runId);
        
        // Start scraping in background
        this.runScrape(runId, { minStars, maxResults });
        
        res.json({ 
          message: 'Scrape started',
          runId,
          status: 'running'
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get scrape status
    this.app.get('/api/scrape/latest', (req, res) => {
      try {
        const latestRun = this.db.getLatestScrapeRun();
        res.json(latestRun || { message: 'No scrape runs yet' });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  async runScrape(runId, options) {
    try {
      console.log(`\n=== Starting scrape run ${runId} ===`);
      
      // Initialize scraper and pipeline
      const scraper = new GitHubScraper(this.githubToken);
      const pipeline = new ConversionPipeline();
      
      // Search for OpenAPI files
      console.log('Searching GitHub for OpenAPI files...');
      const apis = await scraper.searchOpenAPIFiles(options);
      
      console.log(`Found ${apis.length} APIs`);
      this.db.updateScrapeRun(runId, { apis_found: apis.length });
      
      // Process each API
      let processed = 0;
      for (const api of apis) {
        try {
          // Convert and generate docs
          const result = await pipeline.convertAndGenerateDocs(api);
          
          if (result.success) {
            // Save to database
            this.db.createApi({
              ...api,
              collection_path: result.collection_path,
              docs_path: result.docs_path
            });
            
            // Add tags (extract from OpenAPI spec if available)
            if (api.spec?.tags) {
              for (const tag of api.spec.tags) {
                const tagId = uuidv4();
                this.db.createTag(tagId, tag.name);
                const dbTag = this.db.getTag(tag.name);
                if (dbTag) {
                  this.db.addTagToApi(api.id, dbTag.id);
                }
              }
            }
            
            processed++;
          }
        } catch (error) {
          console.error(`Error processing API ${api.name}:`, error.message);
        }
      }
      
      // Update scrape run
      this.db.updateScrapeRun(runId, {
        completed_at: new Date().toISOString(),
        apis_processed: processed,
        status: 'completed'
      });
      
      console.log(`\n=== Scrape run ${runId} completed ===`);
      console.log(`Processed ${processed}/${apis.length} APIs`);
    } catch (error) {
      console.error('Scrape error:', error);
      this.db.updateScrapeRun(runId, {
        completed_at: new Date().toISOString(),
        status: 'failed'
      });
    }
  }

  start() {
    this.app.listen(this.port, () => {
      console.log(`\n🚀 Bruno API Catalog running on http://localhost:${this.port}`);
      console.log(`📊 API endpoints: http://localhost:${this.port}/api`);
      console.log(`📚 Documentation: http://localhost:${this.port}/docs`);
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = CatalogServer;
