# Bruno Doc Gen

Generate beautiful, static HTML documentation from your [Bruno](https://www.usebruno.com/) API collections.

## Features

- 🎨 **Beautiful Design** - Clean, modern two-column layout inspired by popular API documentation sites
- 📝 **Markdown Support** - Full markdown rendering for collection, folder, and request-level documentation
- 💻 **Code Generation** - Automatic code samples in 20+ languages (curl, JavaScript, Python, Go, etc.)
- 🔗 **"Fetch in Bruno" Button** - Optional integration with Bruno's fetch button for easy collection importing
- 📱 **Responsive** - Mobile-friendly design that works on all devices
- 🎯 **Zero Config** - Works out of the box with sensible defaults
- 🚀 **Fast** - Static HTML generation, no runtime dependencies

## Installation

### Global Installation (Recommended)

```bash
npm install -g bruno-doc-gen
```

### Local Installation

```bash
npm install bruno-doc-gen
```

## Usage

### Basic Usage

Generate documentation from a Bruno collection:

```bash
bruno-docs generate /path/to/bruno/collection -o ./docs
```

This will create a `docs` folder with your generated documentation.

### With "Fetch in Bruno" Button

Add a "Fetch in Bruno" button to your documentation:

```bash
bruno-docs generate /path/to/bruno/collection -o ./docs --bruno-url https://github.com/username/repo.git
```

### Custom Title

Specify a custom title for your documentation:

```bash
bruno-docs generate /path/to/bruno/collection -o ./docs --title "My API Documentation"
```

### Publish to GitHub Pages

Generate and automatically publish to GitHub Pages:

```bash
bruno-docs generate /path/to/bruno/collection -o ./docs --publish
```

This will:
1. Generate your documentation
2. Create/update a `gh-pages` branch
3. Push the docs to GitHub
4. Configure GitHub Pages to use the `gh-pages` branch (if you have GitHub CLI installed)
5. Give you the live URL

**Publish to a different repository:**

```bash
bruno-docs generate /path/to/bruno/collection -o ./docs --publish --gh-repo https://github.com/username/my-docs-repo.git
```

This is useful when you want to publish documentation to a separate public repository while keeping your Bruno collection private

### All Options

```bash
bruno-docs generate <collection-path> [options]

Options:
  -o, --output <path>        Output directory (default: "./docs")
  -t, --title <title>        Documentation title
  --bruno-url <url>          Bruno collection URL for "Fetch in Bruno" button
  --theme <theme>            Theme (light/dark) (default: "light")
  --publish                  Publish to GitHub Pages after generation
  --gh-repo <url>            GitHub repository URL to publish to (defaults to current repo)
  --gh-branch <branch>       GitHub Pages branch (default: "gh-pages")
  -h, --help                 Display help
```

## Example

```bash
# Generate docs for your API collection
bruno-docs generate ./my-api -o ./api-docs --title "My API" --bruno-url https://github.com/myorg/my-api.git

# Open the generated documentation
open api-docs/index.html
```

## Documentation Features

### Collection-Level Documentation

Add documentation to your entire collection by editing the `docs` section in your `collection.bru` file:

```
docs {
  # My API Documentation
  
  This is the main documentation for my API.
  
  ## Getting Started
  
  To get started, you'll need an API key...
}
```

### Request-Level Documentation

Add documentation to individual requests in your `.bru` files:

```
docs {
  This endpoint retrieves user information.
  
  ## Parameters
  
  - `id`: The user ID
  
  ## Example Response
  
  ```json
  {
    "id": 123,
    "name": "John Doe"
  }
  ```
}
```

### Folder-Level Documentation

Add documentation to folders by editing the `docs` section in your `folder.bru` file.

## Output

The generated documentation includes:

- **Sidebar Navigation** - Collapsible folder structure matching your Bruno collection
- **Request Details** - Method, URL, headers, body, and parameters
- **Code Samples** - Automatically generated code in multiple languages
- **Markdown Rendering** - Full support for headings, lists, code blocks, images, and links
- **Responsive Design** - Works on desktop, tablet, and mobile

## Publishing Your Documentation

### GitHub Pages

1. Generate your docs to a `docs` folder:
   ```bash
   bruno-docs generate ./my-collection -o ./docs
   ```

2. Commit and push to GitHub:
   ```bash
   git add docs
   git commit -m "Add API documentation"
   git push
   ```

3. Enable GitHub Pages in your repository settings, selecting the `docs` folder as the source

### Netlify/Vercel

Simply point your deployment to the output directory and deploy as a static site.

## Requirements

- Node.js >= 14.0.0
- A Bruno collection (`.bru` files)

## How It Works

Bruno Doc Gen:

1. Parses your Bruno collection files (`.bru` format)
2. Extracts requests, folders, and documentation
3. Generates code samples using [httpsnippet](https://github.com/Kong/httpsnippet)
4. Renders markdown documentation
5. Creates a single, self-contained HTML file with embedded CSS and JavaScript

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Credits

Built for the [Bruno](https://www.usebruno.com/) API client community.
