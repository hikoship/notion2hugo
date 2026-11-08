#!/usr/bin/env node
/**
 * worker.js - Notion to Hugo Publishing Worker Daemon (Node.js)
 *
 * Managed by PM2. Directly polls Notion database every 30s for Status='Publish',
 * downloads block trees, rehosts images to Cloudflare R2, parses to Markdown + YAML frontmatter,
 * writes to local Hugo repository, and pushes to GitHub.
 * Zero inbound ports, zero third-party queues.
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, validateConfig } from './lib/config.js';
import { NotionService } from './lib/notion.js';
import { extractProperties, renderYamlFrontmatter } from './lib/frontmatter.js';
import { BlockParser } from './lib/blocks-to-md.js';
import { createImageStore } from './lib/image-store.js';
import { GitManager } from './lib/git.js';

let isProcessing = false;
let shouldTerminate = false;

function setupSignals() {
  const onSignal = (sig) => {
    console.log(`[Worker] Received ${sig}. Finishing current work before stopping...`);
    shouldTerminate = true;
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

export class NotionHugoWorker {
  constructor(config) {
    this.config = config;
    this.notion = new NotionService(config.notionApiKey, config.notionApiVersion);
    this.imageStore = createImageStore(config);
    this.git = new GitManager({
      repoDir: config.gitRepoDir,
      branch: config.gitBranch,
      remote: config.gitRemote,
      authorName: config.gitCommitAuthorName,
      authorEmail: config.gitCommitAuthorEmail,
    });
    this.syncStatePath = config.syncStatePath || path.resolve('.sync_state.json');
    this.syncState = this._loadSyncState();
  }

  _loadSyncState() {
    try {
      if (fs.existsSync(this.syncStatePath)) {
        return JSON.parse(fs.readFileSync(this.syncStatePath, 'utf8'));
      }
    } catch (err) {
      console.warn(`[Worker] Could not load sync state (${err.message}), starting fresh.`);
    }
    return {};
  }

  _saveSyncState() {
    try {
      fs.writeFileSync(this.syncStatePath, JSON.stringify(this.syncState, null, 2), 'utf8');
    } catch (err) {
      console.error(`[Worker] Failed to save sync state: ${err.message}`);
    }
  }

  async processPage(pageId) {
    console.log(`\n============================================================`);
    console.log(`[Worker] Processing Notion page: ${pageId}`);
    console.log(`============================================================`);

    // 1. Fetch page metadata
    const page = await this.notion.getPage(pageId);
    const props = extractProperties(page);
    const slug = props.slug;
    const title = props.title || 'Untitled';

    if (!slug) {
      console.error(`[Worker] Page ${pageId} has no valid slug/filename. Aborting.`);
      return false;
    }

    console.log(`[Worker] Article: '${title}' | Slug: '${slug}' | Date: '${props.date || 'none'}'`);

    // 2. Fetch all blocks recursively
    console.log(`[Worker] Fetching blocks recursively...`);
    const blocks = await this.notion.getAllBlocks(pageId, true);
    console.log(`[Worker] Retrieved ${blocks.length} top-level blocks.`);

    // 3. Convert blocks to Markdown + rehost images to Cloudflare R2
    const parser = new BlockParser({
      imageStore: this.imageStore,
      postSlug: slug,
    });
    const bodyMarkdown = await parser.parseBlocks(blocks);

    // 4. Generate YAML frontmatter
    const frontmatterYaml = renderYamlFrontmatter(props);
    const fullDocument = frontmatterYaml + bodyMarkdown;

    // 5. Write to local Hugo content directory
    await fs.promises.mkdir(this.config.hugoContentDir, { recursive: true });
    const destFile = path.join(this.config.hugoContentDir, `${slug}.md`);
    console.log(`[Worker] Writing generated markdown to: ${destFile}`);
    await fs.promises.writeFile(destFile, fullDocument, 'utf8');

    // 6. Sequential Git Operations
    try {
      await this.git.pullLatest();
      const commitMsg = `publish(post): ${slug} - '${title}'`;
      const committed = await this.git.commitFile(destFile, commitMsg);

      if (committed) {
        await this.git.push();
        const verified = await this.git.verifyPush();
        if (!verified) {
          console.error(`[Worker] Git push verification failed for '${slug}'!`);
          return false;
        }
      } else {
        console.log(`[Worker] No changes detected for '${slug}'. Skipping push.`);
      }
    } catch (gitErr) {
      console.error(`[Worker] Git automation failed for '${slug}': ${gitErr.message}`);
      return false;
    }

    // 7. Update Notion status to 'Published' (Date is manual; not touched)
    const updatedPage = await this.notion.updatePageStatus(pageId, 'Published');
    const latestEdited = updatedPage?.last_edited_time || page.last_edited_time;
    this.syncState[page.id] = {
      slug,
      lastEditedTime: latestEdited,
      syncedAt: new Date().toISOString(),
    };
    this._saveSyncState();
    console.log(`[Worker] Successfully published post: ${slug}\n`);
    return true;
  }

  async pollOnce() {
    if (isProcessing) {
      console.warn(`[Worker] Processing lock active. Skipping poll iteration.`);
      return 0;
    }

    const allCandidates = await this.notion.queryPublishCandidates(this.config.notionDatabaseId);
    if (!allCandidates || allCandidates.length === 0) {
      return 0;
    }

    // Filter to pages with Status='Publish' OR whose last_edited_time changed since last sync
    const candidates = allCandidates.filter((page) => {
      if (page.properties?.Status?.status?.name === 'Publish') return true;
      const prev = this.syncState[page.id];
      return !prev || prev.lastEditedTime !== page.last_edited_time;
    });

    if (candidates.length === 0) {
      return 0;
    }

    console.log(`[Worker] Found ${candidates.length} modified/new article(s) ready to publish.`);
    let processedCount = 0;

    for (const page of candidates) {
      if (shouldTerminate) break;

      isProcessing = true;
      try {
        const success = await this.processPage(page.id);
        if (success) processedCount++;
      } catch (err) {
        console.error(`[Worker] Unexpected error processing page ${page.id}: ${err.message}`);
      } finally {
        isProcessing = false;
      }
    }

    return processedCount;
  }

  async runDaemon() {
    console.log(`[Worker] Starting Notion-to-Hugo Worker Daemon (Polling interval: ${this.config.pollIntervalSeconds}s)`);

    while (!shouldTerminate) {
      try {
        await this.pollOnce();
      } catch (err) {
        console.error(`[Worker] Error in polling loop: ${err.message}`);
      }

      for (let s = 0; s < this.config.pollIntervalSeconds; s++) {
        if (shouldTerminate) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
    }

    console.log(`[Worker] Daemon stopped gracefully.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node worker.js [options]

Options:
  --once             Run a single poll iteration and exit
  --page-id <id>     Process a specific Notion page ID directly and exit
  --help, -h         Show this help message
`);
    process.exit(0);
  }

  const isOnce = args.includes('--once');
  const pageIdIndex = args.indexOf('--page-id');
  const targetPageId = pageIdIndex !== -1 ? args[pageIdIndex + 1] : null;

  setupSignals();

  const config = loadConfig();
  validateConfig(config, { requireNotion: true });

  // Simple file lock to prevent duplicate worker instances
  let lockFd;
  try {
    lockFd = fs.openSync(config.lockFilePath, 'w');
  } catch (err) {
    console.error(`[Worker] Cannot open lock file ${config.lockFilePath}: ${err.message}`);
    process.exit(1);
  }

  const worker = new NotionHugoWorker(config);

  try {
    if (targetPageId) {
      console.log(`[Worker] Processing single page via CLI: ${targetPageId}`);
      const success = await worker.processPage(targetPageId);
      process.exit(success ? 0 : 1);
    } else if (isOnce) {
      console.log(`[Worker] Executing single poll iteration (--once)...`);
      const count = await worker.pollOnce();
      console.log(`[Worker] Single poll finished. Processed ${count} articles.`);
      process.exit(0);
    } else {
      await worker.runDaemon();
    }
  } finally {
    try {
      fs.closeSync(lockFd);
      fs.unlinkSync(config.lockFilePath);
    } catch {
      // Ignore cleanup error
    }
  }
}

const isMain =
  process.argv[1] === import.meta.filename ||
  process.env.pm_exec_path === import.meta.filename;

if (isMain) {
  main().catch((err) => {
    console.error('[Worker Fatal Error]', err);
    process.exit(1);
  });
}
