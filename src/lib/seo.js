/**
 * Server-side rendering helpers for SEO / AEO.
 *
 * Everything here produces plain strings. The Express server decides which
 * database rows to pass in; this module only knows how to turn them into
 * HTML, JSON-LD, sitemaps and llms.txt.
 */

const fs = require('fs');
const path = require('path');
const { slugify, ownerFromApi } = require('./slug');

const SITE_URL = (process.env.SITE_URL || 'https://openapicatalog.com').replace(/\/$/, '');
const SITE_NAME = 'OpenAPI Catalog';
const OG_IMAGE = `${SITE_URL}/og-image.png`;
const HOME_DESCRIPTION =
  'The largest catalog of public OpenAPI specifications. Browse thousands of REST APIs with interactive docs and ready-to-import Bruno collections. Free and open source.';

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

/** Strip markdown/HTML noise from spec descriptions so they read as prose. */
function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value, max) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\-\s]+$/, '') + '…';
}

function formatStars(count) {
  const n = Number(count) || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/** SQLite "YYYY-MM-DD HH:MM:SS" or ISO string -> ISO 8601 with timezone. */
function toIsoDate(value) {
  if (!value) return null;
  const str = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str) ? str.replace(' ', 'T') + 'Z' : str;
  const date = new Date(normalized);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function toDateOnly(value) {
  const iso = toIsoDate(value);
  return iso ? iso.slice(0, 10) : null;
}

function jsonLd(obj) {
  // "<" must not appear raw inside a script tag
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
}

// ---------------------------------------------------------------------------
// Categories (tags merged into display categories)
// ---------------------------------------------------------------------------

/** Raw tag name (lower-cased) -> display name. Keep in sync with public/index.html. */
const TAG_DISPLAY = {
  'cloud': 'Cloud & Infrastructure',
  'cloud & infrastructure': 'Cloud & Infrastructure',
  'backend': 'Backend & Infrastructure',
  'developer_tools': 'Developer Tools',
  'developer tools': 'Developer Tools',
  'tools': 'Developer Tools',
  'customer_relation': 'Customer Relations',
  'ecommerce': 'E-commerce',
  'e-commerce': 'E-commerce',
  'machine_learning': 'AI & ML',
  'ai & ml': 'AI & ML',
  'open_data': 'Open Data',
  'payment': 'Payments',
  'payments': 'Payments',
  'financial': 'Finance',
  'finance': 'Finance',
  'project_management': 'Project Management',
  'time_management': 'Time Management',
  'social': 'Social Media',
  'social media': 'Social Media',
  'storage': 'Storage & Data',
  'database': 'Database',
  'telecom': 'Telecommunications',
  'transport': 'Transportation',
  'iot': 'IoT',
  'security': 'Security',
  'analytics': 'Analytics',
  'monitoring': 'Analytics',
  'media': 'Media',
  'education': 'Education',
  'email': 'Email',
  'messaging': 'Messaging',
  'communication': 'Communication',
  'healthcare': 'Healthcare',
  'gaming': 'Gaming',
  'authentication': 'Authentication',
  'documentation': 'Documentation',
  'general': 'General'
};

function displayTagName(raw) {
  const name = String(raw || '').trim();
  if (!name) return '';
  const mapped = TAG_DISPLAY[name.toLowerCase()];
  if (mapped) return mapped;
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');
}

function categorySlug(displayName) {
  return slugify(displayName);
}

/**
 * Merge raw DB tags into display categories.
 * @param {Array<{id, name, count}>} tagsWithCounts
 * @returns {Array<{slug, name, count, tagIds: string[], tagNames: string[]}>}
 */
function buildCategories(tagsWithCounts) {
  const bySlug = new Map();
  for (const tag of tagsWithCounts || []) {
    const name = String(tag.name || '').trim();
    if (name.length < 2) continue; // junk single-letter tags
    const display = displayTagName(name);
    const slug = categorySlug(display);
    if (!slug) continue;
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { slug, name: display, count: 0, tagIds: [], tagNames: [] });
    }
    const cat = bySlug.get(slug);
    cat.count += Number(tag.count) || 0;
    cat.tagIds.push(tag.id);
    cat.tagNames.push(name);
  }
  return [...bySlug.values()]
    .filter(c => c.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function categoriesForApi(apiTags, categories) {
  const slugs = new Set((apiTags || []).map(t => categorySlug(displayTagName(t.name))));
  return categories.filter(c => slugs.has(c.slug));
}

function categoryUrl(cat) {
  return `${SITE_URL}/category/${cat.slug}`;
}

// ---------------------------------------------------------------------------
// OpenAPI spec facts (endpoint count, auth, base URL, ...)
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
const specCache = new Map();

function authLabel(scheme) {
  if (!scheme || typeof scheme !== 'object') return null;
  const type = String(scheme.type || '').toLowerCase();
  if (type === 'apikey') return 'API key';
  if (type === 'http') {
    const s = String(scheme.scheme || '').toLowerCase();
    if (s === 'bearer') return 'Bearer token';
    if (s === 'basic') return 'Basic auth';
    return s ? `HTTP ${s}` : 'HTTP auth';
  }
  if (type === 'oauth2') return 'OAuth 2.0';
  if (type === 'openidconnect') return 'OpenID Connect';
  if (type === 'basic') return 'Basic auth';
  return null;
}

/**
 * Read data/openapi/<id>.json and extract summary facts. Cached by file mtime.
 */
function specFacts(apiId, openapiDir) {
  const file = path.join(openapiDir, `${apiId}.json`);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return {};
  }
  const cached = specCache.get(apiId);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.facts;

  let facts = {};
  try {
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const info = spec.info || {};
    const paths = spec.paths && typeof spec.paths === 'object' ? spec.paths : {};

    let endpoints = 0;
    const methodCounts = {};
    for (const item of Object.values(paths)) {
      if (!item || typeof item !== 'object') continue;
      for (const method of HTTP_METHODS) {
        if (item[method]) {
          endpoints++;
          methodCounts[method.toUpperCase()] = (methodCounts[method.toUpperCase()] || 0) + 1;
        }
      }
    }

    let baseUrl = null;
    if (Array.isArray(spec.servers) && spec.servers[0] && spec.servers[0].url) {
      baseUrl = String(spec.servers[0].url);
    } else if (spec.host) {
      const scheme = Array.isArray(spec.schemes) && spec.schemes[0] ? spec.schemes[0] : 'https';
      baseUrl = `${scheme}://${spec.host}${spec.basePath || ''}`;
    }

    const schemes = (spec.components && spec.components.securitySchemes) || spec.securityDefinitions || {};
    const auth = [...new Set(Object.values(schemes).map(authLabel).filter(Boolean))];

    const specVersion = spec.openapi
      ? `OpenAPI ${spec.openapi}`
      : spec.swagger
        ? `Swagger ${spec.swagger}`
        : null;

    facts = {
      endpoints,
      pathCount: Object.keys(paths).length,
      methodCounts,
      baseUrl,
      auth,
      specVersion,
      license: info.license && info.license.name ? { name: info.license.name, url: info.license.url || null } : null,
      termsOfService: info.termsOfService || null,
      contactUrl: info.contact && (info.contact.url || null),
      providerName: info['x-providerName'] || null,
      infoDescription: cleanText(info.description || ''),
      infoTitle: info.title || null
    };
  } catch (e) {
    facts = {};
  }

  specCache.set(apiId, { mtimeMs: stat.mtimeMs, facts });
  return facts;
}

// ---------------------------------------------------------------------------
// Per-API metadata
// ---------------------------------------------------------------------------

function apiUrl(api) {
  return api.slug ? `${SITE_URL}/apis/${api.slug}` : `${SITE_URL}/docs/${api.id}/index.html`;
}

function apiPath(api) {
  return api.slug ? `/apis/${api.slug}` : `/docs/${api.id}/index.html`;
}

function apiOwner(api, facts) {
  return (facts && facts.providerName) || ownerFromApi(api) || null;
}

function sourceLink(api) {
  const url = api.github_url || api.source_url || api.openapi_url;
  if (!url) return null;
  let label = url;
  try {
    const u = new URL(url);
    label = u.hostname.replace(/^www\./, '') + (u.hostname.includes('github.com') ? u.pathname.replace(/\/$/, '') : '');
  } catch (e) {
    /* keep raw url */
  }
  return { url, label: label.length > 60 ? label.slice(0, 57) + '…' : label };
}

function pageTitle(api, { isDuplicate = false, owner = null } = {}) {
  const name = cleanText(api.name) || 'API';
  const suffix = isDuplicate && owner ? ` (${owner})` : '';
  return `${name}${suffix} – OpenAPI Spec, Docs & Bruno Collection`;
}

function metaDescription(api, { facts = {}, categories = [], owner = null } = {}) {
  const base = cleanText(api.description) || facts.infoDescription || '';
  const count = facts.endpoints ? `${facts.endpoints} endpoint${facts.endpoints === 1 ? '' : 's'}` : null;
  const spec = facts.specVersion || 'OpenAPI';

  if (base) {
    const tail = ` ${spec}${count ? ` · ${count}` : ''} · docs & Bruno collection.`;
    let lead = truncate(base, Math.max(80, 158 - tail.length));
    if (!/[.!?…]$/.test(lead)) lead += '.';
    return lead + tail;
  }

  const name = cleanText(api.name) || 'This API';
  const from = owner ? ` from ${owner}` : '';
  const cats = categories.length ? ` in ${categories.slice(0, 2).map(c => c.name).join(' and ')}` : '';
  const text = `${name} is a REST API${from}${count ? ` with ${count}` : ''}${cats}. ${spec} spec, interactive docs, and a free Bruno collection.`;
  return truncate(text, 160);
}

// ---------------------------------------------------------------------------
// API documentation page (wraps the bruno-doc-gen output)
// ---------------------------------------------------------------------------

const API_PAGE_CSS = `
<style>
  .oac-summary{padding:1.25rem 1.5rem 0.5rem;border-bottom:1px solid #e9ecef;background:#fff}
  .oac-breadcrumb{font-size:.85rem;color:#6c757d;margin-bottom:.5rem}
  .oac-breadcrumb a{color:#3b82f6;text-decoration:none}
  .oac-breadcrumb a:hover{text-decoration:underline}
  .oac-summary h1{font-size:1.6rem;font-weight:700;margin:0 0 .5rem;line-height:1.25}
  .oac-summary h1 small{font-size:.9rem;color:#6c757d;font-weight:400;margin-left:.5rem}
  .oac-desc{max-width:72ch;color:#343a40;margin-bottom:1rem}
  .oac-facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.5rem 1.5rem;margin:0 0 1rem;font-size:.9rem}
  .oac-facts dt{font-weight:600;color:#6c757d;font-size:.75rem;text-transform:uppercase;letter-spacing:.03em}
  .oac-facts dd{margin:0;word-break:break-word}
  .oac-facts code{font-size:.85em;background:#f8f9fa;padding:.1rem .3rem;border-radius:3px}
  .oac-facts a{color:#3b82f6}
  .oac-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem}
  .oac-actions .btn{display:inline-flex;align-items:center;gap:.35rem}
  .oac-howto{font-size:.9rem;color:#495057;margin-bottom:1rem}
  .oac-howto ol{margin:.25rem 0 0 1.1rem;padding:0}
  .oac-related h2{font-size:1rem;font-weight:600;margin:0 0 .4rem}
  .oac-related ul{list-style:none;padding:0;margin:0 0 .5rem;display:flex;flex-wrap:wrap;gap:.4rem}
  .oac-related li a{display:inline-block;padding:.25rem .6rem;border:1px solid #dee2e6;border-radius:999px;font-size:.85rem;color:#343a40;text-decoration:none;background:#f8f9fa}
  .oac-related li a:hover{border-color:#3b82f6;color:#3b82f6}
  @media (max-width:768px){.oac-summary{padding:1rem}}
</style>`;

/**
 * Inject SEO head tags, a breadcrumb, a summary block, and related links into
 * a generated bruno-doc-gen page.
 */
function renderApiPage({ html, api, tags = [], related = [], facts = {}, categories = [], isDuplicate = false }) {
  const owner = apiOwner(api, facts);
  const apiCats = categoriesForApi(tags, categories);
  const title = pageTitle(api, { isDuplicate, owner });
  const description = metaDescription(api, { facts, categories: apiCats, owner });
  const url = apiUrl(api);
  const name = cleanText(api.name) || 'API';
  const longDescription = truncate(cleanText(api.description) || facts.infoDescription || '', 600);
  const source = sourceLink(api);
  const updated = toDateOnly(api.updated_at || api.last_synced_at || api.created_at);
  const primaryCat = apiCats[0] || null;
  const specPath = `${apiPath(api)}/openapi.json`;
  const downloadPath = `/api/apis/${api.id}/download`;

  // ---- head -------------------------------------------------------------
  const graph = [
    {
      '@type': 'WebAPI',
      '@id': `${url}#api`,
      name,
      description: description,
      url,
      documentation: url,
      ...(api.version ? { version: String(api.version) } : {}),
      ...(owner ? { provider: { '@type': 'Organization', name: owner, ...(api.github_url ? { url: api.github_url.split('/').slice(0, 4).join('/') } : {}) } } : {}),
      ...(facts.termsOfService ? { termsOfService: facts.termsOfService } : {}),
      ...(facts.license && facts.license.url ? { license: facts.license.url } : {}),
      ...(apiCats.length ? { keywords: apiCats.map(c => c.name).join(', ') } : {}),
      ...(source ? { sameAs: source.url } : {})
    },
    {
      '@type': 'WebPage',
      '@id': url,
      url,
      name: title,
      description,
      isPartOf: { '@id': `${SITE_URL}/#website` },
      breadcrumb: { '@id': `${url}#breadcrumb` },
      mainEntity: { '@id': `${url}#api` },
      ...(toIsoDate(api.updated_at) ? { dateModified: toIsoDate(api.updated_at) } : {}),
      ...(toIsoDate(api.created_at) ? { datePublished: toIsoDate(api.created_at) } : {})
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${url}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
        ...(primaryCat ? [{ '@type': 'ListItem', position: 2, name: primaryCat.name, item: categoryUrl(primaryCat) }] : []),
        { '@type': 'ListItem', position: primaryCat ? 3 : 2, name, item: url }
      ]
    },
    {
      '@type': 'SoftwareSourceCode',
      name: `${name} Bruno collection`,
      description: `Bruno API client collection generated from the ${name} OpenAPI specification.`,
      url,
      ...(api.github_url ? { codeRepository: api.github_url } : {}),
      programmingLanguage: 'Bruno',
      isAccessibleForFree: true,
      downloadUrl: `${SITE_URL}${downloadPath}`
    }
  ];

  const head = `
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="${escapeAttr(url)}">
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="${SITE_NAME}">
    <meta property="og:url" content="${escapeAttr(url)}">
    <meta property="og:title" content="${escapeAttr(title)}">
    <meta property="og:description" content="${escapeAttr(description)}">
    <meta property="og:image" content="${OG_IMAGE}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${SITE_NAME}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeAttr(title)}">
    <meta name="twitter:description" content="${escapeAttr(description)}">
    <meta name="twitter:image" content="${OG_IMAGE}">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
    <link rel="preconnect" href="https://stackpath.bootstrapcdn.com" crossorigin>
    <link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin>
    <link rel="preconnect" href="https://use.fontawesome.com" crossorigin>
    ${jsonLd({ '@context': 'https://schema.org', '@graph': graph })}
    ${API_PAGE_CSS}`;

  // ---- body: breadcrumb + summary ----------------------------------------
  const factRows = [];
  if (facts.endpoints) {
    const methods = Object.entries(facts.methodCounts || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([m, c]) => `${c} ${m}`)
      .join(', ');
    factRows.push(['Endpoints', `${facts.endpoints}${methods ? ` <span style="color:#6c757d">(${escapeHtml(methods)})</span>` : ''}`]);
  }
  if (facts.baseUrl) factRows.push(['Base URL', `<code>${escapeHtml(facts.baseUrl)}</code>`]);
  factRows.push(['Authentication', facts.auth && facts.auth.length ? escapeHtml(facts.auth.join(', ')) : 'Not specified in spec']);
  if (facts.specVersion) factRows.push(['Spec format', escapeHtml(facts.specVersion)]);
  if (api.version) factRows.push(['API version', escapeHtml(api.version)]);
  if (source) {
    const stars = api.stars ? ` <span title="GitHub stars">★ ${formatStars(api.stars)}</span>` : '';
    factRows.push(['Source', `<a href="${escapeAttr(source.url)}" rel="noopener" target="_blank">${escapeHtml(source.label)}</a>${stars}`]);
  }
  if (owner) factRows.push(['Provider', escapeHtml(owner)]);
  if (facts.license) {
    factRows.push(['License', facts.license.url
      ? `<a href="${escapeAttr(facts.license.url)}" rel="noopener nofollow" target="_blank">${escapeHtml(facts.license.name)}</a>`
      : escapeHtml(facts.license.name)]);
  }
  if (apiCats.length) {
    factRows.push(['Categories', apiCats.map(c => `<a href="/category/${c.slug}">${escapeHtml(c.name)}</a>`).join(', ')]);
  }
  if (updated) factRows.push(['Last updated', `<time datetime="${updated}">${updated}</time>`]);

  const breadcrumb = `
    <nav class="oac-breadcrumb" aria-label="Breadcrumb">
      <a href="/">${SITE_NAME}</a> ›
      ${primaryCat ? `<a href="/category/${primaryCat.slug}">${escapeHtml(primaryCat.name)}</a> › ` : ''}
      <span>${escapeHtml(name)}</span>
    </nav>`;

  const relatedHtml = related.length
    ? `<div class="oac-related">
        <h2>Related APIs</h2>
        <ul>${related.map(r => `<li><a href="${escapeAttr(apiPath(r))}">${escapeHtml(cleanText(r.name))}</a></li>`).join('')}</ul>
      </div>`
    : '';

  const summary = `
  <section class="oac-summary" id="overview">
    ${breadcrumb}
    <h1>${escapeHtml(name)}${api.version ? `<small>v${escapeHtml(api.version)}</small>` : ''}</h1>
    ${longDescription ? `<p class="oac-desc">${escapeHtml(longDescription)}</p>` : ''}
    <dl class="oac-facts">
      ${factRows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
    </dl>
    <div class="oac-actions">
      <a class="btn btn-primary btn-sm" href="${downloadPath}">Download Bruno collection (.zip)</a>
      <a class="btn btn-outline-secondary btn-sm" href="${escapeAttr(specPath)}">OpenAPI spec (JSON)</a>
      ${source ? `<a class="btn btn-outline-secondary btn-sm" href="${escapeAttr(source.url)}" rel="noopener" target="_blank">Source</a>` : ''}
      <a class="btn btn-outline-secondary btn-sm" href="#doc-body">Jump to endpoints</a>
    </div>
    <div class="oac-howto">
      <strong>Use this API in Bruno:</strong>
      <ol>
        <li>Download the Bruno collection above and unzip it.</li>
        <li>In Bruno, choose <em>Open Collection</em> and select the unzipped folder.</li>
        <li>Set the <code>baseUrl</code> variable${facts.baseUrl ? ` (for example <code>${escapeHtml(facts.baseUrl)}</code>)` : ''}${facts.auth && facts.auth.length ? ` and your ${escapeHtml(facts.auth[0])} credentials` : ''}, then send requests.</li>
      </ol>
    </div>
    ${relatedHtml}
  </section>`;

  // ---- apply ---------------------------------------------------------------
  let out = html;

  // Title
  out = out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>${head}`);
  if (!/<title>/i.test(html)) {
    out = out.replace(/<head>/i, `<head><title>${escapeHtml(title)}</title>${head}`);
  }

  // Absolute asset paths so the page works at /apis/:slug
  const assetBase = `/docs/${api.id}/assets/`;
  out = out.replace(/(href|src)="assets\//g, `$1="${assetBase}`);

  // Summary block
  const marker = '<div class="row p-lg-4">';
  if (out.includes(marker)) {
    out = out.replace(marker, `${summary}\n${marker}`);
  } else if (out.includes('<div class="container-fluid">')) {
    out = out.replace('<div class="container-fluid">', `<div class="container-fluid">${summary}`);
  } else {
    out = out.replace(/<body[^>]*>/i, m => `${m}${summary}`);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Shared page layout for server-rendered pages (categories, 404)
// ---------------------------------------------------------------------------

const LAYOUT_CSS = `
:root{--primary:#3b82f6;--bg:#fff;--bg2:#f7fafc;--text:#1a202c;--muted:#718096;--border:#e2e8f0}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text);background:var(--bg);line-height:1.55}
a{color:var(--primary)}
.container{max-width:1200px;margin:0 auto;padding:0 16px}
header.site{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:2.5rem 0}
header.site a{color:#fff;text-decoration:none}
header.site .brand{font-weight:700;font-size:1rem;opacity:.9;display:inline-block;margin-bottom:.75rem}
header.site h1{margin:0 0 .5rem;font-size:2.25rem;line-height:1.2}
header.site p{margin:0;max-width:70ch;opacity:.92}
nav.crumbs{font-size:.875rem;color:var(--muted);margin:1rem 0}
main{padding:1rem 0 3rem}
.api-table{width:100%;border-collapse:collapse;margin-top:1rem;background:#fff;border:1px solid var(--border);border-radius:10px;overflow:hidden}
.api-table th{text-align:left;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:var(--bg2);padding:.75rem 1rem;border-bottom:1px solid var(--border)}
.api-table td{padding:.9rem 1rem;border-bottom:1px solid var(--border);vertical-align:top}
.api-table tr:last-child td{border-bottom:0}
.api-name{font-weight:600}
.api-name a{color:var(--text);text-decoration:none}
.api-name a:hover{color:var(--primary)}
.api-description{color:var(--muted);font-size:.875rem;margin-top:.2rem;max-width:70ch}
.tag{display:inline-block;background:var(--bg2);border:1px solid var(--border);border-radius:999px;padding:.1rem .6rem;font-size:.75rem;margin:.1rem .25rem .1rem 0;color:var(--text)}
.btn{display:inline-block;padding:.35rem .7rem;border-radius:6px;font-size:.8rem;text-decoration:none;border:1px solid var(--border);color:var(--text);white-space:nowrap}
.btn-primary{background:var(--primary);border-color:var(--primary);color:#fff}
.cat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.75rem;margin:1.5rem 0}
.cat-grid a{display:flex;justify-content:space-between;align-items:center;padding:.8rem 1rem;border:1px solid var(--border);border-radius:10px;text-decoration:none;color:var(--text);background:#fff}
.cat-grid a:hover{border-color:var(--primary)}
.cat-grid span.count{color:var(--muted);font-size:.85rem}
.muted{color:var(--muted)}
footer.site{border-top:1px solid var(--border);padding:2rem 0;color:var(--muted);font-size:.875rem}
footer.site nav a{margin-right:.9rem;white-space:nowrap}
@media (max-width:768px){header.site h1{font-size:1.6rem}.api-table td.hide-sm,.api-table th.hide-sm{display:none}}
`;

function layout({ title, description, canonical, heading, lede, crumbs = [], body, structuredData = [], categories = [], noindex = false }) {
  const crumbHtml = crumbs.length
    ? `<nav class="crumbs" aria-label="Breadcrumb">${crumbs.map((c, i) => (i < crumbs.length - 1 ? `<a href="${escapeAttr(c.href)}">${escapeHtml(c.name)}</a> › ` : `<span>${escapeHtml(c.name)}</span>`)).join('')}</nav>`
    : '';
  const footerNav = categories.length
    ? `<nav aria-label="Categories"><strong>Browse by category:</strong> ${categories.map(c => `<a href="/category/${c.slug}">${escapeHtml(c.name)}</a>`).join(' ')}</nav>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttr(description)}">
  <link rel="canonical" href="${escapeAttr(canonical)}">
  <meta name="robots" content="${noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large, max-snippet:-1'}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:url" content="${escapeAttr(canonical)}">
  <meta property="og:title" content="${escapeAttr(title)}">
  <meta property="og:description" content="${escapeAttr(description)}">
  <meta property="og:image" content="${OG_IMAGE}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeAttr(title)}">
  <meta name="twitter:description" content="${escapeAttr(description)}">
  <meta name="twitter:image" content="${OG_IMAGE}">
  <meta name="theme-color" content="#3b82f6">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  ${structuredData.map(jsonLd).join('\n  ')}
  <style>${LAYOUT_CSS}</style>
</head>
<body>
  <header class="site">
    <div class="container">
      <a class="brand" href="/">← ${SITE_NAME}</a>
      <h1>${escapeHtml(heading)}</h1>
      ${lede ? `<p>${lede}</p>` : ''}
    </div>
  </header>
  <main>
    <div class="container">
      ${crumbHtml}
      ${body}
    </div>
  </main>
  <footer class="site">
    <div class="container">
      ${footerNav}
      <p style="margin-top:1rem">Built for the <a href="https://www.usebruno.com/" rel="noopener">Bruno</a> API client community · <a href="/about">About</a> · <a href="/categories">All categories</a> · <a href="/llms.txt">llms.txt</a></p>
    </div>
  </footer>
</body>
</html>`;
}

/** Table rows shared by the homepage and category pages. */
function renderApiRows(apis, tagMap, { showTags = true } = {}) {
  return apis.map(api => {
    const tags = (tagMap && tagMap.get(api.id)) || [];
    const seen = new Set();
    const tagHtml = tags
      .map(t => displayTagName(t.name))
      .filter(n => n && !seen.has(n) && seen.add(n))
      .slice(0, 3)
      .map(n => `<a class="tag" href="/category/${categorySlug(n)}">${escapeHtml(n)}</a>`)
      .join('') || '<span class="tag">Uncategorized</span>';
    const source = sourceLink(api);
    const desc = truncate(api.description || '', 140) || 'No description available';
    return `
      <tr>
        <td>
          <div class="api-name"><a href="${escapeAttr(apiPath(api))}">${escapeHtml(cleanText(api.name) || 'Unnamed API')}</a></div>
          <div class="api-description">${escapeHtml(desc)}</div>
        </td>
        ${showTags ? `<td><div class="api-tags">${tagHtml}</div></td>` : ''}
        <td class="hide-sm"><span class="muted" style="font-size:.875rem">v${escapeHtml(api.version || '1.0.0')}</span>${api.stars ? `<div class="muted" style="font-size:.8rem">★ ${formatStars(api.stars)}</div>` : ''}</td>
        <td>
          <div class="api-actions">
            <a href="/api/apis/${api.id}/download" class="btn btn-primary" download>Bruno</a>
            <a href="${escapeAttr(apiPath(api))}" class="btn btn-secondary">Docs</a>
            ${source ? `<a href="${escapeAttr(source.url)}" class="btn btn-secondary" target="_blank" rel="noopener">${source.url.includes('github.com') ? 'GitHub' : 'Source'}</a>` : ''}
          </div>
        </td>
      </tr>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Homepage (fills server-side markers in public/index.html)
// ---------------------------------------------------------------------------

function renderHome({ indexHtml, totalApis, categories, topApis, tagMap }) {
  let out = indexHtml;

  out = out.replace(/id="totalApis">[^<]*</, `id="totalApis">${formatNumber(totalApis)}<`);
  out = out.replace(/id="totalTags">[^<]*</, `id="totalTags">${categories.length}<`);
  out = out.replace(/<span data-ssr="count">[^<]*<\/span>/g, `<span data-ssr="count">${formatNumber(totalApis)}</span>`);

  // Category dropdown
  out = out.replace(/(<select id="categoryFilter">)[\s\S]*?(<\/select>)/, (m, open, close) => {
    const options = ['<option value="">All Categories</option>']
      .concat(categories.map(c => `<option value="${escapeAttr(c.name)}">${escapeHtml(c.name)} (${c.count})</option>`));
    return `${open}\n            ${options.join('\n            ')}\n          ${close}`;
  });

  // Filter chips (crawlable links to category pages)
  out = out.replace(/(<div class="filter-tags" id="filterTags">)[\s\S]*?(<\/div>)/, (m, open, close) => {
    const chips = categories.slice(0, 12).map(c =>
      `<a class="filter-tag" href="/category/${c.slug}" data-category="${escapeAttr(c.name)}" onclick="toggleFilter(this.dataset.category); return false;">${escapeHtml(c.name)} (${c.count})</a>`
    );
    return `${open}\n        ${chips.join('\n        ')}\n      ${close}`;
  });

  // Pre-rendered table of the most popular APIs
  const table = `
      <div class="api-table-container">
        <table class="api-table">
          <thead>
            <tr>
              <th>API</th>
              <th>Tags</th>
              <th>Version</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${renderApiRows(topApis, tagMap)}
          </tbody>
        </table>
      </div>
      <p class="muted" style="text-align:center;margin:1rem 0;font-size:.875rem">Showing the ${topApis.length} most-starred APIs. <a href="/categories">Browse all ${formatNumber(totalApis)} APIs by category</a>.</p>`;
  out = out.replace('<!--SSR:CONTENT-->', table);

  // Footer category navigation
  out = out.replace('<!--SSR:CATEGORIES-->',
    `<nav class="footer-categories" aria-label="Browse by category">
        ${categories.map(c => `<a href="/category/${c.slug}">${escapeHtml(c.name)}</a>`).join('\n        ')}
      </nav>`);

  // Structured data
  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${SITE_URL}/#popular`,
    name: 'Most popular OpenAPI specifications',
    description: `The ${topApis.length} most-starred public APIs in the ${SITE_NAME}, out of ${formatNumber(totalApis)} total.`,
    numberOfItems: topApis.length,
    itemListOrder: 'https://schema.org/ItemListOrderDescending',
    itemListElement: topApis.slice(0, 50).map((api, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: cleanText(api.name),
      url: apiUrl(api)
    }))
  };
  const collection = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': `${SITE_URL}/`,
    url: `${SITE_URL}/`,
    name: SITE_NAME,
    description: HOME_DESCRIPTION,
    isPartOf: { '@id': `${SITE_URL}/#website` },
    hasPart: categories.slice(0, 30).map(c => ({ '@type': 'CollectionPage', name: `${c.name} APIs`, url: categoryUrl(c) }))
  };
  out = out.replace(/<!--SSR:ITEMLIST-->[\s\S]*?<!--\/SSR:ITEMLIST-->/, `${jsonLd(itemList)}\n  ${jsonLd(collection)}`);

  return out;
}

// ---------------------------------------------------------------------------
// About page
// ---------------------------------------------------------------------------

function renderAbout({ aboutHtml, totalApis, categories }) {
  let out = aboutHtml;
  out = out.replace(/id="totalApis">[^<]*</, `id="totalApis">${formatNumber(totalApis)}<`);
  out = out.replace(/<span data-ssr="count">[^<]*<\/span>/g, `<span data-ssr="count">${formatNumber(totalApis)}</span>`);
  out = out.replace(/<span data-ssr="categories">[^<]*<\/span>/g, `<span data-ssr="categories">${categories.length}</span>`);
  return out;
}

// ---------------------------------------------------------------------------
// Category pages
// ---------------------------------------------------------------------------

function renderCategoryPage({ category, apis, tagMap, categories, totalApis }) {
  const url = categoryUrl(category);
  const count = apis.length;
  const title = `${category.name} APIs – ${count} OpenAPI Specs & Bruno Collections`;
  const description = truncate(
    `Browse ${count} public ${category.name} APIs with OpenAPI specifications, interactive documentation, and ready-to-import Bruno collections. ${apis.slice(0, 3).map(a => cleanText(a.name)).filter(Boolean).join(', ')}${count > 3 ? ' and more' : ''}.`,
    160
  );
  const others = categories.filter(c => c.slug !== category.slug);

  const structuredData = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      '@id': url,
      url,
      name: title,
      description,
      isPartOf: { '@id': `${SITE_URL}/#website` },
      breadcrumb: { '@id': `${url}#breadcrumb` },
      mainEntity: {
        '@type': 'ItemList',
        name: `${category.name} APIs`,
        numberOfItems: count,
        itemListElement: apis.slice(0, 200).map((api, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: cleanText(api.name),
          url: apiUrl(api)
        }))
      }
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      '@id': `${url}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: 'Categories', item: `${SITE_URL}/categories` },
        { '@type': 'ListItem', position: 3, name: category.name, item: url }
      ]
    }
  ];

  const body = `
    <p>These ${count} APIs are tagged <strong>${escapeHtml(category.name)}</strong> in the ${SITE_NAME}, which indexes ${formatNumber(totalApis)} public OpenAPI specifications in total. Each entry links to interactive documentation generated from the spec, the original source, and a downloadable <a href="https://www.usebruno.com/" rel="noopener">Bruno</a> collection you can open locally. APIs are ordered by GitHub stars.</p>
    <table class="api-table">
      <thead><tr><th>API</th><th>Tags</th><th class="hide-sm">Version</th><th>Actions</th></tr></thead>
      <tbody>${renderApiRows(apis, tagMap)}</tbody>
    </table>
    <h2 style="margin-top:2.5rem">Other categories</h2>
    <div class="cat-grid">
      ${others.map(c => `<a href="/category/${c.slug}"><span>${escapeHtml(c.name)}</span><span class="count">${c.count}</span></a>`).join('')}
    </div>`;

  return layout({
    title,
    description,
    canonical: url,
    heading: `${category.name} APIs`,
    lede: `${count} public ${escapeHtml(category.name)} APIs with OpenAPI specs, docs, and Bruno collections.`,
    crumbs: [{ name: SITE_NAME, href: '/' }, { name: 'Categories', href: '/categories' }, { name: category.name, href: `/category/${category.slug}` }],
    body,
    structuredData,
    categories
  });
}

function renderCategoriesIndex({ categories, totalApis }) {
  const url = `${SITE_URL}/categories`;
  const title = `API Categories – Browse ${formatNumber(totalApis)} OpenAPI Specs by Topic`;
  const description = truncate(
    `Browse ${formatNumber(totalApis)} public OpenAPI specifications across ${categories.length} categories including ${categories.slice(0, 5).map(c => c.name).join(', ')}. Every API includes docs and a Bruno collection.`,
    160
  );
  const structuredData = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      '@id': url,
      url,
      name: title,
      description,
      isPartOf: { '@id': `${SITE_URL}/#website` },
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: categories.length,
        itemListElement: categories.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: `${c.name} APIs`, url: categoryUrl(c) }))
      }
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: 'Categories', item: url }
      ]
    }
  ];
  const body = `
    <p>Every API in the catalog is tagged with one or more categories. Pick a category to see its APIs ranked by popularity, each with an OpenAPI spec, generated documentation, and a Bruno collection.</p>
    <div class="cat-grid">
      ${categories.map(c => `<a href="/category/${c.slug}"><span>${escapeHtml(c.name)}</span><span class="count">${c.count} APIs</span></a>`).join('')}
    </div>`;
  return layout({
    title,
    description,
    canonical: url,
    heading: 'Browse APIs by category',
    lede: `${categories.length} categories · ${formatNumber(totalApis)} OpenAPI specifications`,
    crumbs: [{ name: SITE_NAME, href: '/' }, { name: 'Categories', href: '/categories' }],
    body,
    structuredData,
    categories: []
  });
}

function renderNotFound({ categories = [] } = {}) {
  return layout({
    title: `Page not found – ${SITE_NAME}`,
    description: 'The page you requested could not be found.',
    canonical: `${SITE_URL}/404`,
    heading: 'Page not found',
    lede: 'That API or page does not exist, or it may have moved.',
    body: `<p><a href="/">Back to the catalog</a> or <a href="/categories">browse by category</a>.</p>`,
    categories,
    noindex: true
  });
}

// ---------------------------------------------------------------------------
// Sitemap, robots-adjacent files
// ---------------------------------------------------------------------------

function renderSitemap({ apis, categories, lastBuild }) {
  const now = (lastBuild || new Date()).toISOString();
  const entries = [];
  const add = (loc, lastmod, changefreq, priority) => {
    entries.push(`  <url>\n    <loc>${escapeHtml(loc)}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ''}    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`);
  };

  add(`${SITE_URL}/`, now, 'daily', '1.0');
  add(`${SITE_URL}/categories`, now, 'weekly', '0.8');
  add(`${SITE_URL}/about`, null, 'monthly', '0.5');
  for (const cat of categories) add(categoryUrl(cat), now, 'weekly', '0.8');
  for (const api of apis) {
    add(apiUrl(api), toIsoDate(api.updated_at || api.created_at), 'monthly', api.stars > 100 ? '0.7' : '0.6');
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>`;
}

function llmsLine(api, { withOwner = false } = {}) {
  const desc = truncate(api.description || '', 140);
  const owner = withOwner ? ownerFromApi(api) : null;
  return `- [${cleanText(api.name)}](${apiUrl(api)})${owner ? ` (${owner})` : ''}${desc ? `: ${desc}` : ''}`;
}

function renderLlmsTxt({ totalApis, categories, topApis }) {
  return `# ${SITE_NAME}

> ${SITE_NAME} (${SITE_URL}) is a free, open-source catalog of ${formatNumber(totalApis)} public OpenAPI/Swagger specifications collected from GitHub and APIs.guru. Every API has a page with a plain-language summary, endpoint count, base URL, authentication type, interactive documentation generated from the spec, a link to the original source, the raw OpenAPI JSON, and a downloadable Bruno collection that can be opened in the Bruno API client.

## How to use this site

- Each API page lives at ${SITE_URL}/apis/<slug> and includes the full endpoint reference with code examples in many languages.
- The raw OpenAPI document for an API is available at ${SITE_URL}/apis/<slug>/openapi.json.
- A Bruno collection (ZIP) for an API is available from the download link on its page.
- Category pages list every API on a topic: ${SITE_URL}/category/<category-slug>.
- The complete index with one line per API is at ${SITE_URL}/llms-full.txt.

## Categories

${categories.map(c => `- [${c.name}](${categoryUrl(c)}): ${c.count} APIs`).join('\n')}

## Most popular APIs

${topApis.map(api => llmsLine(api)).join('\n')}

## Other resources

- [About the catalog](${SITE_URL}/about): data sources, how specs are converted, and FAQ
- [All categories](${SITE_URL}/categories)
- [Sitemap](${SITE_URL}/sitemap.xml)
- [Bruno API client](https://www.usebruno.com/): the open-source API client these collections are built for
`;
}

function renderLlmsFullTxt({ totalApis, categories, apisByCategory, uncategorized = [] }) {
  const sections = categories.map(c => {
    const list = apisByCategory.get(c.slug) || [];
    return `## ${c.name} (${list.length})\n\n${list.map(api => llmsLine(api, { withOwner: true })).join('\n')}`;
  });
  if (uncategorized.length) {
    sections.push(`## Uncategorized (${uncategorized.length})\n\n${uncategorized.map(api => llmsLine(api, { withOwner: true })).join('\n')}`);
  }
  return `# ${SITE_NAME} – full index

> ${formatNumber(totalApis)} public OpenAPI specifications, grouped by category. Each line links to the API's documentation page on ${SITE_URL}. Append /openapi.json to any API URL for the raw specification. See ${SITE_URL}/llms.txt for a shorter overview.

${sections.join('\n\n')}
`;
}

module.exports = {
  SITE_URL,
  SITE_NAME,
  HOME_DESCRIPTION,
  escapeHtml,
  cleanText,
  truncate,
  toIsoDate,
  displayTagName,
  categorySlug,
  buildCategories,
  categoriesForApi,
  specFacts,
  pageTitle,
  metaDescription,
  apiUrl,
  apiPath,
  renderApiPage,
  renderHome,
  renderAbout,
  renderCategoryPage,
  renderCategoriesIndex,
  renderNotFound,
  renderSitemap,
  renderLlmsTxt,
  renderLlmsFullTxt
};
