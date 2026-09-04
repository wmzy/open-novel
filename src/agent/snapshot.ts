import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { summarizeDiff } from '../shared/diff-utils';

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

    // 轻量维护：累计松散对象/打包阈值时才打包，防止快照历史无限膨胀。
    // gc --auto 是廉价 no-op，除非 git 自身判断需要。
    await execFileAsync('git', ['gc', '--auto'], { cwd: projectDir }).catch(() => {});
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
    })).filter((c) => c.message !== '[auto] review checkpoint');
  } catch {
    return [];
  }
}

/**
 * Restore project to a specific snapshot.
 *
 * `git checkout <hash> -- .` 只更新该 commit 中存在的路径，不会删除快照之后
 * 新增的文件——回滚到早期里程碑时后续章节会残留在磁盘并被 resync 加回。
 * 因此：先做安全提交（当前状态可找回），再 checkout，最后按 diff 删除
 * hash..HEAD 中 status=A 的路径（含快照之后的章节/设定文件）。
 */
export async function restoreSnapshot(projectDir: string, commitHash: string): Promise<boolean> {
  try {
    await ensureGitInit(projectDir);

    // 1. 安全提交：回滚前把当前状态（含未提交改动）落成一个 commit，
    //    回滚后仍可从快照列表找回——回滚本身不可逆但要有后悔药。
    await createSnapshot(projectDir, `pre-rollback safety (target ${commitHash.slice(0, 8)})`);

    // 2. 收集快照之后新增的文件（checkout 不会删除它们）
    const { stdout: diffOut } = await execFileAsync('git', [
      'diff', '--name-status', commitHash, 'HEAD', '--no-color',
    ], { cwd: projectDir });
    const addedPaths: string[] = [];
    for (const line of diffOut.split('\n')) {
      if (!line) continue;
      const [code, filePath] = line.split('\t');
      if (code === 'A' && filePath) addedPaths.push(filePath);
    }

    // 3. 恢复快照内容
    await execFileAsync('git', ['checkout', commitHash, '--', '.'], { cwd: projectDir });

    // 4. 删除快照之后新增的文件（限定项目目录内，防御异常路径）
    const { rm } = await import('node:fs/promises');
    for (const rel of addedPaths) {
      const full = path.resolve(projectDir, rel);
      if (!full.startsWith(path.resolve(projectDir) + path.sep)) continue;
      await rm(full, { recursive: true, force: true }).catch(() => {});
    }

    // 5. 回滚结果落为显式 commit（当前分支，通常为 draft）。
    //    之前只改工作区不动 HEAD：审阅面板的 review checkpoint 会把它裹进
    //    「待审阅批次」，而「丢弃」会 reset 掉整个工作区——回滚被静默吞没。
    //    显式提交让回滚成为版本链上的可见节点，merge/discard 语义随之正确。
    try {
      await execFileAsync('git', ['add', '-A'], { cwd: projectDir });
      try {
        await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: projectDir });
      } catch {
        await execFileAsync('git', ['commit', '-m', `[auto] rollback to ${commitHash.slice(0, 8)}`], { cwd: projectDir });
      }
    } catch { /* 回滚内容已在工作区，提交失败不阻断回滚本身 */ }

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
 * 双分支模型下同步推 draft + main：远程 main 只靠 merge 后同步会长期滞后，
 * 用户在其他机器 clone main 会拿到陈旧内容。draft 推送失败则整体失败。
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

    // 额外推 main（镜像分支）：失败不影响整体成功，但如实报告。
    let mainMessage = '';
    try {
      await execFileAsync('git', ['push', 'origin', 'main'], { cwd: projectDir, timeout: 30000 });
      mainMessage = 'main 已同步';
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      mainMessage = `main 同步失败: ${message}`;
    }

    return { success: true, message: `同步完成（draft 已推送；${mainMessage}）` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message: `同步失败: ${message}` };
  }
}

/**
 * 确保项目仓库处于双分支模型：main（只读镜像）+ draft（工作区）。
 * - 两者都不存在：从当前 HEAD 创建 main 与 draft，checkout 到 draft
 * - main 不存在：从当前 HEAD 创建 main（不动位置）
 * - draft 不存在：从当前 HEAD 创建 draft
 * - checkout 到 draft
 *
 * 幂等：已处于双分支模型时无副作用。
 */
export async function ensureDraftBranch(projectDir: string): Promise<void> {
  await ensureGitInit(projectDir);

  const hasBranch = async (name: string): Promise<boolean> => {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', name], { cwd: projectDir });
      return true;
    } catch {
      return false;
    }
  };

  // 若无任何提交（空仓库），先建一个初始提交作为分支基点
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectDir });
  } catch {
    await execFileAsync('git', ['add', '-A'], { cwd: projectDir });
    try {
      await execFileAsync('git', ['commit', '--allow-empty', '-m', '[auto] init'], { cwd: projectDir });
    } catch { /* nothing to commit, allow-empty 兜底 */ }
  }

  // 推断"当前分支名"作为基点（迁移前可能是 master/main/其他）
  const { stdout: curOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectDir });
  const cur = curOut.trim();

  // 确保 main 存在（若 cur 就是 main/master 则复用；否则从当前 HEAD 建 main）
  const mainExists = await hasBranch('main');
  if (!mainExists) {
    // 若用户原分支是 master，将其视为 main（不强制改名：在 main 上 mirror master 的位置）
    const masterExists = await hasBranch('master');
    if (masterExists && cur === 'master') {
      await execFileAsync('git', ['branch', 'main', 'master'], { cwd: projectDir });
    } else {
      await execFileAsync('git', ['branch', 'main'], { cwd: projectDir });
    }
  }

  // 确保 draft 存在
  const draftExists = await hasBranch('draft');
  if (!draftExists) {
    await execFileAsync('git', ['branch', 'draft'], { cwd: projectDir });
  }

  // checkout 到 draft
  await execFileAsync('git', ['checkout', 'draft'], { cwd: projectDir });
}

export interface ReviewCommit {
  hash: string;
  message: string;
  date: string;
}

export interface ReviewFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  addedLines: number;
  removedLines: number;
  diff: string;
}

export interface ReviewResult {
  commits: ReviewCommit[];
  files: ReviewFile[];
  totalAdded: number;
  totalRemoved: number;
}

/**
 * 聚合 draft 相对 main 的待审阅数据。
 * 流程：
 * 1. 先把 working tree 未提交改动 checkpoint commit 到 draft（确保 diff 完整）
 * 2. rev-list main..draft 取 commit 列表；为空则返回空审阅
 * 3. diff --name-status main..draft 取“确有差异”的文件列表；
 *    再用 git log --name-status 取每个文件最近一次变更的状态
 *    （add 后又 modify → modified）
 * 4. 对每个文件 diff main..draft -- <path> 取 unified diff，summarizeDiff 统计行数
 */
export async function reviewDiff(projectDir: string): Promise<ReviewResult> {
  await ensureDraftBranch(projectDir);

  // 1. checkpoint 未提交改动
  await execFileAsync('git', ['add', '-A'], { cwd: projectDir });
  try {
    await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: projectDir });
    // 无暂存改动
  } catch {
    await execFileAsync('git', ['commit', '-m', '[auto] review checkpoint'], { cwd: projectDir });
  }

  // 2. commit 列表
  const { stdout: revOut } = await execFileAsync('git', [
    'rev-list', 'main..draft', '--format=%H|%s|%ai', '--no-color',
  ], { cwd: projectDir });
  const commits: ReviewCommit[] = revOut.trim().split('\n')
    .filter((l) => l && !l.startsWith('commit '))
    .map((line) => {
      const [hash, message, date] = line.split('|');
      return { hash, message, date };
    });

  if (commits.length === 0) {
    return { commits: [], files: [], totalAdded: 0, totalRemoved: 0 };
  }

  // 3. 文件列表（以 net diff 为准：只包含 main/draft 间确有差异的文件，
  //    避免“新增后又删除”这类净效果为空的文件被误报）
  const { stdout: statOut } = await execFileAsync('git', [
    'diff', '--name-status', 'main..draft', '--no-color',
  ], { cwd: projectDir });
  const netFiles = statOut.trim().split('\n').filter(Boolean).map((line) => {
    const [code, filePath] = line.split('\t');
    const status: ReviewFile['status'] =
      code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
    return { path: filePath, status };
  });

  // 文件状态取“最近一次触碰该文件的 commit”的状态（git log 默认 newest-first，
  // 首次出现即为最新）。这样 add 后又 modify 的文件会报告为 modified，
  // 而非 net diff 的 added。
  const { stdout: logOut } = await execFileAsync('git', [
    'log', '--name-status', '--format=', '--no-color', 'main..draft',
  ], { cwd: projectDir });
  const latestStatus = new Map<string, ReviewFile['status']>();
  for (const line of logOut.split('\n')) {
    if (!line) continue;
    const [code, filePath] = line.split('\t');
    if (!filePath || latestStatus.has(filePath)) continue;
    latestStatus.set(filePath, code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified');
  }
  const fileEntries = netFiles.map((fe) => ({
    path: fe.path,
    status: latestStatus.get(fe.path) ?? fe.status,
  }));

  // 4. per-file diff + 行数统计
  let totalAdded = 0;
  let totalRemoved = 0;
  const files: ReviewFile[] = [];
  for (const fe of fileEntries) {
    const { stdout: diffOut } = await execFileAsync('git', [
      'diff', 'main..draft', '--', fe.path, '--no-color',
    ], { cwd: projectDir });
    const summary = summarizeDiff(diffOut);
    files.push({
      path: fe.path,
      status: fe.status,
      addedLines: summary.addedLines,
      removedLines: summary.removedLines,
      diff: diffOut,
    });
    totalAdded += summary.addedLines;
    totalRemoved += summary.removedLines;
  }

  return { commits, files, totalAdded, totalRemoved };
}

export interface MergeResult {
  success: boolean;
  fastForward: boolean;
  hash: string | null;
  /** 失败原因（如 non-fast-forward），供前端展示可操作的错误信息。 */
  error?: string;
}

/**
 * 审阅合并：ff main 到 draft，然后 checkout 回 draft。
 * main 只读镜像约束下必然 fast-forward。
 * 非 ff（历史分叉）不再静默普通合并——普通合并会在 main 上产生 merge commit，
 * 破坏镜像不变量且用户无感知；改为显式失败，由用户选择逐文件接受/丢弃。
 */
export async function mergeDraft(projectDir: string): Promise<MergeResult> {
  try {
    await ensureDraftBranch(projectDir);
    await execFileAsync('git', ['checkout', 'main'], { cwd: projectDir });

    // 检测能否 ff（工作区未提交改动已由 reviewDiff checkpoint，理论干净）
    let fastForward = true;
    try {
      await execFileAsync('git', ['merge', '--ff-only', 'draft'], { cwd: projectDir });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Not possible to fast-forward') || msg.includes('non-fast-forward')) {
        fastForward = false;
        // 放弃合并状态，回到 draft，返回可操作错误
        await execFileAsync('git', ['merge', '--abort'], { cwd: projectDir }).catch(() => {});
        await execFileAsync('git', ['checkout', 'draft'], { cwd: projectDir }).catch(() => {});
        return {
          success: false,
          fastForward: false,
          hash: null,
          error: 'main 与 draft 历史分叉，无法安全合并。请先逐文件接受/丢弃待审阅改动，或先执行「丢弃」重置 draft 到 main。',
        };
      }
      throw err;
    }

    const { stdout } = await execFileAsync('git', ['rev-parse', 'main'], { cwd: projectDir });
    await execFileAsync('git', ['checkout', 'draft'], { cwd: projectDir });
    return { success: true, fastForward, hash: stdout.trim() };
  } catch {
    return { success: false, fastForward: false, hash: null, error: '合并失败：git 操作异常，请稍后重试' };
  }
}

export interface DiscardResult {
  success: boolean;
}

/**
 * 丢弃整批未审阅：reset draft 到 main（含 working tree 改动）。
 *
 * 丢弃前先打 pre-discard 安全提交（含未提交改动），丢弃后仍可从
 * reflog/悬空 commit 找回——reset --hard 本身不可逆，必须有后悔药，
 * 与 restoreSnapshot 的 pre-rollback safety 对齐。
 */
export async function discardDraft(projectDir: string): Promise<DiscardResult> {
  try {
    await ensureDraftBranch(projectDir);
    // 安全提交：把当前 draft 状态（含 working tree 改动）落成一个 commit。
    // reset --hard main 后该 commit 悬空，但 git 至少保留 90 天（gc.reflogExpireUnreachable），
    // 期间可经 git reflog / fsck 找回。
    await createSnapshot(projectDir, `pre-discard safety ${new Date().toISOString()}`);
    await execFileAsync('git', ['reset', '--hard', 'main'], { cwd: projectDir });
    return { success: true };
  } catch {
    return { success: false };
  }
}

export interface FileReviewResult {
  success: boolean;
  error?: string;
}

/** 校验待审阅文件路径：必须是仓库内相对路径（防路径穿越）。 */
function isSafeRepoPath(filePath: string): boolean {
  if (!filePath || filePath.startsWith('/') || filePath.includes('..')) return false;
  return !path.isAbsolute(filePath);
}

/**
 * 接受单个文件的改动：把 draft 中该文件的最新内容写入 main 并提交，
 * 然后回到 draft。该文件不再出现在待审阅列表（net diff 归零），
 * 其余文件保持待审阅状态。
 */
export async function acceptFileInReview(projectDir: string, filePath: string): Promise<FileReviewResult> {
  if (!isSafeRepoPath(filePath)) return { success: false, error: '非法文件路径' };
  try {
    await ensureDraftBranch(projectDir);
    await execFileAsync('git', ['checkout', 'main'], { cwd: projectDir });
    // 判断 draft 中该文件是否存在：不存在 = draft 删除了该文件，接受=从 main 同步删除
    let existsInDraft = false;
    try {
      await execFileAsync('git', ['cat-file', '-e', `draft:${filePath}`], { cwd: projectDir });
      existsInDraft = true;
    } catch { /* 不存在于 draft */ }
    if (existsInDraft) {
      try {
        await execFileAsync('git', ['checkout', 'draft', '--', filePath], { cwd: projectDir });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await execFileAsync('git', ['checkout', 'draft'], { cwd: projectDir }).catch(() => {});
        return { success: false, error: `文件不存在于 draft：${msg}` };
      }
    } else {
      // 接受删除：从 main 移除该文件
      await execFileAsync('git', ['rm', '--ignore-unmatch', '--', filePath], { cwd: projectDir }).catch(() => {});
    }
    try {
      await execFileAsync('git', ['commit', '-m', `[review] accept ${filePath}`, '--', filePath], { cwd: projectDir });
    } catch {
      // 无变化（内容相同）也视为接受成功：无需提交
    }
    await execFileAsync('git', ['checkout', 'draft'], { cwd: projectDir });
    return { success: true };
  } catch (err: unknown) {
    await execFileAsync('git', ['checkout', 'draft'], { cwd: projectDir }).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * 拒绝单个文件的改动：把该文件在 draft 上的内容还原为 main 版本并提交，
 * 其余文件保持待审阅状态。
 */
export async function rejectFileInReview(projectDir: string, filePath: string): Promise<FileReviewResult> {
  if (!isSafeRepoPath(filePath)) return { success: false, error: '非法文件路径' };
  try {
    await ensureDraftBranch(projectDir);
    // 确保在 draft 分支
    await execFileAsync('git', ['checkout', 'draft'], { cwd: projectDir });
    try {
      await execFileAsync('git', ['checkout', 'main', '--', filePath], { cwd: projectDir });
    } catch {
      // main 中没有该文件 → 从 draft 删除（新增文件的拒绝语义）
      await execFileAsync('git', ['rm', '--ignore-unmatch', '--', filePath], { cwd: projectDir }).catch(() => {});
    }
    try {
      await execFileAsync('git', ['commit', '-m', `[review] reject ${filePath}`, '--', filePath], { cwd: projectDir });
    } catch {
      // 无变化也视为拒绝成功
    }
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}
