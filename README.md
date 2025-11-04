# OpenAPI Catalog

The **largest** OpenAPI-backed API catalog, automatically curated from GitHub and APIs.guru, with ready-to-use Bruno collections and interactive documentation.

🔗 **Live Site**: [Coming Soon - Add your domain here]

## Features

- 🌐 **~2,900+ APIs** - From GitHub and APIs.guru combined
- 📦 **Bruno Collections** - Download ready-to-use collections for [Bruno API Client](https://www.usebruno.com/)
- 📚 **Interactive Documentation** - Auto-generated HTML docs for every API
- 🔍 **Search & Filter** - Find APIs by name, category, or source
- 🏷️ **Smart Categorization** - Organized by tags with normalized naming
- ⭐ **GitHub Integration** - Star counts and direct links to source repos
- 🎨 **Modern UI** - Clean, responsive interface with purple gradient header

## Data Sources

### 🔵 GitHub Scraper
- Searches GitHub for public OpenAPI specifications
- Captures star counts as quality signals
- Direct links to source repositories
- ~400+ community APIs

### 🟣 APIs.guru Import
- Imports the comprehensive [APIs.guru](https://apis.guru) catalog
- ~2,500+ official APIs from major providers (AWS, Azure, Google, Stripe, etc.)
- Well-maintained specs with regular updates
- Rich metadata including logos and categories

## Architecture

```
GitHub → Scraper → OpenAPI Spec → Converter → Bruno Collection → Doc Generator → Catalog
```

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Environment

Create a `.env` file:

```bash
GITHUB_TOKEN=your_github_personal_access_token
PORT=3000
```

To create a GitHub token:
1. Go to GitHub Settings → Developer settings → Personal access tokens
2. Generate new token (classic)
3. Select scopes: `public_repo`, `read:org`
4. Copy the token to your `.env` file

### 3. Start the Server

```bash
npm start
```

The catalog will be available at `http://localhost:3000`

### 4. Scrape GitHub for APIs

Option A: Use the web UI
- Open `http://localhost:3000`
- Click "Start Scraping"

Option B: Use the API
```bash
curl -X POST http://localhost:3000/api/scrape \
  -H "Content-Type: application/json" \
  -d '{"minStars": 10, "maxResults": 10}'
```

## Project Structure

```
bruno-api-catalog/
├── src/
│   ├── api/              # Express server
│   ├── database/         # SQLite database
│   ├── scraper/          # GitHub scraper
│   └── pipeline/         # Conversion pipeline
├── public/               # Frontend web app
├── data/
│   ├── collections/      # Bruno collections
│   ├── docs/             # Generated documentation
│   └── openapi/          # Downloaded OpenAPI specs
├── index.js              # Main entry point
└── package.json
```

## API Endpoints

### GET /api/apis
List all APIs with pagination and search

Query params:
- `limit` - Number of results (default: 50)
- `offset` - Offset for pagination (default: 0)
- `search` - Search query
- `orderBy` - Sort order (default: created_at DESC)

### GET /api/apis/:id
Get details for a specific API

### GET /api/tags
List all tags

### GET /api/tags/:tagName/apis
Get APIs by tag

### GET /api/stats
Get catalog statistics

### POST /api/scrape
Trigger a scrape run (requires GitHub token)

Body:
```json
{
  "minStars": 10,
  "maxResults": 20
}
```

### GET /api/scrape/latest
Get status of the latest scrape run

## Configuration

### Environment Variables

- `GITHUB_TOKEN` - GitHub personal access token (required for scraping)
- `PORT` - Server port (default: 3000)

### Scraper Options

Edit `src/scraper/github-scraper.js` to customize:
- File patterns to search for
- Minimum star count
- Maximum results
- Rate limiting

### Pipeline Options

Edit `src/pipeline/converter.js` to customize:
- Path to bruno-doc-gen
- Storage directories
- Conversion options

## Development

### Prerequisites

- Node.js 18+
- bruno-doc-gen repository (should be in `../bruno-doc-gen`)

### Running in Development

```bash
npm start
```

### Database

The catalog uses SQLite for simplicity. The database file is created at `./data/catalog.db`.

To reset the database:
```bash
rm data/catalog.db
```

## Deployment

### Option 1: Railway/Render

1. Push to GitHub
2. Connect to Railway/Render
3. Set environment variables
4. Deploy

### Option 2: Docker

```dockerfile
FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

### Option 3: VPS

```bash
# Install Node.js
# Clone repo
git clone <your-repo>
cd bruno-api-catalog
npm install

# Set up environment
cp .env.example .env
# Edit .env with your GitHub token

# Run with PM2
npm install -g pm2
pm2 start index.js --name bruno-catalog
pm2 save
pm2 startup
```

## How It Works

### 1. Scraping

The scraper searches GitHub for files matching:
- `openapi.json`
- `openapi.yaml`
- `openapi.yml`
- `swagger.json`

It filters by star count and extracts metadata from the OpenAPI spec.

### 2. Conversion

For each found API:
1. Downloads the OpenAPI spec
2. Converts to Bruno collection using `openapi-to-bruno`
3. Generates documentation using `bruno-docs`
4. Stores metadata in database

### 3. Catalog

The web app provides:
- Browse all APIs
- Search by name/description
- Filter by tags
- View documentation
- Link to GitHub repo
- "Fetch in Bruno" button

## Roadmap

- [ ] Scheduled scraping (cron jobs)
- [ ] API versioning support
- [ ] User accounts and favorites
- [ ] API health monitoring
- [ ] Community contributions
- [ ] API ratings/reviews
- [ ] Advanced search filters
- [ ] Export catalog data

## Contributing

Contributions welcome! Please:
1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT

## Credits

Built for the [Bruno](https://www.usebruno.com/) API client community.

Uses:
- [bruno-doc-gen](https://github.com/your-repo/bruno-doc-gen) - Documentation generator
- [Octokit](https://github.com/octokit/rest.js) - GitHub API client
- [Express](https://expressjs.com/) - Web framework
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - SQLite database
