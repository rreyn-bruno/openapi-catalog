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

/** Display category names for an API from its raw tags (de-duplicated, in tag order). */
function displayCategoriesForTags(tags) {
  const seen = new Set();
  return (tags || [])
    .map(t => displayTagName(typeof t === 'string' ? t : t.name))
    .filter(n => n && !seen.has(n) && seen.add(n));
}

// ---------------------------------------------------------------------------
// OpenAPI spec facts (endpoint count, auth, base URL, operations, ...)
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE'];
const specCache = new Map();

function methodClass(method) {
  const m = String(method || '').toLowerCase();
  return ['get', 'post', 'put', 'patch', 'delete'].includes(m) ? m : 'other';
}

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

/** "payment_intents" -> "Payment intents"; "Customers" stays as is. */
function groupTitle(raw) {
  const text = String(raw || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return 'Other';
  return text.charAt(0).toUpperCase() + text.slice(1);
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
    const operations = [];
    for (const [p, item] of Object.entries(paths)) {
      if (!item || typeof item !== 'object') continue;
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op || typeof op !== 'object') continue;
        endpoints++;
        const M = method.toUpperCase();
        methodCounts[M] = (methodCounts[M] || 0) + 1;
        const tag = Array.isArray(op.tags) && op.tags[0] ? String(op.tags[0]) : null;
        const summary = truncate(op.summary || '', 140) || (op.operationId ? String(op.operationId) : '');
        operations.push({ method: M, path: String(p), summary, tag });
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
      operations,
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

/** Group operations by first tag, falling back to the first path segment. */
function endpointGroups(operations) {
  const groups = new Map();
  for (const op of operations || []) {
    let key = op.tag;
    if (!key) {
      const seg = op.path.split('/').filter(Boolean)[0] || '';
      key = seg && !/^\{.*\}$/.test(seg) ? seg : 'Other';
    }
    const name = groupTitle(key);
    if (!groups.has(name)) groups.set(name, { name, ops: [] });
    groups.get(name).ops.push(op);
  }
  return [...groups.values()];
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
  return api.provider || (facts && facts.providerName) || ownerFromApi(api) || null;
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
// Shared page chrome (head, header, footer)
// ---------------------------------------------------------------------------

const THEME_SCRIPT = `<script>(function(){var t=null;try{t=localStorage.getItem('theme')}catch(e){}if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.setAttribute('data-theme',t)})();</script>`;

const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">`;

function htmlHead({ title, description, canonical, noindex = false, structuredData = [], extra = '' }) {
  return `<meta charset="UTF-8">
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
  <meta property="og:image:alt" content="${SITE_NAME}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeAttr(title)}">
  <meta name="twitter:description" content="${escapeAttr(description)}">
  <meta name="twitter:image" content="${OG_IMAGE}">
  <meta name="theme-color" content="#0b0c0e">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  ${structuredData.map(jsonLd).join('\n  ')}
  ${THEME_SCRIPT}
  ${FONT_LINKS}
  <link rel="stylesheet" href="/site.css">
  ${extra}`;
}

function siteHeader() {
  return `<header class="site-header">
    <div class="wrap">
      <a class="wordmark" href="/">${SITE_NAME}</a>
      <nav class="site-nav" aria-label="Primary">
        <a href="/">APIs</a>
        <a href="/categories">Categories</a>
        <a href="/about">About</a>
      </nav>
      <div class="spacer"></div>
      <a class="site-llms" href="/llms.txt">llms.txt</a>
      <button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch theme">Light</button>
    </div>
  </header>`;
}

function footerCategoriesNav(categories) {
  if (!categories || !categories.length) return '';
  return `<nav class="footer-categories" aria-label="Browse by category">
      ${categories.map(c => `<a href="/category/${c.slug}">${escapeHtml(c.name)}</a>`).join('\n      ')}
    </nav>`;
}

function siteFooter(categories = []) {
  return `<footer class="site-footer">
    <div class="wrap">
      <span>Specs from GitHub and APIs.guru. Built for the <a class="bruno" href="https://www.usebruno.com/" rel="noopener">Bruno</a> API client community.</span>
      <span class="footer-links"><a href="/about">About</a><a href="/categories">Categories</a><a href="/llms.txt">llms.txt</a><a href="/llms-full.txt">llms-full.txt</a></span>
    </div>
    ${footerCategoriesNav(categories)}
  </footer>`;
}

// ---------------------------------------------------------------------------
// API rows (homepage SSR + category pages)
// ---------------------------------------------------------------------------

function apiRowHtml(api, tags) {
  const docs = apiPath(api);
  const source = sourceLink(api);
  const cats = displayCategoriesForTags(tags);
  const provider = apiOwner(api) || '';
  const endpoints = api.endpoint_count == null ? '' : `${formatNumber(api.endpoint_count)} endpoint${Number(api.endpoint_count) === 1 ? '' : 's'}`;
  const desc = truncate(api.description || '', 160) || 'No description available';
  return `
      <li class="api-row" data-href="${escapeAttr(docs)}">
        <div class="api-row-main">
          <div>
            <div class="api-row-name"><a href="${escapeAttr(docs)}">${escapeHtml(cleanText(api.name) || 'Unnamed API')}</a></div>
            <div class="api-row-provider">${escapeHtml(provider)}</div>
          </div>
          <div>
            <div class="api-row-desc">${escapeHtml(desc)}</div>
            <div class="api-row-cat">${escapeHtml(cats[0] || 'Uncategorized')}</div>
          </div>
        </div>
        <div class="api-row-meta">
          <span class="api-row-endpoints">${endpoints}</span>
          <span class="api-row-version" title="${escapeAttr(api.version || '')}">${escapeHtml(api.version || '')}</span>
          <span class="api-row-actions">
            <a class="btn btn-amber" href="/api/apis/${escapeAttr(api.id)}/download" download>Collection</a>
            <a class="btn btn-outline" href="${escapeAttr(docs)}">Docs</a>
            ${source ? `<a class="btn btn-outline" href="${escapeAttr(source.url)}" target="_blank" rel="noopener">Source</a>` : ''}
          </span>
        </div>
      </li>`;
}

/** Row list shared by the homepage and category pages. */
function renderApiRows(apis, tagMap) {
  return apis.map(api => apiRowHtml(api, (tagMap && tagMap.get(api.id)) || [])).join('');
}

/** Clicking a row opens the API page (links and buttons inside keep their own targets). */
const ROW_CLICK_SCRIPT = `<script>document.addEventListener('click',function(e){if(e.target.closest('a, button'))return;var r=e.target.closest('.api-row[data-href]');if(!r)return;if(window.getSelection&&String(window.getSelection()))return;window.location.href=r.getAttribute('data-href')});</script>`;

// ---------------------------------------------------------------------------
// API documentation page
// ---------------------------------------------------------------------------

const PRISM_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0';
const PRISM_SCRIPTS = ['prism.min.js', ...['json', 'bash', 'python', 'go', 'ruby', 'java', 'csharp', 'markup-templating', 'php'].map(l => `components/prism-${l}.min.js`)]
  .map(f => `<script src="${PRISM_BASE}/${f}" data-manual defer></script>`)
  .join('\n  ');

const LANGUAGE_OPTIONS = [
  ['shell_curl', 'cURL'],
  ['javascript_fetch', 'JavaScript (Fetch)'],
  ['node_native', 'Node.js (HTTP)'],
  ['python_requests', 'Python (Requests)'],
  ['go_native', 'Go'],
  ['ruby_native', 'Ruby'],
  ['java_okhttp', 'Java (OkHttp)'],
  ['csharp_restsharp', 'C# (RestSharp)'],
  ['php_curl', 'PHP (cURL)']
];

const DETAIL_SCRIPT = `<script>
(function(){
  var NA='# Code generation not available';
  var sel=document.getElementById('global-lang-select');
  var langClass={shell_curl:'language-bash',javascript_fetch:'language-javascript',node_native:'language-javascript',python_requests:'language-python',go_native:'language-go',ruby_native:'language-ruby',java_okhttp:'language-java',csharp_restsharp:'language-csharp',php_curl:'language-php'};
  function highlight(el){
    if(!el||el.getAttribute('data-hl')||typeof Prism==='undefined')return;
    el.setAttribute('data-hl','1');
    var codes=el.querySelectorAll('code');
    for(var i=0;i<codes.length;i++){try{Prism.highlightElement(codes[i])}catch(e){}}
  }
  function showLang(lang){
    var boxes=document.querySelectorAll('.example-request-code-samples, .code-samples');
    for(var i=0;i<boxes.length;i++){
      var samples=boxes[i].querySelectorAll('.code-sample');
      for(var j=0;j<samples.length;j++){samples[j].classList.toggle('active',samples[j].getAttribute('data-lang')===lang)}
      var act=boxes[i].querySelector('.code-sample.active');
      var ok=!!act&&act.textContent.indexOf(NA)===-1;
      var wrap=boxes[i].closest('.sample-request, .example-request-code')||boxes[i];
      wrap.classList.toggle('is-empty',!ok);
      if(ok)highlight(act);
    }
  }
  var samples=document.querySelectorAll('.code-sample'),hasReal=false;
  for(var i=0;i<samples.length;i++){
    var c=samples[i].querySelector('code');var k=langClass[samples[i].getAttribute('data-lang')];
    if(c&&k)c.classList.add(k);
    if(!hasReal&&samples[i].textContent.indexOf(NA)===-1)hasReal=true;
  }
  var ctl=document.getElementById('lang-control');
  if(ctl&&!hasReal)ctl.style.display='none';
  var raws=document.querySelectorAll('.raw-body pre code');
  for(var r=0;r<raws.length;r++){
    var box=raws[r].closest('.request-body'),type=box?box.querySelector('.body-type'):null,tt=type?type.textContent.toLowerCase():'';
    if(tt.indexOf('json')!==-1)raws[r].classList.add('language-json');else if(tt.indexOf('xml')!==-1)raws[r].classList.add('language-markup');
  }
  var bodies=document.querySelectorAll('.response-body pre code');
  for(var b=0;b<bodies.length;b++){
    var t=bodies[b].textContent.trim();
    try{bodies[b].textContent=JSON.stringify(JSON.parse(t),null,2)}catch(e){if(t.charAt(0)==='<'){bodies[b].classList.remove('language-json');bodies[b].classList.add('language-markup')}}
  }
  if(sel){sel.addEventListener('change',function(){showLang(this.value)})}
  document.addEventListener('click',function(e){
    var tab=e.target.closest('.response-tab');if(!tab)return;
    var id=tab.getAttribute('data-request-id'),idx=tab.getAttribute('data-response-index');
    var tabs=document.querySelectorAll('.response-tab[data-request-id="'+id+'"]');
    for(var i=0;i<tabs.length;i++){tabs[i].classList.toggle('active',tabs[i]===tab)}
    var panes=document.querySelectorAll('.response-content[data-request-id="'+id+'"]');
    for(var j=0;j<panes.length;j++){var on=panes[j].getAttribute('data-response-index')===idx;panes[j].classList.toggle('active',on);if(on)highlight(panes[j])}
  });
  function norm(p){return String(p||'').replace(/^\\{\\{baseUrl\\}\\}/,'').replace(/^https?:\\/\\/[^/]+/,'').split('?')[0].replace(/\\{([^}]+)\\}/g,':$1').replace(/\\/+$/,'')||'/'}
  var refs={},secs=document.querySelectorAll('.ref .api-information[id]');
  for(var s=0;s<secs.length;s++){var m=secs[s].querySelector('.method'),u=secs[s].querySelector('.url');if(!m||!u)continue;refs[m.textContent.trim().toUpperCase()+' '+norm(u.textContent)]=secs[s].id}
  var rows=document.querySelectorAll('.ep[data-method]');
  for(var q=0;q<rows.length;q++){var id=refs[rows[q].getAttribute('data-method')+' '+norm(rows[q].getAttribute('data-path'))];if(id)rows[q].setAttribute('href','#'+id)}
  function onReady(){
    showLang(sel?sel.value:'shell_curl');
    var pres=document.querySelectorAll('.raw-body pre, .response-content.active');
    for(var i=0;i<pres.length;i++)highlight(pres[i]);
  }
  if(document.readyState==='complete')onReady();else window.addEventListener('load',onReady);
})();
</script>`;

/** Pull the generated endpoint reference out of a bruno-doc-gen page. */
function extractDocBody(html) {
  if (!html) return '';
  const start = html.indexOf('id="doc-body"');
  if (start === -1) return '';
  const open = html.indexOf('>', start);
  const end = html.lastIndexOf('</article>');
  if (open === -1 || end === -1 || end < open) return '';
  return html.slice(open + 1, end).trim();
}

/**
 * Render the API page: a summary built from the database row and spec facts,
 * followed by the bruno-doc-gen endpoint reference (restyled) when it exists.
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
  const specUrl = `${SITE_URL}${specPath}`;
  const downloadPath = `/api/apis/${api.id}/download`;
  const downloadUrl = `${SITE_URL}${downloadPath}`;
  const endpointCount = facts.endpoints != null ? facts.endpoints : api.endpoint_count;

  // ---- structured data ----------------------------------------------------
  const graph = [
    {
      '@type': 'WebAPI',
      '@id': `${url}#api`,
      name,
      description,
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
      downloadUrl
    }
  ];

  // ---- facts grid -----------------------------------------------------------
  const factRows = [];
  if (endpointCount) factRows.push(['Endpoints', formatNumber(endpointCount)]);
  if (facts.baseUrl) factRows.push(['Base URL', `<code>${escapeHtml(facts.baseUrl)}</code>`]);
  factRows.push(['Authentication', facts.auth && facts.auth.length ? escapeHtml(facts.auth.join(', ')) : 'Not specified in spec']);
  if (facts.specVersion) factRows.push(['Spec format', escapeHtml(facts.specVersion)]);
  if (api.version) factRows.push(['API version', escapeHtml(api.version)]);
  if (owner) factRows.push(['Provider', escapeHtml(owner)]);
  if (facts.license) {
    factRows.push(['License', facts.license.url
      ? `<a href="${escapeAttr(facts.license.url)}" rel="noopener nofollow" target="_blank">${escapeHtml(facts.license.name)}</a>`
      : escapeHtml(facts.license.name)]);
  }
  if (updated) factRows.push(['Last updated', `<time datetime="${updated}">${updated}</time>`]);

  // ---- endpoints ------------------------------------------------------------
  const methodCounts = facts.methodCounts || {};
  const methodsSorted = Object.keys(methodCounts).sort((a, b) => {
    const ia = METHOD_ORDER.indexOf(a), ib = METHOD_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const groups = endpointGroups(facts.operations);
  const endpointsHtml = groups.length
    ? `
      <section class="endpoints" id="doc-body">
        <div class="section-head">
          <h2>Endpoints</h2>
          <span class="total">${formatNumber(facts.endpoints)} total</span>
        </div>
        <div class="method-bar" aria-hidden="true">
          ${methodsSorted.map(m => `<span class="bg-${methodClass(m)}" style="flex:${methodCounts[m]}"></span>`).join('')}
        </div>
        <div class="method-legend">
          ${methodsSorted.map(m => `<span><span class="m-${methodClass(m)}">${escapeHtml(m)}</span> ${formatNumber(methodCounts[m])}</span>`).join('')}
        </div>
        ${groups.map(g => `
        <div class="ep-group">
          <h3>${escapeHtml(g.name)}</h3>
          <div class="ep-list">
            ${g.ops.map(op => `<a class="ep" data-method="${escapeAttr(op.method)}" data-path="${escapeAttr(op.path)}"><span class="ep-method m-${methodClass(op.method)}">${escapeHtml(op.method)}</span><span class="ep-path" title="${escapeAttr(op.path)}">${escapeHtml(op.path)}</span><span class="ep-summary" title="${escapeAttr(op.summary)}">${escapeHtml(op.summary)}</span></a>`).join('\n            ')}
          </div>
        </div>`).join('')}
      </section>`
    : '';

  // ---- reference (bruno-doc-gen output) ------------------------------------
  const docBody = extractDocBody(html);
  const referenceHtml = docBody
    ? `
      <section class="ref" id="reference"${groups.length ? '' : ' data-doc-body'}>
        <div class="section-head">
          <h2>Reference</h2>
          <label id="lang-control"><span class="faint" style="font-size:12.5px;margin-right:8px">Code samples</span><select id="global-lang-select">${LANGUAGE_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        </div>
        ${docBody}
      </section>`
    : (groups.length ? '' : `
      <section class="ref" id="doc-body">
        <p class="no-docs">Endpoint documentation has not been generated for this API yet. Download the Bruno collection or the OpenAPI spec above.</p>
      </section>`);

  // ---- aside ----------------------------------------------------------------
  const markdown = [
    `# ${name}${api.version ? ` (v${api.version})` : ''}`,
    longDescription,
    '',
    ...(facts.baseUrl ? [`- Base URL: ${facts.baseUrl}`] : []),
    ...(facts.auth && facts.auth.length ? [`- Auth: ${facts.auth.join(', ')}`] : []),
    ...(endpointCount ? [`- Endpoints: ${endpointCount}`] : []),
    `- Spec: ${specUrl}`,
    `- Collection: ${downloadUrl}`
  ].filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n');

  const curl = `curl ${specUrl}\ncurl -LO ${downloadUrl}`;

  const relatedHtml = related.length
    ? `<div class="related">
          <h2>Related</h2>
          ${related.map(r => `<a href="${escapeAttr(apiPath(r))}"><span>${escapeHtml(cleanText(r.name))}</span><span class="n">${r.endpoint_count != null ? formatNumber(r.endpoint_count) : ''}</span></a>`).join('\n          ')}
        </div>`
    : '';

  const catLinks = apiCats.length
    ? apiCats.map(c => `<a href="/category/${c.slug}">${escapeHtml(c.name)}</a>`).join(', ')
    : '';
  const subline = [owner ? escapeHtml(owner) : '', catLinks].filter(Boolean).join(' · ');

  const body = `
  <main class="detail">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Catalog</a><span>/</span>${primaryCat ? `<a href="/category/${primaryCat.slug}">${escapeHtml(primaryCat.name)}</a><span>/</span>` : ''}<span class="current">${escapeHtml(name)}</span>
    </nav>
    <div class="detail-cols">
      <div class="detail-main">
        <div class="title-row">
          <h1>${escapeHtml(name)}</h1>
          ${api.version ? `<span class="version">v${escapeHtml(api.version)}</span>` : ''}
        </div>
        ${subline ? `<div class="subline">${subline}</div>` : ''}
        ${longDescription ? `<p class="detail-desc">${escapeHtml(longDescription)}</p>` : ''}
        <div class="actions">
          <a class="btn btn-lg btn-amber" href="${downloadPath}">Download Bruno collection (.zip)</a>
          <a class="btn btn-lg btn-outline" href="${escapeAttr(specPath)}">OpenAPI spec (JSON)</a>
          ${source ? `<a class="btn btn-lg btn-outline" href="${escapeAttr(source.url)}" rel="noopener" target="_blank">Source</a>` : ''}
          <button class="btn btn-lg btn-outline" type="button" data-copy="${escapeAttr(markdown)}" data-copied="Copied">Copy as Markdown</button>
        </div>
        <dl class="facts">
          ${factRows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('\n          ')}
        </dl>
        ${endpointsHtml}
        ${referenceHtml}
      </div>
      <aside class="detail-aside">
        <div class="panel">
          <div class="panel-head"><span>Fetch</span><button class="copy-btn" type="button" data-copy="${escapeAttr(curl)}">copy</button></div>
          <pre><span class="c"># raw spec</span>
<span class="k">curl</span> ${escapeHtml(specUrl)}

<span class="c"># collection</span>
<span class="k">curl -LO</span> ${escapeHtml(downloadUrl)}</pre>
        </div>
        <div class="aside-box">
          <h2>Use this API in Bruno</h2>
          <ol>
            <li>Download the Bruno collection above and unzip it.</li>
            <li>In Bruno, choose <em>Open Collection</em> and select the unzipped folder.</li>
            <li>Set the <code>baseUrl</code> variable${facts.baseUrl ? ` (for example <code>${escapeHtml(facts.baseUrl)}</code>)` : ''}${facts.auth && facts.auth.length ? ` and your ${escapeHtml(facts.auth[0])} credentials` : ''}, then send requests.</li>
          </ol>
        </div>
        ${relatedHtml}
      </aside>
    </div>
  </main>`;

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  ${htmlHead({ title, description, canonical: url, structuredData: [{ '@context': 'https://schema.org', '@graph': graph }], extra: PRISM_SCRIPTS })}
</head>
<body>
  ${siteHeader()}
  ${body}
  ${siteFooter()}
  <script src="/site.js"></script>
  ${DETAIL_SCRIPT}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Shared page layout for server-rendered pages (categories, 404)
// ---------------------------------------------------------------------------

function layout({ title, description, canonical, heading, lede, crumbs = [], body, structuredData = [], categories = [], noindex = false, scripts = '' }) {
  const crumbHtml = crumbs.length
    ? `<nav class="crumbs" aria-label="Breadcrumb">${crumbs.map((c, i) => (i < crumbs.length - 1 ? `<a href="${escapeAttr(c.href)}">${escapeHtml(c.name)}</a><span>/</span>` : `<span class="current">${escapeHtml(c.name)}</span>`)).join('')}</nav>`
    : '';
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  ${htmlHead({ title, description, canonical, noindex, structuredData })}
</head>
<body>
  ${siteHeader()}
  <main class="page">
    ${crumbHtml}
    <h1 class="page-title">${escapeHtml(heading)}</h1>
    ${lede ? `<p class="page-lede">${lede}</p>` : ''}
    ${body}
  </main>
  ${siteFooter(categories)}
  <script src="/site.js"></script>
  ${scripts}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Homepage (fills server-side markers in public/index.html)
// ---------------------------------------------------------------------------

function renderHome({ indexHtml, totalApis, categories, topApis, tagMap }) {
  let out = indexHtml;

  out = out.replace(/<span data-ssr="count">[^<]*<\/span>/g, `<span data-ssr="count">${formatNumber(totalApis)}</span>`);
  out = out.replace(/placeholder="Search [^"]*"/, `placeholder="Search ${formatNumber(totalApis)} APIs by name, provider, or category"`);

  // Category chips (crawlable links to category pages)
  out = out.replace(/(<div class="chips" id="filterTags">)[\s\S]*?(<\/div>)/, (m, open, close) => {
    const chips = [`<a class="chip active" href="/" data-category="" onclick="toggleFilter(null); return false;">All <span class="count">${formatNumber(totalApis)}</span></a>`]
      .concat(categories.slice(0, 9).map(c =>
        `<a class="chip" href="/category/${c.slug}" data-category="${escapeAttr(c.name)}" onclick="toggleFilter(this.dataset.category); return false;">${escapeHtml(c.name)} <span class="count">${formatNumber(c.count)}</span></a>`
      ));
    return `${open}\n          ${chips.join('\n          ')}\n        ${close}`;
  });

  // Result count + pre-rendered rows for the most popular APIs
  out = out.replace(/(<div class="result-count" id="resultCount">)[\s\S]*?(<\/div>)/, `$1${formatNumber(topApis.length)} of <span data-ssr="count">${formatNumber(totalApis)}</span> APIs$2`);
  const rows = `
      <ul class="api-rows">${renderApiRows(topApis, tagMap)}
      </ul>
      <p class="note">Showing the ${topApis.length} most-starred APIs. <a href="/categories">Browse all ${formatNumber(totalApis)} APIs by category</a>.</p>`;
  out = out.replace('<!--SSR:CONTENT-->', rows);

  // Footer category navigation
  out = out.replace('<!--SSR:CATEGORIES-->', footerCategoriesNav(categories));

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
  out = out.replace('<!--SSR:CATEGORIES-->', footerCategoriesNav(categories));
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
    <p class="intro">These ${count} APIs are tagged <strong>${escapeHtml(category.name)}</strong> in the ${SITE_NAME}, which indexes ${formatNumber(totalApis)} public OpenAPI specifications in total. Each entry links to documentation generated from the spec, the original source, and a downloadable <a href="https://www.usebruno.com/" rel="noopener">Bruno</a> collection you can open locally. APIs are ordered by GitHub stars.</p>
    <div class="result-count">${formatNumber(count)} of ${formatNumber(totalApis)} APIs</div>
    <ul class="api-rows">${renderApiRows(apis, tagMap)}
    </ul>
    <h2>Other categories</h2>
    <div class="cat-grid">
      ${others.map(c => `<a href="/category/${c.slug}"><span>${escapeHtml(c.name)}</span><span class="count">${formatNumber(c.count)}</span></a>`).join('\n      ')}
    </div>`;

  return layout({
    title,
    description,
    canonical: url,
    heading: `${category.name} APIs`,
    lede: `${formatNumber(count)} public ${escapeHtml(category.name)} APIs with OpenAPI specs, docs, and Bruno collections.`,
    crumbs: [{ name: 'Catalog', href: '/' }, { name: 'Categories', href: '/categories' }, { name: category.name, href: `/category/${category.slug}` }],
    body,
    structuredData,
    categories,
    scripts: ROW_CLICK_SCRIPT
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
    <p class="intro">Every API in the catalog is tagged with one or more categories. Pick a category to see its APIs ranked by popularity, each with an OpenAPI spec, generated documentation, and a Bruno collection.</p>
    <div class="cat-grid">
      ${categories.map(c => `<a href="/category/${c.slug}"><span>${escapeHtml(c.name)}</span><span class="count">${formatNumber(c.count)} API${c.count === 1 ? '' : 's'}</span></a>`).join('\n      ')}
    </div>`;
  return layout({
    title,
    description,
    canonical: url,
    heading: 'Browse APIs by category',
    lede: `${categories.length} categories · ${formatNumber(totalApis)} OpenAPI specifications`,
    crumbs: [{ name: 'Catalog', href: '/' }, { name: 'Categories', href: '/categories' }],
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
    body: `<p class="intro"><a href="/">Back to the catalog</a> or <a href="/categories">browse by category</a>.</p>`,
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
  const owner = withOwner ? (api.provider || ownerFromApi(api)) : null;
  return `- [${cleanText(api.name)}](${apiUrl(api)})${owner ? ` (${owner})` : ''}${desc ? `: ${desc}` : ''}`;
}

function renderLlmsTxt({ totalApis, categories, topApis }) {
  return `# ${SITE_NAME}

> ${SITE_NAME} (${SITE_URL}) is a free, open-source catalog of ${formatNumber(totalApis)} public OpenAPI/Swagger specifications collected from GitHub and APIs.guru. Every API has a page with a plain-language summary, endpoint count, base URL, authentication type, interactive documentation generated from the spec, a link to the original source, the raw OpenAPI JSON, and a downloadable Bruno collection that can be opened in the Bruno API client.

## How to use this site

- Each API page lives at ${SITE_URL}/apis/<slug> and includes the full endpoint reference with code examples in many languages.
- The raw OpenAPI document for an API is available at ${SITE_URL}/apis/<slug>/openapi.json.
- A Bruno collection (ZIP) for an API is available from the download link on its page.
- JSON search across the catalog: ${SITE_URL}/api/apis?search=<query> (returns name, tags, provider, endpoint count and links).
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
  endpointGroups,
  apiOwner,
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
