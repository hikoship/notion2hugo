# Notion to Hugo Publishing Pipeline (Node.js)

A zero-inbound-port publishing worker daemon managed natively by PM2.

Directly polls your Notion `Blog` database every 5 minutes (`300s`) using a server-side `last_edited_time` + `WIP = false` filter, converts Notion block trees to Hugo-compatible Markdown + YAML frontmatter, writes files directly into your local Hugo repository (`~/GitHub/blog/content/post`), and commits & pushes to GitHub (`hikoship/blog`) to trigger GitHub Actions deployment to `https://blog.hgao.net`.

---

## 1. Architecture

```
                    +-----------------------------+
                    |       Notion Database       |
                    |     (Published = true)      |
                    |   *Date is manually set*    |
                    +--------------+--------------+
                                   |
                          Outbound HTTPS Poll
                     (Every 5m, filters last_edited_time)
                                   |
                    +--------------v--------------+
                    |          worker.js          |
                    |      (Managed by PM2)       |
                    |  - .sync_state.json diffing |
                    |  - Block Tree -> Markdown   |
                    |  - YAML Frontmatter         |
                    +--------------+--------------+
                                   |
                    Writes to ~/GitHub/blog/content/post
                                   |
                                   v
                    +-----------------------------+
                    |  Sequential Git Automation  |
                    | (pull -> commit -> push)    |
                    +--------------+--------------+
                                   |
                                   v
                    +-----------------------------+
                    |    GitHub Actions CI/CD     |
                    | (Hugo Build -> Deploy Site) |
                    +-----------------------------+
```

### Key Design Principles & Conventions:
- **Zero Inbound Ports & Zero Pipedream:** The daemon runs entirely as an outbound client polling Notion directly every 5 minutes (`300s`).
- **Sync Rules (`Published`, `WIP`, and `last_edited_time`):**
  1. **`WIP = true` (Work in Progress):** Ignored completely by the worker—neither exported nor removed while `WIP` is checked.
  2. **`Published = true` & `WIP = false` (Public, non-WIP):** Exported to `~/GitHub/blog/content/post/<slug>.md` and pushed to GitHub only when newly published or recently edited (`page.last_edited_time` differs from `.sync_state.json`, or file is missing on disk).
  3. **`Published = false` & `WIP = false` (Unpublished):** If `~/GitHub/blog/content/post/<slug>.md` already exists in the blog repository, the worker automatically removes the file (`git rm`), commits, and pushes to unpublish it from GitHub.
- **Manual Date Control:** Publication dates (`Date`) are manually set by the author in Notion. The daemon preserves your dates and **never** overwrites them.
- **Image Hosting (ImageKit.io):** Blog post images are hosted on ImageKit (`https://ik.imagekit.io/hikoship/blog/<post-slug>/<filename>`) or Flickr and embedded in Notion as external image links (`/image` -> Embed link).
- **Heading & Media Conventions:**
  - Notion `Heading 1` $\leftrightarrow$ Markdown `##` (H2); Notion `Heading 2` $\leftrightarrow$ Markdown `###` (H3).
  - Notion `video` blocks (YouTube links) $\leftrightarrow$ responsive YouTube `<iframe>` embeds in Hugo Markdown.

---

## 2. Directory Structure

```
notion2hugo/
├── worker.js                # Long-running daemon entrypoint
├── ecosystem.config.cjs     # Native PM2 configuration
├── package.json             # Node dependencies and scripts
├── .env.example             # Environment configuration template
├── lib/                     # Core libraries
│   ├── blocks-to-md.js      # Notion block tree to Markdown parser
│   ├── config.js            # Environment loader & validator
│   ├── frontmatter.js       # YAML frontmatter generator
│   ├── git.js               # Safe git execution with push verification
│   ├── image-store.js       # ImageKit.io / R2 / local image store helpers
│   └── notion.js            # Official Notion SDK wrapper with 429 retries
├── scripts/                 # Migration & Maintenance Tooling
│   ├── inventory-images.js  # Audit image usage across all Markdown files
│   ├── migrate-images.js    # Upload local images to ImageKit (/blog/<slug>/) & rewrite posts
│   ├── import-articles.js   # Import or update (--overwrite in-place) Hugo posts & drafts in Notion
│   ├── export-all.js        # Export Notion database to Markdown
│   ├── verify-roundtrip.js  # Diff check between original and exported posts
│   └── setup-pm2.sh         # PM2 initialization script
└── tests/                   # Test suite
    └── converter.test.js    # Unit tests for parser and frontmatter
```

---

## 3. Quick Start & Setup

### 3.1 Install Dependencies
```bash
cd ~/GitHub/notion2hugo
npm install
```

### 3.2 Configure Environment (`.env`)
```bash
cp .env.example .env
```
Key settings in `.env`:
- `NOTION_API_KEY`: Notion internal integration secret
- `NOTION_DATABASE_ID`: `0341d5b6-2282-4928-ae97-ebfb4fc8bff8`
- `HUGO_CONTENT_DIR`: `/home/hongyuan/GitHub/blog/content/post`
- `GIT_REPO_DIR`: `/home/hongyuan/GitHub/blog`
- `IMAGEKIT_URL_ENDPOINT`: `https://ik.imagekit.io/hikoship` (`IMAGEKIT_PRIVATE_KEY` is only needed for one-off `npm run migrate:images`)

---

## 4. Production PM2 Daemon

Start the worker under PM2:
```bash
./scripts/setup-pm2.sh
```

### Process Management Commands:
```bash
pm2 logs notion-hugo-pipeline       # View live logs
pm2 status notion-hugo-pipeline     # Check process health
pm2 restart notion-hugo-pipeline    # Restart worker
pm2 stop notion-hugo-pipeline       # Stop worker
```

### Manual CLI Usage:
```bash
node worker.js --once               # Run a single poll iteration and exit
node worker.js --page-id <PAGE_ID>  # Export & publish a single Notion page immediately
```

---

## 5. Migration & Sync Scripts

- **Audit local/external images:**
  ```bash
  npm run inventory:images
  ```
- **Upload local images to ImageKit (`/blog/<post-slug>/`) & rewrite Markdown:**
  ```bash
  npm run migrate:images -- --dry-run
  npm run migrate:images
  ```
- **Import local Hugo Markdown posts & drafts into Notion:**
  ```bash
  npm run import:articles -- --dry-run
  npm run import:articles                     # Skips slugs already in Notion
  npm run import:articles -- --overwrite      # Updates existing Notion pages in-place
  ```
- **Export all Notion pages to a test directory & verify round-trip:**
  ```bash
  npm run export:all -- --output-dir /tmp/notion_test
  npm run verify:roundtrip -- --exported-dir /tmp/notion_test
  ```

---

## 6. Testing

Run the automated test suite:
```bash
npm test
```
