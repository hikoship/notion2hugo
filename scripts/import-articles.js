#!/usr/bin/env node
/**
 * scripts/import-articles.js - Migrate Hugo Markdown posts and drafts to Notion database.
 *
 * Usage:
 *   node scripts/import-articles.js --dry-run
 *   node scripts/import-articles.js --limit 1
 *   node scripts/import-articles.js
 */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { markdownToBlocks } from '@tryfabric/martian';
import { loadConfig } from '../lib/config.js';
import { NotionService } from '../lib/notion.js';

const BLOG_DIR = path.resolve('/home/hongyuan/GitHub/blog');
const POSTS_DIR = path.join(BLOG_DIR, 'content', 'post');
const DRAFTS_DIR = path.join(BLOG_DIR, 'content', 'draft');

function parseFrontmatterAndBody(content) {
  let meta = {};
  let body = content;

  // TOML frontmatter +++ ... +++
  const tomlMatch = content.match(/^\+\+\+\s*\n([\s\S]*?)\n\+\+\+\s*\n([\s\S]*)$/);
  if (tomlMatch) {
    const rawMeta = tomlMatch[1];
    body = tomlMatch[2];
    for (const line of rawMeta.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.includes('=')) {
        const [k, ...vParts] = trimmed.split('=');
        const kClean = k.trim().toLowerCase();
        const vClean = vParts.join('=').trim().replace(/^["']|["']$/g, '');
        meta[kClean] = vClean;
      }
    }
    return { meta, body };
  }

  // YAML frontmatter --- ... ---
  const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (yamlMatch) {
    try {
      const parsed = YAML.parse(yamlMatch[1]);
      meta = Object.fromEntries(
        Object.entries(parsed || {}).map(([k, v]) => [k.toLowerCase(), v])
      );
      body = yamlMatch[2];
    } catch {
      // Ignore parse error
    }
    return { meta, body };
  }

  return { meta, body };
}

function cleanMarkdownForMartian(markdownText, imageBaseUrl) {
  let text = markdownText;

  // Convert Hugo highlight shortcodes {{< highlight lang >}} ... {{< / highlight >}} to ```lang
  text = text.replace(/\{\{<\s*highlight\s+([a-zA-Z0-9_-]+)[^>]*>\}\}/gi, '```$1\n');
  text = text.replace(/\{\{<\s*\/\s*highlight\s*>\}\}/gi, '\n```');

  // Convert raw HTML <img src="..." alt="..."> to ![alt](url)
  text = text.replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, '![$2]($1)');
  text = text.replace(/<img\s+[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi, '![$1]($2)');

  // Convert YouTube <iframe> embeds into a placeholder token that postProcessBlocks turns into a Notion video block
  text = text.replace(
    /<iframe[^>]+src=["'][^"']*youtube\.com\/embed\/([a-zA-Z0-9_-]+)[^"']*["'][^>]*>\s*<\/iframe>/gi,
    '\n\nYOUTUBEVIDEOBLOCKTOKEN:$1\n\n'
  );

  // Convert <del>...</del> to ~~...~~
  text = text.replace(/<del>([\s\S]*?)<\/del>/gi, '~~$1~~');

  // Prefix relative image paths with live URL
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
    const trimmedUrl = url.trim();
    if (trimmedUrl.startsWith('/')) {
      return `![${alt}](${imageBaseUrl}${trimmedUrl})`;
    }
    return match;
  });

  // Prefix relative internal links [text](/post/...) with https://blog.hgao.net so Notion API accepts them
  text = text.replace(/(?<!!)\[([^\]]+)\]\(\/([^)]*)\)/g, '[$1](https://blog.hgao.net/$2)');

  // Shift headings up by 1 level (## -> #, ### -> ##, #### -> ###) outside code fences
  // so Markdown H2 maps to Notion Heading 1 (which exports back to Markdown H2)
  const lines = text.split('\n');
  let inCodeFence = false;
  const hasH1 = lines.some((l) => /^#\s+/.test(l));
  if (!hasH1) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('```')) {
        inCodeFence = !inCodeFence;
        continue;
      }
      if (!inCodeFence && /^#{2,4}\s+/.test(lines[i])) {
        lines[i] = lines[i].slice(1);
      }
    }
    text = lines.join('\n');
  }

  return text;
}

function sanitizeRichTextLinks(richText) {
  if (!Array.isArray(richText)) return;
  for (const item of richText) {
    const url = item?.text?.link?.url;
    if (url && !/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) {
      if (url.startsWith('/')) {
        item.text.link.url = `https://blog.hgao.net${url}`;
      } else {
        delete item.text.link;
      }
    }
  }
}

function postProcessBlocks(blocks) {
  return blocks.map((block) => {
    const data = block[block.type];
    if (data?.rich_text) {
      sanitizeRichTextLinks(data.rich_text);
    }
    if (data?.children) {
      data.children = postProcessBlocks(data.children);
    }
    if (block.type === 'paragraph') {
      const plain = (block.paragraph?.rich_text || []).map((t) => t.text?.content || t.plain_text || '').join('').trim();
      const match = plain.match(/^YOUTUBEVIDEOBLOCKTOKEN:([a-zA-Z0-9_-]+)$/);
      if (match) {
        return {
          object: 'block',
          type: 'video',
          video: {
            type: 'external',
            external: {
              url: `https://www.youtube.com/watch?v=${match[1]}`,
            },
          },
        };
      }
    }
    return block;
  });
}

function buildNotionProperties(meta, slug, isDraft, dbSchema) {
  const title = meta.title || slug.replace(/-/g, ' ');
  const rawDate = meta.date || '2021-01-01';
  const dateStr = rawDate.length >= 10 ? rawDate.slice(0, 10) : '2021-01-01';
  const category = meta.categories || meta.category || '';
  const summary = meta.summary || '';

  const props = {};

  // Title property (Name or Title)
  const titlePropName = Object.keys(dbSchema).find((k) => dbSchema[k].type === 'title') || 'Name';
  props[titlePropName] = {
    title: [{ type: 'text', text: { content: title } }],
  };

  // Slug / Filename property
  if (dbSchema['Filename']) {
    props['Filename'] = {
      rich_text: [{ type: 'text', text: { content: slug } }],
    };
  } else if (dbSchema['Slug']) {
    props['Slug'] = {
      rich_text: [{ type: 'text', text: { content: slug } }],
    };
  }

  // Date property
  if (dbSchema['Date']) {
    props['Date'] = {
      date: { start: dateStr },
    };
  }

  // Publication status
  if (dbSchema['Status']) {
    props['Status'] = {
      status: { name: isDraft ? 'Draft' : 'Published' },
    };
  } else if (dbSchema['Published']) {
    props['Published'] = {
      checkbox: !isDraft,
    };
  }

  // Category
  if (category && (dbSchema['Category'] || dbSchema['Categories'])) {
    const catPropName = dbSchema['Category'] ? 'Category' : 'Categories';
    props[catPropName] = {
      select: { name: String(category).trim() },
    };
  }

  // Summary
  if (summary && dbSchema['Summary']) {
    props['Summary'] = {
      rich_text: [{ type: 'text', text: { content: summary.slice(0, 1900) } }],
    };
  }

  return props;
}

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const overwrite = args.includes('--overwrite');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;

  const config = loadConfig();
  if (!config.notionApiKey || !config.notionDatabaseId) {
    console.error('Error: NOTION_API_KEY and NOTION_DATABASE_ID must be set in .env');
    process.exit(1);
  }

  const notion = new NotionService(config.notionApiKey, config.notionApiVersion);
  const imageBaseUrl = (config.imageBaseUrl || 'https://blog.hgao.net').replace(/\/+$/, '');

  // 1. Fetch database schema
  console.log(`Querying Notion database schema: ${config.notionDatabaseId}...`);
  const db = await notion.getDatabase(config.notionDatabaseId);
  const dbSchema = db.properties;
  console.log(`Database Title: '${db.title?.map((t) => t.plain_text).join('')}'`);
  console.log('Available properties:', Object.keys(dbSchema).join(', '));

  // 2. Fetch existing pages to prevent duplicates
  console.log('Checking existing pages in Notion database to avoid duplicates...');
  const existingPages = [];
  let cursor = undefined;
  while (true) {
    const res = await notion.client.databases.query({
      database_id: config.notionDatabaseId.replace(/-/g, ''),
      page_size: 100,
      start_cursor: cursor,
    });
    existingPages.push(...(res.results || []));
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  const existingSlugs = new Map();
  for (const p of existingPages) {
    const fn =
      p.properties.Filename?.rich_text?.map((t) => t.plain_text).join('') ||
      p.properties.Slug?.rich_text?.map((t) => t.plain_text).join('');
    if (fn) existingSlugs.set(fn, p.id);
  }
  console.log(`Found ${existingPages.length} existing page(s) in Notion (${existingSlugs.size} with slug/filename).`);

  // 3. Collect local articles
  const items = [];
  if (fs.existsSync(POSTS_DIR)) {
    const postFiles = fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md') && !f.startsWith('.'));
    for (const f of postFiles.sort()) {
      items.push({ file: path.join(POSTS_DIR, f), isDraft: false });
    }
  }

  if (fs.existsSync(DRAFTS_DIR)) {
    const draftFiles = fs.readdirSync(DRAFTS_DIR).filter((f) => f.endsWith('.md') && !f.startsWith('.'));
    for (const f of draftFiles.sort()) {
      items.push({ file: path.join(DRAFTS_DIR, f), isDraft: true });
    }
  }

  console.log('\n============================================================');
  console.log(`NOTION ARTICLE MIGRATION PLAN (${items.length} total local files)`);
  console.log('============================================================');

  let importedCount = 0;
  let skippedCount = 0;

  const toProcess = limit ? items.slice(0, limit) : items;

  for (let idx = 0; idx < toProcess.length; idx++) {
    const { file, isDraft } = toProcess[idx];
    const baseSlug = path.basename(file, '.md');
    const slug = isDraft && fs.existsSync(path.join(POSTS_DIR, `${baseSlug}.md`))
      ? `${baseSlug}-draft`
      : baseSlug;
    const content = fs.readFileSync(file, 'utf8');

    const { meta, body } = parseFrontmatterAndBody(content);
    const title = meta.title || slug;
    const statusName = isDraft ? 'Draft' : 'Published';

    // Check if already in Notion
    if (existingSlugs.has(slug) && !overwrite) {
      console.log(`[${idx + 1}/${toProcess.length}] [SKIPPING] Already exists in Notion: '${title}' (slug: ${slug})`);
      skippedCount++;
      continue;
    }

    const cleanedBody = cleanMarkdownForMartian(body, imageBaseUrl);
    const blocks = postProcessBlocks(markdownToBlocks(cleanedBody));
    const properties = buildNotionProperties(meta, slug, isDraft, dbSchema);

    console.log(`[${idx + 1}/${toProcess.length}] [IMPORTING] '${title}' (slug: ${slug})`);
    console.log(`       Status: ${statusName} | Blocks: ${blocks.length} | Date: ${meta.date || 'none'}`);

    if (isDryRun) {
      importedCount++;
      continue;
    }

  function blockSignature(block) {
  const type = block.type;
  const data = block[type] || {};
  if (type === 'image' || type === 'video') {
    return `${type}:${data.external?.url || data.file?.url || ''}`;
  }
  if (type === 'divider') {
    return 'divider';
  }
  const rt = (data.rich_text || []).map((t) => {
    const content = t.text?.content ?? t.plain_text ?? '';
    const link = t.text?.link?.url ?? t.href ?? '';
    const a = t.annotations || {};
    const flags = [
      a.bold ? 'b' : '',
      a.italic ? 'i' : '',
      a.strikethrough ? 's' : '',
      a.underline ? 'u' : '',
      a.code ? 'c' : '',
    ].join('');
    return `${content}|${link}|${flags}`;
  }).join('~');
  return `${type}:${data.language || ''}:${data.checked ?? ''}:${rt}`;
}

async function updatePageInPlace(notion, pageId, properties, newBlocks) {
  // 1. Update page properties
  await notion.client.pages.update({
    page_id: pageId,
    properties,
  });

  // 2. Fetch existing top-level blocks
  const existingBlocks = await notion.getAllBlocks(pageId, false);

  // Find first index where block type or structure is incompatible for in-place update
  let divergeIdx = 0;
  const minLen = Math.min(existingBlocks.length, newBlocks.length);
  while (divergeIdx < minLen) {
    const oldB = existingBlocks[divergeIdx];
    const newB = newBlocks[divergeIdx];
    const newData = newB[newB.type] || {};
    const canUpdateInPlace =
      oldB.type === newB.type &&
      !oldB.has_children &&
      !newData.children &&
      newB.type !== 'table';
    if (!canUpdateInPlace) break;
    divergeIdx++;
  }

  let updatedBlocks = 0;
  // Update compatible prefix blocks in-place only if their content changed
  for (let i = 0; i < divergeIdx; i++) {
    const oldB = existingBlocks[i];
    const newB = newBlocks[i];
    if (blockSignature(oldB) !== blockSignature(newB)) {
      const type = newB.type;
      await notion.client.blocks.update({
        block_id: oldB.id,
        [type]: newB[type],
      });
      updatedBlocks++;
      await new Promise((res) => setTimeout(res, 150));
    }
  }

  // Delete remaining old blocks from divergeIdx onward
  let deletedBlocks = 0;
  for (let i = divergeIdx; i < existingBlocks.length; i++) {
    await notion.client.blocks.delete({ block_id: existingBlocks[i].id });
    deletedBlocks++;
    await new Promise((res) => setTimeout(res, 150));
  }

  // Append remaining new blocks from divergeIdx onward
  const toAppend = newBlocks.slice(divergeIdx);
  let bCursor = 0;
  while (bCursor < toAppend.length) {
    const chunk = toAppend.slice(bCursor, bCursor + 100);
    bCursor += 100;
    await notion.client.blocks.children.append({
      block_id: pageId,
      children: chunk,
    });
    await new Promise((res) => setTimeout(res, 350));
  }

  console.log(
    `       -> Updated in-place! Page ID: ${pageId} (updated: ${updatedBlocks}, deleted: ${deletedBlocks}, appended: ${toAppend.length})`
  );
}
    try {
      if (existingSlugs.has(slug) && overwrite) {
        const existingPageId = existingSlugs.get(slug);
        console.log(`       Updating existing page '${slug}' in-place (${existingPageId})...`);
        await updatePageInPlace(notion, existingPageId, properties, blocks);
      } else {
        const initialBlocks = blocks.slice(0, 100);
        const remainingBlocks = blocks.slice(100);

        const newPage = await notion.client.pages.create({
          parent: { database_id: config.notionDatabaseId.replace(/-/g, '') },
          properties,
          children: initialBlocks,
        });

        const pageId = newPage.id;

        // Append remaining blocks
        let bCursor = 0;
        while (bCursor < remainingBlocks.length) {
          const chunk = remainingBlocks.slice(bCursor, bCursor + 100);
          bCursor += 100;
          await notion.client.blocks.children.append({
            block_id: pageId,
            children: chunk,
          });
          await new Promise((res) => setTimeout(res, 350));
        }

        console.log(`       -> Created! Page ID: ${pageId}`);
        existingSlugs.set(slug, pageId);
      }
      importedCount++;
      await new Promise((res) => setTimeout(res, 400));
    } catch (err) {
      console.error(`       [ERROR] Failed to import ${slug}: ${err.message}`);
    }
  }

  console.log('\n============================================================');
  console.log(`Migration Summary:`);
  console.log(`  - Imported: ${importedCount}`);
  console.log(`  - Skipped (already in Notion): ${skippedCount}`);
  console.log(`  - Total local articles: ${items.length}`);
  console.log('============================================================');
}

main().catch((err) => {
  console.error('[Import Error]', err);
  process.exit(1);
});
