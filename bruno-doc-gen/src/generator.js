const fs = require('fs-extra');
const path = require('path');
// Use vendored parser with example support
const { parseRequest, parseCollection, parseFolder } = require('./vendored-parser');
const { createTemplate } = require('./templates');

async function generateDocs({ collectionPath, outputPath, theme = 'light', title, brunoCollectionUrl }) {
  try {
    // Parse the Bruno collection directory
    console.log('Parsing collection directory...');
    const collection = await parseCollectionDirectory(collectionPath);
    console.log(`Found ${collection.items?.length || 0} top-level items`);

    // Generate HTML from template
    console.log('Generating HTML from template...');
    const html = await createTemplate({
      collection,
      theme,
      title: title || collection.name || 'API Documentation',
      brunoCollectionUrl
    });

    // Ensure output directory exists
    await fs.ensureDir(outputPath);

    // Write HTML file
    await fs.writeFile(path.join(outputPath, 'index.html'), html);

    // Copy static assets (CSS, JS)
    await copyAssets(outputPath);

    console.log('Documentation generated successfully!');
  } catch (error) {
    console.error('Error in generateDocs:', error);
    throw error;
  }
}

async function parseCollectionDirectory(collectionPath) {
  const environmentsPath = path.join(collectionPath, 'environments');

  // Get the collection bruno.json config
  const brunoConfig = await getBrunoConfig(collectionPath);

  // Get the collection root (collection.bru)
  const collectionRoot = await getCollectionRoot(collectionPath);

  // Recursively traverse and parse all items
  const traverse = async (currentPath) => {
    const filesInCurrentDir = await fs.readdir(currentPath);
    if (currentPath.includes('node_modules')) {
      return [];
    }

    const currentDirItems = [];
    for (const file of filesInCurrentDir) {
      const filePath = path.join(currentPath, file);
      const stats = await fs.lstat(filePath);

      if (stats.isDirectory()) {
        if (filePath === environmentsPath) continue;
        if (file.startsWith('.git') || file === 'node_modules') continue;

        // Get the folder root
        let folderItem = {
          name: file,
          pathname: filePath,
          type: 'folder',
          items: await traverse(filePath)
        };

        const folderBruJson = await getFolderRoot(filePath);
        if (folderBruJson) {
          folderItem.root = folderBruJson;
          folderItem.seq = folderBruJson.meta?.seq;
        }
        currentDirItems.push(folderItem);
      } else {
        if (['collection.bru', 'folder.bru'].includes(file)) continue;
        if (path.extname(filePath) !== '.bru') continue;

        // Get the request item
        const bruContent = await fs.readFile(filePath, 'utf8');
        const requestItem = parseRequest(bruContent);

        // Transform body to include mode property
        const transformBody = (body) => {
          if (!body) return { mode: 'none' };

          // If body already has mode, return as is
          if (body.mode) return body;

          // Detect mode from body properties
          if (body.json !== undefined) return { mode: 'json', ...body };
          if (body.xml !== undefined) return { mode: 'xml', ...body };
          if (body.text !== undefined) return { mode: 'text', ...body };
          if (body.formUrlEncoded !== undefined) return { mode: 'formUrlEncoded', ...body };
          if (body.multipartForm !== undefined) return { mode: 'multipartForm', ...body };
          if (body.graphql !== undefined) return { mode: 'graphql', ...body };

          return { mode: 'none' };
        };

        // Transform parsed structure to match template expectations
        const request = {
          method: requestItem.http?.method || 'GET',
          url: requestItem.http?.url || '',
          headers: requestItem.headers || [],
          params: requestItem.params || [],
          body: transformBody(requestItem.body),
          auth: requestItem.auth || { mode: 'inherit' },
          script: requestItem.script || {},
          vars: requestItem.vars || {},
          assertions: requestItem.assertions || [],
          tests: requestItem.tests || '',
          docs: requestItem.docs || ''
        };

        // Transform examples to ensure request structure is consistent
        const transformedExamples = (requestItem.examples || []).map(example => {
          if (example.request) {
            return {
              ...example,
              request: {
                method: example.request.method || 'GET',
                url: example.request.url || '',
                headers: example.request.headers || [],
                params: example.request.params || [],
                body: transformBody(example.request.body),
                auth: example.request.auth || { mode: 'inherit' }
              }
            };
          }
          return example;
        });

        currentDirItems.push({
          name: file.replace('.bru', ''),
          pathname: filePath,
          type: requestItem.meta?.type || 'http-request',
          request,
          examples: transformedExamples,
          ...requestItem
        });
      }
    }

    // Sort folders and requests
    const folderItems = currentDirItems.filter(item => item.type === 'folder');
    const requestItems = currentDirItems.filter(item => item.type !== 'folder');

    folderItems.sort((a, b) => {
      if (a.seq !== undefined && b.seq !== undefined) {
        return a.seq - b.seq;
      }
      return a.name.localeCompare(b.name);
    });

    requestItems.sort((a, b) => (a.seq || 0) - (b.seq || 0));

    return [...folderItems, ...requestItems];
  };

  const items = await traverse(collectionPath);

  return {
    name: brunoConfig?.name || collectionRoot?.meta?.name || 'API Collection',
    brunoConfig,
    root: collectionRoot,
    pathname: collectionPath,
    items,
    docs: collectionRoot?.docs || ''
  };
}

async function getBrunoConfig(dir) {
  const brunoJsonPath = path.join(dir, 'bruno.json');
  const exists = await fs.pathExists(brunoJsonPath);
  if (!exists) {
    return {};
  }

  const content = await fs.readFile(brunoJsonPath, 'utf8');
  return JSON.parse(content);
}

async function getCollectionRoot(dir) {
  const collectionRootPath = path.join(dir, 'collection.bru');
  const exists = await fs.pathExists(collectionRootPath);
  if (!exists) {
    return {};
  }

  const content = await fs.readFile(collectionRootPath, 'utf8');
  return parseCollection(content);
}

async function getFolderRoot(dir) {
  const folderRootPath = path.join(dir, 'folder.bru');
  const exists = await fs.pathExists(folderRootPath);
  if (!exists) {
    return null;
  }

  const content = await fs.readFile(folderRootPath, 'utf8');
  return parseFolder(content);
}

async function copyAssets(outputPath) {
  const assetsDir = path.join(__dirname, '../assets');
  const targetDir = path.join(outputPath, 'assets');

  if (await fs.pathExists(assetsDir)) {
    await fs.copy(assetsDir, targetDir);
  }
}

module.exports = { generateDocs };

