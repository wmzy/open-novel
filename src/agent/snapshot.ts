import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

/**
 * Initialize a git repository in the project directory if not already initialized.
 */
export async function ensureGitInit(projectDir: string): Promise<void> {
  const gitDir = path.join(projectDir, '.git');
  if (existsSync(gitDir)) return;

  await execFileAsync('git', ['init'], { cwd: projectDir });
  await execFileAsync('git', ['config', 'user.email', 'open-novel@local'], { cwd: projectDir });
  await execFileAsync('git', ['config', 'user.name', 'Open Novel'], { cwd: projectDir });

  // Create .gitignore
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(projectDir, '.gitignore'), 'node_modules/\n.env\n');
}

/**
 * Create an automatic snapshot (git commit) of the current project state.
 * Message is prefixed with `[auto]` so UI can distinguish machine snapshots
 * from user-created milestones.
 */
export async function createSnapshot(projectDir: string, message: string): Promise<string | null> {
  try {
    await ensureGitInit(projectDir);

    // Stage all changes
    await execFileAsync('git', ['add', '-A'], { cwd: projectDir });

    // Check if there are changes to commit
    try {
      await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: projectDir });
      return null; // No changes
    } catch {
      // There are changes, proceed with commit
    }

    // Commit with [auto] prefix
    const autoMessage = `[auto] ${message}`;
    await execFileAsync('git', ['commit', '-m', autoMessage], { cwd: projectDir });

    // Use rev-parse for reliable hash extraction (commit output format varies
    // by locale and root-commit vs normal commit)
    const { stdout: hashOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectDir });
    return hashOut.trim();
  } catch {
    return null;
  }
}

/**
 * Create a user milestone snapshot: commit pending changes (if any) and tag
 * the resulting / latest commit with `milestone-<name>`. Returns commit hash
 * (may be null if nothing to commit and no HEAD exists yet).
 */
export async function createUserSnapshot(projectDir: string, name: string): Promise<string | null> {
  try {
    await ensureGitInit(projectDir);

    // Stage all changes
    await execFileAsync('git', ['add', '-A'], { cwd: projectDir });

    // Commit if there are staged changes; otherwise tag current HEAD
    let commitHash: string | null = null;
    try {
      await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: projectDir });
      // No staged changes — use current HEAD
      const { stdout: headOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectDir });
      commitHash = headOut.trim();
    } catch {
      // Has staged changes — commit them
      const message = `[milestone] ${name}`;
      await execFileAsync('git', ['commit', '-m', message], { cwd: projectDir });
      const { stdout: hashOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectDir });
      commitHash = hashOut.trim();
    }

    if (!commitHash) return null;

    // Tag the commit (force to allow re-tagging same name)
    const tagName = `milestone-${name}`;
    await execFileAsync('git', ['tag', '-f', tagName, commitHash], { cwd: projectDir });

    return commitHash;
  } catch {
    return null;
  }
}

export interface Snapshot {
  hash: string;
  message: string;
  date: string;
  /** Tags pointing at this commit (e.g. milestone names). */
  tags: string[];
  /** True for machine-generated `[auto] ...` commits. */
  isAuto: boolean;
}

/**
 * List recent snapshots (git log), enriched with tags and auto flag.
 */
export async function listSnapshots(projectDir: string, limit = 20): Promise<Snapshot[]> {
  try {
    const { stdout } = await execFileAsync('git', [
      'log', `--max-count=${limit}`, '--format=%H|%s|%ai', '--no-color',
    ], { cwd: projectDir });

    const commits = stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [hash, message, date] = line.split('|');
      return { hash, message, date };
    });

    if (commits.length === 0) return [];

    // Build tag→commit map in one call
    const tagMap = new Map<string, string[]>(); // commitHash → tagNames
    try {
      const { stdout: tagOut } = await execFileAsync('git', [
        'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/tags',
      ], { cwd: projectDir });
      for (const line of tagOut.trim().split('\n').filter(Boolean)) {
        const [tagName, commitHash] = line.split(' ');
        if (!tagName || !commitHash) continue;
        const arr = tagMap.get(commitHash) || [];
        arr.push(tagName);
        tagMap.set(commitHash, arr);
      }
    } catch { /* no tags yet */ }

    return commits.map((c) => ({
      hash: c.hash,
      message: c.message,
      date: c.date,
      tags: tagMap.get(c.hash) || [],
      isAuto: c.message.startsWith('[auto] '),
    }));
  } catch {
    return [];
  }
}

/**
 * Restore project to a specific snapshot.
 */
export async function restoreSnapshot(projectDir: string, commitHash: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['checkout', commitHash, '--', '.'], { cwd: projectDir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a git remote is configured.
 */
export async function hasRemote(projectDir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['remote'], { cwd: projectDir });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Sync with remote: pull then push.
 */
export async function gitSync(projectDir: string): Promise<{ success: boolean; message: string }> {
  try {
    if (!(await hasRemote(projectDir))) {
      return { success: false, message: '未配置远程仓库。请先运行: git remote add origin <url>' };
    }

    try {
      await execFileAsync('git', ['pull', '--rebase'], { cwd: projectDir, timeout: 30000 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('no tracking information')) {
        return { success: false, message: `拉取失败: ${message}` };
      }
    }

    try {
      await execFileAsync('git', ['push'], { cwd: projectDir, timeout: 30000 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message: `推送失败: ${message}` };
    }

    return { success: true, message: '同步完成' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message: `同步失败: ${message}` };
  }
}
