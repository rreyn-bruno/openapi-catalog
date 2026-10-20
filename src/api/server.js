const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const CatalogDatabase = require('../database/schema');
const GitHubScraper = require('../scraper/github-scraper');
const ConversionPipeline = require('../pipeline/converter');
const APIsGuruImporter = require('../scraper/apisguru-importer');
const seo = require('../lib/seo');

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
    this.app.set('trust proxy', 1);
    this.app.disable('x-powered-by');
    this.app.use(cors());
    this.app.use(express.json());

    // Canonical host: send www.* to the apex domain
    this.app.use((req, res, next) => {
      const host = req.hostname || '';
      if (host.startsWith('www.')) {
        return res.redirect(301, `https://${host.slice(4)}${req.originalUrl}`);
      }
      next();
    });
    
    // Request logging
    this.app.use((req, res, next) => {
      console.log(`${req.method} ${req.path}`);
      next();
    });
  }

  setupRoutes() {
    // Server-rendered HTML pages (registered first so they win over static files)
    this.setupPageRoutes();

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
        
        // Add tags to each API (single query instead of one per API)
        const tagMap = this.db.getTagsForApis(apis.map(api => api.id));
        const apisWithTags = apis.map(api => ({
          ...api,
          tags: tagMap.get(api.id) || []
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
        res.json({ ...stats, totalTags: this.getCategories().length });
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

    // Static assets and 404/500 handlers go last
    this.setupStaticAndFallback();
  }

  // ---------------------------------------------------------------------------
  // Server-rendered pages (SEO / AEO)
  // ---------------------------------------------------------------------------

  publicPath(...parts) {
    return path.join(__dirname, '../../public', ...parts);
  }

  dataPath(...parts) {
    return path.join(__dirname, '../../data', ...parts);
  }

  /** Read a file from /public, cached by mtime. */
  readTemplate(file) {
    this.templateCache = this.templateCache || new Map();
    const full = this.publicPath(file);
    const stat = fs.statSync(full);
    const cached = this.templateCache.get(full);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.html;
    const html = fs.readFileSync(full, 'utf8');
    this.templateCache.set(full, { mtimeMs: stat.mtimeMs, html });
    return html;
  }

  /** Display categories (raw tags merged), cached for five minutes. */
  getCategories() {
    const now = Date.now();
    if (!this.categoryCache || now - this.categoryCache.at > 5 * 60 * 1000) {
      this.categoryCache = { at: now, categories: seo.buildCategories(this.db.getTagsWithCounts()) };
    }
    return this.categoryCache.categories;
  }

  findCategory(slug) {
    return this.getCategories().find(c => c.slug === slug) || null;
  }

  /** Directory holding the generated docs for an API, or null. */
  docsDirFor(api) {
    const candidates = [api.docs_path, this.dataPath('docs', api.id)].filter(Boolean);
    return candidates.find(dir => fs.existsSync(path.join(dir, 'index.html'))) || null;
  }

  sendPage(res, html, { maxAge = 600, status = 200 } = {}) {
    res.status(status);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=86400`);
    res.send(html);
  }

  sendText(res, body, type, maxAge = 3600) {
    res.set('Content-Type', type);
    res.set('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=86400`);
    res.send(body);
  }

  sendNotFound(res) {
    this.sendPage(res, seo.renderNotFound({ categories: this.getCategories() }), { status: 404, maxAge: 60 });
  }

  /** Minimal skeleton used when an API has no generated documentation yet. */
  fallbackDocHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title></title>
    <link rel="stylesheet" href="https://stackpath.bootstrapcdn.com/bootstrap/4.4.1/css/bootstrap.min.css">
</head>
<body>
    <main class="page-content">
        <div class="container-fluid">
            <div class="row p-lg-4">
                <article class="main-content col-md-12" id="doc-body">
                    <p class="text-muted">Endpoint documentation has not been generated for this API yet. Download the Bruno collection or the OpenAPI spec above.</p>
                </article>
            </div>
        </div>
    </main>
</body>
</html>`;
  }

  setupPageRoutes() {
    const app = this.app;

    // Homepage: pre-rendered stats, category links and the most popular APIs
    app.get('/', (req, res, next) => {
      try {
        const totalApis = this.db.getStats().totalApis;
        const categories = this.getCategories();
        const topApis = this.db.getTopApis(100);
        const tagMap = this.db.getTagsForApis(topApis.map(a => a.id));
        const html = seo.renderHome({ indexHtml: this.readTemplate('index.html'), totalApis, categories, topApis, tagMap });
        this.sendPage(res, html);
      } catch (error) {
        next(error);
      }
    });
    app.get('/index.html', (req, res) => res.redirect(301, '/'));

    // About
    app.get('/about', (req, res, next) => {
      try {
        const totalApis = this.db.getStats().totalApis;
        const html = seo.renderAbout({ aboutHtml: this.readTemplate('about.html'), totalApis, categories: this.getCategories() });
        this.sendPage(res, html, { maxAge: 3600 });
      } catch (error) {
        next(error);
      }
    });
    app.get('/about.html', (req, res) => res.redirect(301, '/about'));

    // Category index and category pages
    app.get('/categories', (req, res, next) => {
      try {
        const totalApis = this.db.getStats().totalApis;
        this.sendPage(res, seo.renderCategoriesIndex({ categories: this.getCategories(), totalApis }), { maxAge: 3600 });
      } catch (error) {
        next(error);
      }
    });

    app.get('/category/:slug', (req, res, next) => {
      try {
        const category = this.findCategory(req.params.slug);
        if (!category) return this.sendNotFound(res);
        const apis = this.db.getApisByTagIds(category.tagIds);
        const tagMap = this.db.getTagsForApis(apis.map(a => a.id));
        const totalApis = this.db.getStats().totalApis;
        const html = seo.renderCategoryPage({ category, apis, tagMap, categories: this.getCategories(), totalApis });
        this.sendPage(res, html, { maxAge: 3600 });
      } catch (error) {
        next(error);
      }
    });

    // Raw OpenAPI document for an API
    app.get('/apis/:slug/openapi.json', (req, res, next) => {
      try {
        const api = this.db.getApiBySlug(req.params.slug);
        if (!api) return res.status(404).json({ error: 'API not found' });
        const file = this.dataPath('openapi', `${api.id}.json`);
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'OpenAPI document not available' });
        res.set('Cache-Control', 'public, max-age=86400');
        res.set('X-Robots-Tag', 'noindex');
        res.type('application/json');
        res.sendFile(file);
      } catch (error) {
        next(error);
      }
    });

    // API documentation page (generated docs wrapped with SEO metadata and a summary)
    app.get('/apis/:slug', (req, res, next) => {
      try {
        let api = this.db.getApiBySlug(req.params.slug);
        if (!api) {
          const byId = this.db.getApi(req.params.slug);
          if (byId && byId.slug) return res.redirect(301, `/apis/${byId.slug}`);
          return this.sendNotFound(res);
        }

        const docsDir = this.docsDirFor(api);
        const html = docsDir ? fs.readFileSync(path.join(docsDir, 'index.html'), 'utf8') : this.fallbackDocHtml();
        const tags = this.db.getApiTags(api.id);
        // Related APIs, de-duplicated by name (the catalog holds several copies of some specs)
        const seenNames = new Set([String(api.name || '').toLowerCase()]);
        const related = this.db.getRelatedApis(api.id, 18)
          .filter(r => {
            const key = String(r.name || '').toLowerCase();
            if (seenNames.has(key)) return false;
            seenNames.add(key);
            return true;
          })
          .slice(0, 6);
        const facts = seo.specFacts(api.id, this.dataPath('openapi'));
        const isDuplicate = this.db.countApisByName(api.name) > 1;

        const page = seo.renderApiPage({ html, api, tags, related, facts, categories: this.getCategories(), isDuplicate });
        this.sendPage(res, page, { maxAge: 3600 });
      } catch (error) {
        next(error);
      }
    });

    // Legacy doc URLs redirect to the canonical slug URL. Assets under
    // /docs/:id/assets/* are still served statically.
    app.get(['/docs/:id', '/docs/:id/index.html'], (req, res, next) => {
      const api = this.db.getApi(req.params.id);
      if (api && api.slug) return res.redirect(301, `/apis/${api.slug}`);
      next();
    });

    // llms.txt: concise, answer-engine friendly overview
    app.get('/llms.txt', (req, res, next) => {
      try {
        const totalApis = this.db.getStats().totalApis;
        const body = seo.renderLlmsTxt({ totalApis, categories: this.getCategories(), topApis: this.db.getTopApis(50) });
        this.sendText(res, body, 'text/plain; charset=utf-8');
      } catch (error) {
        next(error);
      }
    });

    app.get('/llms-full.txt', (req, res, next) => {
      try {
        const categories = this.getCategories();
        const apis = this.db.getAllApis({ limit: 100000, orderBy: 'stars DESC, name ASC' });
        const tagMap = this.db.getTagsForApis(apis.map(a => a.id));
        const bySlug = new Map();
        const uncategorized = [];
        for (const api of apis) {
          const slugs = new Set((tagMap.get(api.id) || []).map(t => seo.categorySlug(seo.displayTagName(t.name))).filter(Boolean));
          if (slugs.size === 0) uncategorized.push(api);
          for (const slug of slugs) {
            if (!bySlug.has(slug)) bySlug.set(slug, []);
            bySlug.get(slug).push(api);
          }
        }
        const body = seo.renderLlmsFullTxt({ totalApis: apis.length, categories, apisByCategory: bySlug, uncategorized });
        this.sendText(res, body, 'text/plain; charset=utf-8');
      } catch (error) {
        next(error);
      }
    });

    // Sitemap (ISO 8601 lastmod, canonical slug URLs, category pages)
    app.get('/sitemap.xml', (req, res, next) => {
      try {
        const apis = this.db.getAllApis({ limit: 100000, orderBy: 'stars DESC, name ASC' });
        const xml = seo.renderSitemap({ apis, categories: this.getCategories() });
        this.sendText(res, xml, 'application/xml; charset=utf-8');
      } catch (error) {
        next(error);
      }
    });
  }

  setupStaticAndFallback() {
    const oneDay = 24 * 60 * 60 * 1000;

    // Generated documentation assets (the index.html pages themselves are served via /apis/:slug)
    this.app.use('/docs', express.static(this.dataPath('docs'), { maxAge: 7 * oneDay, index: false, redirect: false }));

    // Frontend assets. index.html / about.html are rendered by routes above.
    this.app.use(express.static(this.publicPath(), { maxAge: oneDay, index: false, redirect: false }));

    // 404
    this.app.use((req, res) => {
      if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
      this.sendNotFound(res);
    });

    // 500
    // eslint-disable-next-line no-unused-vars
    this.app.use((err, req, res, next) => {
      console.error('Unhandled error:', err);
      if (req.path.startsWith('/api/')) return res.status(500).json({ error: err.message });
      res.status(500).set('Content-Type', 'text/plain').send('Internal server error');
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
      let skipped = 0;
      for (const api of apis) {
        try {
          // Check if API already exists (by URL)
          const existing = this.db.getApiByUrl(api.openapi_url || api.github_url);
          if (existing) {
            console.log(`⏭️  Skipping ${api.name} (already exists in database)`);
            skipped++;
            continue;
          }

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
      console.log(`Found: ${apis.length} APIs`);
      console.log(`Processed: ${processed} new APIs`);
      console.log(`Skipped: ${skipped} duplicates`);
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
