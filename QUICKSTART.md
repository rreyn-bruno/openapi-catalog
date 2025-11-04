# Quick Start Guide

## 🚀 Get Started in 5 Minutes

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Configure GitHub Token (Optional but Recommended)

The catalog can run without a GitHub token, but you won't be able to scrape for new APIs.

1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Give it a name like "Bruno API Catalog"
4. Select scopes: `public_repo`, `read:org`
5. Click "Generate token"
6. Copy the token

Edit `.env` file:
```bash
GITHUB_TOKEN=your_token_here
PORT=5000
```

### Step 3: Start the Server

```bash
npm start
```

You should see:
```
🚀 Bruno API Catalog running on http://localhost:5000
📊 API endpoints: http://localhost:5000/api
📚 Documentation: http://localhost:5000/docs
```

### Step 4: Open the Catalog

Open your browser to: http://localhost:5000

### Step 5: Scrape Some APIs

Click the "Start Scraping" button in the web UI, or use curl:

```bash
curl -X POST http://localhost:5000/api/scrape \
  -H "Content-Type: application/json" \
  -d '{"minStars": 10, "maxResults": 5}'
```

Watch the server console for progress. This will:
1. Search GitHub for OpenAPI files
2. Download each spec
3. Convert to Bruno collection
4. Generate documentation
5. Add to the catalog

### Step 6: Browse the Catalog

Refresh the page and you'll see the discovered APIs!

Click on any API to view its documentation.

## What's Next?

- **Customize scraping**: Edit `src/scraper/github-scraper.js`
- **Add more APIs**: Trigger more scrape runs with different parameters
- **Deploy**: See README.md for deployment options
- **Contribute**: Add features and submit PRs!

## Troubleshooting

### "GitHub token not configured"
- Make sure you've set `GITHUB_TOKEN` in your `.env` file
- Restart the server after adding the token

### "Error: Cannot find module"
- Run `npm install` again
- Make sure you're in the `bruno-api-catalog` directory

### "Port 5000 already in use"
- Change `PORT=5000` to another port in `.env`
- Or kill the process using port 5000

### Scraping takes a long time
- This is normal! Each API needs to be:
  - Downloaded
  - Converted to Bruno
  - Documentation generated
- Start with small `maxResults` (5-10) for testing

### "bruno-doc-gen not found"
- Make sure the `bruno-doc-gen` repo is in `../bruno-doc-gen`
- Or update the path in `src/pipeline/converter.js`

## Need Help?

- Check the full README.md
- Review ARCHITECTURE.md for system design
- Open an issue on GitHub
