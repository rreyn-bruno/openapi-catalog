const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { slugCandidates } = require('../lib/slug');

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
        source TEXT DEFAULT 'github-scrape',
        source_url TEXT,
        last_synced_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add new columns to existing table if they don't exist
    try {
      this.db.exec(`ALTER TABLE apis ADD COLUMN source TEXT DEFAULT 'github-scrape'`);
    } catch (e) {
      // Column already exists, ignore
    }
    try {
      this.db.exec(`ALTER TABLE apis ADD COLUMN source_url TEXT`);
    } catch (e) {
      // Column already exists, ignore
    }
    try {
      this.db.exec(`ALTER TABLE apis ADD COLUMN last_synced_at DATETIME`);
    } catch (e) {
      // Column already exists, ignore
    }
    try {
      this.db.exec(`ALTER TABLE apis ADD COLUMN slug TEXT`);
    } catch (e) {
      // Column already exists, ignore
    }

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

    // Human-readable, stable URL slugs (used for /apis/:slug pages)
    this.backfillSlugs();
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_apis_slug ON apis(slug)`);
  }

  slugExists(slug) {
    const row = this.db.prepare('SELECT 1 FROM apis WHERE slug = ?').get(slug);
    return !!row;
  }

  /**
   * Pick the most readable slug for an API that is not already in use.
   * `taken` is an optional in-memory set used during bulk backfills.
   */
  uniqueSlugFor(api, taken = new Set()) {
    const candidates = slugCandidates(api);
    for (const candidate of candidates) {
      if (!taken.has(candidate) && !this.slugExists(candidate)) {
        return candidate;
      }
    }
    const last = candidates[candidates.length - 1];
    let n = 2;
    while (taken.has(`${last}-${n}`) || this.slugExists(`${last}-${n}`)) n++;
    return `${last}-${n}`;
  }

  backfillSlugs() {
    const rows = this.db.prepare(`
      SELECT id, name, version, github_url, source_url, openapi_url
      FROM apis
      WHERE slug IS NULL OR slug = ''
      ORDER BY stars DESC, created_at ASC
    `).all();
    if (rows.length === 0) return;

    const taken = new Set(
      this.db.prepare('SELECT slug FROM apis WHERE slug IS NOT NULL').all().map(r => r.slug)
    );
    const update = this.db.prepare('UPDATE apis SET slug = ? WHERE id = ?');
    const run = this.db.transaction(list => {
      for (const row of list) {
        const slug = this.uniqueSlugFor(row, taken);
        taken.add(slug);
        update.run(slug, row.id);
      }
    });
    run(rows);
    console.log(`✓ Assigned URL slugs to ${rows.length} API(s)`);
  }

  // API operations
  createApi(api) {
    const stmt = this.db.prepare(`
      INSERT INTO apis (id, name, description, version, github_url, openapi_url, collection_path, docs_path, stars, source, source_url, last_synced_at, slug)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const slug = api.slug || this.uniqueSlugFor(api);
    return stmt.run(
      api.id,
      api.name,
      api.description,
      api.version,
      api.github_url,
      api.openapi_url,
      api.collection_path,
      api.docs_path,
      api.stars || 0,
      api.source || 'github-scrape',
      api.source_url || null,
      api.last_synced_at || new Date().toISOString(),
      slug
    );
  }

  getApi(id) {
    const stmt = this.db.prepare('SELECT * FROM apis WHERE id = ?');
    return stmt.get(id);
  }

  getApiByUrl(url) {
    const stmt = this.db.prepare('SELECT * FROM apis WHERE openapi_url = ? OR github_url = ?');
    return stmt.get(url, url);
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

  getOrCreateTag(name) {
    // Try to get existing tag
    let tag = this.getTag(name);

    // If it doesn't exist, create it
    if (!tag) {
      const { v4: uuidv4 } = require('uuid');
      const id = uuidv4();
      this.createTag(id, name);
      tag = { id, name };
    }

    return tag;
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

  // Page-rendering helpers
  getApiBySlug(slug) {
    const stmt = this.db.prepare('SELECT * FROM apis WHERE slug = ?');
    return stmt.get(slug);
  }

  countApisByName(name) {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM apis WHERE name = ?');
    return stmt.get(name).count;
  }

  getTopApis(limit = 100) {
    const stmt = this.db.prepare('SELECT * FROM apis ORDER BY stars DESC, name ASC LIMIT ?');
    return stmt.all(limit);
  }

  getTagsWithCounts() {
    const stmt = this.db.prepare(`
      SELECT t.id, t.name, COUNT(at.api_id) as count
      FROM tags t
      LEFT JOIN api_tags at ON at.tag_id = t.id
      GROUP BY t.id
      ORDER BY count DESC, t.name ASC
    `);
    return stmt.all();
  }

  getApisByTagIds(tagIds) {
    if (!tagIds || tagIds.length === 0) return [];
    const placeholders = tagIds.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT DISTINCT a.* FROM apis a
      JOIN api_tags at ON a.id = at.api_id
      WHERE at.tag_id IN (${placeholders})
      ORDER BY a.stars DESC, a.name ASC
    `);
    return stmt.all(...tagIds);
  }

  getRelatedApis(apiId, limit = 6) {
    const stmt = this.db.prepare(`
      SELECT a.*, COUNT(*) as shared_tags FROM apis a
      JOIN api_tags at ON a.id = at.api_id
      WHERE at.tag_id IN (SELECT tag_id FROM api_tags WHERE api_id = ?)
        AND a.id != ?
      GROUP BY a.id
      ORDER BY shared_tags DESC, a.stars DESC
      LIMIT ?
    `);
    return stmt.all(apiId, apiId, limit);
  }

  /**
   * Tags for many APIs in one query. Returns a Map of apiId -> [{id, name}].
   */
  getTagsForApis(apiIds) {
    const map = new Map();
    const ids = [...new Set(apiIds)];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT at.api_id, t.id, t.name FROM api_tags at
        JOIN tags t ON t.id = at.tag_id
        WHERE at.api_id IN (${placeholders})
      `).all(...chunk);
      for (const row of rows) {
        if (!map.has(row.api_id)) map.set(row.api_id, []);
        map.get(row.api_id).push({ id: row.id, name: row.name });
      }
    }
    return map;
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
