/**
 * Markdown 文件引用弹窗 + 共享链接工具。
 *
 * 当 Markdown 正文里的链接指向项目内的 .md 文件时，点击在弹窗中加载并渲染该文件。
 * 弹窗内容本身也是 Markdown 渲染，且其中的 .md 链接可继续点击——在同一弹窗内导航，
 * 无需层层叠弹窗。
 *
 * 设计要点：
 *  - isMarkdownRef / normalizeMdPath 为纯函数，供本组件与 useMdFilePreview 复用。
 *  - 布局复刻 EntityDetailDialog：overlay 遮罩 + 居中卡片，Esc 关闭，点遮罩关闭。
 */
import { useState, useEffect, useCallback, isValidElement, type ReactNode, type ComponentProps } from 'react';
import { css } from '@linaria/core';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ── 共享工具 ──────────────────────────────────────────────────────────

/** .md 文件链接的可点击样式（虚线下划线，hover 实线）。 */
export const mdFileLink = css`
  color: var(--haze-color-primary);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dashed;
  text-underline-offset: 2px;
  transition: background 0.15s;
  &:hover {
    text-decoration-style: solid;
    background: color-mix(in srgb, var(--haze-color-primary) 10%, transparent);
  }
`;

/**
 * 判断 href 是否指向项目内 .md 文件。
 * 排除 http(s)/mailto/tel/data/# 锚点等非文件引用。
 */
export function isMarkdownRef(href: string): boolean {
  if (!href) return false;
  if (/^(https?:|mailto:|tel:|data:|#)/i.test(href)) return false;
  return /\.md(\?|#|$)/i.test(href);
}

/**
 * 规范化 .md 引用路径：
 *  - 去掉查询串与锚点
 *  - decodeURIComponent：react-markdown 把中文链接 URL 编码（%E5%89%91…）
 *  - 去掉前导 ./ / / 和 .novel/ 前缀（agent 文本常用 .novel/xxx.md）
 *
 * 注意：不处理 ../ 相对路径前缀——路径解析在 dialog 的 resolveFile 中完成。
 */
export function normalizeMdPath(href: string): string {
  let p = href.replace(/[?#].*$/, '');
  try {
    p = decodeURIComponent(p);
  } catch { /* malformed URI, keep as-is */ }
  return p
    .replace(/^(\.\/|\/+)/, '')
    .replace(/^\.novel\//, '');
}

/** react-markdown 传入 a 组件的 props（含 node 节点引用，需剥离避免传入 DOM）。 */
export type AnchorLinkProps = ComponentProps<'a'> & { node?: unknown };

/** 从 React children 提取纯文本（用作标题回退）。 */
export function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

// ── 弹窗样式 ──────────────────────────────────────────────────────────

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
`;

const dialog = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 10px;
  width: 100%;
  max-width: 640px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
`;

const header = css`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid var(--haze-color-border);
`;

const title = css`
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--haze-color-text);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const pathBadge = css`
  font-size: 0.7rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  background: var(--haze-color-bg-secondary);
  color: var(--haze-color-text-secondary);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const closeBtn = css`
  background: transparent;
  border: none;
  font-size: 1.25rem;
  line-height: 1;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  &:hover {
    background: var(--haze-color-bg-secondary);
    color: var(--haze-color-text);
  }
`;

const body = css`
  padding: 1rem 1.25rem;
  overflow-y: auto;
  font-size: 0.9rem;
  line-height: 1.8;
  color: var(--haze-color-text);
  & p {
    margin: 0.5rem 0;
  }
  & ul,
  ol {
    padding-left: 1.5rem;
  }
  & h1,
  h2,
  h3 {
    margin-top: 0.75rem;
  }
`;

const status = css`
  color: var(--haze-color-text-secondary);
  font-size: 0.85rem;
  padding: 0.5rem 0;
`;

// ── 弹窗组件 ──────────────────────────────────────────────────────────

interface Props {
  projectId: string;
  /** 初始 .md 文件路径（相对 .novel 目录）。 */
  filePath: string;
  /** 弹窗标题（通常是链接文字）。 */
  title?: string;
  onClose: () => void;
}

export function MarkdownFileDialog({ projectId, filePath, title, onClose }: Props) {
  const [currentPath, setCurrentPath] = useState(filePath);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 加载文件内容：先试原始路径，失败则查文件列表做候选解析
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const tryFetch = async (p: string) => {
      const r = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(p)}`);
      const data = (await r.json()) as { content?: string; error?: string };
      if (data.error) return null;
      return data.content ?? '';
    };

    const resolveAndFetch = async () => {
      // 1. 直接试原始路径
      let content = await tryFetch(currentPath);
      if (content !== null) return content;

      // 2. 原始路径失败——查文件列表，用后缀匹配候选
      //    场景：profiles.md 里的链接是 profiles/剑平.md，但该文件实际在
      //    characters/profiles/剑平.md。又如 ../角色关系图.md 实际在
      //    characters/角色关系图.md。
      try {
        const listResp = await fetch(`/api/projects/${projectId}/files/list`);
        const listData = (await listResp.json()) as { files?: string[] };
        const allFiles = listData.files ?? [];
        // 规范化路径用于后缀匹配：去 ../ 和 ./
        const normalized = currentPath.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
        const candidate = allFiles.find((f) => f.endsWith(normalized));
        if (candidate) {
          content = await tryFetch(candidate);
          if (content !== null) return content;
        }
      } catch { /* list failed, fall through to error */ }

      return null;
    };

    resolveAndFetch()
      .then((content) => {
        if (cancelled) return;
        if (content === null) setError('文件未找到：' + currentPath);
        else setContent(content);
      })
      .catch(() => {
        if (!cancelled) setError('加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, currentPath]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 弹窗内嵌套 .md 链接：点击在同一弹窗内导航
  const a = useCallback(
    (props: AnchorLinkProps) => {
      const { href, children, node: _node, ...rest } = props;
      void _node;
      if (href && isMarkdownRef(href)) {
        return (
          <a
            {...rest}
            href={href}
            className={mdFileLink}
            onClick={(e) => {
              e.preventDefault();
              setCurrentPath(normalizeMdPath(href));
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
          {children}
        </a>
      );
    },
    [],
  );

  return (
    <div className={overlay} onClick={onClose}>
      <div
        className={dialog}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`文件预览：${title || currentPath}`}
      >
        <div className={header}>
          <span className={title}>{title || currentPath}</span>
          <span className={pathBadge} title={currentPath}>
            {currentPath}
          </span>
          <button className={closeBtn} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className={body}>
          {loading ? (
            <span className={status}>加载中…</span>
          ) : error ? (
            <span className={status}>{error}</span>
          ) : (
            <Markdown remarkPlugins={[remarkGfm]} components={{ a }}>
              {content || '*空文件*'}
            </Markdown>
          )}
        </div>
      </div>
    </div>
  );
}
