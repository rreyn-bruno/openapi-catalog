const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const CatalogDatabase = require('../database/schema');
const GitHubScraper = require('../scraper/github-scraper');
const ConversionPipeline = require('../pipeline/converter');
const APIsGuruImporter = require('../scraper/apisguru-importer');

class CatalogServer {
  constructor(options = {}) {
    this.app = express();
    this.port = options.port || 5000;
    this.db = new CatalogDatabase(options.dbPath);
    this.githubToken = options.githubToken;

    // Ensure data directories exist
    this.ensureDataDirectories();

    this.setupMiddleware();
    this.setupRoutes();
  }

  ensureDataDirectories() {
    const directories = [
      path.join(__dirname, '../../data'),
      path.join(__dirname, '../../data/openapi'),
      path.join(__dirname, '../../data/collections'),
      path.join(__dirname, '../../data/docs')
    ];

    directories.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✓ Created directory: ${dir}`);
      }
    });
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
          limit: parseInt(limit) || 10000,
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

    // Download Bruno collection as ZIP
    this.app.get('/api/apis/:id/download', (req, res) => {
      try {
        const api = this.db.getApi(req.params.id);
        if (!api) {
          return res.status(404).json({ error: 'API not found' });
        }

        if (!api.collection_path) {
          return res.status(404).json({ error: 'Bruno collection not available for this API' });
        }

        const archiver = require('archiver');
        const path = require('path');
        const fs = require('fs');

        const collectionPath = path.resolve(api.collection_path);

        // Check if collection exists
        if (!fs.existsSync(collectionPath)) {
          return res.status(404).json({ error: 'Collection files not found' });
        }

        // Set headers for download
        const filename = `${api.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_bruno_collection.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        // Create archive
        const archive = archiver('zip', {
          zlib: { level: 9 }
        });

        archive.on('error', (err) => {
          console.error('Archive error:', err);
          res.status(500).json({ error: 'Failed to create archive' });
        });

        // Pipe archive to response
        archive.pipe(res);

        // Add the collection directory to the archive
        archive.directory(collectionPath, false);

        // Finalize the archive
        archive.finalize();

      } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Get all tags with counts
    this.app.get('/api/tags', (req, res) => {
      try {
        const tags = this.db.getAllTags();
        // Add count for each tag
        const tagsWithCounts = tags.map(tag => {
          const stmt = this.db.db.prepare(`
            SELECT COUNT(*) as count FROM api_tags WHERE tag_id = ?
          `);
          const count = stmt.get(tag.id).count;
          return { ...tag, count };
        });
        // Sort by count descending
        tagsWithCounts.sort((a, b) => b.count - a.count);
        res.json(tagsWithCounts);
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

    // Import from APIs.guru
    this.app.post('/api/import/apisguru', async (req, res) => {
      try {
        const { maxApis = null, skipExisting = true } = req.body;

        res.json({
          message: 'APIs.guru import started',
          status: 'running'
        });

        // Run import in background
        this.runAPIsGuruImport({ maxApis, skipExisting });

      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Regenerate documentation for all APIs
    this.app.post('/api/regenerate-docs', async (req, res) => {
      try {
        const { apiId = null } = req.body;

        res.json({
          message: apiId ? `Regenerating docs for API ${apiId}` : 'Regenerating docs for all APIs',
          status: 'running'
        });

        // Run regeneration in background
        this.regenerateDocs(apiId);

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
            
            // Add tags - use high-level categories based on API content
            const tagsToAdd = new Set();
            const name = (api.name || '').toLowerCase();
            const desc = (api.description || '').toLowerCase();
            const combined = `${name} ${desc}`;

            // Define category keywords
            const categories = {
              'Payments': ['payment', 'stripe', 'paypal', 'billing', 'invoice', 'transaction', 'checkout'],
              'Authentication': ['auth', 'oauth', 'login', 'sso', 'identity', 'jwt', 'token'],
              'Database': ['database', 'sql', 'postgres', 'mysql', 'mongodb', 'redis', 'storage'],
              'Cloud & Infrastructure': ['cloud', 'aws', 'azure', 'gcp', 'kubernetes', 'docker', 'infrastructure', 'terraform'],
              'AI & ML': ['ai', 'ml', 'machine learning', 'llm', 'gpt', 'openai', 'model', 'neural'],
              'Communication': ['chat', 'messaging', 'email', 'sms', 'notification', 'twilio', 'sendgrid'],
              'Analytics': ['analytics', 'metrics', 'tracking', 'monitoring', 'observability', 'telemetry'],
              'E-commerce': ['ecommerce', 'e-commerce', 'shop', 'cart', 'product', 'inventory'],
              'Social Media': ['social', 'twitter', 'facebook', 'instagram', 'linkedin'],
              'Developer Tools': ['api', 'sdk', 'cli', 'developer', 'webhook', 'rest', 'graphql'],
              'Security': ['security', 'encryption', 'firewall', 'vulnerability', 'scan'],
              'Media': ['video', 'audio', 'image', 'media', 'streaming', 'upload'],
              'Documentation': ['docs', 'documentation', 'wiki', 'knowledge'],
              'IoT': ['iot', 'sensor', 'device', 'hardware', 'embedded'],
              'Finance': ['finance', 'banking', 'trading', 'stock', 'crypto', 'blockchain'],
              'Healthcare': ['health', 'medical', 'patient', 'hospital', 'clinical'],
              'Education': ['education', 'learning', 'course', 'student', 'school'],
              'Gaming': ['game', 'gaming', 'player', 'unity', 'unreal']
            };

            // Match categories
            for (const [category, keywords] of Object.entries(categories)) {
              if (keywords.some(keyword => combined.includes(keyword))) {
                tagsToAdd.add(category);
              }
            }

            // If no categories matched, add a general one
            if (tagsToAdd.size === 0) {
              tagsToAdd.add('General');
            }

            // Save tags to database
            for (const tagName of tagsToAdd) {
              const tagId = uuidv4();
              this.db.createTag(tagId, tagName);
              const dbTag = this.db.getTag(tagName);
              if (dbTag) {
                this.db.addTagToApi(api.id, dbTag.id);
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

  async runAPIsGuruImport(options = {}) {
    try {
      console.log('\n=== Starting APIs.guru import ===');

      const importer = new APIsGuruImporter();
      const pipeline = new ConversionPipeline();

      const stats = await importer.importAll({
        database: this.db,
        processor: pipeline,
        skipExisting: options.skipExisting !== false,
        maxApis: options.maxApis,
        delay: 1000 // 1 second delay between downloads
      });

      console.log('\n=== APIs.guru import completed ===');
      console.log(`Total: ${stats.total}`);
      console.log(`Downloaded: ${stats.downloaded}`);
      console.log(`Processed: ${stats.processed}`);
      console.log(`Skipped: ${stats.skipped}`);
      console.log(`Failed: ${stats.failed}`);

      if (stats.errors.length > 0) {
        console.log('\nErrors:');
        stats.errors.forEach(err => {
          console.log(`  - ${err.api}: ${err.error}`);
        });
      }

    } catch (error) {
      console.error('APIs.guru import error:', error);
    }
  }

  async regenerateDocs(apiId = null) {
    try {
      console.log('\n=== Starting documentation regeneration ===');

      const pipeline = new ConversionPipeline();

      // Get APIs to regenerate
      const apis = apiId ? [this.db.getApi(apiId)] : this.db.getAllApis({ limit: 10000 });

      console.log(`Regenerating docs for ${apis.length} API(s)...`);

      let regenerated = 0;
      let failed = 0;

      for (const api of apis) {
        if (!api) continue;

        try {
          console.log(`\nRegenerating docs for: ${api.name}`);

          // Check if collection exists
          if (!api.collection_path || !fs.existsSync(api.collection_path)) {
            console.log(`⚠️  Collection not found for ${api.name}, skipping...`);
            failed++;
            continue;
          }

          // Regenerate documentation
          const docsPath = await pipeline.generateDocs(
            api.id,
            api.name,
            api.collection_path,
            api.github_url
          );

          // Update database with new docs path
          this.db.updateApi(api.id, {
            docs_path: docsPath,
            updated_at: new Date().toISOString()
          });

          console.log(`✓ Regenerated docs for ${api.name}`);
          regenerated++;

        } catch (error) {
          console.error(`✗ Error regenerating docs for ${api.name}:`, error.message);
          failed++;
        }
      }

      console.log('\n=== Documentation regeneration completed ===');
      console.log(`Regenerated: ${regenerated}`);
      console.log(`Failed: ${failed}`);

    } catch (error) {
      console.error('Documentation regeneration error:', error);
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
