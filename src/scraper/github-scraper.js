const { Octokit } = require('@octokit/rest');
const { v4: uuidv4 } = require('uuid');

class GitHubScraper {
  constructor(token) {
    this.octokit = new Octokit({
      auth: token,
      userAgent: 'bruno-api-catalog/1.0.0'
    });
  }

  /**
   * Search GitHub for OpenAPI specification files
   * @param {Object} options - Search options
   * @returns {Promise<Array>} Array of found OpenAPI specs
   */
  async searchOpenAPIFiles(options = {}) {
    const {
      minStars = 0,
      maxResults = 10000,
      filePatterns = [
        'openapi.json',
        'openapi.yaml',
        'openapi.yml',
        'swagger.json',
        'swagger.yaml',
        'swagger.yml'
      ],
      useStarRanges = true
    } = options;

    const results = [];
    const seenRepos = new Set(); // Track repos we've already processed

    // Define star ranges to bypass GitHub's 1000 result limit
    const starRanges = useStarRanges ? [
      { min: 1000, max: null, label: '1000+' },
      { min: 100, max: 999, label: '100-999' },
      { min: 10, max: 99, label: '10-99' },
      { min: 1, max: 9, label: '1-9' },
      { min: 0, max: 0, label: '0' }
    ] : [{ min: minStars, max: null, label: `${minStars}+` }];

    for (const pattern of filePatterns) {
      for (const range of starRanges) {
        // Skip ranges below minStars
        if (range.max !== null && range.max < minStars) continue;
        if (range.min < minStars && range.max === null) continue;

        try {
          // Build star query
          let starQuery = '';
          if (range.max === null) {
            starQuery = `stars:>=${range.min}`;
          } else if (range.min === range.max) {
            starQuery = `stars:${range.min}`;
          } else {
            starQuery = `stars:${range.min}..${range.max}`;
          }

          const query = `filename:${pattern} ${starQuery}`;
          console.log(`\n=== Searching: ${query} ===`);

          // GitHub API limits to 1000 results per query (10 pages of 100)
          const maxPages = 10;

          for (let page = 1; page <= maxPages; page++) {
            // Stop if we've reached maxResults
            if (results.length >= maxResults) {
              console.log(`Reached max results (${maxResults}), stopping...`);
              break;
            }

            try {
              // Search for files with pagination
              const searchResults = await this.octokit.search.code({
                q: query,
                per_page: 100,
                page: page,
                sort: 'indexed'
              });

              console.log(`Page ${page}: Found ${searchResults.data.items.length} files`);

              // If no more results, break pagination
              if (searchResults.data.items.length === 0) {
                console.log(`No more results for this query`);
                break;
              }

              for (const item of searchResults.data.items) {
                // Stop if we've reached maxResults
                if (results.length >= maxResults) {
                  console.log(`Reached max results (${maxResults}), stopping...`);
                  break;
                }

                // Create unique key for this repo+path combination
                const repoKey = `${item.repository.owner.login}/${item.repository.name}/${item.path}`;

                // Skip if we've already processed this exact file
                if (seenRepos.has(repoKey)) {
                  console.log(`Skipping duplicate: ${repoKey}`);
                  continue;
                }

                try {
                  // Get repository info
                  const repo = await this.octokit.repos.get({
                    owner: item.repository.owner.login,
                    repo: item.repository.name
                  });

                  // Filter by stars AFTER getting repo info
                  if (repo.data.stargazers_count < minStars) {
                    console.log(`Skipping ${repo.data.full_name} (${repo.data.stargazers_count} stars < ${minStars})`);
                    continue;
                  }

                  // Get file content
                  const fileContent = await this.octokit.repos.getContent({
                    owner: item.repository.owner.login,
                    repo: item.repository.name,
                    path: item.path
                  });

                  // Decode content
                  const content = Buffer.from(fileContent.data.content, 'base64').toString('utf-8');

                  // Try to parse as JSON or YAML
                  let spec;
                  try {
                    spec = JSON.parse(content);
                  } catch (e) {
                    // If not JSON, might be YAML - we'll handle this in the pipeline
                    spec = { raw: content };
                  }

                  // Mark this repo as seen
                  seenRepos.add(repoKey);

                  results.push({
                    id: uuidv4(),
                    name: spec.info?.title || repo.data.name,
                    description: spec.info?.description || repo.data.description || '',
                    version: spec.info?.version || '1.0.0',
                    github_url: repo.data.html_url,
                    openapi_url: fileContent.data.download_url,
                    stars: repo.data.stargazers_count,
                    file_path: item.path,
                    repo_owner: item.repository.owner.login,
                    repo_name: item.repository.name,
                    spec: spec,
                    source: 'github-scrape',
                    source_url: fileContent.data.download_url,
                    last_synced_at: new Date().toISOString()
                  });

                  console.log(`✓ Added ${repo.data.full_name} (${repo.data.stargazers_count} stars)`);

                  // Rate limiting - be nice to GitHub
                  await this.sleep(1000);
                } catch (error) {
                  console.error(`Error processing ${item.path}:`, error.message);
                }
              }
            } catch (error) {
              console.error(`Error fetching page ${page}:`, error.message);
              break; // Stop pagination on error
            }
          }

          // Stop searching other ranges if we've reached maxResults
          if (results.length >= maxResults) {
            console.log(`Reached max results (${maxResults}), stopping all searches...`);
            break;
          }

        } catch (error) {
          console.error(`Error searching ${pattern} with ${range.label} stars:`, error.message);
        }
      }

      // Stop searching other patterns if we've reached maxResults
      if (results.length >= maxResults) {
        break;
      }
    }

    console.log(`\n=== Search complete ===`);
    console.log(`Total unique APIs found: ${results.length}`);
    console.log(`Unique repos processed: ${seenRepos.size}`);

    return results;
  }

  /**
   * Get OpenAPI spec from a specific repository
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} path - Path to OpenAPI file
   * @returns {Promise<Object>} OpenAPI spec info
   */
  async getOpenAPIFromRepo(owner, repo, path = 'openapi.json') {
    try {
      const repoInfo = await this.octokit.repos.get({ owner, repo });
      const fileContent = await this.octokit.repos.getContent({ owner, repo, path });

      const content = Buffer.from(fileContent.data.content, 'base64').toString('utf-8');
      const spec = JSON.parse(content);

      return {
        id: uuidv4(),
        name: spec.info?.title || repoInfo.data.name,
        description: spec.info?.description || repoInfo.data.description || '',
        version: spec.info?.version || '1.0.0',
        github_url: repoInfo.data.html_url,
        openapi_url: fileContent.data.download_url,
        stars: repoInfo.data.stargazers_count,
        spec: spec,
        source: 'github-scrape',
        source_url: fileContent.data.download_url,
        last_synced_at: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(`Failed to get OpenAPI spec: ${error.message}`);
    }
  }

  /**
   * Check rate limit status
   * @returns {Promise<Object>} Rate limit info
   */
  async getRateLimit() {
    const { data } = await this.octokit.rateLimit.get();
    return {
      limit: data.rate.limit,
      remaining: data.rate.remaining,
      reset: new Date(data.rate.reset * 1000)
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = GitHubScraper;
