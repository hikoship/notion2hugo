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
    const isWip = Boolean(page.properties?.WIP?.checkbox);

    if (isWip) {
      console.log(`[Worker] Page '${title}' (${slug}) is marked WIP. Ignoring.`);
      return false;
    }

    if (!slug) {
      console.error(`[Worker] Page ${pageId} has no valid slug/filename. Aborting.`);
      return false;
    }

    console.log(`[Worker] Article: '${title}' | Slug: '${slug}' | Date: '${props.date || 'none'}'`);

    // 2. Fetch all blocks recursively
    console.log(`[Worker] Fetching blocks recursively...`);
    const blocks = await this.notion.getAllBlocks(pageId, true);
    console.log(`[Worker] Retrieved ${blocks.length} top-level blocks.`);

    // 3. Convert blocks to Markdown
    const parser = new BlockParser({
      imageStore: this.imageStore,
      postSlug: slug,
    });
    const bodyMarkdown = await parser.parseBlocks(blocks);

    // 4. Generate YAML frontmatter
    const frontmatterYaml = renderYamlFrontmatter(props);
    const fullDocument = frontmatterYaml + bodyMarkdown;

    // 5. Pull latest git changes before writing to disk so git rebase never fails on unstaged edits
    try {
      await this.git.pullLatest();

      await fs.promises.mkdir(this.config.hugoContentDir, { recursive: true });
      const destFile = path.join(this.config.hugoContentDir, `${slug}.md`);
      console.log(`[Worker] Writing generated markdown to: ${destFile}`);
      await fs.promises.writeFile(destFile, fullDocument, 'utf8');

      // If the page's Filename (slug) was renamed since last sync, remove the old file
      const prevSlug = this.syncState[page.id]?.slug;
      if (prevSlug && prevSlug !== slug) {
        const oldFile = path.join(this.config.hugoContentDir, `${prevSlug}.md`);
        if (fs.existsSync(oldFile)) {
          await this.git.removeFile(oldFile, `chore(post): remove renamed post ${prevSlug} -> ${slug}`);
        }
      }

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

  async unpublishPage(pageId, slug, title = slug) {
    const destFile = path.join(this.config.hugoContentDir, `${slug}.md`);
    if (!fs.existsSync(destFile)) {
      if (this.syncState[pageId]) {
        delete this.syncState[pageId];
        this._saveSyncState();
      }
      return false;
    }

    console.log(`\n============================================================`);
    console.log(`[Worker] Unpublishing non-public post from GitHub: '${title}' (${slug}.md)`);
    console.log(`============================================================`);

    try {
      await this.git.pullLatest();
      const commitMsg = `unpublish(post): ${slug} - '${title}'`;
      const removed = await this.git.removeFile(destFile, commitMsg);

      if (removed) {
        await this.git.push();
        const verified = await this.git.verifyPush();
        if (!verified) {
          console.error(`[Worker] Git push verification failed when unpublishing '${slug}'!`);
          return false;
        }
      }
    } catch (gitErr) {
      console.error(`[Worker] Git removal failed for '${slug}': ${gitErr.message}`);
      return false;
    }

    if (this.syncState[pageId]) {
      delete this.syncState[pageId];
      this._saveSyncState();
    }
    console.log(`[Worker] Successfully removed unpublished post: ${slug}\n`);
    return true;
  }

  async pollOnce() {
    if (isProcessing) {
      console.warn(`[Worker] Processing lock active. Skipping poll iteration.`);
      return 0;
    }

    const isClean = await this.git.isWorkingTreeClean();
    if (!isClean) {
      console.warn(
        `[Worker] Blog repository (${this.config.gitRepoDir}) has uncommitted changes. Skipping poll iteration.`
      );
      return 0;
    }

    this.syncState = this._loadSyncState();
    const pollStartTimeIso = new Date().toISOString();
    // Subtract a 2-minute window from _lastCheckTime to account for Notion's 1-minute last_edited_time resolution
    const cutoffIso = this.syncState._lastCheckTime
      ? new Date(Date.parse(this.syncState._lastCheckTime) - 2 * 60 * 1000).toISOString()
      : null;

    const changedPages = await this.notion.queryRecentlyChangedPages(
      this.config.notionDatabaseId,
      cutoffIso
    );
    if (!changedPages) {
      return 0;
    }

    const toPublish = [];
    const toUnpublish = [];

    for (const page of changedPages) {
      const isWip = Boolean(page.properties?.WIP?.checkbox);

      // 1. If an article is WIP, ignore it completely
      if (isWip) {
        continue;
      }

      const props = extractProperties(page);
      const slug = props.slug;
      const title = props.title || slug;
      if (!slug) continue;

      const isPublic =
        Boolean(page.properties?.Published?.checkbox) ||
        ['Publish', 'Published'].includes(page.properties?.Status?.status?.name);

      const destFile = path.join(this.config.hugoContentDir, `${slug}.md`);

      if (isPublic) {
        // 2. Public, non-WIP post: export only if recently changed or file missing on disk
        const prev = this.syncState[page.id];
        const isRecentlyChanged =
          !prev ||
          prev.lastEditedTime !== page.last_edited_time ||
          prev.slug !== slug ||
          !fs.existsSync(destFile);

        if (isRecentlyChanged) {
          toPublish.push(page);
        }
      } else {
        // 3. Not public & not WIP: remove from GitHub if it currently exists in content/post/
        if (fs.existsSync(destFile)) {
          toUnpublish.push({ pageId: page.id, slug, title });
        } else if (this.syncState[page.id]) {
          const oldSlug = this.syncState[page.id].slug;
          const oldFile = path.join(this.config.hugoContentDir, `${oldSlug}.md`);
          if (fs.existsSync(oldFile)) {
            toUnpublish.push({ pageId: page.id, slug: oldSlug, title });
          } else {
            delete this.syncState[page.id];
            this._saveSyncState();
          }
        }
      }
    }

    if (toPublish.length === 0 && toUnpublish.length === 0) {
      this.syncState._lastCheckTime = pollStartTimeIso;
      this._saveSyncState();
      return 0;
    }

    let processedCount = 0;
    let failedCount = 0;

    for (const item of toUnpublish) {
      if (shouldTerminate) break;
      isProcessing = true;
      try {
        const removed = await this.unpublishPage(item.pageId, item.slug, item.title);
        if (removed) processedCount++;
      } catch (err) {
        failedCount++;
        console.error(`[Worker] Error unpublishing ${item.slug}: ${err.message}`);
      } finally {
        isProcessing = false;
      }
    }

    if (toPublish.length > 0) {
      console.log(`[Worker] Found ${toPublish.length} public, non-WIP, recently changed article(s) to export.`);
    }

    for (const page of toPublish) {
      if (shouldTerminate) break;
      isProcessing = true;
      try {
        const success = await this.processPage(page.id);
        if (success) processedCount++;
        else failedCount++;
      } catch (err) {
        failedCount++;
        console.error(`[Worker] Unexpected error processing page ${page.id}: ${err.message}`);
      } finally {
        isProcessing = false;
      }
    }

    if (failedCount === 0 && !shouldTerminate) {
      this.syncState._lastCheckTime = pollStartTimeIso;
      this._saveSyncState();
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
      const isClean = await worker.git.isWorkingTreeClean();
      if (!isClean) {
        console.error(
          `[Worker] Blog repository (${config.gitRepoDir}) has uncommitted changes. Aborting.`
        );
        process.exit(1);
      }
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
