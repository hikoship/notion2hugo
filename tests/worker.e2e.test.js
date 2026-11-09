import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { NotionHugoWorker } from '../worker.js';

function createSandboxedGitEnv() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notion2hugo-e2e-'));
  const remoteDir = path.join(tmpRoot, 'remote.git');
  const repoDir = path.join(tmpRoot, 'blog');
  const contentDir = path.join(repoDir, 'content', 'post');
  const syncStatePath = path.join(tmpRoot, '.sync_state.json');

  // 1. Initialize bare remote repository
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remoteDir]);

  // 2. Clone working repository and create initial commit on main
  execFileSync('git', ['clone', remoteDir, repoDir]);
  execFileSync('git', ['config', 'user.name', 'hikoship'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'hikoship@users.noreply.github.com'], { cwd: repoDir });
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Sandboxed Blog\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'chore: initial commit'], { cwd: repoDir });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir });

  return { tmpRoot, remoteDir, repoDir, contentDir, syncStatePath };
}

function makeNotionPage({
  id = 'page-e2e-1',
  title = 'E2E Test Article',
  slug = 'e2e-test-article',
  date = '2026-11-08',
  published = true,
  wip = false,
  lastEditedTime = '2026-11-08T10:00:00.000Z',
}) {
  return {
    id,
    last_edited_time: lastEditedTime,
    created_time: '2026-11-08T09:00:00.000Z',
    properties: {
      Name: { title: [{ plain_text: title }] },
      Filename: { rich_text: [{ plain_text: slug }] },
      Date: { date: { start: date } },
      Category: { type: 'select', select: { name: 'Tech' } },
      Summary: { rich_text: [{ plain_text: 'E2E summary' }] },
      Published: { checkbox: published },
      WIP: { checkbox: wip },
    },
  };
}

test('Sandboxed E2E: Publish -> Idempotent Poll -> WIP Ignore -> Uncheck WIP -> Rename Slug -> Unpublish', async (t) => {
  const env = createSandboxedGitEnv();
  t.after(() => {
    fs.rmSync(env.tmpRoot, { recursive: true, force: true });
  });

  const worker = new NotionHugoWorker({
    notionApiKey: 'secret_sandbox',
    notionDatabaseId: '0341d5b6-2282-4928-ae97-ebfb4fc8bff8',
    notionApiVersion: '2022-06-28',
    pollIntervalSeconds: 300,
    hugoContentDir: env.contentDir,
    gitRepoDir: env.repoDir,
    gitBranch: 'main',
    gitRemote: 'origin',
    gitCommitAuthorName: 'hikoship',
    gitCommitAuthorEmail: 'hikoship@users.noreply.github.com',
    syncStatePath: env.syncStatePath,
  });

  let currentPage = makeNotionPage({
    published: true,
    wip: false,
    lastEditedTime: '2026-11-08T10:00:00.000Z',
  });
  let currentBodyText = 'Version 1 body content.';

  // Stub Notion API calls on worker.notion
  worker.notion.queryRecentlyChangedPages = async () => {
    if (currentPage.properties.WIP.checkbox) return [];
    return [currentPage];
  };
  worker.notion.getPage = async () => currentPage;
  worker.notion.getAllBlocks = async () => [
    {
      type: 'heading_1',
      heading_1: { rich_text: [{ plain_text: 'Section One' }] },
    },
    {
      type: 'paragraph',
      paragraph: { rich_text: [{ plain_text: currentBodyText }] },
    },
  ];
  worker.notion.updatePageStatus = async () => currentPage;

  // --- Step 1: Initial Publish (Published=true, WIP=false) ---
  const count1 = await worker.pollOnce();
  assert.equal(count1, 1);

  const mdPath1 = path.join(env.contentDir, 'e2e-test-article.md');
  assert.ok(fs.existsSync(mdPath1), 'Markdown file should be created on disk');
  const mdContent1 = fs.readFileSync(mdPath1, 'utf8');
  assert.match(mdContent1, /title: "E2E Test Article"/);
  assert.match(mdContent1, /categories: "Tech"/);
  assert.match(mdContent1, /## Section One/);
  assert.match(mdContent1, /Version 1 body content\./);

  // Verify pushed to bare remote
  const remoteFiles1 = execFileSync('git', ['ls-tree', '--name-only', 'main', 'content/post/'], {
    cwd: env.remoteDir,
  }).toString();
  assert.match(remoteFiles1, /content\/post\/e2e-test-article\.md/);

  // --- Step 2: Idempotent Poll (no changes to last_edited_time) ---
  const count2 = await worker.pollOnce();
  assert.equal(count2, 0, 'Unchanged page should not be re-exported');

  // --- Step 2.5: Dirty blog repo check (uncommitted changes skip Notion query) ---
  let notionQueriedWhileDirty = false;
  const origQuery = worker.notion.queryRecentlyChangedPages;
  worker.notion.queryRecentlyChangedPages = async (...args) => {
    notionQueriedWhileDirty = true;
    return origQuery(...args);
  };
  const dirtyFile = path.join(env.repoDir, 'uncommitted-file.txt');
  fs.writeFileSync(dirtyFile, 'dirty working tree', 'utf8');
  const countDirty = await worker.pollOnce();
  assert.equal(countDirty, 0, 'Poll must return 0 when blog repo has uncommitted changes');
  assert.equal(notionQueriedWhileDirty, false, 'Notion must not be queried when blog repo is dirty');
  fs.unlinkSync(dirtyFile);
  worker.notion.queryRecentlyChangedPages = origQuery;

  // --- Step 3: Edit while WIP=true (should be ignored) ---
  currentPage = makeNotionPage({
    published: true,
    wip: true,
    lastEditedTime: '2026-11-08T10:05:00.000Z',
  });
  currentBodyText = 'WIP draft changes that must not be published yet.';

  const count3 = await worker.pollOnce();
  assert.equal(count3, 0, 'WIP article must be ignored');
  assert.match(fs.readFileSync(mdPath1, 'utf8'), /Version 1 body content\./);

  // --- Step 4: Uncheck WIP (Published=true, WIP=false) -> exports Version 2 ---
  currentPage = makeNotionPage({
    published: true,
    wip: false,
    lastEditedTime: '2026-11-08T10:10:00.000Z',
  });
  currentBodyText = 'Version 2 finalized content.';

  const count4 = await worker.pollOnce();
  assert.equal(count4, 1, 'Unchecked WIP article with newer last_edited_time should export');
  assert.match(fs.readFileSync(mdPath1, 'utf8'), /Version 2 finalized content\./);

  // --- Step 5: Rename Filename slug (e2e-test-article -> e2e-renamed) ---
  currentPage = makeNotionPage({
    slug: 'e2e-renamed',
    published: true,
    wip: false,
    lastEditedTime: '2026-11-08T10:15:00.000Z',
  });

  const count5 = await worker.pollOnce();
  assert.equal(count5, 1);
  const mdPathRenamed = path.join(env.contentDir, 'e2e-renamed.md');
  assert.ok(!fs.existsSync(mdPath1), 'Old slug file should be removed');
  assert.ok(fs.existsSync(mdPathRenamed), 'New slug file should exist');

  // --- Step 6: Unpublish (Published=false, WIP=false) -> removes file from GitHub ---
  currentPage = makeNotionPage({
    slug: 'e2e-renamed',
    published: false,
    wip: false,
    lastEditedTime: '2026-11-08T10:20:00.000Z',
  });

  const count6 = await worker.pollOnce();
  assert.equal(count6, 1, 'Unpublished article should be removed from git');
  assert.ok(!fs.existsSync(mdPathRenamed), 'Unpublished file should be deleted from disk');

  const remoteFilesAfterUnpublish = execFileSync('git', ['ls-tree', '--name-only', 'main', 'content/post/'], {
    cwd: env.remoteDir,
  }).toString();
  assert.equal(remoteFilesAfterUnpublish.trim(), '', 'Remote content/post/ should be empty after unpublish');

  const syncStateFinal = JSON.parse(fs.readFileSync(env.syncStatePath, 'utf8'));
  assert.equal(syncStateFinal['page-e2e-1'], undefined, 'Unpublished page should be removed from .sync_state.json');
});

test('Hugo Build Verification: Exported Markdown renders expected HTML elements via Hugo', async (t) => {
  const blogDir = '/home/hongyuan/GitHub/blog';
  if (!fs.existsSync(blogDir)) {
    t.skip('Local blog repository not found');
    return;
  }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notion2hugo-hugo-build-'));
  t.after(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  execFileSync('hugo', ['--source', blogDir, '--destination', outDir, '--gc']);

  // Verify 2006-world-cup-memory HTML rendering (headings, image alt captions, YouTube iframe, footnotes)
  const wcHtmlPath = path.join(outDir, 'post', '2006-world-cup-memory', 'index.html');
  assert.ok(fs.existsSync(wcHtmlPath), '2006-world-cup-memory/index.html should be generated by Hugo');
  const wcHtml = fs.readFileSync(wcHtmlPath, 'utf8');
  assert.match(wcHtml, /<h2>德国世界杯十周年回忆录<\/h2>/);
  assert.match(wcHtml, /<iframe[^>]+src="https:\/\/www\.youtube\.com\/embed\/4aOxDHqWyK0"[^>]*><\/iframe>/);
  assert.match(
    wcHtml,
    /<img src="https:\/\/ik\.imagekit\.io\/hikoship\/blog\/2006-world-cup-memory\/wc2006-logo\.jpg" alt="二〇〇六世界杯会徽">/
  );
  assert.match(wcHtml, /<h2 id="前奏">前奏<\/h2>/);
  assert.match(wcHtml, /<h2 id="启航">启航<\/h2>/);
  assert.match(wcHtml, /class="footnote-ref"/);
});


