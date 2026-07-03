import { useState } from 'react';
import { css } from '@linaria/core';

// ---- 类型 ----
// 镜像后端 src/shared/naming/name-generator.ts 的导出 interface。
// 不直接 import 后端模块（其可能引入 node:fs），故在此复制字段以保证前端零后端耦合。

interface NameSource {
  text: string;
  quote: string;
}

interface NameChecks {
  homophone: boolean;
  collision: boolean;
  phonetics: boolean;
  similarity: boolean;
  rarity: boolean;
}

interface NameCandidate {
  name: string;
  surname: string;
  givenName: string;
  source: NameSource | null;
  imageryTags: string[];
  pinyin: string;
  checks: NameChecks;
  warnings: string[];
  reject: boolean;
}

// ---- 样式 ----

const container = css`
  display: flex;
  flex-direction: column;
`;

const form = css`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  border-bottom: 1px solid var(--haze-color-border);
`;

const formRow = css`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
`;

const label = css`
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--haze-color-text-secondary);
`;

const input = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.375rem 0.625rem;
  font-size: 0.8rem;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  &:focus { outline: none; border-color: var(--haze-color-primary); }
`;

const textarea = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.375rem 0.625rem;
  font-size: 0.8rem;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  resize: vertical;
  min-height: 4rem;
  font-family: inherit;
  line-height: 1.6;
  &:focus { outline: none; border-color: var(--haze-color-primary); }
`;

const select = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.375rem 0.625rem;
  font-size: 0.8rem;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  cursor: pointer;
  &:focus { outline: none; border-color: var(--haze-color-primary); }
`;

const generateBtn = css`
  background: var(--haze-color-primary);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 0.5rem 1rem;
  font-size: 0.85rem;
  cursor: pointer;
  font-weight: 600;
  align-self: flex-start;
  &:hover { opacity: 0.9; }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const candidateList = css`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
`;

const candidateCard = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.75rem 0.875rem;
  background: var(--haze-color-bg-secondary);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const candidateName = css`
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--haze-color-text);
  line-height: 1.3;
`;

const candidatePinyin = css`
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
`;

const source = css`
  font-size: 0.72rem;
  line-height: 1.6;
  color: var(--haze-color-text-secondary);
`;

const imageryTag = css`
  display: inline-block;
  font-size: 0.68rem;
  padding: 0.125rem 0.5rem;
  border-radius: 10px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text-secondary);
  margin-right: 0.25rem;
  margin-bottom: 0.125rem;
  border: 1px solid var(--haze-color-border);
`;

const warningRow = css`
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  color: var(--haze-color-warning, #f59e0b);
`;

const actionRow = css`
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
`;

const actionBtn = css`
  background: transparent;
  color: var(--haze-color-primary);
  border: 1px solid var(--haze-color-primary);
  border-radius: 4px;
  padding: 0.3rem 0.7rem;
  font-size: 0.75rem;
  cursor: pointer;
  &:hover { background: var(--haze-color-primary); color: white; }
`;

const loadingText = css`
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
  font-style: italic;
  padding: 1rem;
`;

const errorMsg = css`
  font-size: 0.78rem;
  color: var(--haze-color-error, #ef4444);
  padding: 1rem;
`;

const emptyHint = css`
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
  padding: 1rem;
`;

// ---- 组件 ----

const CATEGORIES = ['人名', '地名', '门派', '武功', '兵器', '章节名'] as const;
type Category = (typeof CATEGORIES)[number];

const REGIONS = ['模糊古代', '江南', '江淮', '江北', '岭南', '巴蜀', '中原', '塞北', '关中'] as const;
const GENDERS = ['不限', '男', '女'] as const;
type Gender = (typeof GENDERS)[number];

interface NamingPanelProps {
  projectId: string;
  /** 选中候选时回调：返回名字 + 拼音 + 意象标签 */
  onSelectRole?: (candidate: NameCandidate) => void;
}

export default function NamingPanel({ projectId, onSelectRole }: NamingPanelProps) {
  const [category, setCategory] = useState<Category>('人名');
  const [description, setDescription] = useState('');
  const [region, setRegion] = useState('模糊古代');
  const [gender, setGender] = useState<Gender>('不限');
  const [surnameConstraint, setSurnameConstraint] = useState('');
  const [candidates, setCandidates] = useState<NameCandidate[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [error, setError] = useState('');

  /** 将 UI gender 值映射为后端识别的 gender */
  function mapGender(g: Gender): string | undefined {
    if (g === '不限') return undefined;
    return g === '男' ? 'male' : 'female';
  }

  /** 生成候选名字 */
  const generate = async () => {
    if (!description.trim()) return;
    setStatus('loading');
    setError('');
    setCandidates([]);
    try {
      const res = await fetch(`/api/projects/${projectId}/naming/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          description: description.trim(),
          region,
          gender: mapGender(gender),
          surnameConstraint: surnameConstraint.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : `请求失败（${res.status}）`);
      }
      setCandidates(data.candidates ?? []);
      setStatus('success');
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 复制名字到剪贴板 */
  const copyName = async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
    } catch {
      // 剪贴板不可用时静默失败
    }
  };

  return (
    <div className={container}>
      {/* 表单区域 */}
      <div className={form}>
        <div className={formRow}>
          <label className={label}>类目</label>
          <select
            className={select}
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div className={formRow}>
          <label className={label}>设定描述</label>
          <textarea
            className={textarea}
            placeholder="沉默寡言、家道中落、背负秘密"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </div>

        <div className={formRow}>
          <label className={label}>出身地</label>
          <select
            className={select}
            value={region}
            onChange={(e) => setRegion(e.target.value)}
          >
            {REGIONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>

        <div className={formRow}>
          <label className={label}>性别</label>
          <select
            className={select}
            value={gender}
            onChange={(e) => setGender(e.target.value as Gender)}
          >
            {GENDERS.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </div>

        <div className={formRow}>
          <label className={label}>姓氏约束（可选）</label>
          <input
            className={input}
            placeholder="如：萧"
            value={surnameConstraint}
            onChange={(e) => setSurnameConstraint(e.target.value)}
          />
        </div>

        <button
          className={generateBtn}
          disabled={status === 'loading' || !description.trim()}
          onClick={generate}
        >
          {status === 'loading' ? '生成中...' : '生成'}
        </button>
      </div>

      {/* 状态指示 */}
      {status === 'loading' && <div className={loadingText}>正在生成候选名字...</div>}
      {status === 'error' && <div className={errorMsg}>{error}</div>}
      {status === 'success' && candidates.length === 0 && (
        <div className={emptyHint}>未生成符合条件的名字，请调整描述或筛选条件</div>
      )}

      {/* 候选列表 */}
      {candidates.length > 0 && (
        <div className={candidateList}>
          {candidates.map((c, idx) => (
            <div key={`${c.name}-${idx}`} className={candidateCard}>
              <div className={candidateName}>{c.name}</div>
              <div className={candidatePinyin}>{c.pinyin}</div>

              {c.source && (
                <div className={source}>
                  {c.source.text}{c.source.quote ? `「${c.source.quote}」` : ''}
                </div>
              )}

              {c.imageryTags.length > 0 && (
                <div>
                  {c.imageryTags.map((tag, ti) => (
                    <span key={ti} className={imageryTag}>{tag}</span>
                  ))}
                </div>
              )}

              {c.warnings.length > 0 && (
                <div className={warningRow}>
                  <span>⚠</span>
                  <span>{c.warnings.join('；')}</span>
                </div>
              )}

              <div className={actionRow}>
                <button
                  className={actionBtn}
                  onClick={() => copyName(c.name)}
                >
                  复制
                </button>
                {onSelectRole && (
                  <button
                    className={actionBtn}
                    onClick={() => onSelectRole(c)}
                  >
                    用于角色
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}