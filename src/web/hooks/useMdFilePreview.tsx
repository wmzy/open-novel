/**
 * Markdown 文件引用弹窗的共享 hook。
 *
 * 用法：
 *   const { a, dialog } = useMdFilePreview(projectId);
 *   <Markdown components={{ a }}>...</Markdown>
 *   {dialog}
 *
 * - a：react-markdown 的 components.a，拦截 .md 链接并打开弹窗；
 *       非项目内 .md 链接退化为 target=_blank 新标签打开。
 * - dialog：弹窗 JSX，无目标时为 null。
 * - projectId 为空时禁用（a 退化为普通链接），方便无项目上下文的渲染器复用。
 */
import { useState, useCallback, type ReactNode } from 'react';
import {
  MarkdownFileDialog,
  mdFileLink,
  isMarkdownRef,
  normalizeMdPath,
  extractText,
  type AnchorLinkProps,
} from '../components/MarkdownFileDialog';

export function useMdFilePreview(projectId?: string) {
  const [target, setTarget] = useState<{ path: string; title: string } | null>(null);

  const a = useCallback(
    (props: AnchorLinkProps) => {
      const { href, children, node: _node, ...rest } = props;
      void _node;
      if (href && projectId && isMarkdownRef(href)) {
        const title = extractText(children) || normalizeMdPath(href);
        return (
          <a
            {...rest}
            href={href}
            className={mdFileLink}
            onClick={(e) => {
              e.preventDefault();
              setTarget({ path: normalizeMdPath(href), title });
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
    [projectId],
  );

  const dialog: ReactNode =
    projectId && target ? (
      <MarkdownFileDialog
        projectId={projectId}
        filePath={target.path}
        title={target.title}
        onClose={() => setTarget(null)}
      />
    ) : null;

  return { a, dialog };
}
