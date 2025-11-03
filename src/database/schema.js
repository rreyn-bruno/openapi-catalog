const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class CatalogDatabase {
  constructor(dbPath = './data/catalog.db') {
    // Ensure data directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  initSchema() {
    // APIs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apis (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        version TEXT,
        github_url TEXT,
        openapi_url TEXT,
        collection_path TEXT,
        docs_path TEXT,
        stars INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tags table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      )
    `);

    // API-Tag relationship
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_tags (
        api_id TEXT,
        tag_id TEXT,
        PRIMARY KEY (api_id, tag_id),
        FOREIGN KEY (api_id) REFERENCES apis(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      )
    `);

    // Scrape runs history
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scrape_runs (
        id TEXT PRIMARY KEY,
        started_at DATETIME,
        completed_at DATETIME,
        apis_found INTEGER DEFAULT 0,
        apis_processed INTEGER DEFAULT 0,
        status TEXT
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_apis_name ON apis(name);
      CREATE INDEX IF NOT EXISTS idx_apis_stars ON apis(stars DESC);
      CREATE INDEX IF NOT EXISTS idx_apis_created ON apis(created_at DESC);
    `);
  }

  // API operations
  createApi(api) {
    const stmt = this.db.prepare(`
      INSERT INTO apis (id, name, description, version, github_url, openapi_url, collection_path, docs_path, stars)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      api.id,
      api.name,
      api.description,
      api.version,
      api.github_url,
      api.openapi_url,
      api.collection_path,
      api.docs_path,
      api.stars || 0
    );
  }

  getApi(id) {
    const stmt = this.db.prepare('SELECT * FROM apis WHERE id = ?');
    return stmt.get(id);
  }

  getAllApis(options = {}) {
    const { limit = 50, offset = 0, search = '', orderBy = 'created_at DESC' } = options;
    
    let query = 'SELECT * FROM apis';
    const params = [];

    if (search) {
      query += ' WHERE name LIKE ? OR description LIKE ?';
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = this.db.prepare(query);
    return stmt.all(...params);
  }

  updateApi(id, updates) {
    const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updates);
    
    const stmt = this.db.prepare(`
      UPDATE apis SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);
    return stmt.run(...values, id);
  }

  deleteApi(id) {
    const stmt = this.db.prepare('DELETE FROM apis WHERE id = ?');
    return stmt.run(id);
  }

  // Tag operations
  createTag(id, name) {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)');
    return stmt.run(id, name);
  }

  getTag(name) {
    const stmt = this.db.prepare('SELECT * FROM tags WHERE name = ?');
    return stmt.get(name);
  }

  getAllTags() {
    const stmt = this.db.prepare('SELECT * FROM tags ORDER BY name');
    return stmt.all();
  }

  // API-Tag relationship
  addTagToApi(apiId, tagId) {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO api_tags (api_id, tag_id) VALUES (?, ?)');
    return stmt.run(apiId, tagId);
  }

  getApiTags(apiId) {
    const stmt = this.db.prepare(`
      SELECT t.* FROM tags t
      JOIN api_tags at ON t.id = at.tag_id
      WHERE at.api_id = ?
    `);
    return stmt.all(apiId);
  }

  getApisByTag(tagName) {
    const stmt = this.db.prepare(`
      SELECT a.* FROM apis a
      JOIN api_tags at ON a.id = at.api_id
      JOIN tags t ON at.tag_id = t.id
      WHERE t.name = ?
    `);
    return stmt.all(tagName);
  }

  // Scrape run operations
  createScrapeRun(id) {
    const stmt = this.db.prepare(`
      INSERT INTO scrape_runs (id, started_at, status)
      VALUES (?, CURRENT_TIMESTAMP, 'running')
    `);
    return stmt.run(id);
  }

  updateScrapeRun(id, updates) {
    const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updates);
    
    const stmt = this.db.prepare(`
      UPDATE scrape_runs SET ${fields} WHERE id = ?
    `);
    return stmt.run(...values, id);
  }

  getLatestScrapeRun() {
    const stmt = this.db.prepare('SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT 1');
    return stmt.get();
  }

  // Stats
  getStats() {
    const totalApis = this.db.prepare('SELECT COUNT(*) as count FROM apis').get().count;
    const totalTags = this.db.prepare('SELECT COUNT(*) as count FROM tags').get().count;
    const latestRun = this.getLatestScrapeRun();

    return {
      totalApis,
      totalTags,
      latestScrapeRun: latestRun
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = CatalogDatabase;
