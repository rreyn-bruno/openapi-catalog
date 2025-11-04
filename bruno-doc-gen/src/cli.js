const { Command } = require('commander');
const { generateDocs } = require('./generator');
const { publishToGitHubPages } = require('./publisher');
const path = require('path');

const program = new Command();

program
  .name('bruno-docs')
  .description('Generate HTML documentation from Bruno collections')
  .version('0.1.0');

program
  .command('generate')
  .description('Generate documentation from a Bruno collection')
  .argument('<collection-path>', 'Path to Bruno collection directory')
  .option('-o, --output <path>', 'Output directory', './docs')
  .option('-t, --theme <theme>', 'Theme (light|dark)', 'light')
  .option('--title <title>', 'Documentation title')
  .option('--bruno-url <url>', 'Git URL for "Fetch in Bruno" button')
  .option('--publish', 'Publish to GitHub Pages after generation')
  .option('--gh-repo <url>', 'GitHub repository URL to publish to (defaults to current repo)')
  .option('--gh-branch <branch>', 'GitHub Pages branch', 'gh-pages')
  .action(async (collectionPath, options) => {
    try {
      const outputPath = path.resolve(options.output);

      // Generate documentation
      await generateDocs({
        collectionPath: path.resolve(collectionPath),
        outputPath,
        theme: options.theme,
        title: options.title,
        brunoCollectionUrl: options.brunoUrl
      });
      console.log(`✅ Documentation generated at: ${options.output}`);

      // Publish to GitHub Pages if requested
      if (options.publish) {
        await publishToGitHubPages({
          outputPath,
          repoUrl: options.ghRepo,
          branch: options.ghBranch
        });
      }
    } catch (error) {
      console.error('Error generating documentation:', error.message);
      process.exit(1);
    }
  });

program.parse();

