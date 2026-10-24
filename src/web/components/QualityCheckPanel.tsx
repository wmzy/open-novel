import { useState } from 'react';
import { css } from '@linaria/core';

// ---- 类型 ----
// 镜像后端 src/agent/quality-checker.ts 的导出 interface。
// 不直接 import 后端模块（其顶部引入了 node:fs），故在此复制字段以保证前端零后端耦合。

/** 反 AI 味单条问题。 */
interface AiPatternIssue {
  type: string;
  snippet: string;
  suggestion: string;
}

/** 反 AI 味报告：0-100 评分（越高越像 AI）+ 逐条问题。 */
interface AiPatternReport {
  score: number;
  issues: AiPatternIssue[];
}

/** 疑似遗忘的伏笔。 */
interface ForgottenForeshadow {
  id: number;
  content: string;
  lastSeenChapter: number;
  chaptersSinceLastSeen: number;
}

/** 已回收的伏笔。 */
interface ResolvedForeshadow {
  id: number;
  content: string;
  resolvedIn: number | null;
}

/** 仍在跟踪的健康伏笔。 */
interface HealthyForeshadow {
  id: number;
  content: string;
  lastSeenChapter: number;
}

/** 伏笔遗忘报告。 */
interface ForeshadowReport {
  forgotten: ForgottenForeshadow[];
  resolved: ResolvedForeshadow[];
  healthy: HealthyForeshadow[];
}

/** 单条人物 OOC（Out Of Character）问题。 */
interface OocIssue {
  character: string;
  chapter: number;
  issue: string;
  profileExpectation: string;
  actualBehavior: string;
}

/** 人物 OOC 报告。 */
interface OocReport {
  oocIssues: OocIssue[];
}

/** 事实核查问题类型（与后端 FactIssueType 对齐）。 */
type FactIssueType = 'pov-leakage' | 'name-inconsistency' | 'canon-contradiction';

/** 事实核查严重度。 */
type FactSeverity = 'blocker' | 'major' | 'minor';

/** 统一的事实核查条目（镜像后端 FactCheckFinding）。 */
interface FactCheckFinding {
  type: FactIssueType;
  severity: FactSeverity;
  chapter: number;
  character?: string;
  quote: string;
  detail: string;
  suggestion?: string;
  source: 'mechanical' | 'semantic';
}

/** 事实核查报告：机械 + 语义结果。 */
interface FactCheckReport {
  chapter: number;
  pov?: string | null;
  findings: FactCheckFinding[];
  mechanical: FactCheckFinding[];
  semantic: FactCheckFinding[];
  semanticError?: string;
}

/** 单项检查的运行态。 */
type CheckStatus = 'idle' | 'loading' | 'success' | 'error';

interface CheckState<T> {
  status: CheckStatus;
  data?: T;
  error?: string;
}

// ---- 样式 ----

const container = css`
  display: flex;
  flex-direction: column;
`;

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
  gap: 0.5rem;
  flex-wrap: wrap;
`;

const body = css`
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
`;

const checkSection = css`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const checkHeader = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
`;

const sectionTitle = css`
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--haze-color-text-secondary);
  margin: 0;
`;

const primaryBtn = css`
  background: var(--haze-color-primary);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 0.375rem 0.875rem;
  font-size: 0.8rem;
  cursor: pointer;
  white-space: nowrap;
  &:hover { opacity: 0.9; }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const thresholdRow = css`
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.72rem;
  color: var(--haze-color-text-secondary);
`;

const thresholdInput = css`
  width: 3rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.125rem 0.375rem;
  font-size: 0.75rem;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  &:focus { outline: none; border-color: var(--haze-color-primary); }
`;

const scoreRow = css`
  display: flex;
  align-items: center;
  gap: 0.625rem;
`;

const scoreBar = css`
  flex: 1;
  height: 8px;
  border-radius: 4px;
  background: var(--haze-color-bg-secondary);
  overflow: hidden;
`;

const scoreBarFill = css`
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s ease;
`;

const scoreLabel = css`
  font-size: 0.78rem;
  font-weight: 600;
  white-space: nowrap;
`;

const issueList = css`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.5rem;
`;

const issueItem = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.5rem 0.625rem;
  background: var(--haze-color-bg-secondary);
`;

const issueType = css`
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.0625rem 0.5rem;
  border-radius: 10px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  margin-bottom: 0.25rem;
`;

const severityTag = css`
  display: inline-block;
  font-size: 0.66rem;
  font-weight: 600;
  padding: 0.0625rem 0.45rem;
  border-radius: 10px;
  color: #fff;
  margin-left: 0.375rem;
  vertical-align: middle;
`;

const snippet = css`
  font-size: 0.8rem;
  line-height: 1.6;
  color: var(--haze-color-text);
  margin: 0.125rem 0;
`;

const suggestion = css`
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--haze-color-text-secondary);
`;

const groupTitle = css`
  font-size: 0.78rem;
  font-weight: 600;
  margin: 0.25rem 0;
  color: var(--haze-color-text);
  margin-top: 0.75rem;
`;

const warnItem = css`
  border: 1px solid var(--haze-color-warning, #f59e0b);
  background: color-mix(in srgb, var(--haze-color-warning, #f59e0b) 12%, var(--haze-color-bg-secondary));
  border-radius: 6px;
  padding: 0.5rem 0.625rem;
`;

const metaWarn = css`
  font-size: 0.72rem;
  color: var(--haze-color-warning, #f59e0b);
  margin-top: 0.25rem;
`;

const metaMuted = css`
  font-size: 0.72rem;
  color: var(--haze-color-text-secondary);
  margin-top: 0.25rem;
`;

const loadingText = css`
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
  font-style: italic;
`;

const errorMsg = css`
  font-size: 0.78rem;
  color: var(--haze-color-error, #ef4444);
`;

const emptyHint = css`
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
  padding: 0.25rem 0;
`;

// ---- 数据 ----

/** AI 味评分 → 颜色（绿<30 / 黄 30-60 / 红>60）。 */
function scoreColor(score: number): string {
  if (score < 30) return '#22c55e';
  if (score <= 60) return '#f59e0b';
  return '#ef4444';
}

/** AI 味评分 → 文案。 */
function scoreText(score: number): string {
  if (score < 30) return 'AI 味低';
  if (score <= 60) return 'AI 味中等';
  return 'AI 味高';
}

interface Props {
  projectId: string;
  chapterNum: number;
  /** 当前选择的 agent，用于「AI 语义核查」；为空时该按钮禁用。 */
  agentId?: string;
}

export default function QualityCheckPanel({ projectId, chapterNum, agentId }: Props) {
  const [aiState, setAiState] = useState<CheckState<AiPatternReport>>({ status: 'idle' });
  const [foreshadowState, setForeshadowState] = useState<CheckState<ForeshadowReport>>({ status: 'idle' });
  const [oocState, setOocState] = useState<CheckState<OocReport>>({ status: 'idle' });
  const [factState, setFactState] = useState<CheckState<FactCheckReport>>({ status: 'idle' });
  const [factMode, setFactMode] = useState<'quick' | 'deep' | null>(null);
  // 伏笔遗忘阈值，默认 5（与后端 FORGOTTEN_CHAPTER_THRESHOLD 一致）
  const [threshold, setThreshold] = useState(5);

  /** 通用请求封装：POST JSON，解析返回；失败抛出可读错误。 */
  async function postCheck<T>(path: string, payload: unknown): Promise<T> {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof data?.error === 'string' ? data.error : `请求失败（${res.status}）`);
    }
    return data as T;
  }

  /** 反 AI 味检测：按当前章节正文分析。 */
  const runAiPatterns = async () => {
    setAiState({ status: 'loading' });
    try {
      const data = await postCheck<AiPatternReport>(
        `/api/projects/${projectId}/check/ai-patterns`,
        { chapterNum },
      );
      setAiState({ status: 'success', data });
    } catch (e) {
      setAiState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  };

  /** 伏笔遗忘检测：按阈值分类。 */
  const runForeshadows = async () => {
    setForeshadowState({ status: 'loading' });
    try {
      const data = await postCheck<ForeshadowReport>(
        `/api/projects/${projectId}/check/foreshadows?threshold=${threshold}`,
        {},
      );
      setForeshadowState({ status: 'success', data });
    } catch (e) {
      setForeshadowState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  };

  /** 人物 OOC 检测：检查当前章节人物是否符合人设。 */
  const runOoc = async () => {
    setOocState({ status: 'loading' });
    try {
      const data = await postCheck<OocReport>(
        `/api/projects/${projectId}/check/ooc`,
        { chapterNum },
      );
      setOocState({ status: 'success', data });
    } catch (e) {
      setOocState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  };

  /**
   * 事实核查：
   * - quick：只跑机械规则（POV 知情越界启发式 + 人名近似笔误），秒级返回；
   * - deep：额外调用当前 agent 做语义核查（POV 泄漏 / 姓名别名 / 设定时间线）。
   * 结果只报告，不阻断写作。
   */
  const runFactCheck = async (deep: boolean) => {
    if (deep && !agentId) return;
    setFactMode(deep ? 'deep' : 'quick');
    setFactState({ status: 'loading' });
    try {
      const data = await postCheck<FactCheckReport>(
        `/api/projects/${projectId}/check/fact-check`,
        { chapterNum, deep, ...(deep ? { agentId } : {}) },
      );
      setFactState({ status: 'success', data });
    } catch (e) {
      setFactState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    } finally {
      setFactMode(null);
    }
  };

  return (
    <div className={container}>
      <div className={header}>
        <span>第 {chapterNum} 章 · 自动化质量检查</span>
      </div>

      <div className={body}>
        {/* 反 AI 味 */}
        <section className={checkSection}>
          <div className={checkHeader}>
            <p className={sectionTitle}>🤖 反 AI 味检测</p>
            <button className={primaryBtn} disabled={aiState.status === 'loading'} onClick={runAiPatterns}>
              {aiState.status === 'loading' ? '检测中...' : '开始检测'}
            </button>
          </div>
          {aiState.status === 'loading' && <div className={loadingText}>正在分析章节正文...</div>}
          {aiState.status === 'error' && <div className={errorMsg}>{aiState.error}</div>}
          {aiState.status === 'success' && aiState.data && (
            <AiPatternsResult report={aiState.data} />
          )}
        </section>

        {/* 伏笔遗忘 */}
        <section className={checkSection}>
          <div className={checkHeader}>
            <p className={sectionTitle}>🔮 伏笔遗忘检测</p>
            <div className={thresholdRow}>
              <span>阈值</span>
              <input
                className={thresholdInput}
                type="number"
                min={1}
                value={threshold}
                onChange={(e) => setThreshold(Math.max(1, Number(e.target.value) || 1))}
              />
              <button
                className={primaryBtn}
                disabled={foreshadowState.status === 'loading'}
                onClick={runForeshadows}
              >
                {foreshadowState.status === 'loading' ? '检测中...' : '开始检测'}
              </button>
            </div>
          </div>
          {foreshadowState.status === 'loading' && <div className={loadingText}>正在比对伏笔与章节正文...</div>}
          {foreshadowState.status === 'error' && <div className={errorMsg}>{foreshadowState.error}</div>}
          {foreshadowState.status === 'success' && foreshadowState.data && (
            <ForeshadowResult report={foreshadowState.data} />
          )}
        </section>

        {/* 人物 OOC */}
        <section className={checkSection}>
          <div className={checkHeader}>
            <p className={sectionTitle}>🎭 人物 OOC 检测</p>
            <button className={primaryBtn} disabled={oocState.status === 'loading'} onClick={runOoc}>
              {oocState.status === 'loading' ? '检测中...' : '开始检测'}
            </button>
          </div>
          {oocState.status === 'loading' && <div className={loadingText}>正在比对角色人设...</div>}
          {oocState.status === 'error' && <div className={errorMsg}>{oocState.error}</div>}
          {oocState.status === 'success' && oocState.data && (
            <OocResult report={oocState.data} />
          )}
        </section>

        {/* 事实核查：POV 知情边界 / 人名 / 设定时间线 */}
        <section className={checkSection}>
          <div className={checkHeader}>
            <p className={sectionTitle}>🔎 事实核查（POV / 人名 / 设定）</p>
            <div className={thresholdRow}>
              <button
                className={primaryBtn}
                disabled={factState.status === 'loading'}
                onClick={() => runFactCheck(false)}
              >
                {factState.status === 'loading' && factMode === 'quick' ? '检查中...' : '快速检查'}
              </button>
              <button
                className={primaryBtn}
                disabled={factState.status === 'loading' || !agentId}
                title={agentId ? '调用当前 agent 做语义核查，耗时较长' : '请先在对话面板选择 agent'}
                onClick={() => runFactCheck(true)}
              >
                {factState.status === 'loading' && factMode === 'deep' ? '核查中...' : 'AI 语义核查'}
              </button>
            </div>
          </div>
          <div className={metaMuted}>
            只报告、不阻断。快速检查覆盖 POV 知情越界与名册人名笔误；AI 语义核查额外检查设定/时间线矛盾。
          </div>
          {factState.status === 'loading' && <div className={loadingText}>正在比对知情边界与角色名册...</div>}
          {factState.status === 'error' && <div className={errorMsg}>{factState.error}</div>}
          {factState.status === 'success' && factState.data && (
            <FactCheckResult report={factState.data} />
          )}
        </section>
      </div>
    </div>
  );
}

/** 反 AI 味报告渲染：评分进度条 + 逐条问题。 */
function AiPatternsResult({ report }: { report: AiPatternReport }) {
  const color = scoreColor(report.score);
  return (
    <div>
      <div className={scoreRow}>
        <div className={scoreBar}>
          <div className={scoreBarFill} style={{ width: `${report.score}%`, background: color }} />
        </div>
        <span className={scoreLabel} style={{ color: color }}>
          {report.score} · {scoreText(report.score)}
        </span>
      </div>
      {report.issues.length === 0 ? (
        <div className={emptyHint}>未检测到明显 AI 味问题</div>
      ) : (
        <ul className={issueList}>
          {report.issues.map((issue, i) => (
            <li key={i} className={issueItem}>
              <span className={issueType}>{issue.type}</span>
              <div className={snippet}>「{issue.snippet}」</div>
              <div className={suggestion}>建议：{issue.suggestion}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 伏笔遗忘报告渲染：疑似遗忘（高亮）/ 已回收 / 正常跟踪 三组。 */
function ForeshadowResult({ report }: { report: ForeshadowReport }) {
  return (
    <div>
      <p className={groupTitle}>⚠️ 疑似遗忘（{report.forgotten.length}）</p>
      {report.forgotten.length === 0 ? (
        <div className={emptyHint}>无</div>
      ) : (
        <ul className={issueList}>
          {report.forgotten.map((f) => (
            <li key={f.id} className={warnItem}>
              <div className={snippet}>{f.content}</div>
              <div className={metaWarn}>
                最近见于第 {f.lastSeenChapter} 章 · 已 {f.chaptersSinceLastSeen} 章未提及
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className={groupTitle}>✅ 已回收（{report.resolved.length}）</p>
      {report.resolved.length === 0 ? (
        <div className={emptyHint}>无</div>
      ) : (
        <ul className={issueList}>
          {report.resolved.map((f) => (
            <li key={f.id} className={issueItem}>
              <div className={snippet}>{f.content}</div>
              <div className={metaMuted}>
                回收于{f.resolvedIn == null ? '未知章节' : `第 ${f.resolvedIn} 章`}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className={groupTitle}>💚 正常跟踪（{report.healthy.length}）</p>
      {report.healthy.length === 0 ? (
        <div className={emptyHint}>无</div>
      ) : (
        <ul className={issueList}>
          {report.healthy.map((f) => (
            <li key={f.id} className={issueItem}>
              <div className={snippet}>{f.content}</div>
              <div className={metaMuted}>最近见于第 {f.lastSeenChapter} 章</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 人物 OOC 报告渲染：逐条偏离问题。 */
function OocResult({ report }: { report: OocReport }) {
  if (report.oocIssues.length === 0) {
    return <div className={emptyHint}>未检测到人物 OOC 问题</div>;
  }
  return (
    <ul className={issueList}>
      {report.oocIssues.map((issue, i) => (
        <li key={i} className={issueItem}>
          <span className={issueType}>{issue.character}（第 {issue.chapter} 章）</span>
          <div className={snippet}>{issue.issue}</div>
          <div className={suggestion}>人设预期：{issue.profileExpectation}</div>
          <div className={suggestion}>实际表现：{issue.actualBehavior}</div>
        </li>
      ))}
    </ul>
  );
}

/** 事实核查类型 → 中文标签。 */
const FACT_TYPE_LABELS: Record<FactIssueType, string> = {
  'pov-leakage': 'POV 越界知情',
  'name-inconsistency': '人名/别名不一致',
  'canon-contradiction': '设定/时间线矛盾',
};

/** 严重度 → 中文标签与颜色。 */
const FACT_SEVERITY_META: Record<FactSeverity, { label: string; color: string }> = {
  blocker: { label: '阻断', color: '#ef4444' },
  major: { label: '重要', color: '#f59e0b' },
  minor: { label: '轻微', color: '#6b7280' },
};

/** 事实核查报告：按严重度高亮，展示类型、角色、引文与建议。 */
function FactCheckResult({ report }: { report: FactCheckReport }) {
  const mechanicalCount = report.mechanical?.length ?? 0;
  const semanticCount = report.semantic?.length ?? 0;
  return (
    <div>
      <div className={metaMuted}>
        第 {report.chapter} 章{report.pov ? ` · POV：${report.pov}` : ''} · 共 {report.findings.length} 条
        （规则 {mechanicalCount} / AI {semanticCount}）
      </div>
      {report.semanticError && (
        <div className={metaWarn}>AI 语义核查未完成：{report.semanticError}</div>
      )}
      {report.findings.length === 0 ? (
        <div className={emptyHint}>未发现事实性问题</div>
      ) : (
        <ul className={issueList}>
          {report.findings.map((finding, i) => {
            const severity = FACT_SEVERITY_META[finding.severity];
            const critical = finding.severity === 'blocker' || finding.severity === 'major';
            return (
              <li key={i} className={critical ? warnItem : issueItem}>
                <span className={issueType}>{FACT_TYPE_LABELS[finding.type]}</span>
                <span className={severityTag} style={{ background: severity.color }}>
                  {severity.label}
                </span>
                <div className={snippet}>「{finding.quote}」</div>
                {finding.character && (
                  <div className={suggestion}>涉及角色：{finding.character}</div>
                )}
                {finding.detail && <div className={suggestion}>{finding.detail}</div>}
                {finding.suggestion && <div className={suggestion}>建议：{finding.suggestion}</div>}
                <div className={metaMuted}>
                  第 {finding.chapter} 章 · {finding.source === 'mechanical' ? '规则检查' : 'AI 语义核查'}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
