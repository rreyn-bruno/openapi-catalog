const { Octokit } = require('@octokit/rest');
const { v4: uuidv4 } = require('uuid');

class GitHubScraper {
  constructor(token) {
    this.octokit = new Octokit({
      auth: token,
      userAgent: 'bruno-api-catalog/1.0.0'
    });
    this.rateLimitResetTime = null;
  }

  /**
   * Check and handle rate limits
   * @returns {Promise<void>}
   */
  async checkRateLimit() {
    try {
      const { data } = await this.octokit.rateLimit.get();
      const codeSearch = data.resources.search;

      console.log(`\n📊 Rate Limit Status:`);
      console.log(`   Remaining: ${codeSearch.remaining}/${codeSearch.limit}`);
      console.log(`   Resets at: ${new Date(codeSearch.reset * 1000).toLocaleTimeString()}`);

      // If we're low on requests, wait
      if (codeSearch.remaining < 2) {
        const resetTime = new Date(codeSearch.reset * 1000);
        const waitTime = resetTime - Date.now() + 5000; // Add 5 second buffer

        if (waitTime > 0) {
          console.log(`\n⏳ Rate limit reached. Waiting ${Math.ceil(waitTime / 1000)} seconds until reset...`);
          await this.sleep(waitTime);
          console.log(`✅ Rate limit reset! Continuing...`);
        }
      }
    } catch (error) {
      console.error('Error checking rate limit:', error.message);
    }
  }

  /**
   * Handle rate limit errors with automatic retry
   * @param {Error} error - The error to check
   * @returns {Promise<boolean>} - True if we should retry
   */
  async handleRateLimitError(error) {
    if (error.status === 403 && error.message.includes('rate limit')) {
      console.log('\n🚨 Rate limit exceeded! Checking reset time...');

      try {
        const { data } = await this.octokit.rateLimit.get();
        const resetTime = new Date(data.resources.search.reset * 1000);
        const waitTime = resetTime - Date.now() + 5000; // Add 5 second buffer

        if (waitTime > 0) {
          console.log(`⏳ Waiting ${Math.ceil(waitTime / 1000)} seconds for rate limit reset...`);
          console.log(`   Reset time: ${resetTime.toLocaleString()}`);
          await this.sleep(waitTime);
          console.log(`✅ Rate limit reset! Retrying...`);
          return true; // Signal to retry
        }
      } catch (e) {
        console.error('Error getting rate limit info:', e.message);
      }
    }
    return false; // Don't retry
  }

  /**
   * Search GitHub for OpenAPI specification files
   * @param {Object} options - Search options
   * @returns {Promise<Array>} Array of found OpenAPI specs
   */
  async searchOpenAPIFiles(options = {}) {
    const {
      minStars = 10,
      maxResults = 1000,
      filePatterns = [
        'openapi.json',
        'openapi.yaml',
        'openapi.yml',
        'swagger.json'
      ]
    } = options;

    const results = [];
    const seenRepos = new Set(); // Track repos we've already processed

    console.log(`\n🔍 Starting GitHub search for OpenAPI specs (minStars: ${minStars}, maxResults: ${maxResults})`);

    for (const pattern of filePatterns) {
      // Stop if we've reached maxResults
      if (results.length >= maxResults) {
        console.log(`Reached max results (${maxResults}), stopping...`);
        break;
      }

      try {
        // Note: GitHub Code Search API doesn't support stars: qualifier
        // We'll filter by stars after getting repo info
        const query = `filename:${pattern}`;
        console.log(`\n=== Searching: ${query} (will filter by ${minStars}+ stars) ===`);

        // Check rate limit before starting this search
        await this.checkRateLimit();

        // GitHub API limits to 1000 results per query (10 pages of 100)
        const maxPages = Math.min(10, Math.ceil(maxResults / 100));

        for (let page = 1; page <= maxPages; page++) {
          // Stop if we've reached maxResults
          if (results.length >= maxResults) {
            console.log(`Reached max results (${maxResults}), stopping...`);
            break;
          }

          let searchResults;
          let retryCount = 0;
          const maxRetries = 3;

          // Retry loop for rate limit errors
          while (retryCount < maxRetries) {
            try {
              // Search for files with pagination
              searchResults = await this.octokit.search.code({
                q: query,
                per_page: 100,
                page: page,
                sort: 'indexed'
              });
              break; // Success, exit retry loop
            } catch (error) {
              const shouldRetry = await this.handleRateLimitError(error);
              if (shouldRetry && retryCount < maxRetries - 1) {
                retryCount++;
                console.log(`Retry attempt ${retryCount}/${maxRetries}...`);
                continue;
              } else {
                throw error; // Re-throw if not rate limit or max retries reached
              }
            }
          }

          if (!searchResults) {
            console.log(`Failed to get results after ${maxRetries} retries`);
            break;
          }

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

          // Small delay between pages
          await this.sleep(1000);
        }

        // Small delay between file patterns
        await this.sleep(2000);

      } catch (error) {
        console.error(`Error searching ${pattern}:`, error.message);
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
