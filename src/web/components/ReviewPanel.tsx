import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { css, cx } from '@linaria/core';
import { useReviewComments } from '../hooks/useReview';
import type { ReviewComment, ReviewResult } from '../hooks/useReview';

interface Props {
  review: ReviewResult | undefined;
  onMerge: () => void;
  onDiscard: () => void;
  merging: boolean;
  discarding: boolean;
  onClose: () => void;
  /** 逐文件接受（draft → main）。 */
  onAcceptFile: (path: string) => void;
  /** 逐文件拒绝（draft 还原为 main 版本）。 */
  onRejectFile: (path: string) => void;
  /** 逐文件操作进行中（禁用按钮防止并发 git 操作）。 */
  fileBusy: boolean;
}

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`;

const panel = css`
  background: var(--haze-color-bg, #fff);
  border-radius: 8px;
  width: 80vw;
  max-width: 900px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
`;

const headerBar = css`
  padding: 1rem;
  border-bottom: 1px solid var(--haze-color-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
`;

const title = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

const summary = css`
  color: var(--haze-color-text-secondary, #888);
  font-size: 0.85rem;
`;

const body = css`
  padding: 1rem;
  overflow-y: auto;
  flex: 1;
`;

const fileRow = css`
  padding: 0.5rem;
  cursor: pointer;
  border-bottom: 1px solid var(--haze-color-border);
  display: flex;
  justify-content: space-between;
  &:hover {
    background: var(--haze-color-bg-hover);
  }
`;

const fileName = css`
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
`;

const statusBadge = css`
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  margin-right: 0.5rem;
  background: var(--haze-color-bg-secondary);
`;

/** 文件行 💬 徽标：该文件有未解决评论时显示。 */
const commentBadge = css`
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  margin-left: 0.5rem;
  background: color-mix(in srgb, var(--haze-color-primary, #2563eb) 12%, transparent);
  color: var(--haze-color-primary, #2563eb);
  white-space: nowrap;
`;

const statsGap = css`
  display: inline-flex;
  gap: 0.25rem;
`;

const addedCount = css`
  color: var(--haze-color-success, #16a34a);
`;

const removedCount = css`
  color: var(--haze-color-error, #dc2626);
`;

const footer = css`
  padding: 1rem;
  border-top: 1px solid var(--haze-color-border);
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  align-items: center;
`;

const mergeBtn = css`
  background: var(--haze-color-success, #16a34a);
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const discardBtn = css`
  background: var(--haze-color-error, #dc2626);
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const ghostBtn = css`
  background: transparent;
  border: 1px solid var(--haze-color-border);
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  color: var(--haze-color-text);
`;

const closeBtn = css`
  background: transparent;
  border: 1px solid var(--haze-color-border);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  cursor: pointer;
  color: var(--haze-color-text);
`;

const confirmText = css`
  margin-right: auto;
  font-size: 0.85rem;
  color: var(--haze-color-text-secondary, #888);
`;

const fileActionRow = css`
  display: flex;
  gap: 0.375rem;
  margin-left: 0.5rem;
  flex-shrink: 0;
`;

const acceptBtn = css`
  border: 1px solid var(--haze-color-success, #16a34a);
  color: var(--haze-color-success, #16a34a);
  background: transparent;
  border-radius: 4px;
  padding: 0.125rem 0.5rem;
  font-size: 0.75rem;
  cursor: pointer;
  &:hover { background: color-mix(in srgb, var(--haze-color-success, #16a34a) 12%, transparent); }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const rejectBtn = css`
  border: 1px solid var(--haze-color-error, #dc2626);
  color: var(--haze-color-error, #dc2626);
  background: transparent;
  border-radius: 4px;
  padding: 0.125rem 0.5rem;
  font-size: 0.75rem;
  cursor: pointer;
  &:hover { background: color-mix(in srgb, var(--haze-color-error, #dc2626) 12%, transparent); }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const statusLabel = (s: string): string =>
  ({ added: '新增', modified: '修改', deleted: '删除' } as Record<string, string>)[s] || s;

/** run 进行中占位横幅。 */
const runBanner = css`
  padding: 0.75rem 1rem;
  border: 1px solid var(--haze-color-primary);
  border-radius: 6px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text-secondary);
  font-size: 0.85rem;
  line-height: 1.5;
`;

/** 展开文件区：diff + 该文件的评论列表。 */
const expandedFile = css`
  margin-top: 0.5rem;
  margin-bottom: 0.75rem;
`;

// ---- 行内评论 diff 渲染 ----

const diffBlock = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  overflow: hidden;
`;

const diffBodyScroll = css`
  max-height: 400px;
  overflow-y: auto;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  line-height: 1.5;
`;

/** diff 行：行号槽 + 内容 + 悬停可见的 ＋ 评论按钮。 */
const diffRow = css`
  display: flex;
  align-items: flex-start;
  padding: 0 0.5rem 0 0;
  white-space: pre-wrap;
  word-break: break-all;
  &:hover .comment-add-btn { opacity: 1; }
`;

const rowLineNo = css`
  flex-shrink: 0;
  width: 3rem;
  text-align: right;
  padding-right: 0.5rem;
  color: var(--haze-color-text-secondary, #999);
  user-select: none;
`;

const rowText = css`
  flex: 1;
  min-width: 0;
  padding-right: 0.5rem;
`;

const rowAdd = css`
  color: #16a34a;
  background: rgba(22, 163, 74, 0.08);
`;

const rowDel = css`
  color: #dc2626;
  background: rgba(220, 38, 38, 0.08);
`;

const rowCtx = css`
  color: var(--haze-color-text, inherit);
`;

const rowHunk = css`
  color: var(--haze-color-primary, #2563eb);
  background: var(--haze-color-bg-secondary, #f6f6f6);
`;

const rowMeta = css`
  color: var(--haze-color-text-secondary, #888);
`;

/** 行尾 ＋ 按钮：默认半透明，行悬停时完全不透明（jsdom/键盘下仍可点击）。 */
const commentAddBtn = css`
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--haze-color-primary, #2563eb);
  cursor: pointer;
  font-size: 0.85rem;
  line-height: 1.5;
  padding: 0 0.25rem;
  opacity: 0.35;
  &:hover { opacity: 1; }
  &:disabled { opacity: 0.2; cursor: not-allowed; }
`;

const expandAllRow = css`
  cursor: pointer;
  padding: 0.5rem;
  text-align: center;
`;

/** 行内评论编辑器（点 ＋ 后插在该行下方）。 */
const composer = css`
  flex: 1;
  min-width: 0;
  margin: 0.25rem 0 0.5rem 3.5rem;
  padding: 0.5rem;
  border: 1px solid var(--haze-color-primary, #2563eb);
  border-radius: 6px;
  background: var(--haze-color-bg);
  font-family: inherit;
  font-size: 0.8rem;
`;

const composerTitle = css`
  font-size: 0.72rem;
  color: var(--haze-color-text-secondary, #888);
  margin-bottom: 0.25rem;
`;

const composerInput = css`
  width: 100%;
  box-sizing: border-box;
  font-family: inherit;
  font-size: 0.8rem;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  resize: vertical;
  color: var(--haze-color-text);
  background: var(--haze-color-bg);
`;

const composerActions = css`
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin-top: 0.375rem;
`;

const composerError = css`
  color: var(--haze-color-error, #dc2626);
  font-size: 0.72rem;
  margin-right: auto;
`;

const composerSubmit = css`
  background: var(--haze-color-primary, #2563eb);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 0.25rem 0.75rem;
  font-size: 0.75rem;
  cursor: pointer;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const composerCancel = css`
  background: transparent;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.25rem 0.75rem;
  font-size: 0.75rem;
  cursor: pointer;
  color: var(--haze-color-text);
`;

// ---- 评论列表 ----

const commentList = css`
  margin-top: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
`;

const commentItem = css`
  border: 1px solid var(--haze-color-border);
  border-left: 3px solid var(--haze-color-primary, #2563eb);
  border-radius: 4px;
  padding: 0.375rem 0.5rem;
  font-size: 0.8rem;
`;

/** 已解决评论：淡化 + 删除线，保留内容供回溯。 */
const commentItemResolved = css`
  opacity: 0.6;
  border-left-color: var(--haze-color-success, #16a34a);
`;

const commentMeta = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.72rem;
  color: var(--haze-color-text-secondary, #888);
`;

/** 行号锚点徽标。 */
const commentAnchor = css`
  background: var(--haze-color-bg-secondary, #f6f6f6);
  border-radius: 3px;
  padding: 0 0.3rem;
`;

const commentBody = css`
  margin-top: 0.25rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--haze-color-text);
`;

const resolveToggleBtn = css`
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.0625rem 0.5rem;
  font-size: 0.72rem;
  cursor: pointer;
  color: var(--haze-color-text-secondary, #888);
  &:hover { color: var(--haze-color-text); }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

/** 空态/run 态下「评论但不在此批待审文件中」的区块标题与文件名。 */
const allComments = css`
  margin-top: 1rem;
`;

const allCommentsTitle = css`
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--haze-color-text);
  margin-bottom: 0.5rem;
`;

const commentFileName = css`
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--haze-color-text-secondary, #888);
  margin: 0.5rem 0 0.25rem;
`;

const commentHint = css`
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary, #888);
  padding: 0.25rem 0;
`;

/** 评论写入失败横幅（resolve/新增在面板级失败时提示）。 */
const commentErrorBanner = css`
  margin-bottom: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--haze-color-error, #dc2626);
  border-radius: 6px;
  color: var(--haze-color-error, #dc2626);
  font-size: 0.8rem;
`;

// ---- diff 解析 ----

type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 评论锚点行号：新增/上下文行取新文件行号，删除行取旧文件行号。 */
  line?: number;
}

/**
 * 解析 unified diff 文本。首个 @@ 前的 `diff --git`/`index`/`---`/`+++` 等
 * 视为 meta（不可评论）；@@ 之后按 +/-/空格 前缀识别内容行并推进新旧行号。
 */
function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let sawHunk = false;
  for (const raw of diff.split('\n')) {
    if (raw === '') continue; // 尾部空串
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      sawHunk = true;
      out.push({ kind: 'hunk', text: raw });
    } else if (!sawHunk
      && (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('--- ')
        || raw.startsWith('+++ ') || raw.startsWith('new file') || raw.startsWith('deleted file')
        || raw.startsWith('old mode') || raw.startsWith('new mode') || raw.startsWith('Binary files')
        || raw.startsWith('similarity') || raw.startsWith('rename ') || raw.startsWith('copy '))) {
      out.push({ kind: 'meta', text: raw });
    } else if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw, ...(newNo > 0 ? { line: newNo } : {}) });
      newNo++;
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw, ...(oldNo > 0 ? { line: oldNo } : {}) });
      oldNo++;
    } else if (raw.startsWith(' ')) {
      out.push({ kind: 'ctx', text: raw, ...(newNo > 0 ? { line: newNo } : {}) });
      oldNo++;
      newNo++;
    } else {
      // `\ No newline at end of file` 等其余行
      out.push({ kind: 'meta', text: raw });
    }
  }
  return out;
}

/** 评论时间：月/日 时:分（解析失败返回空串）。 */
function fmtCommentTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 评论列表：行号锚点 + 作者时间 + 内容 + 解决勾选（已解决淡化保留）。 */
function CommentList({ comments, onResolve, busy }: {
  comments: ReviewComment[];
  onResolve: (comment: ReviewComment, resolved: boolean) => void;
  busy: boolean;
}) {
  if (comments.length === 0) return null;
  return (
    <div className={commentList}>
      {comments.map((cm) => (
        <div key={cm.id} className={cx(commentItem, cm.resolved && commentItemResolved)}>
          <div className={commentMeta}>
            <span className={commentAnchor}>{cm.line !== undefined ? `行 ${cm.line}` : '全文'}</span>
            <span>{fmtCommentTime(cm.createdAt)}</span>
            {cm.resolved && <span>已解决</span>}
            <button
              className={resolveToggleBtn}
              onClick={() => onResolve(cm, !cm.resolved)}
              disabled={busy}
              title={cm.resolved ? '重新打开这条评论' : '标记为已解决'}
            >
              {cm.resolved ? '重新打开' : '✓ 解决'}
            </button>
          </div>
          <div className={commentBody}>{cm.body}</div>
        </div>
      ))}
    </div>
  );
}

/** 空态/run 态：无待审 diff 时仍可查看与处理遗留评论（run 中解决按钮锁定）。 */
function AllCommentsSection({ byFile, onResolve, busy, locked }: {
  byFile: Record<string, ReviewComment[]>;
  onResolve: (comment: ReviewComment, resolved: boolean) => void;
  busy: boolean;
  /** run 进行中：PATCH 会被后端 409，禁用操作并说明。 */
  locked?: boolean;
}) {
  const files = Object.keys(byFile).filter((f) => (byFile[f] ?? []).length > 0);
  if (files.length === 0) return null;
  return (
    <div className={allComments}>
      <div className={allCommentsTitle}>评论（{files.reduce((n, f) => n + byFile[f].length, 0)} 条）</div>
      {files.map((f) => (
        <div key={f}>
          <div className={commentFileName}>{f}</div>
          <CommentList comments={byFile[f]} onResolve={onResolve} busy={busy || !!locked} />
        </div>
      ))}
      {locked && (
        <div className={commentHint}>写作任务进行中，解决/新增评论暂不可用，任务结束后自动恢复。</div>
      )}
    </div>
  );
}

const MAX_LINES_BEFORE_COLLAPSE = 200;
const VISIBLE_LINES_WHEN_COLLAPSED = 50;

/** 行内评论编辑器。 */
function Composer({ line, busy, error, text, onTextChange, onSubmit, onCancel }: {
  line: number | undefined;
  busy: boolean;
  error: string | null;
  text: string;
  onTextChange: (text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={composer}>
      <div className={composerTitle}>{line !== undefined ? `评论 行 ${line}` : '评论此行'}</div>
      <textarea
        className={composerInput}
        autoFocus
        rows={3}
        value={text}
        placeholder="写下批注…（⌘/Ctrl+Enter 提交，Esc 取消）"
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit();
        }}
      />
      <div className={composerActions}>
        {error && <span className={composerError}>{error}</span>}
        <button
          className={composerSubmit}
          disabled={busy || !text.trim()}
          onClick={onSubmit}
        >
          提交
        </button>
        <button className={composerCancel} onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

/**
 * 带 行内评论 的 unified diff 渲染：行号槽 + 行尾 ＋ 按钮（悬停显现）。
 * 长 diff 折叠（>200 行显示前 50 行 + 展开全部），与 RevisionDiffPanel 同策略。
 */
function DiffBody({ diff, onAddComment, busy }: {
  diff: string;
  onAddComment: (line: number | undefined, body: string) => Promise<unknown>;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  /** 编辑器锚定解析后行的下标（含 line 锚点）；null = 未激活。 */
  const [composing, setComposing] = useState<{ index: number; line?: number; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const shouldCollapse = lines.length > MAX_LINES_BEFORE_COLLAPSE;
  const visibleLines = shouldCollapse && !expanded
    ? lines.slice(0, VISIBLE_LINES_WHEN_COLLAPSED)
    : lines;

  const submit = async () => {
    if (!composing || !composing.text.trim()) return;
    setError(null);
    try {
      await onAddComment(composing.line, composing.text.trim());
      setComposing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加评论失败');
    }
  };

  return (
    <div className={diffBlock}>
      <div className={diffBodyScroll}>
        {visibleLines.map((l, i) => (
          <div key={i}>
            <div
              className={cx(
                diffRow,
                l.kind === 'add' && rowAdd,
                l.kind === 'del' && rowDel,
                l.kind === 'ctx' && rowCtx,
                l.kind === 'hunk' && rowHunk,
                l.kind === 'meta' && rowMeta,
              )}
            >
              <span className={rowLineNo}>{l.line ?? ''}</span>
              <span className={rowText}>{l.text || ' '}</span>
              {l.kind !== 'hunk' && l.kind !== 'meta' && (
                <button
                  className={commentAddBtn}
                  title={l.line !== undefined ? `评论第 ${l.line} 行` : '评论此行'}
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setComposing({ index: i, line: l.line, text: '' });
                  }}
                >
                  ＋
                </button>
              )}
            </div>
            {composing && composing.index === i && (
              <Composer
                line={composing.line}
                busy={busy}
                error={error}
                text={composing.text}
                onTextChange={(text) => setComposing({ ...composing, text })}
                onSubmit={() => void submit()}
                onCancel={() => setComposing(null)}
              />
            )}
          </div>
        ))}
        {shouldCollapse && !expanded && (
          <div
            className={cx(rowMeta, expandAllRow)}
            onClick={() => setExpanded(true)}
          >
            ▾ 展开全部（共 {lines.length} 行）
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 审阅面板：列出 draft 相对 main 的待审阅改动（PR 式）。
 * 合并 = ff main 到 draft；丢弃 = reset draft 到 main（需二次确认）；
 * 逐文件接受/拒绝 = 只处理单个文件的改动，其余保持待审阅；
 * 行内评论 = diff 行尾 ＋ 添加批注（纯 .novel 元数据，不影响 git 审阅门），
 * 顶部汇总条统计未解决评论数，有未解决评论的文件行带 💬 徽标。
 */
export default function ReviewPanel({ review, onMerge, onDiscard, merging, discarding, onClose, onAcceptFile, onRejectFile, fileBusy }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // projectId 取自路由 :id（与 ProjectPage 同源）；无路由上下文时评论能力降级隐藏
  const { id } = useParams<{ id: string }>();
  const { comments: commentsData, addComment, resolveComment, commentBusy } = useReviewComments(id);
  /** 评论写入失败（面板级兜底提示；编辑器内失败就地显示）。 */
  const [commentError, setCommentError] = useState<string | null>(null);

  const byFile = commentsData?.byFile ?? {};
  const unresolvedCount = commentsData?.unresolvedCount ?? 0;

  const empty = !review || review.commits.length === 0;
  const busy = merging || discarding || fileBusy;

  const handleResolve = async (cm: ReviewComment, resolved: boolean) => {
    setCommentError(null);
    try {
      await resolveComment({ id: cm.id, resolved });
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : '更新评论失败');
    }
  };

  return (
    <div className={overlay} onClick={onClose}>
      <div className={panel} onClick={(e) => e.stopPropagation()}>
        <div className={headerBar}>
          <div className={title}>
            <strong>审阅待合并</strong>
            {!empty && (
              <span className={summary}>
                {review!.commits.length} 个提交 · {review!.files.length} 个文件 · +{review!.totalAdded} -{review!.totalRemoved}
                {unresolvedCount > 0 ? ` · 💬 ${unresolvedCount} 条未解决评论` : ''}
              </span>
            )}
          </div>
          <button className={closeBtn} onClick={onClose}>✕</button>
        </div>
        <div className={body}>
          {commentError && <div className={commentErrorBanner}>{commentError}</div>}
          {review?.runInProgress ? (
            <>
              <div className={runBanner}>
                写作任务进行中，暂不可审阅。任务完成后待审阅改动会自动出现在这里。
              </div>
              <AllCommentsSection byFile={byFile} onResolve={handleResolve} busy={commentBusy} locked />
            </>
          ) : empty ? (
            <>
              <div>无待审阅</div>
              <AllCommentsSection byFile={byFile} onResolve={handleResolve} busy={commentBusy} />
            </>
          ) : (
            review!.files.map((f) => {
              const fileComments = byFile[f.path] ?? [];
              const fileUnresolved = fileComments.filter((cm) => !cm.resolved).length;
              return (
                <div key={f.path}>
                  <div className={fileRow} onClick={() => setExpanded(expanded === f.path ? null : f.path)}>
                    <span className={fileName}>
                      <span className={statusBadge}>{statusLabel(f.status)}</span>
                      {f.path}
                      {fileUnresolved > 0 && (
                        <span className={commentBadge} title={`${fileUnresolved} 条未解决评论`}>
                          💬 {fileUnresolved}
                        </span>
                      )}
                    </span>
                    <span className={statsGap}>
                      <span className={addedCount}>+{f.addedLines}</span>
                      <span className={removedCount}>-{f.removedLines}</span>
                    </span>
                    <span className={fileActionRow} onClick={(e) => e.stopPropagation()}>
                      <button
                        className={acceptBtn}
                        onClick={() => onAcceptFile(f.path)}
                        disabled={busy}
                        title="接受此文件的改动（写入 main）"
                      >
                        ✓ 接受
                      </button>
                      <button
                        className={rejectBtn}
                        onClick={() => onRejectFile(f.path)}
                        disabled={busy}
                        title="拒绝此文件的改动（还原为 main 版本）"
                      >
                        ✗ 拒绝
                      </button>
                    </span>
                  </div>
                  {expanded === f.path && (
                    <div className={expandedFile}>
                      <DiffBody
                        diff={f.diff}
                        busy={commentBusy}
                        onAddComment={(line, text) => addComment({ file: f.path, line, body: text })}
                      />
                      <CommentList comments={fileComments} onResolve={handleResolve} busy={commentBusy} />
                      {fileComments.length === 0 && (
                        <div className={commentHint}>点击 diff 行尾的 ＋ 添加行内批注</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        {!empty && (
          <div className={footer}>
            {confirmDiscard ? (
              <>
                <span className={confirmText}>将丢弃所有未审阅改动（含未提交手改）。丢弃前会自动保存当前状态，可从 git reflog 找回。确认？</span>
                <button className={discardBtn} onClick={() => { onDiscard(); setConfirmDiscard(false); }} disabled={discarding}>
                  {discarding ? '丢弃中...' : '确认丢弃'}
                </button>
                <button className={ghostBtn} onClick={() => setConfirmDiscard(false)}>取消</button>
              </>
            ) : (
              <>
                <button className={discardBtn} onClick={() => setConfirmDiscard(true)} disabled={busy}>丢弃</button>
                <button className={mergeBtn} onClick={onMerge} disabled={busy}>
                  {merging ? '合并中...' : '合并'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
