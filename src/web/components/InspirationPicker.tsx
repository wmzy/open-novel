import { useState } from 'react';
import { css } from '@linaria/core';
import {
  buildInspirationMessage,
  type Dimension,
  type DimensionParams,
} from '../../shared/inspiration';

/** 灵感注入 chat 的事件名。ChatPanel 监听此事件 → sendMessage。 */
export const INSPIRE_TO_CHAT_EVENT = 'open-novel:inspire-to-chat';

export interface InspireToChatDetail {
  message: string;
}

const DIMENSION_LABELS: Record<Dimension, string> = {
  faction: '门派/势力',
  archetype: '历史/现实原型',
  role: '功能定位',
  triangle: '驱动力三角',
  tension: '关系张力',
  random: '随机刺激',
};

const ROLE_OPTIONS: NonNullable<DimensionParams['role']>[] = [
  '盟友', '导师', '镜面', '障碍', '叛徒', '救星',
];

const TENSION_TYPES: NonNullable<NonNullable<DimensionParams['tension']>['type']>[] = [
  '敌对', '暧昧', '师徒', '利用',
];

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

/** 检查当前维度的必填参数是否齐全，用于禁用生成按钮。 */
function paramsComplete(dimension: Dimension, params: DimensionParams): boolean {
  switch (dimension) {
    case 'faction': return !!params.faction?.trim();
    case 'archetype': return true; // 原型可选，留空则 AI 自由发挥
    case 'role': return !!params.role;
    case 'tension': return !!params.tension?.target?.trim() && !!params.tension?.type;
    case 'triangle':
    case 'random': return true;
  }
}

export default function InspirationPicker() {
  const [dimension, setDimension] = useState<Dimension>('faction');
  const [faction, setFaction] = useState('');
  const [archetype, setArchetype] = useState('');
  const [role, setRole] = useState<NonNullable<DimensionParams['role']>>('盟友');
  const [tensionTarget, setTensionTarget] = useState('');
  const [tensionType, setTensionType] = useState<NonNullable<NonNullable<DimensionParams['tension']>['type']>>('敌对');

  const params: DimensionParams = {
    faction: faction || undefined,
    archetype: archetype || undefined,
    role,
    tension: dimension === 'tension' ? { target: tensionTarget, type: tensionType } : undefined,
  };

  const canGenerate = paramsComplete(dimension, params);

  const handleGenerate = () => {
    if (!canGenerate) return;
    const message = buildInspirationMessage(dimension, params);
    window.dispatchEvent(
      new CustomEvent<InspireToChatDetail>(INSPIRE_TO_CHAT_EVENT, { detail: { message } }),
    );
  };

  return (
    <div className={wrap}>
      <div className={row}>
        <span className={label}>维度：</span>
        <select
          className={select}
          value={dimension}
          onChange={(e) => setDimension(e.target.value as Dimension)}
        >
          {(Object.keys(DIMENSION_LABELS) as Dimension[]).map((d) => (
            <option key={d} value={d}>{DIMENSION_LABELS[d]}</option>
          ))}
        </select>
      </div>

      {/* 动态参数区 */}
      {dimension === 'faction' && (
        <div className={row}>
          <span className={label}>势力名：</span>
          <input className={input} value={faction} onChange={(e) => setFaction(e.target.value)} placeholder="如：明教、丐帮、朝廷" />
        </div>
      )}
      {dimension === 'archetype' && (
        <div className={row}>
          <span className={label}>原型人物：</span>
          <input className={input} value={archetype} onChange={(e) => setArchetype(e.target.value)} placeholder="如：诸葛亮、白起、苏轼（留空则 AI 自由发挥）" />
        </div>
      )}
      {dimension === 'role' && (
        <div className={row}>
          <span className={label}>功能：</span>
          <select className={select} value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      )}
      {dimension === 'tension' && (
        <>
          <div className={row}>
            <span className={label}>对手角色：</span>
            <input className={input} value={tensionTarget} onChange={(e) => setTensionTarget(e.target.value)} placeholder="已有角色名" />
          </div>
          <div className={row}>
            <span className={label}>关系：</span>
            <select className={select} value={tensionType} onChange={(e) => setTensionType(e.target.value as typeof tensionType)}>
              {TENSION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </>
      )}
      {/* triangle / random 无参数区 */}

      <div className={row}>
        <button className={generateBtn} onClick={handleGenerate} disabled={!canGenerate}>
          生成灵感
        </button>
      </div>
    </div>
  );
}
