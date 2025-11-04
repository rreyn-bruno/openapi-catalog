const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs').promises;
const yaml = require('js-yaml');

const execAsync = promisify(exec);

class ConversionPipeline {
  constructor(options = {}) {
    // Use absolute paths to avoid issues when changing directories
    const rootDir = path.resolve(__dirname, '../..');
    this.brunoDocGenPath = options.brunoDocGenPath || path.resolve(rootDir, '../bruno-doc-gen');
    this.collectionsDir = options.collectionsDir || path.resolve(rootDir, 'data/collections');
    this.docsDir = options.docsDir || path.resolve(rootDir, 'data/docs');
    this.openapiDir = options.openapiDir || path.resolve(rootDir, 'data/openapi');
  }

  /**
   * Convert OpenAPI spec to Bruno collection and generate docs
   * @param {Object} apiInfo - API information from scraper
   * @returns {Promise<Object>} Conversion result
   */
  async convertAndGenerateDocs(apiInfo) {
    const { id, name, openapi_url, github_url } = apiInfo;
    
    console.log(`\n=== Processing: ${name} ===`);
    
    try {
      // Step 1: Download OpenAPI spec
      console.log('1. Downloading OpenAPI spec...');
      const openapiPath = await this.downloadOpenAPISpec(id, openapi_url);
      
      // Step 2: Convert to Bruno collection
      console.log('2. Converting to Bruno collection...');
      const collectionPath = await this.convertToBruno(id, name, openapiPath);
      
      // Step 3: Generate documentation
      console.log('3. Generating documentation...');
      const docsPath = await this.generateDocs(id, name, collectionPath, github_url);
      
      console.log(`✓ Successfully processed ${name}`);
      
      return {
        success: true,
        collection_path: collectionPath,
        docs_path: docsPath,
        openapi_path: openapiPath
      };
    } catch (error) {
      console.error(`✗ Error processing ${name}:`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Download OpenAPI spec from URL
   */
  async downloadOpenAPISpec(id, url) {
    const filename = `${id}.json`;
    const filepath = path.join(this.openapiDir, filename);

    // Ensure directory exists
    await fs.mkdir(this.openapiDir, { recursive: true });

    // Download using curl
    await execAsync(`curl -L "${url}" -o "${filepath}"`);

    // Validate and convert if needed
    let content = await fs.readFile(filepath, 'utf-8');

    // Try to parse as JSON first
    let isValidSpec = false;
    try {
      const parsed = JSON.parse(content);
      // Check if it looks like an OpenAPI spec
      if (parsed.openapi || parsed.swagger) {
        isValidSpec = true;
      } else {
        throw new Error('Not a valid OpenAPI specification (missing openapi/swagger field)');
      }
    } catch (jsonError) {
      // If not JSON, try to parse as YAML
      try {
        const yamlContent = yaml.load(content);
        if (yamlContent && (yamlContent.openapi || yamlContent.swagger)) {
          // Convert YAML to JSON
          console.log('  Converting YAML to JSON...');
          content = JSON.stringify(yamlContent, null, 2);
          await fs.writeFile(filepath, content, 'utf-8');
          isValidSpec = true;
        } else {
          throw new Error('Not a valid OpenAPI specification (missing openapi/swagger field)');
        }
      } catch (yamlError) {
        throw new Error('Downloaded file is not a valid OpenAPI spec (not JSON or YAML)');
      }
    }

    if (!isValidSpec) {
      throw new Error('Downloaded file is not a valid OpenAPI specification');
    }

    return filepath;
  }

  /**
   * Convert OpenAPI to Bruno collection using openapi-to-bruno
   */
  async convertToBruno(id, name, openapiPath) {
    const collectionPath = path.join(this.collectionsDir, id);
    
    // Ensure directory exists
    await fs.mkdir(this.collectionsDir, { recursive: true });
    
    // Use the openapi-to-bruno tool from bruno-doc-gen
    const command = `cd ${this.brunoDocGenPath} && node bin/openapi-to-bruno "${openapiPath}" "${collectionPath}" --force`;
    
    try {
      const { stdout, stderr } = await execAsync(command);
      console.log(stdout);
      if (stderr) console.error(stderr);
    } catch (error) {
      throw new Error(`Failed to convert to Bruno: ${error.message}`);
    }
    
    return collectionPath;
  }

  /**
   * Generate documentation using bruno-docs
   */
  async generateDocs(id, name, collectionPath, githubUrl) {
    const docsPath = path.join(this.docsDir, id);
    
    // Ensure directory exists
    await fs.mkdir(this.docsDir, { recursive: true });
    
    // Use bruno-docs to generate documentation
    let command = `cd ${this.brunoDocGenPath} && node bin/bruno-docs generate "${collectionPath}" -o "${docsPath}" --title "${name}"`;
    
    // Add bruno-url if available
    if (githubUrl) {
      command += ` --bruno-url "${githubUrl}"`;
    }
    
    try {
      const { stdout, stderr } = await execAsync(command);
      console.log(stdout);
      // Ignore stderr warnings about HAR validation
    } catch (error) {
      // Even if there are warnings, docs might still be generated
      console.warn(`Warning during doc generation: ${error.message}`);
    }
    
    return docsPath;
  }

  /**
   * Process multiple APIs in batch
   */
  async processBatch(apiList) {
    const results = [];
    
    for (const api of apiList) {
      const result = await this.convertAndGenerateDocs(api);
      results.push({
        ...api,
        ...result
      });
      
      // Small delay between conversions
      await this.sleep(500);
    }
    
    return results;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = ConversionPipeline;
