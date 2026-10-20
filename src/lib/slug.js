/**
 * URL slug helpers shared by the database layer and the page renderer.
 */

function slugify(input, maxLength = 80) {
  const slug = String(input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // strip accents
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug;
}

/**
 * Best-effort "owner" of an API: the GitHub org/user for scraped repos,
 * otherwise the registrable domain of the source URL.
 */
function ownerFromApi(api) {
  if (!api) return null;

  if (api.github_url) {
    const match = api.github_url.match(/github\.com\/([^/]+)/i);
    if (match) return match[1];
  }

  const url = api.source_url || api.openapi_url;
  if (url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host === 'raw.githubusercontent.com' || host === 'github.com') {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        if (parts[0]) return parts[0];
      }
      const labels = host.split('.');
      return labels.length > 2 ? labels.slice(-2).join('.') : host;
    } catch (e) {
      return null;
    }
  }

  return null;
}

/**
 * Ordered list of slug candidates for an API, most readable first.
 */
function slugCandidates(api) {
  const base = slugify(api.name) || 'api';
  const owner = slugify(ownerFromApi(api) || '');
  const version = slugify(api.version || '');
  const shortId = String(api.id || '').replace(/-/g, '').slice(0, 8);

  const candidates = [base];
  if (owner) candidates.push(`${base}-${owner}`);
  if (owner && version) candidates.push(`${base}-${owner}-${version}`);
  if (shortId) candidates.push(`${base}-${shortId}`);
  return candidates.filter((c, i, arr) => c && arr.indexOf(c) === i);
}

module.exports = { slugify, ownerFromApi, slugCandidates };
