// Vendored filestore wrapper that uses the vendored bruno-lang with example support
const jsonToBru = require('./vendored-bruno-lang/v2/src/jsonToBru');
const _ = require('lodash');

/**
 * Custom stringifyRequest that uses vendored bruno-lang with example support
 * This is a simplified version that focuses on HTTP requests with examples
 */
function stringifyRequest(requestObj) {
  // Transform the request object to the format expected by jsonToBru
  const bruJson = {
    meta: {
      name: requestObj.name,
      type: requestObj.type || 'http',
      seq: requestObj.seq
    },
    http: {
      method: requestObj.request.method.toUpperCase(),
      url: requestObj.request.url,
      body: requestObj.request.body?.mode || 'none',
      auth: requestObj.request.auth?.mode || 'inherit'
    },
    params: requestObj.request.params || [],
    headers: requestObj.request.headers || [],
    body: requestObj.request.body || { mode: 'none' },
    auth: requestObj.request.auth || { mode: 'inherit' },
    script: requestObj.request.script || {},
    vars: requestObj.request.vars || {},
    assertions: requestObj.request.assertions || [],
    tests: requestObj.request.tests || '',
    docs: requestObj.request.docs || '',
    examples: requestObj.examples || []
  };

  return jsonToBru(bruJson);
}

module.exports = {
  stringifyRequest
};

