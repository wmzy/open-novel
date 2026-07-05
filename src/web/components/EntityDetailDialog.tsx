/**
 * 实体详情弹窗：渲染 EntityRef.sectionRaw（markdown 原文）。
 * 布局参考 RevisionDialog：overlay 遮罩 + 居中卡片。
 */
import { useEffect } from 'react';
import { css } from '@linaria/core';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { EntityRef } from '@/shared/entity-dict';

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
  max-width: 560px;
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
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--haze-color-border);
`;

const title = css`
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--haze-color-text);
  flex: 1;
`;

const typeBadge = css`
  font-size: 0.7rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  background: var(--haze-color-bg-secondary);
  color: var(--haze-color-text-secondary);
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
  & h2,
  h3 {
    margin-top: 0.75rem;
  }
`;

const TYPE_LABELS: Record<EntityRef['type'], string> = {
  character: '角色',
  alias: '外号',
  weapon: '武器',
  martial: '武功',
  sect: '门派',
  move: '招式',
  place: '地名',
};

interface Props {
  entity: EntityRef;
  onClose: () => void;
}

export function EntityDetailDialog({ entity, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={overlay} onClick={onClose}>
      <div
        className={dialog}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`实体详情：${entity.name}`}
      >
        <div className={header}>
          <span className={title}>{entity.name}</span>
          <span className={typeBadge}>{TYPE_LABELS[entity.type]}</span>
          <button className={closeBtn} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className={body}>
          <Markdown remarkPlugins={[remarkGfm]}>{entity.sectionRaw}</Markdown>
        </div>
      </div>
    </div>
  );
}
