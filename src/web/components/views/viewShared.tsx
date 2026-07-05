import type { CSSProperties, ReactNode } from 'react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { css } from '@linaria/core';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isPlaceholder, parseSections } from './parseSections';
import type { MdField, MdSection } from './parseSections';

// 重新导出类型，方便视图统一引用
export type { MdField, MdSection, MdSubsection, ParsedDoc } from './parseSections';
// isPlaceholder 也重新导出，供各视图判断字段是否为模板占位符
export { isPlaceholder } from './parseSections';

/** 通用：拉取某个 .novel 文件原文。queryKey 保持 `['novel-file', projectId, fileKey]`，与 SSE 失效逻辑一致。 */
export function useNovelFile(projectId: string, fileKey: string, path: string) {
  return useQuery({
    queryKey: ['novel-file', projectId, fileKey],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(path)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.content as string;
    },
  });
}

/** 列出项目 .novel/ 下所有 .md/.json 文件（相对路径），用于发现子目录文件（如 wuxia/）。 */
export function useNovelFileList(projectId: string) {
  return useQuery({
    queryKey: ['novel-file-list', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/files/list`);
      if (!res.ok) return [] as string[];
      const data = await res.json();
      return (data.files as string[]) ?? [];
    },
  });
}

/** 加载中占位。 */
export const loadingWrap = css`
  padding: 2rem 1rem;
  color: var(--haze-color-text-secondary);
  font-size: 0.875rem;
`;

/** 空态容器。 */
export const emptyWrap = css`
  padding: 3rem 1rem;
  text-align: center;
  color: var(--haze-color-text-secondary);
  font-size: 0.875rem;
`;

/** 空态提示语。 */
export const emptyHint = css`
  display: inline-block;
  margin-top: 0.5rem;
  padding: 0.35rem 0.75rem;
  background: var(--haze-color-bg-secondary);
  border-radius: 6px;
  font-size: 0.8rem;
`;

/** 视图标题（与原各视图 <h3> 对齐）。 */
export const pageHeading = css`
  margin: 0 0 1.25rem;
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--haze-color-text);
`;

/** 修订按钮样式。ConceptView/WorldView/CharacterView/WritingView 共用。 */
export const reviseBtn = css`
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font-size: 0.75rem;
  color: var(--haze-color-text);
  &:hover {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
  }
`;

/** 卡片底座。 */
export const card = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 10px;
  padding: 1rem 1.1rem;
`;

/** 卡片标题。 */
export const cardTitle = css`
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--haze-color-text);
  margin: 0 0 0.75rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--haze-color-border);
`;

/** 字段行（标签：值 内联）。 */
export const fieldInline = css`
  font-size: 0.85rem;
  line-height: 1.6;
  color: var(--haze-color-text);
`;

/** 字段标签。 */
export const fieldKey = css`
  color: var(--haze-color-text-secondary);
  margin-right: 0.35rem;
`;

/** 字段空值占位。 */
export const fieldValEmpty = css`
  color: var(--haze-color-text-secondary);
  opacity: 0.55;
  font-style: italic;
`;

/** 段落正文。 */
export const bodyText = css`
  margin: 0 0 0.5rem;
  font-size: 0.875rem;
  line-height: 1.7;
  color: var(--haze-color-text);
  &:last-child { margin-bottom: 0; }
`;

// ── Markdown 渲染 / 源码切换 ──────────────────────────────────────────

/** 视图模式：'md' 渲染 Markdown，'source' 显示源码。 */
export type ViewMode = 'md' | 'source';

/** 视图头部行：标题 + 模式切换按钮。 */
export const viewHeaderRow = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0 0 1.25rem;
`;

/** 模式切换按钮组。 */
export const modeToggle = css`
  display: inline-flex;
  border: 1px solid var(--haze-color-border);
  border-radius: 7px;
  overflow: hidden;
  flex-shrink: 0;
`;

/** 单个模式按钮。 */
export const modeBtn = css`
  padding: 0.28rem 0.7rem;
  font-size: 0.78rem;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--haze-color-text-secondary);
  transition: background 0.12s, color 0.12s;
  &:hover { background: var(--haze-color-bg-secondary); }
`;

/** 激活态模式按钮。 */
export const modeBtnActive = css`
  background: var(--haze-color-primary);
  color: white;
  &:hover { background: var(--haze-color-primary); }
`;

/** 卡片内 Markdown 渲染区。 */
export const markdownBody = css`
  font-size: 0.875rem;
  line-height: 1.7;
  color: var(--haze-color-text);

  & > *:first-child { margin-top: 0; }
  & > *:last-child { margin-bottom: 0; }

  & p { margin: 0 0 0.5rem; }
  & ul, & ol { margin: 0.25rem 0 0.5rem; padding-left: 1.3rem; }
  & li { margin-bottom: 0.2rem; }
  & h1, & h2, & h3, & h4, & h5, & h6 {
    font-size: 0.9rem;
    font-weight: 600;
    margin: 0.6rem 0 0.3rem;
    color: var(--haze-color-text);
  }
  & h1 { font-size: 1rem; }
  & h2 { font-size: 0.95rem; }
  & blockquote {
    margin: 0.4rem 0;
    padding: 0.3rem 0.7rem;
    border-left: 3px solid var(--haze-color-border);
    color: var(--haze-color-text-secondary);
    background: var(--haze-color-bg-secondary);
    border-radius: 0 4px 4px 0;
  }
  & code {
    font-family: var(--haze-font-mono, monospace);
    font-size: 0.82rem;
    background: var(--haze-color-bg-secondary);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }
  & pre {
    margin: 0.4rem 0;
    padding: 0.6rem;
    background: var(--haze-color-bg-secondary);
    border-radius: 6px;
    overflow-x: auto;
    font-size: 0.8rem;
    & code { background: none; padding: 0; }
  }
  & table {
    width: 100%;
    border-collapse: collapse;
    margin: 0.4rem 0;
    font-size: 0.82rem;
    & th, & td {
      border: 1px solid var(--haze-color-border);
      padding: 0.35rem 0.5rem;
      text-align: left;
    }
    & th { background: var(--haze-color-bg-secondary); font-weight: 600; }
  }
  & hr {
    border: none;
    border-top: 1px solid var(--haze-color-border);
    margin: 0.6rem 0;
  }
  & strong { font-weight: 600; }
  & a { color: var(--haze-color-primary); text-decoration: none; }
`;

/** 卡片内源码显示区。 */
export const sourcePre = css`
  margin: 0;
  padding: 0.5rem 0.7rem;
  background: var(--haze-color-bg-secondary);
  border-radius: 6px;
  font-family: var(--haze-font-mono, monospace);
  font-size: 0.8rem;
  line-height: 1.6;
  color: var(--haze-color-text);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
`;

/** 卡片内空内容内联占位。 */
export const emptyInline = css`
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
  opacity: 0.6;
  font-style: italic;
`;

interface EmptyStateProps {
  /** 提示语，例如"尚未创建角色"。 */
  message: string;
  /** 起始指令，例如"/characters"。 */
  command?: string;
}

/** 统一的空态：文案 + "在聊天面板输入 /xxx 开始" 提示。 */
export function EmptyState({ message, command }: EmptyStateProps) {
  return (
    <div className={emptyWrap}>
      <div>{message}</div>
      {command && <div className={emptyHint}>在聊天面板中输入 {command} 开始</div>}
    </div>
  );
}

/** 可渲染内容块的形状。 */
interface BlockLike {
  fields: MdField[];
  items: string[];
  ordered: string[];
  body: string[];
}

/**
 * 把一个内容块渲染成字段 + 列表 + 段落，保证不丢内容。
 * `emphasize` 可对指定字段键返回行内样式（用于强调冲突/目标等）。
 */
export function renderBlock(block: BlockLike, emphasize?: (key: string) => CSSProperties | undefined): ReactNode {
  return (
    <>
      {block.fields.map((f, i) => (
        <div key={`f${i}`} className={fieldInline}>
          <span className={fieldKey}>{f.key}：</span>
          {!isPlaceholder(f.value) ? (
            <span style={emphasize?.(f.key)}>{f.value}</span>
          ) : (
            <span className={fieldValEmpty}>未填写</span>
          )}
        </div>
      ))}
      {block.items.map((it, i) => (
        <div key={`i${i}`} className={fieldInline}>{it}</div>
      ))}
      {block.ordered.length > 0 && (
        <ol style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
          {block.ordered.map((o, i) => (
            <li key={`o${i}`} className={fieldInline} style={{ marginBottom: '0.25rem' }}>{o}</li>
          ))}
        </ol>
      )}
      {block.body.map((p, i) => (
        <p key={`b${i}`} className={bodyText}>{p}</p>
      ))}
    </>
  );
}

/** 解析结果为空时的原始文本兜底，避免内容丢失。 */
export function RawFallback({ text }: { text: string }) {
  return (
    <div className={card}>
      <div className={cardTitle}>原始内容</div>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--haze-font-mono)', fontSize: '0.8rem', color: 'var(--haze-color-text-secondary)' }}>
        {text.trim()}
      </pre>
    </div>
  );
}

/**
 * 模式切换工具栏。
 * 放在视图标题右侧，点击在 Markdown 渲染和源码之间切换。
 */
export function ViewToolbar({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <div className={modeToggle}>
      <button
        type="button"
        className={mode === 'md' ? modeBtn + ' ' + modeBtnActive : modeBtn}
        onClick={() => onChange('md')}
      >
        预览
      </button>
      <button
        type="button"
        className={mode === 'source' ? modeBtn + ' ' + modeBtnActive : modeBtn}
        onClick={() => onChange('source')}
      >
        源码
      </button>
    </div>
  );
}

/** useViewMode：默认 'md'，返回 [mode, setMode]。 */
export function useViewMode(): [ViewMode, (m: ViewMode) => void] {
  return useState<ViewMode>('md');
}

/**
 * 卡片内容：根据 mode 渲染 Markdown 或源码。
 * `rawMd` 为空时显示占位提示。
 */
export function CardContent({ rawMd, mode }: { rawMd: string; mode: ViewMode }) {
  if (!rawMd || !rawMd.trim()) {
    return <span className={emptyInline}>暂无内容</span>;
  }
  if (mode === 'source') {
    return <pre className={sourcePre}>{rawMd}</pre>;
  }
  return (
    <Markdown remarkPlugins={[remarkGfm]} className={markdownBody}>
      {rawMd}
    </Markdown>
  );
}

/** 判断分组是否完全为空（无任何可渲染内容，或内容全是模板占位符）。 */
export function isSectionEmpty(s: MdSection): boolean {
  const subEmpty = (sub: MdSection['subsections'][number]) =>
    isEmptyBlock(sub);
  return isEmptyBlock(s) && s.subsections.every(subEmpty);
}

function isEmptyBlock(b: { fields: MdField[]; items: string[]; ordered: string[]; body: string[] }): boolean {
  const fieldsEmpty = b.fields.length === 0 || b.fields.every((f) => isPlaceholder(f.value));
  const itemsEmpty = b.items.length === 0 || b.items.every((it) => isPlaceholder(it));
  const orderedEmpty = b.ordered.length === 0 || b.ordered.every((o) => isPlaceholder(o));
  const bodyEmpty = b.body.length === 0 || b.body.every((p) => isPlaceholder(p));
  return fieldsEmpty && itemsEmpty && orderedEmpty && bodyEmpty;
}
