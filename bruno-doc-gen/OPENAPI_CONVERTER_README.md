# OpenAPI to Bruno Converter

This tool converts OpenAPI specifications (v3) to Bruno collection file structure, enabling you to:
1. Convert OpenAPI specs to Bruno collections
2. Generate beautiful documentation from those collections
3. Build an API catalog service

## Installation

The converter is included in this package. Install dependencies:

```bash
npm install
```

## Usage

### Convert OpenAPI to Bruno Collection

```bash
# From a URL
openapi-to-bruno https://petstore3.swagger.io/api/v3/openapi.json ./my-bruno-collection

# From a local file (JSON or YAML)
openapi-to-bruno ./path/to/openapi.json ./my-bruno-collection
openapi-to-bruno ./path/to/openapi.yaml ./my-bruno-collection

# Overwrite existing directory
openapi-to-bruno ./openapi.json ./output --force
```

### Generate Documentation from Converted Collection

After converting, generate docs:

```bash
bruno-docs generate ./my-bruno-collection -o ./docs --title "My API"
```

### Complete Workflow Example

```bash
# 1. Convert OpenAPI to Bruno
openapi-to-bruno https://api.example.com/openapi.json ./api-collection

# 2. Generate documentation
bruno-docs generate ./api-collection -o ./api-docs --title "Example API"

# 3. Open the docs
open api-docs/index.html
```

## Output Structure

The converter creates a complete Bruno collection with:

```
my-bruno-collection/
├── bruno.json              # Collection configuration
├── collection.bru          # Collection-level settings
├── environments/           # Environment files
│   └── Environment 1.bru
├── folder-name/            # Folders (from OpenAPI tags)
│   ├── folder.bru
│   ├── Request 1.bru
│   └── Request 2.bru
└── ungrouped-request.bru   # Requests without tags
```

## Features

- ✅ **Full File Structure**: Creates proper `.bru` files, not just JSON
- ✅ **URL Support**: Fetch OpenAPI specs from URLs
- ✅ **YAML & JSON**: Supports both OpenAPI formats
- ✅ **Environments**: Auto-generates environments from OpenAPI servers
- ✅ **Folder Organization**: Groups requests by OpenAPI tags
- ✅ **Authentication**: Converts OpenAPI security schemes to Bruno auth
- ✅ **Request Bodies**: Handles JSON, form data, multipart, etc.
- ✅ **Path Parameters**: Converts OpenAPI path params to Bruno format

## Building an API Catalog Service

This converter is perfect for building an API catalog service. Here's the workflow:

### 1. Scrape OpenAPI Specs

```javascript
const { convertOpenApiToFileStructure } = require('./src/openapi-converter');

// Scrape GitHub for OpenAPI specs
const repos = await searchGitHubForOpenAPI();

for (const repo of repos) {
  const openApiUrl = repo.openApiUrl;
  const outputDir = `./collections/${repo.name}`;
  
  // Convert to Bruno
  await convertOpenApiToFileStructure(openApiUrl, outputDir);
}
```

### 2. Generate Documentation

```javascript
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Generate docs for each collection
for (const collection of collections) {
  await execAsync(
    `bruno-docs generate ${collection.path} -o ./docs/${collection.name} --bruno-url ${collection.repoUrl}`
  );
}
```

### 3. Build Catalog Frontend

Create a simple web app that:
- Lists all APIs with metadata (name, description, tags)
- Links to generated documentation
- Provides "Fetch in Bruno" buttons
- Offers search/filter functionality

### 4. Store Collections

- **Option A**: Store in Git repos (one per API)
- **Option B**: Store in object storage (S3, etc.)
- **Option C**: Hybrid - Git for versioning, CDN for docs

### Example Catalog Architecture

```
┌─────────────────────┐
│  Scraper Service    │  ← Periodic job (cron)
│  - Find OpenAPI     │
│  - Convert to Bruno │
│  - Generate docs    │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   Database          │
│   + File Storage    │
│  - API metadata     │
│  - Bruno collections│
│  - Generated docs   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Catalog Web App    │
│  - Browse APIs      │
│  - View docs        │
│  - Fetch in Bruno   │
└─────────────────────┘
```

## API Reference

### `convertOpenApiToFileStructure(openApiSpec, outputDir, options)`

Converts an OpenAPI specification to Bruno file structure.

**Parameters:**
- `openApiSpec` (string|object): OpenAPI spec URL, file path, or object
- `outputDir` (string): Output directory for Bruno collection
- `options` (object): Optional configuration
  - `verbose` (boolean): Enable verbose logging

**Returns:** Promise<object>
```javascript
{
  success: true,
  collectionName: "My API",
  outputPath: "/path/to/output",
  itemCount: 10,
  environmentCount: 1
}
```

**Example:**
```javascript
const { convertOpenApiToFileStructure } = require('./src/openapi-converter');

// From URL
await convertOpenApiToFileStructure(
  'https://api.example.com/openapi.json',
  './my-collection'
);

// From file
await convertOpenApiToFileStructure(
  './openapi.yaml',
  './my-collection'
);

// From object
const openApiSpec = { openapi: '3.0.0', ... };
await convertOpenApiToFileStructure(
  openApiSpec,
  './my-collection'
);
```

## Known Limitations

1. **Code Snippets**: The doc generator may fail to generate code snippets for requests with variables (like `{{baseUrl}}`). This is a limitation of the HAR validator, but docs are still generated.

2. **OpenAPI v2**: Only OpenAPI v3 is currently supported. Use a converter to upgrade v2 specs first.

3. **Complex Schemas**: Very complex OpenAPI schemas with deep nesting may not convert perfectly.

## Troubleshooting

### "Output directory already exists"
Use the `--force` flag to overwrite:
```bash
openapi-to-bruno ./spec.json ./output --force
```

### "Error generating code snippet"
This is expected for requests with variables. The documentation is still generated successfully, just without code snippets for those specific requests.

### "Only OpenAPI v3 is supported"
Convert your OpenAPI v2 (Swagger) spec to v3 first using tools like:
- https://converter.swagger.io/
- `swagger2openapi` npm package

## Contributing

Contributions welcome! This tool uses:
- `@usebruno/converters` - OpenAPI to Bruno JSON conversion
- `@usebruno/filestore` - Bruno file format serialization
- `fs-extra` - File system operations
- `js-yaml` - YAML parsing

## License

MIT

## Credits

Built for the [Bruno](https://www.usebruno.com/) API client community.

