const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

class APIsGuruImporter {
  constructor() {
    this.apiListUrl = 'https://api.apis.guru/v2/list.json';
  }

  /**
   * Fetch the list of all APIs from APIs.guru
   * @returns {Promise<Object>} Object containing all APIs
   */
  async fetchAPIList() {
    try {
      console.log('Fetching APIs.guru catalog...');
      const response = await axios.get(this.apiListUrl);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to fetch APIs.guru catalog: ${error.message}`);
    }
  }

  /**
   * Convert APIs.guru format to our internal format
   * @param {Object} apiList - The APIs.guru API list
   * @returns {Array} Array of APIs in our format
   */
  convertToInternalFormat(apiList) {
    const apis = [];
    
    for (const [providerKey, providerData] of Object.entries(apiList)) {
      const preferredVersion = providerData.preferred;
      const versionData = providerData.versions[preferredVersion];
      
      if (!versionData) {
        console.warn(`No preferred version found for ${providerKey}`);
        continue;
      }

      const info = versionData.info;
      
      // Determine the OpenAPI spec URL (prefer OpenAPI 3.0 over Swagger 2.0)
      let openapiUrl = versionData.swaggerUrl;
      if (versionData.openapiVer && versionData.openapiVer.startsWith('3.')) {
        openapiUrl = versionData.swaggerUrl; // They use swaggerUrl for both
      }

      // Extract the original source URL from x-origin
      let sourceUrl = openapiUrl;
      if (info['x-origin'] && info['x-origin'].length > 0) {
        sourceUrl = info['x-origin'][0].url || openapiUrl;
      }

      // Get categories/tags
      const tags = info['x-apisguru-categories'] || [];

      // Create API object
      const api = {
        id: uuidv4(),
        name: info.title || providerKey,
        description: info.description || '',
        version: info.version || preferredVersion,
        github_url: null, // APIs.guru doesn't always have GitHub URLs
        openapi_url: openapiUrl,
        stars: 0, // APIs.guru doesn't track stars
        source: 'apis-guru',
        source_url: sourceUrl,
        last_synced_at: new Date().toISOString(),
        provider: info['x-providerName'] || providerKey,
        logo_url: info['x-logo']?.url || null,
        categories: tags,
        added_date: providerData.added,
        updated_date: versionData.updated,
        openapi_version: versionData.openapiVer || '2.0'
      };

      apis.push(api);
    }

    return apis;
  }

  /**
   * Download OpenAPI spec from URL
   * @param {string} url - URL to download from
   * @param {string} outputPath - Path to save the file
   * @returns {Promise<boolean>} Success status
   */
  async downloadSpec(url, outputPath) {
    try {
      const response = await axios.get(url, {
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024 // 10MB max
      });

      await fs.writeFile(outputPath, JSON.stringify(response.data, null, 2));
      return true;
    } catch (error) {
      console.error(`Failed to download spec from ${url}:`, error.message);
      return false;
    }
  }

  /**
   * Check if an API already exists in the database
   * @param {Object} db - Database instance
   * @param {Object} api - API to check
   * @returns {boolean} True if exists
   */
  apiExists(db, api) {
    // Check by name and version
    const stmt = db.prepare('SELECT id FROM apis WHERE name = ? AND version = ?');
    const existing = stmt.get(api.name, api.version);
    return !!existing;
  }

  /**
   * Import all APIs from APIs.guru
   * @param {Object} options - Import options
   * @returns {Promise<Object>} Import statistics
   */
  async importAll(options = {}) {
    const {
      database,
      processor,
      skipExisting = true,
      maxApis = null,
      delay = 1000 // Delay between downloads to be nice to APIs.guru
    } = options;

    const stats = {
      total: 0,
      downloaded: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      errors: []
    };

    try {
      // Fetch the API list
      const apiList = await this.fetchAPIList();
      const apis = this.convertToInternalFormat(apiList);
      
      stats.total = apis.length;
      console.log(`Found ${stats.total} APIs in APIs.guru catalog`);

      // Limit if specified
      const apisToImport = maxApis ? apis.slice(0, maxApis) : apis;
      console.log(`Importing ${apisToImport.length} APIs...`);

      for (const api of apisToImport) {
        try {
          // Check if already exists
          if (skipExisting && this.apiExists(database.db, api)) {
            console.log(`⊘ Skipping ${api.name} (already exists)`);
            stats.skipped++;
            continue;
          }

          console.log(`\n=== Processing: ${api.name} ===`);

          // Download OpenAPI spec
          console.log('1. Downloading OpenAPI spec...');
          const specPath = path.join(process.cwd(), 'data', 'openapi', `${api.id}.json`);
          const downloaded = await this.downloadSpec(api.openapi_url, specPath);
          
          if (!downloaded) {
            stats.failed++;
            stats.errors.push({ api: api.name, error: 'Failed to download spec' });
            continue;
          }
          
          stats.downloaded++;
          api.openapi_path = specPath;

          // Process with the pipeline (convert to Bruno + generate docs)
          if (processor) {
            console.log('2. Converting to Bruno collection...');
            const collectionPath = await processor.convertToBruno(api.id, api.name, specPath);

            if (collectionPath) {
              api.collection_path = collectionPath;

              console.log('3. Generating documentation...');
              const docsPath = await processor.generateDocs(api.id, api.name, collectionPath);
              api.docs_path = docsPath;
            }
          }

          // Save to database
          database.createApi(api);
          
          // Add tags/categories
          if (api.categories && api.categories.length > 0) {
            for (const category of api.categories) {
              const tag = database.getOrCreateTag(category);
              database.addTagToApi(api.id, tag.id);
            }
          }

          console.log(`✓ Successfully processed ${api.name}`);
          stats.processed++;

          // Rate limiting - be nice to APIs.guru
          if (delay > 0) {
            await this.sleep(delay);
          }

        } catch (error) {
          console.error(`✗ Error processing ${api.name}:`, error.message);
          stats.failed++;
          stats.errors.push({ api: api.name, error: error.message });
        }
      }

      return stats;

    } catch (error) {
      throw new Error(`Import failed: ${error.message}`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = APIsGuruImporter;

