/**
 * react-markdown 包装器：在渲染时把正文里的实体名替换为可点击链接。
 *
 * 实现要点（react-markdown v9）：
 *  - components 只能映射 HTML 标签名，无 text key
 *  - 自定义 p/li/h1-h6/blockquote/td/th，每个块组件渲染原标签 + 处理 children
 *  - EntityChildren 递归遍历 React 树，对字符串节点跑 splitTextByEntities
 *  - 实体段渲染 EntityLink，点击打开 EntityDetailDialog
 */
import {
  useState,
  useMemo,
  useContext,
  createContext,
  isValidElement,
  cloneElement,
  createElement,
  type ReactNode,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { EntityRef } from '@/shared/entity-dict';
import { splitTextByEntities } from '@/shared/entity-linker';
import { EntityLink } from './EntityLink';
import { EntityDetailDialog } from './EntityDetailDialog';

interface CtxValue {
  dict: Map<string, EntityRef>;
  onPick: (ref: EntityRef) => void;
}

const EntityContext = createContext<CtxValue>({ dict: new Map(), onPick: () => {} });

/** 递归处理 React 节点：字符串 → 切片渲染；元素 → 递归处理其 children。 */
function processNode(
  node: ReactNode,
  dict: Map<string, EntityRef>,
  onPick: (r: EntityRef) => void,
): ReactNode {
  if (node == null || typeof node === 'boolean') return node;
  if (typeof node === 'string') {
    const segments = splitTextByEntities(node, dict);
    if (segments.length === 0) return node;
    return segments.map((seg, i) =>
      seg.ref ? (
        <EntityLink key={i} entity={seg.ref} onPick={onPick} />
      ) : (
        <span key={i}>{seg.text}</span>
      ),
    );
  }
  if (Array.isArray(node)) {
    return node.map((n, i) => <span key={i}>{processNode(n, dict, onPick)}</span>);
  }
  if (isValidElement(node)) {
    const childProps = node.props as { children?: ReactNode };
    const processedChildren = processNode(childProps.children, dict, onPick);
    return cloneElement(node, {}, processedChildren);
  }
  return node;
}

/** 块组件包装器：渲染原标签，children 经 processNode 处理。 */
function EntityChildren({ children }: { children: ReactNode }) {
  const { dict, onPick } = useContext(EntityContext);
  return <>{processNode(children, dict, onPick)}</>;
}

const BLOCK_TAGS = ['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'td', 'th'] as const;

interface Props {
  content: string;
  dict: Map<string, EntityRef>;
  /** 预留：未来弹窗内可展示该实体出现过的章节（当前未直接使用）。 */
  projectId: string;
  /** 可选：传给 react-markdown 顶层容器的 className（如复用卡片样式）。 */
  className?: string;
}

export function EntityMarkdown({ content, dict, className }: Props) {
  const [dialogEntity, setDialogEntity] = useState<EntityRef | null>(null);

  const ctxValue = useMemo<CtxValue>(
    () => ({ dict, onPick: setDialogEntity }),
    [dict],
  );

  const components = useMemo(() => {
    const wrapped: Record<string, (props: Record<string, unknown>) => ReactNode> = {};
    for (const tag of BLOCK_TAGS) {
      wrapped[tag] = (props) =>
        createElement(
          tag,
          props,
          <EntityChildren>{props.children as ReactNode}</EntityChildren>,
        );
    }
    return wrapped;
  }, []);

  return (
    <EntityContext.Provider value={ctxValue}>
      <Markdown remarkPlugins={[remarkGfm]} components={components} className={className}>
        {content || '*No content*'}
      </Markdown>
      {dialogEntity && (
        <EntityDetailDialog entity={dialogEntity} onClose={() => setDialogEntity(null)} />
      )}
    </EntityContext.Provider>
  );
}
