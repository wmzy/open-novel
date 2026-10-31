/**
 * 富文本（Markdown WYSIWYG）编辑器。
 *
 * contentEditable 完全非受控：React 只在「外部 value 变化」时写入 innerHTML，
 * 打字过程中绝不重设 DOM，避免光标跳动。序列化统一走
 * `editorHtmlToMarkdown`，产物仍是通过 `onChange` 保存的 Markdown。
 */
import { useCallback, useEffect, useRef } from 'react';
import { css, cx } from '@linaria/core';
import {
  editorHtmlToMarkdown,
  markdownToEditorHtml,
} from '@/shared/rich-markdown';

const container = css`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
`;

const formatBar = css`
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-wrap: wrap;
  padding: 0.375rem 0.75rem;
  border-bottom: 1px solid var(--haze-color-border);
  color: var(--haze-color-text-secondary);
`;

const formatBtn = css`
  background: none;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.125rem 0.5rem;
  font-size: 0.7rem;
  line-height: 1.5;
  cursor: pointer;
  color: var(--haze-color-text-secondary);
  &:hover { background: var(--haze-color-bg-secondary); color: var(--haze-color-text); }
  &:focus-visible { outline: 2px solid var(--haze-color-primary); outline-offset: 1px; }
`;

const editorBody = css`
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  font-size: 0.95rem;
  line-height: 1.9;
  color: var(--haze-color-text);
  background: var(--haze-color-bg);
  white-space: pre-wrap;
  word-break: break-word;
  outline: none;

  &:empty::before {
    content: attr(data-placeholder);
    color: var(--haze-color-text-secondary);
    opacity: 0.7;
    pointer-events: none;
  }

  & h1, & h2, & h3, & h4, & h5, & h6 {
    margin: 1em 0 0.5em;
    line-height: 1.4;
  }
  & h1 { font-size: 1.5rem; }
  & h2 { font-size: 1.3rem; }
  & h3 { font-size: 1.15rem; }
  & p { margin: 0 0 0.9em; }
  & blockquote {
    margin: 0 0 0.9em;
    padding-left: 0.75rem;
    border-left: 3px solid var(--haze-color-border);
    color: var(--haze-color-text-secondary);
  }
  & ul, & ol {
    margin: 0 0 0.9em;
    padding-left: 1.5rem;
  }
  & li { margin: 0.2em 0; }
  & code {
    font-family: var(--haze-font-mono);
    font-size: 0.85em;
    background: var(--haze-color-bg-secondary);
    border-radius: 3px;
    padding: 0.1em 0.3em;
  }
  & pre {
    margin: 0 0 0.9em;
    padding: 0.75rem;
    overflow-x: auto;
    background: var(--haze-color-bg-secondary);
    border-radius: 4px;
  }
  & pre code { background: none; padding: 0; }
  & a { color: var(--haze-color-primary); text-decoration: underline; }
  & hr {
    border: none;
    border-top: 1px solid var(--haze-color-border);
    margin: 1.25em 0;
  }
`;

interface Props {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  className?: string;
}

/** 读取选区所在的最近块级标签（用于标题/引用的切换判断）。 */
function ancestorTag(root: HTMLElement, names: Set<string>): string | null {
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  if (!selection?.anchorNode || !root.contains(selection.anchorNode)) return null;
  let node: Node | null = selection.anchorNode;
  while (node && node !== root) {
    if (node.nodeType === 1) {
      const tag = (node as Element).tagName.toLowerCase();
      if (names.has(tag)) return tag;
    }
    node = node.parentNode;
  }
  return null;
}

function exec(command: string, value?: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  try {
    return document.execCommand(command, false, value);
  } catch {
    return false;
  }
}

export default function RichMarkdownEditor({ value, onChange, placeholder, className }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  /** 最近一次由本编辑器产出的 Markdown；用于区分内部输入与外部 value 变更。 */
  const lastEmittedRef = useRef<string | null>(null);

  // 外部 value 变化（切章、AI 回填等）才同步 DOM；内部输入不回写，避免光标跳动。
  useEffect(() => {
    const el = editorRef.current;
    if (!el || value === lastEmittedRef.current) return;
    const html = markdownToEditorHtml(value);
    if (el.innerHTML !== html) el.innerHTML = html;
    lastEmittedRef.current = value;
  }, [value]);

  /** 序列化当前 DOM → Markdown；只有内容真的变了才通知父组件。 */
  const emitChange = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const markdown = editorHtmlToMarkdown(el.innerHTML);
    if (markdown === lastEmittedRef.current) return;
    lastEmittedRef.current = markdown;
    onChange(markdown);
  }, [onChange]);

  const runCommand = useCallback((command: string, commandValue?: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    if (exec(command, commandValue)) emitChange();
  }, [emitChange]);

  const toggleHeading = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const tag = ancestorTag(el, new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']));
    if (exec('formatBlock', tag ? 'p' : 'h2')) emitChange();
  }, [emitChange]);

  const toggleBlockquote = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const inQuote = ancestorTag(el, new Set(['blockquote'])) !== null;
    if (exec('formatBlock', inQuote ? 'p' : 'blockquote')) emitChange();
  }, [emitChange]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      runCommand('bold');
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    // 只接受纯文本，杜绝从网页粘入脚本/样式/外链图片。
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    const el = editorRef.current;
    if (!el) return;
    el.focus();

    let inserted = false;
    if (typeof document.execCommand === 'function') {
      try {
        inserted = document.execCommand('insertText', false, text);
      } catch {
        inserted = false;
      }
    }

    if (!inserted) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0 && el.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const lines = text.replace(/\r\n?/g, '\n').split('\n');
        const fragment = document.createDocumentFragment();
        let lastNode: Node | null = null;
        lines.forEach((line, index) => {
          if (index > 0) {
            lastNode = document.createElement('br');
            fragment.appendChild(lastNode);
          }
          if (line) {
            lastNode = document.createTextNode(line);
            fragment.appendChild(lastNode);
          }
        });
        range.insertNode(fragment);
        if (lastNode) {
          range.setStartAfter(lastNode);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } else {
        el.appendChild(document.createTextNode(text));
      }
    }
    emitChange();
  };

  return (
    <div className={cx(container, className)} data-testid="rich-markdown-editor">
      <div className={formatBar} role="toolbar" aria-label="富文本格式">
        <button
          type="button"
          className={formatBtn}
          aria-label="加粗"
          title="加粗 (Ctrl/Cmd+B)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => runCommand('bold')}
        >
          加粗
        </button>
        <button
          type="button"
          className={formatBtn}
          aria-label="斜体"
          title="斜体"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => runCommand('italic')}
        >
          斜体
        </button>
        <button
          type="button"
          className={formatBtn}
          aria-label="标题"
          title="标题（H2，再次点击恢复正文）"
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleHeading}
        >
          标题
        </button>
        <button
          type="button"
          className={formatBtn}
          aria-label="引用"
          title="引用（再次点击恢复正文）"
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleBlockquote}
        >
          引用
        </button>
        <button
          type="button"
          className={formatBtn}
          aria-label="无序列表"
          title="无序列表"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => runCommand('insertUnorderedList')}
        >
          无序列表
        </button>
        <button
          type="button"
          className={formatBtn}
          aria-label="有序列表"
          title="有序列表"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => runCommand('insertOrderedList')}
        >
          有序列表
        </button>
      </div>
      <div
        ref={editorRef}
        className={editorBody}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="正文"
        data-placeholder={placeholder ?? ''}
        onInput={emitChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />
    </div>
  );
}
