/**
 * 实体链接 span：点击触发 onPick 回调。
 * 按 data-type 着色（CSS 属性选择器）。
 */
import { css } from '@linaria/core';
import type { EntityRef } from '@/shared/entity-dict';

export const entityLink = css`
  color: var(--haze-color-primary);
  cursor: pointer;
  border-bottom: 1px dashed var(--haze-color-primary);
  padding: 0 1px;
  border-radius: 2px;
  transition: background 0.15s, border-bottom-style 0.15s;
  &:hover {
    background: color-mix(in srgb, var(--haze-color-primary) 12%, transparent);
    border-bottom-style: solid;
  }
  &[data-type='weapon'] {
    color: #ef4444;
    border-bottom-color: #ef4444;
  }
  &[data-type='martial'] {
    color: #f97316;
    border-bottom-color: #f97316;
  }
  &[data-type='move'] {
    color: #f97316;
    border-bottom-color: #f97316;
    border-bottom-style: dotted;
  }
  &[data-type='sect'] {
    color: #8b5cf6;
    border-bottom-color: #8b5cf6;
  }
  &[data-type='place'] {
    color: #10b981;
    border-bottom-color: #10b981;
  }
  &[data-type='alias'] {
    color: #64748b;
    border-bottom-color: #64748b;
    border-bottom-style: dotted;
  }
`;

interface Props {
  entity: EntityRef;
  onPick: (ref: EntityRef) => void;
}

export function EntityLink({ entity, onPick }: Props) {
  return (
    <span
      className={entityLink}
      data-type={entity.type}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onPick(entity);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onPick(entity);
        }
      }}
    >
      {entity.name}
    </span>
  );
}
