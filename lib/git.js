import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

export class GitManager {
  constructor({
    repoDir,
    branch = 'main',
    remote = 'origin',
    authorName = 'Notion Hugo Pipeline',
    authorEmail = 'pipeline@hgao.net',
  }) {
    this.repoDir = path.resolve(repoDir);
    this.branch = branch;
    this.remote = remote;
    this.authorName = authorName;
    this.authorEmail = authorEmail;
  }

  async runGit(args) {
    const cmdStr = `git ${args.join(' ')}`;
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: this.repoDir,
        timeout: 120000,
      });
      return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (err) {
      console.error(`[GitManager] Error running '${cmdStr}' in ${this.repoDir}:\nSTDOUT: ${err.stdout}\nSTDERR: ${err.stderr}`);
      throw err;
    }
  }

  async pullLatest() {
    console.log(`[GitManager] Pulling latest changes from ${this.remote}/${this.branch}...`);
    try {
      await this.runGit(['fetch', this.remote, this.branch]);
      await this.runGit(['rebase', `${this.remote}/${this.branch}`]);
    } catch {
      await this.runGit(['pull', '--rebase', this.remote, this.branch]);
    }
  }

  async commitFile(filePath, commitMsg) {
    const relPath = path.relative(this.repoDir, filePath);
    await this.runGit(['add', relPath]);

    // Check if staged diff exists
    try {
      await this.runGit(['diff', '--cached', '--quiet']);
      console.log(`[GitManager] No staged changes for ${relPath}. Skipping commit.`);
      return false;
    } catch {
      // Exit code != 0 means there are differences
    }

    const authorArg = `${this.authorName} <${this.authorEmail}>`;
    await this.runGit(['commit', '-m', commitMsg, `--author=${authorArg}`]);
    console.log(`[GitManager] Committed ${relPath} ('${commitMsg}')`);
    return true;
  }

  async removeFile(filePath, commitMsg) {
    const relPath = path.relative(this.repoDir, filePath);
    await this.runGit(['rm', '-f', '--ignore-unmatch', relPath]);

    try {
      await this.runGit(['diff', '--cached', '--quiet']);
      console.log(`[GitManager] File ${relPath} was not tracked in git. Skipping commit.`);
      return false;
    } catch {
      // Exit code != 0 means removal is staged
    }

    const authorArg = `${this.authorName} <${this.authorEmail}>`;
    await this.runGit(['commit', '-m', commitMsg, `--author=${authorArg}`]);
    console.log(`[GitManager] Removed and committed ${relPath} ('${commitMsg}')`);
    return true;
  }

  async push(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[GitManager] Pushing to ${this.remote}/${this.branch} (attempt ${attempt}/${maxRetries})...`);
        await this.runGit(['push', this.remote, this.branch]);
        return true;
      } catch (err) {
        if (attempt === maxRetries) throw err;
        console.warn(`[GitManager] Push rejected. Re-fetching and rebasing before retry...`);
        await this.pullLatest();
      }
    }
    return false;
  }

  async verifyPush() {
    await this.runGit(['fetch', this.remote, this.branch]);
    const { stdout: localHead } = await this.runGit(['rev-parse', 'HEAD']);
    const { stdout: remoteHead } = await this.runGit(['rev-parse', `${this.remote}/${this.branch}`]);

    const isVerified = localHead === remoteHead;
    if (isVerified) {
      console.log(`[GitManager] Push verified: local HEAD matches ${this.remote}/${this.branch} (${localHead.slice(0, 8)})`);
    } else {
      console.error(`[GitManager] Push verification failed! Local: ${localHead.slice(0, 8)}, Remote: ${remoteHead.slice(0, 8)}`);
    }
    return isVerified;
  }
}

