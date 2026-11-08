#!/usr/bin/env node
/**
 * scripts/export-all.js - Export all pages from Notion database to Hugo Markdown files.
 *
 * Usage:
 *   node scripts/export-all.js --output-dir /tmp/notion_exported_posts
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, validateConfig } from '../lib/config.js';
import { NotionService } from '../lib/notion.js';
import { extractProperties, renderYamlFrontmatter } from '../lib/frontmatter.js';
import { BlockParser } from '../lib/blocks-to-md.js';
import { createImageStore } from '../lib/image-store.js';

async function main() {
  const args = process.argv.slice(2);
  const outDirIdx = args.indexOf('--output-dir');
  const outDir = path.resolve(outDirIdx !== -1 ? args[outDirIdx + 1] : '/tmp/notion_exported_posts');

  const config = loadConfig();
  validateConfig(config, { requireNotion: true });

  const notion = new NotionService(config.notionApiKey, config.notionApiVersion);
  const imageStore = createImageStore(config);

  await fs.promises.mkdir(outDir, { recursive: true });
  console.log(`Querying Notion database: ${config.notionDatabaseId}...`);

  const results = [];
  let startCursor = undefined;

  while (true) {
    const resp = await notion.client.databases.query({
      database_id: config.notionDatabaseId.replace(/-/g, ''),
      page_size: 100,
      start_cursor: startCursor,
    });
    results.push(...(resp.results || []));
    if (!resp.has_more) break;
    startCursor = resp.next_cursor;
  }

  console.log(`Found ${results.length} pages in Notion. Exporting to ${outDir}...`);

  for (let idx = 0; idx < results.length; idx++) {
    const page = results[idx];
    const props = extractProperties(page);
    const slug = props.slug;
    const title = props.title || 'Untitled';

    if (!slug) {
      console.warn(`[${idx + 1}/${results.length}] Skipping page without slug: ${page.id}`);
      continue;
    }

    console.log(`[${idx + 1}/${results.length}] Exporting: '${title}' (${slug}.md)...`);
    const blocks = await notion.getAllBlocks(page.id, true);
    const parser = new BlockParser({ imageStore, postSlug: slug });
    const body = await parser.parseBlocks(blocks);
    const frontmatter = renderYamlFrontmatter(props);

    const targetFile = path.join(outDir, `${slug}.md`);
    await fs.promises.writeFile(targetFile, frontmatter + body, 'utf8');
  }

  console.log(`\nAll articles exported successfully to: ${outDir}`);
}

main().catch((err) => {
  console.error('[Export Error]', err);
  process.exit(1);
});

