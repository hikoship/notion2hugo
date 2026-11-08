import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

export function loadConfig() {
  const notionApiKey = (process.env.NOTION_API_KEY || process.env.NOTION_KEY)?.trim() || '';
  const notionDatabaseId = (process.env.NOTION_DATABASE_ID || process.env.NOTION_DATABASE)?.trim() || '841cec94d55c4e5a979bd3fa3e983e1e';
  const pollIntervalSeconds = parseInt(process.env.POLL_INTERVAL_SECONDS || '300', 10);
  const defaultPollInterval = 300;

  const hugoDirRaw = process.env.HUGO_CONTENT_DIR || '/home/hongyuan/GitHub/blog/content/post';
  const gitDirRaw = process.env.GIT_REPO_DIR || '/home/hongyuan/GitHub/blog';

  const hugoContentDir = path.resolve(hugoDirRaw);
  const gitRepoDir = path.resolve(gitDirRaw);

  const config = {
    notionApiKey,
    notionDatabaseId,
    notionApiVersion: process.env.NOTION_API_VERSION?.trim() || '2022-06-28',
    pollIntervalSeconds: isNaN(pollIntervalSeconds) ? defaultPollInterval : pollIntervalSeconds,

    hugoContentDir,
    gitRepoDir,
    gitBranch: process.env.GIT_BRANCH?.trim() || 'main',
    gitRemote: process.env.GIT_REMOTE?.trim() || 'origin',
    gitCommitAuthorName: process.env.GIT_COMMIT_AUTHOR_NAME?.trim() || 'hikoship',
    gitCommitAuthorEmail: process.env.GIT_COMMIT_AUTHOR_EMAIL?.trim() || 'hikoship@users.noreply.github.com',

    imagekitPrivateKey: process.env.IMAGEKIT_PRIVATE_KEY?.trim() || null,
    imagekitUrlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT?.trim().replace(/\/+$/, '') || 'https://ik.imagekit.io/hikoship',

    r2AccountId: process.env.R2_ACCOUNT_ID?.trim() || null,
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() || null,
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() || null,
    r2Bucket: process.env.R2_BUCKET?.trim() || null,
    imageBaseUrl: process.env.IMAGE_BASE_URL?.trim().replace(/\/+$/, '') || null,

    logLevel: (process.env.LOG_LEVEL || 'info').trim().toLowerCase(),
    lockFilePath: path.resolve(process.env.LOCK_FILE_PATH || '/tmp/notion_hugo_worker.lock'),
    syncStatePath: path.resolve(process.env.SYNC_STATE_PATH || '/home/hongyuan/GitHub/notion2hugo/.sync_state.json'),
  };

  return config;
}

export function validateConfig(config, { requireNotion = true } = {}) {
  const errors = [];
  if (requireNotion && !config.notionApiKey) {
    errors.push('NOTION_API_KEY is missing or empty in .env');
  }
  if (requireNotion && !config.notionDatabaseId) {
    errors.push('NOTION_DATABASE_ID is missing or empty in .env');
  }
  if (!fs.existsSync(config.gitRepoDir)) {
    errors.push(`GIT_REPO_DIR does not exist: ${config.gitRepoDir}`);
  } else if (!fs.existsSync(path.join(config.gitRepoDir, '.git'))) {
    errors.push(`GIT_REPO_DIR is not a git repository: ${config.gitRepoDir}`);
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}

