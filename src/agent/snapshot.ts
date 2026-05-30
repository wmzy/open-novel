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
 * Create a snapshot (git commit) of the current project state.
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

    // Commit
    const { stdout } = await execFileAsync('git', ['commit', '-m', message], { cwd: projectDir });
    const commitHash = stdout.match(/\[[\w-]+\s+([\w]+)\]/)?.[1] || 'unknown';

    return commitHash;
  } catch {
    return null;
  }
}

/**
 * List recent snapshots (git log).
 */
export async function listSnapshots(projectDir: string, limit = 20): Promise<Array<{ hash: string; message: string; date: string }>> {
  try {
    const { stdout } = await execFileAsync('git', [
      'log', `--max-count=${limit}`, '--format=%H|%s|%ai', '--no-color',
    ], { cwd: projectDir });

    return stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [hash, message, date] = line.split('|');
      return { hash, message, date };
    });
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
