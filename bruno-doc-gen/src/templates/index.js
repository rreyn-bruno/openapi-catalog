const Handlebars = require('handlebars');
const fs = require('fs-extra');
const path = require('path');
const MarkdownIt = require('markdown-it');
const { getLanguages, generateSnippet } = require('../codegen');

// Initialize markdown-it with HTML enabled
const md = new MarkdownIt({
  html: true, // Enable HTML tags in source
  linkify: true, // Autoconvert URL-like text to links
  typographer: true // Enable smartquotes and other typographic replacements
});

// Register Handlebars helpers
Handlebars.registerHelper('json', function(context) {
  return JSON.stringify(context, null, 2);
});

Handlebars.registerHelper('eq', function(a, b) {
  return a === b;
});

Handlebars.registerHelper('unless', function(conditional, options) {
  if (!conditional) {
    return options.fn(this);
  }
  return options.inverse(this);
});

Handlebars.registerHelper('hasEnabledItems', function(items) {
  return items && items.some(item => item.enabled);
});

// Register Handlebars helper for markdown rendering
Handlebars.registerHelper('markdown', function(text) {
  if (!text) return '';
  return new Handlebars.SafeString(md.render(text));
});

// Helper to generate code snippet for a specific language
Handlebars.registerHelper('generateCode', function(item, languageTarget, languageClient) {
  if (!item.request) return '';

  const language = {
    target: languageTarget,
    client: languageClient
  };

  return generateSnippet(item.request, language);
});

// Register Handlebars helper for markdown rendering
Handlebars.registerHelper('markdown', function(text) {
  if (!text) return '';
  return new Handlebars.SafeString(md.render(text));
});

async function createTemplate({ collection, theme, title, brunoCollectionUrl }) {
  const templatePath = path.join(__dirname, 'main.hbs');
  const templateSource = await fs.readFile(templatePath, 'utf8');
  const template = Handlebars.compile(templateSource);

  // Flatten collection items for easier templating
  const items = flattenCollection(collection);

  // Build sidebar tree
  const sidebarTree = buildSidebarTree(collection);

  // Get available languages for code generation
  const languages = getLanguages();

  return template({
    title,
    collection,
    items,
    theme,
    brunoCollectionUrl,
    languages: JSON.stringify(languages),
    sidebarTree: JSON.stringify(sidebarTree),
    generatedAt: new Date().toISOString()
  });
}

function flattenCollection(collection, items = [], path = []) {
  const languages = getLanguages();

  if (collection.items) {
    collection.items.forEach(item => {
      if (item.type === 'folder') {
        flattenCollection(item, items, [...path, item.name]);
      } else if (item.type === 'http-request' || item.type === 'graphql-request') {
        // Generate code samples for all languages
        const codeSamples = {};

        // Only generate code if request exists
        if (item.request) {
          languages.forEach(lang => {
            const key = `${lang.target}_${lang.client}`;
            try {
              const code = generateSnippet(item.request, lang);
              // Only include if code was successfully generated and doesn't contain error messages
              if (code && !code.includes('// Error:') && !code.includes('not available')) {
                codeSamples[key] = {
                  name: lang.name,
                  code: code
                };
              } else {
                // Provide a clean fallback
                codeSamples[key] = {
                  name: lang.name,
                  code: `# Code generation not available for this request`
                };
              }
            } catch (error) {
              // Silently handle errors - don't log validation errors
              if (!error.message.includes('afterRequest') && !error.message.includes('strict mode')) {
                console.error(`Error generating code for ${item.name} with ${lang.name}:`, error.message);
              }
              codeSamples[key] = {
                name: lang.name,
                code: `# Code generation not available for this request`
              };
            }
          });
        }

        // Generate code samples for each example's request
        let examplesWithCode = (item.examples || []).map(example => {
          const exampleCodeSamples = {};

          if (example.request) {
            languages.forEach(lang => {
              const key = `${lang.target}_${lang.client}`;
              try {
                const code = generateSnippet(example.request, lang);
                if (code && !code.includes('// Error:') && !code.includes('not available')) {
                  exampleCodeSamples[key] = {
                    name: lang.name,
                    code: code
                  };
                } else {
                  exampleCodeSamples[key] = {
                    name: lang.name,
                    code: `# Code generation not available for this request`
                  };
                }
              } catch (error) {
                if (!error.message.includes('afterRequest') && !error.message.includes('strict mode')) {
                  console.error(`Error generating code for example ${example.name}:`, error.message);
                }
                exampleCodeSamples[key] = {
                  name: lang.name,
                  code: `# Code generation not available for this request`
                };
              }
            });
          }

          return {
            ...example,
            codeSamples: exampleCodeSamples
          };
        });

        // If no examples exist, generate a default example from the main request
        if (examplesWithCode.length === 0 && item.request) {
          const defaultExampleCodeSamples = {};

          languages.forEach(lang => {
            const key = `${lang.target}_${lang.client}`;
            try {
              const code = generateSnippet(item.request, lang);
              if (code && !code.includes('// Error:') && !code.includes('not available')) {
                defaultExampleCodeSamples[key] = {
                  name: lang.name,
                  code: code
                };
              } else {
                defaultExampleCodeSamples[key] = {
                  name: lang.name,
                  code: `# Code generation not available for this request`
                };
              }
            } catch (error) {
              if (!error.message.includes('afterRequest') && !error.message.includes('strict mode')) {
                console.error(`Error generating code for default example:`, error.message);
              }
              defaultExampleCodeSamples[key] = {
                name: lang.name,
                code: `# Code generation not available for this request`
              };
            }
          });

          examplesWithCode = [{
            name: 'Example Request',
            description: null,
            request: item.request,
            response: null,
            codeSamples: defaultExampleCodeSamples
          }];
        }

        items.push({
          ...item,
          path: [...path, item.name],
          id: generateId([...path, item.name]),
          codeSamples,
          examples: examplesWithCode
        });
      }
    });
  }
  return items;
}

function buildSidebarTree(collection) {
  function processItems(items, parentPath = []) {
    return items.map(item => {
      const itemPath = [...parentPath, item.name];
      const id = generateId(itemPath);

      if (item.type === 'folder') {
        return {
          text: item.name,
          type: 'folder',
          nodes: item.items ? processItems(item.items, itemPath) : [],
          docs: item.root?.docs || ''
        };
      } else if (item.type === 'http-request' || item.type === 'graphql-request') {
        return {
          text: item.name,
          type: 'request',
          method: item.request?.method || 'GET',
          href: `#${id}`
        };
      }
    }).filter(Boolean);
  }

  return processItems(collection.items || []);
}

function generateId(pathArray) {
  return pathArray.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

module.exports = { createTemplate };

