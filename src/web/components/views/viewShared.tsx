import type { CSSProperties, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { css } from '@linaria/core';
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
