const { HTTPSnippet, availableTargets } = require('httpsnippet');

// Get all available languages from httpsnippet
function getLanguages() {
  const allLanguages = [];
  const targets = availableTargets();

  for (const target of targets) {
    const { key, title, clients } = target;

    const languages =
      (clients.length === 1)
        ? [{
          name: title,
          target: key,
          client: clients[0].key
        }]
        : clients.map(client => ({
          name: `${title} - ${client.title}`,
          target: key,
          client: client.key
        }));
    allLanguages.push(...languages);
  }

  // Move "Shell" to the top of the array
  const shellCurlIndex = allLanguages.findIndex(lang => lang.name === "Shell");
  if (shellCurlIndex !== -1) {
    const [shellCurl] = allLanguages.splice(shellCurlIndex, 1);
    allLanguages.unshift(shellCurl);
  }

  return allLanguages;
}

// Create content type based on body mode
function createContentType(mode) {
  switch (mode) {
    case 'json':
      return 'application/json';
    case 'text':
      return 'text/plain';
    case 'xml':
      return 'application/xml';
    case 'sparql':
      return 'application/sparql-query';
    case 'formUrlEncoded':
      return 'application/x-www-form-urlencoded';
    case 'graphql':
      return 'application/json';
    case 'multipartForm':
      return 'multipart/form-data';
    case 'file':
      return 'application/octet-stream';
    default:
      return '';
  }
}

// Create headers for HAR request
function createHeaders(request, headers) {
  const enabledHeaders = (headers || [])
    .filter((header) => header.enabled)
    .map((header) => ({
      name: header.name.toLowerCase(),
      value: header.value
    }));

  const contentType = createContentType(request.body?.mode);
  if (contentType !== '' && !enabledHeaders.some((header) => header.name === 'content-type')) {
    enabledHeaders.push({ name: 'content-type', value: contentType });
  }

  return enabledHeaders;
}

// Create query string for HAR request
function createQuery(queryParams = []) {
  return queryParams
    .filter((param) => param.enabled && param.type === 'query')
    .map((param) => ({
      name: param.name,
      value: param.value
    }));
}

// Create post data for HAR request
function createPostData(body) {
  if (!body || body.mode === 'none') {
    return {};
  }

  const contentType = createContentType(body.mode);

  switch (body.mode) {
    case 'formUrlEncoded':
      return {
        mimeType: contentType,
        text: new URLSearchParams(
          (Array.isArray(body[body.mode]) ? body[body.mode] : [])
            .filter((param) => param?.enabled)
            .reduce((acc, param) => {
              acc[param.name] = param.value;
              return acc;
            }, {})
        ).toString(),
        params: (Array.isArray(body[body.mode]) ? body[body.mode] : [])
          .filter((param) => param?.enabled)
          .map((param) => ({
            name: param.name,
            value: param.value
          }))
      };
    case 'multipartForm':
      return {
        mimeType: contentType,
        params: (Array.isArray(body[body.mode]) ? body[body.mode] : [])
          .filter((param) => param?.enabled)
          .map((param) => ({
            name: param.name,
            value: param.value,
            ...(param.type === 'file' && { fileName: param.value })
          }))
      };
    case 'graphql':
      return {
        mimeType: contentType,
        text: JSON.stringify(body[body.mode])
      };
    default:
      return {
        mimeType: contentType,
        text: body[body.mode] || ''
      };
  }
}

// Build HAR request from Bruno request
function buildHarRequest(request) {
  if (!request) {
    throw new Error('Request is undefined or null');
  }

  const postData = createPostData(request.body || {});
  const harRequest = {
    method: request.method || 'GET',
    url: request.url || '',
    httpVersion: 'HTTP/1.1',
    cookies: [],
    headers: createHeaders(request, request.headers || []),
    queryString: createQuery(request.params || []),
    headersSize: 0,
    bodySize: 0,
    binary: true
  };

  // Only include postData if it has content
  if (Object.keys(postData).length > 0) {
    harRequest.postData = postData;
  }

  return harRequest;
}

// Generate code snippet for a request
function generateSnippet(request, language) {
  try {
    // Replace Bruno variables with placeholder URLs for validation
    const variableReplacements = {};
    let modifiedRequest = JSON.parse(JSON.stringify(request)); // Deep clone

    // Replace variables in URL
    if (modifiedRequest.url) {
      const variableRegex = /\{\{([^}]+)\}\}/g;
      let match;
      while ((match = variableRegex.exec(modifiedRequest.url)) !== null) {
        const varName = match[0]; // e.g., "{{baseUrl}}"
        const placeholder = `https://example.com/${match[1]}`; // e.g., "https://example.com/baseUrl"
        variableReplacements[placeholder] = varName;
      }

      // Replace all variables with placeholders
      modifiedRequest.url = modifiedRequest.url.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
        return `https://example.com/${varName}`;
      });
    }

    const harRequest = buildHarRequest(modifiedRequest);

    // Suppress console.error temporarily to hide validation warnings
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
      const snippet = new HTTPSnippet(harRequest);
      let result = snippet.convert(language.target, language.client);

      // Replace placeholders back with Bruno variables
      if (result) {
        for (const [placeholder, variable] of Object.entries(variableReplacements)) {
          result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), variable);
        }
      }

      return result || '// Code snippet generation not available for this request';
    } finally {
      // Restore console.error
      console.error = originalConsoleError;
    }
  } catch (error) {
    // Only log non-validation errors
    if (!error.message.includes('afterRequest') && !error.message.includes('strict mode')) {
      console.error('Error generating code snippet:', error);
    }
    // Return a generic fallback instead of showing the error
    return '// Code snippet generation not available for this request';
  }
}

module.exports = {
  getLanguages,
  generateSnippet,
  buildHarRequest
};

