#!/usr/bin/env node
/**
 * scripts/migrate-images.js - Upload local images to ImageKit (or R2) and update Markdown posts.
 *
 * Usage:
 *   node scripts/migrate-images.js --dry-run
 *   node scripts/migrate-images.js
 */

import fs from 'fs';
import path from 'path';
import { loadConfig } from '../lib/config.js';
import { ImageKitStore, R2ImageStore } from '../lib/image-store.js';

const BLOG_DIR = path.resolve('/home/hongyuan/GitHub/blog');
const CONTENT_DIR = path.join(BLOG_DIR, 'content');
const STATIC_IMAGES_DIR = path.join(BLOG_DIR, 'static', 'images', 'post');

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

function getMdFiles(dir) {
  let files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(getMdFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  let isDryRun = args.includes('--dry-run');
  const noBackup = args.includes('--no-backup');

  const config = loadConfig();

  const useImageKit = Boolean(config.imagekitPrivateKey);
  const useR2 = Boolean(
    config.r2AccountId &&
    config.r2AccessKeyId &&
    config.r2SecretAccessKey &&
    config.r2Bucket &&
    config.imageBaseUrl
  );

  if (!useImageKit && !useR2) {
    console.log('\n[!] Image storage credentials are not set in .env.');
    console.log('    To use ImageKit, please set:');
    console.log(`    IMAGEKIT_PRIVATE_KEY: ${config.imagekitPrivateKey ? '[SET]' : '[EMPTY]'}`);
    console.log(`    IMAGEKIT_URL_ENDPOINT: ${config.imagekitUrlEndpoint}`);
    console.log('\nRunning in DRY-RUN mode to show planned ImageKit mappings...\n');
    isDryRun = true;
  }

  const diskFiles = getDiskFiles(STATIC_IMAGES_DIR);
  console.log(`Found ${diskFiles.length} local image files on disk in static/images/post.`);

  const mdFiles = getMdFiles(CONTENT_DIR);
  const mdContents = mdFiles.map((f) => ({
    file: f,
    slug: path.basename(f, '.md'),
    content: fs.readFileSync(f, 'utf8'),
  }));

  const imagekitBase = (config.imagekitUrlEndpoint || 'https://ik.imagekit.io/hikoship').replace(/\/+$/, '');
  const urlMapping = new Map();

  for (const file of diskFiles) {
    const relFromStatic = path.relative(path.join(BLOG_DIR, 'static'), file); // images/post/cellphone/nokia-3230.jpg
    const slashRel = `/${relFromStatic}`;

    // Find which post references this image
    const referencingPost = mdContents.find(
      (m) => m.content.includes(slashRel) || m.content.includes(relFromStatic)
    );
    const postSlug = referencingPost ? referencingPost.slug : 'post';
    const remoteFolder = `/blog/${postSlug}`;
    const remoteUrl = `${imagekitBase}${remoteFolder}/${path.basename(file)}`;

    urlMapping.set(slashRel, { file, remoteFolder, remoteUrl, postSlug });
    urlMapping.set(relFromStatic, { file, remoteFolder, remoteUrl, postSlug });
  }

  // 1. Upload to ImageKit / R2
  if (!isDryRun) {
    let store;
    if (useImageKit) {
      store = new ImageKitStore({
        privateKey: config.imagekitPrivateKey,
        urlEndpoint: config.imagekitUrlEndpoint,
      });
      console.log('\nUploading local images to ImageKit...');
      for (const [key, val] of urlMapping.entries()) {
        if (key.startsWith('/')) {
          console.log(`  Uploading: ${path.basename(val.file)} -> ${val.remoteUrl}`);
          await store.uploadFile(val.file, val.remoteFolder);
          await new Promise((res) => setTimeout(res, 200)); // slight throttle
        }
      }
    } else if (useR2) {
      store = new R2ImageStore({
        accountId: config.r2AccountId,
        accessKeyId: config.r2AccessKeyId,
        secretAccessKey: config.r2SecretAccessKey,
        bucket: config.r2Bucket,
        baseUrl: config.imageBaseUrl,
      });
      console.log('\nUploading local images to Cloudflare R2...');
      for (const [key, val] of urlMapping.entries()) {
        if (key.startsWith('/')) {
          console.log(`  Uploading: ${path.basename(val.file)} -> ${val.remoteUrl}`);
          await store.uploadFile(val.file, `posts/${val.remoteFolder}/${path.basename(val.file)}`);
        }
      }
    }
    console.log('All image uploads completed successfully!');
  } else {
    console.log('\n[DRY RUN] Planned upload mappings:');
    for (const [key, val] of urlMapping.entries()) {
      if (key.startsWith('/')) {
        console.log(`  ${key} -> ${val.remoteUrl}`);
      }
    }
  }

  // 2. Backup content directory
  if (!isDryRun && !noBackup) {
    const backupDir = '/tmp/content_backup_pre_image_migration';
    if (!fs.existsSync(backupDir)) {
      console.log(`\nCreating backup at ${backupDir}...`);
      fs.cpSync(CONTENT_DIR, backupDir, { recursive: true });
    }
  }

  // 3. Rewrite Markdown references
  console.log('\nUpdating Markdown posts with new ImageKit URLs...');
  let modifiedCount = 0;

  const htmlImgRe1 = /<img\s+[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi;
  const htmlImgRe2 = /<img\s+[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi;

  for (const mdFile of mdFiles) {
    const original = fs.readFileSync(mdFile, 'utf8');
    let updated = original;

    // Replace HTML img tags first and convert to standard Markdown ![alt](url)
    updated = updated.replace(htmlImgRe1, (match, src, alt) => {
      const target = urlMapping.get(src);
      return target ? `![${alt}](${target.remoteUrl})` : match;
    });

    updated = updated.replace(htmlImgRe2, (match, alt, src) => {
      const target = urlMapping.get(src);
      return target ? `![${alt}](${target.remoteUrl})` : match;
    });

    // Replace Markdown syntax ![](/images/post/...)
    for (const [localPath, val] of urlMapping.entries()) {
      if (updated.includes(localPath)) {
        updated = updated.split(localPath).join(val.remoteUrl);
      }
    }

    if (updated !== original) {
      modifiedCount++;
      if (!isDryRun) {
        fs.writeFileSync(mdFile, updated, 'utf8');
      }
      console.log(`  ${isDryRun ? '[DRY-RUN] Would update' : 'Updated'}: ${path.relative(BLOG_DIR, mdFile)}`);
    }
  }

  console.log(`\nFinished image migration. Modified ${modifiedCount}/${mdFiles.length} Markdown files.`);
  if (isDryRun) {
    console.log('[DRY RUN COMPLETE] No files were modified.');
  }
}

main().catch((err) => {
  console.error('[Migration Error]', err);
  process.exit(1);
});
