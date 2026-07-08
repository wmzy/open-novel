import { useState } from 'react';
import { css, cx } from '@linaria/core';
import {
  buildCharacterEnrichMessage,
  buildInspirationMessage,
  ENRICH_DIRECTION_LABELS,
  type EnrichDirection,
} from '../../shared/inspiration';
import { INSPIRE_TO_CHAT_EVENT, type InspireToChatDetail } from './InspirationPicker';

/**
 * 卡片内嵌的轻量灵感触发器。
 * - enrich-character：针对单个已有角色，展开方向选择（补充事迹/强化定位/挖掘背景）。
 * - generate-in-faction：针对势力卡片，生成该势力下的新角色种子。
 * 选定后组装消息并 dispatch INSPIRE_TO_CHAT_EVENT，由 ChatPanel 注入对话。
 */
type Props =
  | { mode: 'enrich-character'; characterName: string }
  | { mode: 'generate-in-faction'; factionName: string };

const inlineWrap = css`
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
`;

const triggerBtn = css`
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 0.95rem;
  line-height: 1;
  padding: 0.1rem 0.2rem;
  border-radius: 4px;
  opacity: 0.55;
  &:hover { opacity: 1; background: var(--haze-color-bg-hover, rgba(0,0,0,0.05)); }
`;

const popRow = css`
  display: inline-flex;
  gap: 0.3rem;
  flex-wrap: wrap;
`;

const dirBtn = css`
  background: var(--haze-color-bg-hover, rgba(74,158,255,0.1));
  color: var(--haze-color-text);
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.15rem 0.5rem;
  font-size: 0.72rem;
  cursor: pointer;
  white-space: nowrap;
  &:hover { border-color: var(--haze-color-accent, #4a9aff); color: var(--haze-color-accent, #4a9aff); }
`;

export default function InlineInspiration(props: Props) {
  const [open, setOpen] = useState(false);

  const dispatch = (message: string) => {
    window.dispatchEvent(
      new CustomEvent<InspireToChatDetail>(INSPIRE_TO_CHAT_EVENT, { detail: { message } }),
    );
    setOpen(false);
  };

  if (props.mode === 'enrich-character') {
    return (
      <div className={inlineWrap}>
        <button
          className={triggerBtn}
          onClick={() => setOpen((v) => !v)}
          title="补充这个角色的灵感"
        >
          💡
        </button>
        {open && (
          <div className={popRow}>
            {(Object.keys(ENRICH_DIRECTION_LABELS) as EnrichDirection[]).map((d) => (
              <button
                key={d}
                className={dirBtn}
                onClick={() => dispatch(buildCharacterEnrichMessage(props.characterName, d))}
              >
                {ENRICH_DIRECTION_LABELS[d]}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // generate-in-faction：势力名缺失则不渲染（防御空数据）
  if (!props.factionName.trim()) return null;
  return (
    <div className={cx(inlineWrap)}>
      <button
        className={triggerBtn}
        onClick={() => setOpen((v) => !v)}
        title="生成这个势力的新角色"
      >
        💡
      </button>
      {open && (
        <div className={popRow}>
          <button
            className={dirBtn}
            onClick={() => dispatch(buildInspirationMessage('faction', { faction: props.factionName }))}
          >
            生成「{props.factionName}」新角色
          </button>
        </div>
      )}
    </div>
  );
}
