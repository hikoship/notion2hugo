#!/usr/bin/env node
/**
 * scripts/inventory-images.js - Audit image usage across all blog Markdown files.
 */

import fs from 'fs';
import path from 'path';

const BLOG_DIR = path.resolve('/home/hongyuan/GitHub/blog');
const CONTENT_DIR = path.join(BLOG_DIR, 'content');
const STATIC_IMAGES_DIR = path.join(BLOG_DIR, 'static', 'images', 'post');

function getFiles(dir, ext = '.md') {
  let files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(getFiles(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext) && !entry.name.startsWith('.')) {
      files.push(fullPath);
    }
  }
  return files;
}

function getDiskFiles(dir) {
  let files = [];
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(getDiskFiles(fullPath));
    } else if (entry.isFile() && !entry.name.startsWith('.')) {
      files.push(fullPath);
    }
  }
  return files;
}

function main() {
  console.log(`Scanning blog markdown files in: ${CONTENT_DIR}`);
  const mdFiles = getFiles(CONTENT_DIR);
  console.log(`Total markdown files found: ${mdFiles.length}`);

  const mdImgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const htmlImgRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/g;

  const localImagesInPosts = new Map();
  const externalImagesInPosts = new Map();

  for (const mdFile of mdFiles) {
    const relPath = path.relative(BLOG_DIR, mdFile);
    const content = fs.readFileSync(mdFile, 'utf8');

    let match;
    while ((match = mdImgRe.exec(content)) !== null) {
      const url = match[2].split(/\s+/)[0].trim();
      if (url.startsWith('/') || !url.startsWith('http')) {
        const list = localImagesInPosts.get(url) || [];
        list.push(relPath);
        localImagesInPosts.set(url, list);
      } else {
        const list = externalImagesInPosts.get(url) || [];
        list.push(relPath);
        externalImagesInPosts.set(url, list);
      }
    }

    while ((match = htmlImgRe.exec(content)) !== null) {
      const url = match[1].split(/\s+/)[0].trim();
      if (url.startsWith('/') || !url.startsWith('http')) {
        const list = localImagesInPosts.get(url) || [];
        list.push(relPath);
        localImagesInPosts.set(url, list);
      } else {
        const list = externalImagesInPosts.get(url) || [];
        list.push(relPath);
        externalImagesInPosts.set(url, list);
      }
    }
  }

  const diskFiles = getDiskFiles(STATIC_IMAGES_DIR).map((f) =>
    path.relative(path.join(BLOG_DIR, 'static'), f)
  );

  console.log('\n============================================================');
  console.log('IMAGE INVENTORY SUMMARY');
  console.log('============================================================');
  console.log(`1. Local image references in posts:    ${localImagesInPosts.size} unique paths`);
  console.log(`2. External image references in posts: ${externalImagesInPosts.size} unique URLs`);
  console.log(`3. Files stored on disk:              ${diskFiles.length} files in static/images/post`);

  console.log('\n--- Disk Files in static/images/post: ---');
  for (const df of diskFiles.sort()) {
    console.log(`  - /${df}`);
  }

  console.log('\n--- External Image Domains: ---');
  const domainCounts = {};
  for (const url of externalImagesInPosts.keys()) {
    try {
      const domain = new URL(url).hostname;
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    } catch {
      domainCounts['invalid'] = (domainCounts['invalid'] || 0) + 1;
    }
  }
  for (const [domain, count] of Object.entries(domainCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${domain}: ${count} images`);
  }
  console.log('============================================================');
}

main();

