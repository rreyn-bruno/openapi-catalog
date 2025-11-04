const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

/**
 * Publish documentation to GitHub Pages
 * @param {Object} options - Publishing options
 * @param {string} options.outputPath - Path to the generated docs
 * @param {string} options.repoUrl - GitHub repository URL (optional, will detect from git remote)
 * @param {string} options.branch - Branch to publish to (default: gh-pages)
 */
async function publishToGitHubPages({ outputPath, repoUrl, branch = 'gh-pages' }) {
  try {
    console.log('\n📦 Publishing to GitHub Pages...\n');

    // Check if we're in a git repository
    if (!isGitRepository()) {
      throw new Error('Not a git repository. Please initialize git first with: git init');
    }

    // Get the repository URL
    const detectedRepoUrl = repoUrl || getGitRemoteUrl();
    if (!detectedRepoUrl) {
      throw new Error('No git remote found. Please add a remote with: git remote add origin <url>');
    }

    // Extract owner and repo name from URL
    const { owner, repo } = parseGitHubUrl(detectedRepoUrl);
    console.log(`📍 Repository: ${owner}/${repo}`);

    // Check if gh CLI is available
    const hasGhCli = checkGhCli();

    // Create a temporary directory for gh-pages branch
    const originalDir = process.cwd();
    const tempDir = path.join(originalDir, '.gh-pages-temp');
    await fs.ensureDir(tempDir);

    try {
      // Initialize or clone the gh-pages branch
      console.log(`🔄 Setting up ${branch} branch...`);

      if (branchExists(detectedRepoUrl, branch)) {
        // Clone existing gh-pages branch
        execSync(`git clone -b ${branch} --single-branch ${detectedRepoUrl} ${tempDir}`, {
          stdio: 'inherit'
        });
      } else {
        // Create new orphan branch
        execSync(`git clone ${detectedRepoUrl} ${tempDir}`, { stdio: 'inherit' });
        process.chdir(tempDir);
        execSync(`git checkout --orphan ${branch}`, { stdio: 'inherit' });
        execSync('git rm -rf .', { stdio: ['pipe', 'pipe', 'pipe'] });
        // Stay in tempDir - don't change back yet
      }

      // Copy generated docs to temp directory
      console.log('📋 Copying documentation files...');

      // Make sure we're in the original directory before copying
      process.chdir(originalDir);

      await fs.copy(outputPath, tempDir, {
        overwrite: true,
        filter: (src) => !src.includes('.git')
      });

      // Now change to temp directory for git operations
      process.chdir(tempDir);
      execSync('git add .', { stdio: 'inherit' });

      // Check if there are changes to commit
      let hasChanges = false;
      try {
        const status = execSync('git status --porcelain', { encoding: 'utf8' });
        hasChanges = status.trim().length > 0;
      } catch (error) {
        // If we can't check status, assume there are changes
        hasChanges = true;
      }

      if (hasChanges) {
        execSync(`git commit -m "Deploy documentation - ${new Date().toISOString()}"`, {
          stdio: 'inherit'
        });
        console.log(`⬆️  Pushing to ${branch} branch...`);
        execSync(`git push origin ${branch}`, { stdio: 'inherit' });
      } else {
        console.log('ℹ️  No changes to publish - documentation is already up to date');
      }

      // Enable/Update GitHub Pages if gh CLI is available
      if (hasGhCli) {
        console.log('🔧 Configuring GitHub Pages...');
        try {
          // Try to create GitHub Pages first
          execSync(`gh api repos/${owner}/${repo}/pages -X POST -f source[branch]=${branch} -f source[path]=/`, {
            stdio: 'pipe'
          });
          console.log('✅ GitHub Pages enabled');
        } catch (error) {
          // If it already exists, update it to use the correct branch
          if (error.message.includes('already exists')) {
            try {
              execSync(`gh api repos/${owner}/${repo}/pages -X PUT -f source[branch]=${branch} -f source[path]=/`, {
                stdio: 'pipe'
              });
              console.log('✅ GitHub Pages updated to use ' + branch + ' branch');
            } catch (updateError) {
              console.log('ℹ️  GitHub Pages may already be configured correctly');
            }
          } else {
            console.log('ℹ️  Could not configure GitHub Pages automatically');
          }
        }
      }

      // Get the GitHub Pages URL
      const pagesUrl = `https://${owner}.github.io/${repo}/`;
      
      console.log('\n✨ Documentation published successfully!\n');
      console.log(`🌐 Your documentation will be available at:`);
      console.log(`   ${pagesUrl}\n`);
      console.log(`⏱️  Note: It may take a few minutes for GitHub Pages to build and deploy.\n`);

      if (!hasGhCli) {
        console.log('💡 Tip: Install GitHub CLI (gh) for automatic GitHub Pages configuration:');
        console.log('   brew install gh\n');
        console.log('   Or manually enable GitHub Pages in your repository settings:');
        console.log(`   https://github.com/${owner}/${repo}/settings/pages\n`);
      }

      return pagesUrl;

    } finally {
      // Cleanup
      process.chdir(originalDir);
      await fs.remove(tempDir);
    }

  } catch (error) {
    console.error('❌ Error publishing to GitHub Pages:', error.message);
    throw error;
  }
}

/**
 * Check if current directory is a git repository
 */
function isGitRepository() {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the git remote URL
 */
function getGitRemoteUrl() {
  try {
    const url = execSync('git config --get remote.origin.url', { 
      encoding: 'utf8' 
    }).trim();
    return url;
  } catch {
    return null;
  }
}

/**
 * Check if a branch exists (locally or remotely)
 */
function branchExists(repoUrl, branch) {
  try {
    const result = execSync(`git ls-remote --heads ${repoUrl} ${branch}`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if GitHub CLI is installed
 */
function checkGhCli() {
  try {
    execSync('which gh', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse GitHub URL to extract owner and repo
 */
function parseGitHubUrl(url) {
  // Handle both HTTPS and SSH URLs
  // HTTPS: https://github.com/owner/repo.git
  // SSH: git@github.com:owner/repo.git
  
  let match;
  
  // Try HTTPS format
  match = url.match(/github\.com[\/:](.+?)\/(.+?)(\.git)?$/);
  
  if (match) {
    return {
      owner: match[1],
      repo: match[2].replace('.git', '')
    };
  }
  
  throw new Error('Invalid GitHub URL format');
}

module.exports = { publishToGitHubPages };

