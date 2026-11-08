import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import mime from 'mime-types';
import ImageKit from '@imagekit/nodejs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export class ImageKitStore {
  constructor({ privateKey, urlEndpoint = 'https://ik.imagekit.io/hikoship' }) {
    this.client = new ImageKit({ privateKey });
    this.urlEndpoint = urlEndpoint.replace(/\/+$/, '');
    console.log(`[ImageStore] Initialized ImageKit storage (endpoint: ${this.urlEndpoint})`);
  }

  async uploadFile(localPath, remoteFolder = '/blog') {
    const fileName = path.basename(localPath);
    const stream = fs.createReadStream(localPath);
    const resp = await this.client.files.upload({
      file: stream,
      fileName,
      folder: remoteFolder,
      useUniqueFileName: false,
    });
    return resp.url;
  }

  async uploadBytes(buffer, fileName, remoteFolder = '/blog') {
    const resp = await this.client.files.upload({
      file: buffer.toString('base64'),
      fileName,
      folder: remoteFolder,
      useUniqueFileName: false,
    });
    return resp.url;
  }

  async rehostImage(sourceUrl, postSlug = 'post') {
    if (!sourceUrl) return sourceUrl;

    // Check if this is an expiring Notion S3 URL
    const isNotionTemporary = ['notion-static.com', 'amazonaws.com', 'notion.so'].some((domain) =>
      sourceUrl.toLowerCase().includes(domain)
    );

    if (!isNotionTemporary) {
      return sourceUrl;
    }

    try {
      console.log(`[ImageStore] Downloading expiring Notion image: ${sourceUrl.slice(0, 70)}...`);
      const resp = await fetch(sourceUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const buffer = Buffer.from(await resp.arrayBuffer());
      const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
      const cleanSlug = postSlug.replace(/[^a-zA-Z0-9_-]/g, '') || 'post';

      const contentType = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      let ext = mime.extension(contentType) || 'jpg';
      if (ext === 'jpeg') ext = 'jpg';
      const fileName = `${hash}.${ext}`;

      const uploadResp = await this.client.files.upload({
        file: buffer.toString('base64'),
        fileName,
        folder: `/blog/${cleanSlug}`,
        useUniqueFileName: false,
      });

      console.log(`[ImageStore] Rehosted image to ImageKit -> ${uploadResp.url}`);
      return uploadResp.url;
    } catch (err) {
      console.error(`[ImageStore] Failed to rehost image to ImageKit: ${err.message}. Keeping original.`);
      return sourceUrl;
    }
  }
}

export class R2ImageStore {
  constructor({ accountId, accessKeyId, secretAccessKey, bucket, baseUrl }) {
    this.bucket = bucket;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

    this.s3 = new S3Client({
      endpoint: this.endpoint,
      region: 'auto',
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
    console.log(`[ImageStore] Initialized Cloudflare R2 storage (bucket: '${this.bucket}', base: ${this.baseUrl})`);
  }

  async uploadBytes(buffer, remoteKey, contentType = 'image/jpeg') {
    const key = remoteKey.replace(/^\/+/, '');
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );
    return `${this.baseUrl}/${key}`;
  }

  async uploadFile(localPath, remoteKey = null) {
    const fileBuffer = await fs.promises.readFile(localPath);
    const contentType = mime.lookup(localPath) || 'application/octet-stream';

    let key = remoteKey;
    if (!key) {
      const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex').slice(0, 16);
      const ext = path.extname(localPath) || '.jpg';
      key = `posts/migrated/${hash}${ext}`;
    }

    return this.uploadBytes(fileBuffer, key, contentType);
  }

  async rehostImage(sourceUrl, postSlug = 'post') {
    if (!sourceUrl) return sourceUrl;

    const isNotionTemporary = ['notion-static.com', 'amazonaws.com', 'notion.so'].some((domain) =>
      sourceUrl.toLowerCase().includes(domain)
    );

    if (!isNotionTemporary) {
      return sourceUrl;
    }

    try {
      console.log(`[ImageStore] Downloading expiring Notion image: ${sourceUrl.slice(0, 70)}...`);
      const resp = await fetch(sourceUrl);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }

      const arrayBuffer = await resp.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const contentType = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      let ext = mime.extension(contentType) || 'jpg';
      if (ext === 'jpeg') ext = 'jpg';

      const fileHash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
      const cleanSlug = postSlug.replace(/[^a-zA-Z0-9_-]/g, '') || 'post';
      const remoteKey = `posts/${cleanSlug}/${fileHash}.${ext}`;

      const permanentUrl = await this.uploadBytes(buffer, remoteKey, contentType);
      console.log(`[ImageStore] Rehosted image -> ${permanentUrl}`);
      return permanentUrl;
    } catch (err) {
      console.error(`[ImageStore] Failed to rehost image: ${err.message}. Keeping original.`);
      return sourceUrl;
    }
  }
}

export class LocalImageStore {
  constructor(gitRepoDir) {
    this.staticDir = path.join(gitRepoDir, 'static', 'images', 'post');
  }

  async uploadBytes(buffer, remoteKey) {
    await fs.promises.mkdir(this.staticDir, { recursive: true });
    const filename = path.basename(remoteKey);
    const dest = path.join(this.staticDir, filename);
    await fs.promises.writeFile(dest, buffer);
    return `/images/post/${filename}`;
  }

  async uploadFile(localPath, remoteKey = null) {
    await fs.promises.mkdir(this.staticDir, { recursive: true });
    const filename = remoteKey ? path.basename(remoteKey) : path.basename(localPath);
    const dest = path.join(this.staticDir, filename);
    await fs.promises.copyFile(localPath, dest);
    return `/images/post/${filename}`;
  }

  async rehostImage(sourceUrl, postSlug = 'post') {
    if (!sourceUrl) return sourceUrl;

    const isNotionTemporary = ['notion-static.com', 'amazonaws.com', 'notion.so'].some((domain) =>
      sourceUrl.toLowerCase().includes(domain)
    );

    if (!isNotionTemporary) {
      return sourceUrl;
    }

    try {
      console.log(`[ImageStore] Downloading expiring Notion image locally: ${sourceUrl.slice(0, 70)}...`);
      const resp = await fetch(sourceUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const buffer = Buffer.from(await resp.arrayBuffer());
      const contentType = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      let ext = mime.extension(contentType) || 'jpg';
      if (ext === 'jpeg') ext = 'jpg';

      const fileHash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
      const filename = `${fileHash}.${ext}`;
      return this.uploadBytes(buffer, filename);
    } catch (err) {
      console.error(`[ImageStore] Failed to download image: ${err.message}`);
      return sourceUrl;
    }
  }
}

export function createImageStore(config) {
  if (config.imagekitPrivateKey) {
    return new ImageKitStore({
      privateKey: config.imagekitPrivateKey,
      urlEndpoint: config.imagekitUrlEndpoint,
    });
  }
  if (
    config.r2AccountId &&
    config.r2AccessKeyId &&
    config.r2SecretAccessKey &&
    config.r2Bucket &&
    config.imageBaseUrl
  ) {
    return new R2ImageStore({
      accountId: config.r2AccountId,
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
      bucket: config.r2Bucket,
      baseUrl: config.imageBaseUrl,
    });
  }
  return new LocalImageStore(config.gitRepoDir);
}
