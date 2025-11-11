# Local Development Guide

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start Local Server
```bash
npm run dev
```

The server will start at: **http://localhost:3001**

---

## 📁 What's Different Locally?

| Environment | URL | Database | Port |
|------------|-----|----------|------|
| **Production** | https://openapicatalog.com | Railway volume | 5000 |
| **Local** | http://localhost:3001 | `./data/catalog.db` | 3001 |

---

## 🔧 Configuration

Local development uses `.env.local` instead of `.env`:

```bash
# .env.local (already created for you)
GITHUB_TOKEN=your_github_token_here
PORT=3001
```

---

## 📊 Database

By default, local development uses the **same database** as production (`./data/catalog.db`).

This means:
- ✅ You have all 3,076 APIs locally
- ✅ You can test with real data
- ⚠️ Changes to the database affect your local copy only (not production)

### Want a Separate Local Database?

Uncomment this line in `.env.local`:
```bash
DB_PATH=./data/catalog-local.db
```

Then restart the server. It will create a fresh empty database.

---

## 🔄 Typical Workflow

### Making Changes:

1. **Start local server:**
   ```bash
   npm run dev
   ```

2. **Make changes** to files (HTML, CSS, JS, backend code)

3. **Restart server** to see backend changes:
   - Press `Ctrl+C` to stop
   - Run `npm run dev` again

4. **Test at http://localhost:3001**

5. **When satisfied, commit and push:**
   ```bash
   git add .
   git commit -m "Your changes"
   git push origin main
   ```

6. **Railway auto-deploys** to production

---

## 🎨 Frontend Changes (HTML/CSS/JS)

Files in `public/` are served statically:
- `public/index.html` - Main page
- `public/styles.css` - Styles (if you add one)

**No restart needed** - just refresh your browser!

---

## ⚙️ Backend Changes (Node.js)

Files in `src/`:
- `src/api/server.js` - API endpoints
- `src/database/schema.js` - Database operations
- `src/pipeline/converter.js` - OpenAPI conversion

**Restart required** - press `Ctrl+C` and run `npm run dev` again.

---

## 🧪 Testing Features

### Test Scraping (locally):
```bash
curl -X POST http://localhost:3001/api/scrape \
  -H "Content-Type: application/json" \
  -d '{"minStars": 100, "maxResults": 5}'
```

### Test Doc Regeneration:
```bash
curl -X POST http://localhost:3001/api/regenerate-docs
```

### Check Health:
```bash
curl http://localhost:3001/api/health
```

---

## 🐛 Troubleshooting

### Port already in use?
Change the port in `.env.local`:
```bash
PORT=3001
```

### Database locked?
Make sure you don't have the server running twice.

### Changes not showing?
- Frontend changes: Hard refresh (`Cmd+Shift+R` on Mac, `Ctrl+Shift+R` on Windows)
- Backend changes: Restart the server

---

## 📝 Tips

- ✅ Always test locally before pushing to production
- ✅ Use `git status` to see what files changed
- ✅ Commit small, logical changes
- ✅ Write descriptive commit messages
- ⚠️ Don't commit `.env.local` (it's in `.gitignore`)

---

## 🚀 Ready to Deploy?

When you're happy with your changes:

```bash
git add .
git commit -m "Add about page and popular APIs section"
git push origin main
```

Railway will automatically deploy to production! 🎉

