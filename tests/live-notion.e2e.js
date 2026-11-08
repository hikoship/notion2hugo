#!/usr/bin/env node
/**
 * tests/live-notion.e2e.js - Live Notion API + Sandboxed Local Git E2E Smoke Test
 *
 * Exercises the real Notion API (creating a temporary page, toggling WIP and Published,
 * querying with server-side filters, and archiving the test page in a finally block)
 * while routing all file and Git operations to an isolated /tmp git repository.
 * Leaves zero trace in ~/GitHub/blog or GitHub.
 */

import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { loadConfig, validateConfig } from '../lib/config.js';
import { NotionHugoWorker } from '../worker.js';
import { extractProperties } from '../lib/frontmatter.js';

function createSandboxedGitEnv() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notion2hugo-live-e2e-'));
  const remoteDir = path.join(tmpRoot, 'remote.git');
  const repoDir = path.join(tmpRoot, 'blog');
  const contentDir = path.join(repoDir, 'content', 'post');
  const syncStatePath = path.join(tmpRoot, '.sync_state.json');

  execFileSync('git', ['init', '--bare', '--initial-branch=main', remoteDir]);
  execFileSync('git', ['clone', remoteDir, repoDir]);
  execFileSync('git', ['config', 'user.name', 'hikoship'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'hikoship@users.noreply.github.com'], { cwd: repoDir });
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Live E2E Sandbox\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'chore: initial commit'], { cwd: repoDir });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir });

  return { tmpRoot, remoteDir, repoDir, contentDir, syncStatePath };
}

async function main() {
  const baseConfig = loadConfig();
  validateConfig(baseConfig, { requireNotion: true });

  const env = createSandboxedGitEnv();
  const worker = new NotionHugoWorker({
    ...baseConfig,
    hugoContentDir: env.contentDir,
    gitRepoDir: env.repoDir,
    syncStatePath: env.syncStatePath,
  });

  const testSlug = `e2e-live-smoke-${Date.now()}`;
  let createdPageId = null;

  try {
    console.log('[Live E2E] 1. Seeding sandbox sync state with existing Notion pages...');
    const existingPages = await worker.notion.queryRecentlyChangedPages(baseConfig.notionDatabaseId, null);
    for (const p of existingPages || []) {
      const props = extractProperties(p);
      if (!props.slug) continue;
      const dummyPath = path.join(env.contentDir, `${props.slug}.md`);
      if (p.properties?.Published?.checkbox) {
        fs.writeFileSync(dummyPath, 'placeholder', 'utf8');
      }
      worker.syncState[p.id] = {
        slug: props.slug,
        lastEditedTime: p.last_edited_time,
        syncedAt: new Date().toISOString(),
      };
    }
    worker.syncState._lastCheckTime = new Date().toISOString();
    worker._saveSyncState();

    console.log(`[Live E2E] 2. Creating temporary Notion page (${testSlug}) with Published=true, WIP=true...`);
    const newPage = await worker.notion.client.pages.create({
      parent: { database_id: baseConfig.notionDatabaseId.replace(/-/g, '') },
      properties: {
        Name: { title: [{ text: { content: `[E2E Temp] ${testSlug}` } }] },
        Filename: { rich_text: [{ text: { content: testSlug } }] },
        Date: { date: { start: '2026-11-08' } },
        Published: { checkbox: true },
        WIP: { checkbox: true },
      },
      children: [
        {
          object: 'block',
          type: 'heading_1',
          heading_1: { rich_text: [{ type: 'text', text: { content: 'Live E2E Heading' } }] },
        },
        {
          object: 'block',
          type: 'video',
          video: { type: 'external', external: { url: 'https://www.youtube.com/watch?v=4aOxDHqWyK0' } },
        },
      ],
    });
    createdPageId = newPage.id;

    console.log('[Live E2E] 3. Running pollOnce() while WIP=true -> verifying article is ignored...');
    const countWip = await worker.pollOnce();
    assert.equal(countWip, 0, 'WIP=true page must be ignored by pollOnce()');
    const targetFile = path.join(env.contentDir, `${testSlug}.md`);
    assert.ok(!fs.existsSync(targetFile), 'Markdown file must not exist while WIP=true');

    console.log('[Live E2E] 4. Updating Notion page to WIP=false, Published=true -> verifying export & git push...');
    await worker.notion.client.pages.update({
      page_id: createdPageId,
      properties: {
        WIP: { checkbox: false },
      },
    });

    const countPub = await worker.pollOnce();
    assert.equal(countPub, 1, 'Page should be exported once WIP=false');
    assert.ok(fs.existsSync(targetFile), 'Exported Markdown file should exist in sandbox repo');
    const exportedMd = fs.readFileSync(targetFile, 'utf8');
    assert.match(exportedMd, /^## Live E2E Heading$/m);
    assert.match(exportedMd, /youtube\.com\/embed\/4aOxDHqWyK0/);

    console.log('[Live E2E] 5. Updating Notion page to Published=false -> verifying git rm & unpublish...');
    await worker.notion.client.pages.update({
      page_id: createdPageId,
      properties: {
        Published: { checkbox: false },
      },
    });

    const countUnpub = await worker.pollOnce();
    assert.equal(countUnpub, 1, 'Unpublished page should be removed by pollOnce()');
    assert.ok(!fs.existsSync(targetFile), 'Unpublished Markdown file should be removed from disk');

    console.log('\n[Live E2E] SUCCESS: All live Notion API + sandboxed Git E2E assertions passed!');
  } finally {
    if (createdPageId) {
      console.log(`[Live E2E] Cleaning up: archiving temporary Notion page ${createdPageId}...`);
      try {
        await worker.notion.client.pages.update({
          page_id: createdPageId,
          archived: true,
        });
      } catch (err) {
        console.error(`[Live E2E] Warning: failed to archive temporary page ${createdPageId}: ${err.message}`);
      }
    }
    fs.rmSync(env.tmpRoot, { recursive: true, force: true });
    console.log('[Live E2E] Cleaned up sandboxed /tmp git directory.');
  }
}

main().catch((err) => {
  console.error('[Live E2E Failure]', err);
  process.exit(1);
});

