import { useState } from 'react';
import { css } from '@linaria/core';
import {
  INSPIRE_STAGES,
  buildStageInspirationMessage,
  stageDimensionReady,
  initDimensionParams,
  type InspireStage,
  type InspireDimensionDef,
} from '../../shared/inspiration';

/** 灵感注入 chat 的事件名。ChatPanel 监听此事件 → sendMessage。 */
export const INSPIRE_TO_CHAT_EVENT = 'open-novel:inspire-to-chat';

export interface InspireToChatDetail {
  message: string;
}

const wrap = css`
  padding: 0.75rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg-secondary);
  margin-bottom: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const row = css`
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
`;

const label = css`
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
  white-space: nowrap;
`;

const select = css`
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.3rem 0.5rem;
  font-size: 0.85rem;
`;

const input = css`
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.3rem 0.5rem;
  font-size: 0.85rem;
  flex: 1;
  min-width: 120px;
`;

const generateBtn = css`
  background: var(--haze-color-accent, #4a9eff);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 0.4rem 1rem;
  font-size: 0.85rem;
  cursor: pointer;
  white-space: nowrap;
  &:hover { opacity: 0.9; }
  &:disabled { opacity: 0.4; cursor: not-allowed; }
`;

/**
 * 数据驱动的灵感选择器。按 stage 渲染对应阶段的维度集合，
 * 选定维度后组装消息并 dispatch INSPIRE_TO_CHAT_EVENT，由 ChatPanel 注入对话。
 */
export default function InspirationPicker({ stage = 'character' }: { stage?: InspireStage }) {
  const stageDef = INSPIRE_STAGES[stage];
  const firstDim: InspireDimensionDef | undefined = stageDef.dimensions[0];
  const [dimensionId, setDimensionId] = useState(firstDim?.id ?? '');
  const [params, setParams] = useState<Record<string, string>>(() => initDimensionParams(firstDim));

  const dim = stageDef.dimensions.find((d) => d.id === dimensionId) ?? firstDim;
  const canGenerate = dim ? stageDimensionReady(stage, dim.id, params) : false;

  const handleGenerate = () => {
    if (!dim || !canGenerate) return;
    const message = buildStageInspirationMessage(stage, dim.id, params);
    window.dispatchEvent(
      new CustomEvent<InspireToChatDetail>(INSPIRE_TO_CHAT_EVENT, { detail: { message } }),
    );
  };

  const switchDimension = (id: string) => {
    const d = stageDef.dimensions.find((x) => x.id === id);
    setDimensionId(id);
    setParams(initDimensionParams(d));
  };

  if (!dim) return null;

  return (
    <div className={wrap}>
      <div className={row}>
        <span className={label}>维度：</span>
        <select className={select} value={dimensionId} onChange={(e) => switchDimension(e.target.value)}>
          {stageDef.dimensions.map((d) => (
            <option key={d.id} value={d.id}>{d.label}</option>
          ))}
        </select>
      </div>

      {dim.params?.map((pd) => (
        <div className={row} key={pd.key}>
          <span className={label}>{pd.label}：</span>
          {pd.type === 'select' ? (
            <select
              className={select}
              value={params[pd.key] ?? pd.options?.[0] ?? ''}
              onChange={(e) => setParams((s) => ({ ...s, [pd.key]: e.target.value }))}
            >
              {pd.options?.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input
              className={input}
              value={params[pd.key] ?? ''}
              onChange={(e) => setParams((s) => ({ ...s, [pd.key]: e.target.value }))}
              placeholder={pd.placeholder}
            />
          )}
        </div>
      ))}

      <div className={row}>
        <button className={generateBtn} onClick={handleGenerate} disabled={!canGenerate}>
          生成灵感
        </button>
      </div>
    </div>
  );
}
