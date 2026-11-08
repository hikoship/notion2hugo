#!/usr/bin/env node
/**
 * scripts/verify-roundtrip.js - Compare original Hugo posts with Notion-exported posts.
 *
 * Usage:
 *   node scripts/verify-roundtrip.js --exported-dir /tmp/notion_exported_posts
 */

import fs from 'fs';
import path from 'path';

const BLOG_POSTS_DIR = path.resolve('/home/hongyuan/GitHub/blog/content/post');

function normalize(text) {
  // Strip frontmatter
  let clean = text.replace(/^\+\+\+[\s\S]*?\+\+\+\s*/, '').replace(/^---[\s\S]*?---\s*/, '');
  // Normalize whitespace
  return clean
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const expIdx = args.indexOf('--exported-dir');
  if (expIdx === -1 || !args[expIdx + 1]) {
    console.error('Usage: node scripts/verify-roundtrip.js --exported-dir <path>');
    process.exit(1);
  }

  const exportedDir = path.resolve(args[expIdx + 1]);
  if (!fs.existsSync(exportedDir)) {
    console.error(`Exported directory does not exist: ${exportedDir}`);
    process.exit(1);
  }

  const originalFiles = fs.readdirSync(BLOG_POSTS_DIR).filter((f) => f.endsWith('.md') && !f.startsWith('.'));
  const exportedFiles = fs.readdirSync(exportedDir).filter((f) => f.endsWith('.md') && !f.startsWith('.'));

  const origSet = new Set(originalFiles);
  const expSet = new Set(exportedFiles);

  console.log('============================================================');
  console.log('ROUNDTRIP FIDELITY VERIFICATION');
  console.log('============================================================');
  console.log(`Original posts in blog/content/post: ${originalFiles.length}`);
  console.log(`Exported posts in target dir:       ${exportedFiles.length}`);

  let exactMatches = 0;
  let diffs = 0;

  for (const filename of originalFiles) {
    if (!expSet.has(filename)) {
      console.warn(`[MISSING IN EXPORT] ${filename}`);
      continue;
    }

    const origContent = normalize(fs.readFileSync(path.join(BLOG_POSTS_DIR, filename), 'utf8'));
    const expContent = normalize(fs.readFileSync(path.join(exportedDir, filename), 'utf8'));

    if (origContent === expContent) {
      exactMatches++;
    } else {
      diffs++;
      console.log(`[DIFF DETECTED] in ${filename}`);
    }
  }

  console.log('\n============================================================');
  console.log(`Verification Results: ${exactMatches} exact matches, ${diffs} with formatting diffs.`);
  console.log('============================================================');
}

main();

