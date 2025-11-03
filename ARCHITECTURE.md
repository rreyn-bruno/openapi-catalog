# Bruno API Catalog - Architecture

## Overview

An automated service that discovers OpenAPI specifications from GitHub, converts them to Bruno collections, generates documentation, and provides a searchable catalog with "Fetch in Bruno" integration.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        GitHub Repositories                       │
│                    (OpenAPI Specifications)                      │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Scraper Service                             │
│  - GitHub API integration                                        │
│  - OpenAPI file discovery                                        │
│  - Scheduled/triggered execution                                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Conversion Pipeline                            │
│  1. OpenAPI → Bruno Collection (openapi-to-bruno)               │
│  2. Bruno Collection → Documentation (bruno-docs)               │
│  3. Store metadata in database                                   │
│  4. Upload collections & docs to storage                         │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌──────────────────┬──────────────────┬──────────────────────────┐
│                  │                  │                          │
│   PostgreSQL     │  File Storage    │   Search Index          │
│   Database       │  (S3/Local)      │   (Optional)            │
│                  │                  │                          │
│  - API metadata  │  - Collections   │  - Full-text search     │
│  - Tags          │  - Docs (HTML)   │  - Fuzzy matching       │
│  - Versions      │  - OpenAPI specs │                          │
└──────────────────┴──────────────────┴──────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Backend API (Express)                       │
│  - GET /api/apis (list/search)                                  │
│  - GET /api/apis/:id (details)                                  │
│  - GET /api/tags (list tags)                                    │
│  - POST /api/scrape (trigger scrape)                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Frontend Web App (React)                      │
│  - Browse APIs by category/tag                                  │
│  - Search and filter                                             │
│  - View embedded documentation                                   │
│  - "Fetch in Bruno" button                                      │
│  - API details and metadata                                      │
└─────────────────────────────────────────────────────────────────┘
```

## MVP Approach

We'll build an **all-in-one Node.js application** for simplicity:
- Single Express.js server
- SQLite database (easy, no setup)
- Local file storage
- React frontend (served by Express)
- Manual scrape trigger

## Next Steps

1. Initialize project structure
2. Build GitHub scraper
3. Set up database
4. Create conversion pipeline
5. Build REST API
6. Create frontend
7. Deploy MVP
