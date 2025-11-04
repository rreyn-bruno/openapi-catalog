const { openApiToBruno } = require('@usebruno/converters');
const { stringifyRequest, stringifyCollection, stringifyFolder } = require('@usebruno/filestore');
const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Sanitize a name to be safe for file system usage
 * @param {string} name - The name to sanitize
 * @returns {string} - Sanitized name
 */
function sanitizeName(name) {
  if (!name) return 'unnamed';
  // Replace invalid file system characters with hyphens
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Recursively write collection items (folders and requests) to file system
 * @param {Array} items - Array of collection items
 * @param {string} currentPath - Current directory path
 */
async function writeItems(items, currentPath) {
  if (!items || !Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    try {
      if (item.type === 'http-request' || item.type === 'graphql-request' || item.type === 'grpc-request') {
        // Write request file
        const filename = sanitizeName(`${item.name}.bru`);
        const filePath = path.join(currentPath, filename);
        const content = stringifyRequest(item);
        await fs.writeFile(filePath, content, 'utf8');
        console.log(`  ✓ Created request: ${filename}`);
      } else if (item.type === 'folder') {
        // Create folder directory
        const folderName = sanitizeName(item.name);
        const folderPath = path.join(currentPath, folderName);
        await fs.ensureDir(folderPath);
        console.log(`  ✓ Created folder: ${folderName}/`);

        // Write folder.bru if folder has root metadata
        if (item.root) {
          const folderBruPath = path.join(folderPath, 'folder.bru');
          const folderContent = stringifyFolder(item.root);
          await fs.writeFile(folderBruPath, folderContent, 'utf8');
        }

        // Recursively write folder items
        if (item.items && item.items.length > 0) {
          await writeItems(item.items, folderPath);
        }
      }
    } catch (error) {
      console.error(`  ✗ Error processing item "${item.name}":`, error.message);
    }
  }
}

/**
 * Convert OpenAPI specification to Bruno file structure
 * @param {string|Object} openApiSpec - OpenAPI spec (file path, URL, or object)
 * @param {string} outputDir - Output directory for Bruno collection
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} - Conversion result
 */
async function convertOpenApiToFileStructure(openApiSpec, outputDir, options = {}) {
  try {
    console.log('🔄 Converting OpenAPI to Bruno file structure...\n');

    // Step 1: Load OpenAPI spec
    let openApiData;
    if (typeof openApiSpec === 'string') {
      if (openApiSpec.startsWith('http://') || openApiSpec.startsWith('https://')) {
        // Load from URL
        console.log(`📥 Fetching OpenAPI spec from URL: ${openApiSpec}`);
        const response = await fetch(openApiSpec);
        const contentType = response.headers.get('content-type');
        const text = await response.text();
        
        if (contentType && contentType.includes('yaml')) {
          openApiData = yaml.load(text);
        } else {
          openApiData = JSON.parse(text);
        }
      } else {
        // Load from file
        console.log(`📂 Loading OpenAPI spec from file: ${openApiSpec}`);
        const fileContent = await fs.readFile(openApiSpec, 'utf8');
        const ext = path.extname(openApiSpec).toLowerCase();
        
        if (ext === '.yaml' || ext === '.yml') {
          openApiData = yaml.load(fileContent);
        } else {
          openApiData = JSON.parse(fileContent);
        }
      }
    } else {
      // Already an object
      openApiData = openApiSpec;
    }

    console.log(`✓ OpenAPI spec loaded: ${openApiData.info?.title || 'Untitled'}\n`);

    // Step 2: Convert OpenAPI to Bruno JSON format
    console.log('🔄 Converting to Bruno format...');
    const brunoJson = openApiToBruno(openApiData);
    console.log(`✓ Converted to Bruno collection: ${brunoJson.name}\n`);

    // Step 3: Create output directory
    console.log(`📁 Creating output directory: ${outputDir}`);
    await fs.ensureDir(outputDir);
    console.log('✓ Output directory ready\n');

    // Step 4: Write bruno.json config file
    console.log('📝 Writing collection files...');
    const brunoConfig = {
      version: "1",
      name: brunoJson.name,
      type: "collection",
      ignore: ["node_modules", ".git"]
    };
    
    const brunoConfigPath = path.join(outputDir, 'bruno.json');
    await fs.writeFile(brunoConfigPath, JSON.stringify(brunoConfig, null, 2), 'utf8');
    console.log('  ✓ Created bruno.json');

    // Step 5: Write collection.bru file
    const collectionRoot = brunoJson.root || {
      request: {
        headers: [],
        auth: { mode: 'inherit' },
        script: {},
        vars: {},
        tests: ''
      },
      docs: openApiData.info?.description || ''
    };
    
    const collectionContent = stringifyCollection(collectionRoot);
    const collectionBruPath = path.join(outputDir, 'collection.bru');
    await fs.writeFile(collectionBruPath, collectionContent, 'utf8');
    console.log('  ✓ Created collection.bru');

    // Step 6: Write environments if they exist
    if (brunoJson.environments && brunoJson.environments.length > 0) {
      const environmentsDir = path.join(outputDir, 'environments');
      await fs.ensureDir(environmentsDir);
      
      for (const env of brunoJson.environments) {
        const envFileName = sanitizeName(`${env.name}.bru`);
        const envFilePath = path.join(environmentsDir, envFileName);
        
        // Create environment file content
        let envContent = `vars {\n`;
        if (env.variables && env.variables.length > 0) {
          for (const variable of env.variables) {
            const prefix = variable.enabled === false ? '~' : '';
            envContent += `  ${prefix}${variable.name}: ${variable.value}\n`;
          }
        }
        envContent += `}\n`;
        
        await fs.writeFile(envFilePath, envContent, 'utf8');
        console.log(`  ✓ Created environment: ${envFileName}`);
      }
    }

    // Step 7: Write all requests and folders
    if (brunoJson.items && brunoJson.items.length > 0) {
      await writeItems(brunoJson.items, outputDir);
    }

    console.log('\n✅ Conversion complete!');
    console.log(`📦 Bruno collection created at: ${outputDir}`);
    
    return {
      success: true,
      collectionName: brunoJson.name,
      outputPath: outputDir,
      itemCount: brunoJson.items?.length || 0,
      environmentCount: brunoJson.environments?.length || 0
    };

  } catch (error) {
    console.error('\n❌ Conversion failed:', error.message);
    if (options.verbose) {
      console.error(error.stack);
    }
    throw error;
  }
}

module.exports = {
  convertOpenApiToFileStructure,
  sanitizeName
};

