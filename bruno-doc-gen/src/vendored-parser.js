// Vendored parser wrapper that uses the vendored bruno-lang with example support
const bruToJson = require('./vendored-bruno-lang/v2/src/bruToJson');
const collectionBruToJson = require('./vendored-bruno-lang/v2/src/collectionBruToJson');

/**
 * Parse a .bru request file with example support
 */
function parseRequest(fileContent) {
  return bruToJson(fileContent);
}

/**
 * Parse a collection.bru file
 */
function parseCollection(fileContent) {
  return collectionBruToJson(fileContent);
}

/**
 * Parse a folder.bru file (uses same format as collection)
 */
function parseFolder(fileContent) {
  return collectionBruToJson(fileContent);
}

module.exports = {
  parseRequest,
  parseCollection,
  parseFolder
};

