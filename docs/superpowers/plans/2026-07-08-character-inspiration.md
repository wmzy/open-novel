# 角色灵感维度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在角色视图（及任意阶段）加「💡 灵感」按钮，用户选维度+填参数，一键把组装好的灵感请求消息注入右侧 ChatPanel，让 agent 在对话流里给 3 个角色种子候选。

**Architecture:** 三层分离——纯函数层（`src/shared/inspiration.ts` 组装消息文本）、事件层（`InspirationPicker` 组件 dispatch + `ChatPanel` 监听）、UI 层（`CharacterView` 工具栏接入）。零后端改动，复用现有 `/api/runs` + `composePrompt` 的 stage 上下文注入。

**Tech Stack:** TypeScript, React 19 + @linaria/core, Vitest。

**Spec:** `docs/superpowers/specs/2026-07-08-character-inspiration-design.md`

---

## File Structure

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/shared/inspiration.ts` | 新建 | `Dimension`/`DimensionParams` 类型 + `buildInspirationMessage(dimension, params)` 纯函数 |
| `tests/unit/shared/inspiration.test.ts` | 新建 | 纯函数测试（6 维度 + 参数校验 + 共用片段） |
| `src/web/components/InspirationPicker.tsx` | 新建 | 维度选择器 + 动态参数输入 + dispatch `INSPIRE_TO_CHAT_EVENT` |
| `src/web/components/views/CharacterView.tsx` | 改 | 工具栏加 `💡 灵感` 按钮 + 挂载 InspirationPicker |
| `src/web/components/ChatPanel.tsx` | 改 | import `INSPIRE_TO_CHAT_EVENT` + 新增 useEffect 监听 → sendMessage |

---

## Task 1: 纯函数 buildInspirationMessage（TDD）

**Files:**
- Create: `tests/unit/shared/inspiration.test.ts`
- Create: `src/shared/inspiration.ts`

- [ ] **Step 1: 写失败的测试——类型与 faction 维度**

创建 `tests/unit/shared/inspiration.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { buildInspirationMessage, type Dimension, type DimensionParams } from '../../../src/shared/inspiration';

describe('buildInspirationMessage', () => {
  // 共用片段断言——所有维度都须包含
  const COMMON_PATTERNS = [
    '跳过采访流程',
    '不要写完整档案',
    '避免和已有角色重名',
    '我挑中后再展开',
  ];

  describe('faction 维度', () => {
    it('注入势力名 + 共用片段', () => {
      const msg = buildInspirationMessage('faction', { faction: '明教' });
      expect(msg).toContain('隶属「明教」');
      for (const p of COMMON_PATTERNS) expect(msg).toContain(p);
    });

    it('缺 faction 参数抛错', () => {
      expect(() => buildInspirationMessage('faction', {})).toThrow('faction');
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm vitest run tests/unit/shared/inspiration.test.ts`
Expected: FAIL，`Cannot find module '../../../src/shared/inspiration'`

- [ ] **Step 3: 实现类型 + faction + random 维度**

创建 `src/shared/inspiration.ts`：

```typescript
/**
 * 角色灵感维度：把用户选择的维度+参数组装成一句自然语言消息，
 * 注入 ChatPanel 让 agent 在对话流里给候选种子。
 * 设计依据见 docs/superpowers/specs/2026-07-08-character-inspiration-design.md
 */

/** 灵感维度标识。 */
export type Dimension =
  | 'faction'    // 门派/势力
  | 'archetype'  // 历史/现实原型
  | 'role'       // 功能定位
  | 'triangle'   // 驱动力三角组合
  | 'tension'    // 关系张力
  | 'random';    // 随机刺激

/** 各维度参数。非必填维度对应字段可缺省。 */
export interface DimensionParams {
  /** 门派/势力名（faction 必填）。 */
  faction?: string;
  /** 原型人物名（archetype 必填）。 */
  archetype?: string;
  /** 功能定位（role 必填）。 */
  role?: '盟友' | '导师' | '镜面' | '障碍' | '叛徒' | '救星';
  /** 关系张力参数（tension 必填 target + type）。 */
  tension?: { target: string; type: '敌对' | '暧昧' | '师徒' | '利用' };
  // triangle / random 无参数
}

/** 共用指令片段：覆盖 INTERVIEW_PROTOCOL 的「先问后做」，强制种子形态。 */
const COMMON = [
  '我在卡角色，需要灵感刺激。',
  '请**跳过采访流程**，直接给我 3 个角色灵感种子——',
  '每个只要：姓名、一句话定位、一个记忆点（为什么读者会记住他）。',
  '结合现有的 concept 和 world-building，避免和已有角色重名。',
  '**不要写完整档案，我挑中后再展开。**',
].join('');

/**
 * 按维度+参数组装灵感请求消息。
 * 必填参数缺失时抛 Error——前端 InspirationPicker 应在参数为空时禁用按钮。
 */
export function buildInspirationMessage(dimension: Dimension, params: DimensionParams = {}): string {
  const prefix = buildDimensionPrefix(dimension, params);
  return `${prefix}${COMMON}`;
}

/** 各维度的定向指令（拼在共用片段前）。 */
function buildDimensionPrefix(dimension: Dimension, params: DimensionParams): string {
  switch (dimension) {
    case 'faction': {
      if (!params.faction) throw new Error('faction 维度需要 faction 参数');
      return `这 3 个角色都隶属「${params.faction}」——`;
    }
    case 'archetype': {
      if (!params.archetype) throw new Error('archetype 维度需要 archetype 参数');
      return `这 3 个角色都以「${params.archetype}」为蓝本，抽取其核心特质转译到本世界，不要照搬历史事迹——`;
    }
    case 'role': {
      if (!params.role) throw new Error('role 维度需要 role 参数');
      return `这 3 个角色都承担「${params.role}」的叙事功能，说明此刻故事为什么需要这个功能——`;
    }
    case 'triangle': {
      return `这 3 个角色的驱动力三角（Want/Need/Wound）各不相同，每个标注三角组合——`;
    }
    case 'tension': {
      if (!params.tension?.target || !params.tension?.type) {
        throw new Error('tension 维度需要 target 和 type 参数');
      }
      return `这 3 个角色都与「${params.tension.target}」产生「${params.tension.type}」关系，说明冲突点——`;
    }
    case 'random': {
      return `这 3 个角色风格差异最大、来自不同维度——`;
    }
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm vitest run tests/unit/shared/inspiration.test.ts`
Expected: PASS（faction 维度 2 条）

- [ ] **Step 5: 追加其余 5 个维度的测试**

在 `tests/unit/shared/inspiration.test.ts` 的 describe 块内追加：

```typescript
  describe('archetype 维度', () => {
    it('注入原型名 + 不照搬历史 + 共用片段', () => {
      const msg = buildInspirationMessage('archetype', { archetype: '诸葛亮' });
      expect(msg).toContain('以「诸葛亮」为蓝本');
      expect(msg).toContain('不要照搬历史事迹');
      for (const p of COMMON_PATTERNS) expect(msg).toContain(p);
    });

    it('缺 archetype 参数抛错', () => {
      expect(() => buildInspirationMessage('archetype', {})).toThrow('archetype');
    });
  });

  describe('role 维度', () => {
    it('注入功能定位 + 共用片段', () => {
      const msg = buildInspirationMessage('role', { role: '导师' });
      expect(msg).toContain('承担「导师」的叙事功能');
      for (const p of COMMON_PATTERNS) expect(msg).toContain(p);
    });

    it('缺 role 参数抛错', () => {
      expect(() => buildInspirationMessage('role', {})).toThrow('role');
    });
  });

  describe('triangle 维度', () => {
    it('标注三角组合 + 共用片段，无需参数', () => {
      const msg = buildInspirationMessage('triangle');
      expect(msg).toContain('驱动力三角（Want/Need/Wound）各不相同');
      for (const p of COMMON_PATTERNS) expect(msg).toContain(p);
    });
  });

  describe('tension 维度', () => {
    it('注入目标角色 + 关系类型 + 共用片段', () => {
      const msg = buildInspirationMessage('tension', {
        tension: { target: '林冲', type: '敌对' },
      });
      expect(msg).toContain('与「林冲」产生「敌对」关系');
      for (const p of COMMON_PATTERNS) expect(msg).toContain(p);
    });

    it('缺 target 抛错', () => {
      expect(() => buildInspirationMessage('tension', { tension: { target: '', type: '敌对' } })).toThrow('tension');
    });

    it('缺 type 抛错', () => {
      expect(() => buildInspirationMessage('tension', { tension: { target: '林冲', type: '' as never } })).toThrow('tension');
    });
  });

  describe('random 维度', () => {
    it('风格差异最大 + 共用片段，无需参数', () => {
      const msg = buildInspirationMessage('random');
      expect(msg).toContain('风格差异最大');
      for (const p of COMMON_PATTERNS) expect(msg).toContain(p);
    });
  });
```

- [ ] **Step 6: 运行全部测试验证通过**

Run: `pnpm vitest run tests/unit/shared/inspiration.test.ts`
Expected: PASS（6 维度共 9 条全过）

- [ ] **Step 7: Commit**

```bash
git add src/shared/inspiration.ts tests/unit/shared/inspiration.test.ts
git commit -m "feat: add buildInspirationMessage for character inspiration dimensions"
```

---

## Task 2: InspirationPicker 组件

**Files:**
- Create: `src/web/components/InspirationPicker.tsx`

- [ ] **Step 1: 创建 InspirationPicker 组件**

创建 `src/web/components/InspirationPicker.tsx`：

```tsx
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
    case 'archetype': return !!params.archetype?.trim();
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
          <input className={input} value={archetype} onChange={(e) => setArchetype(e.target.value)} placeholder="如：诸葛亮、白起、苏轼" />
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
```

- [ ] **Step 2: 验证 typecheck**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/web/components/InspirationPicker.tsx
git commit -m "feat: add InspirationPicker component for dimension-based character inspiration"
```

---

## Task 3: CharacterView 接入灵感按钮

**Files:**
- Modify: `src/web/components/views/CharacterView.tsx`

- [ ] **Step 1: 加 import 和灵感按钮**

在 `CharacterView.tsx` 顶部 import 区加：

```tsx
import InspirationPicker from '../InspirationPicker';
```

- [ ] **Step 2: 加 showInspiration state**

在组件内现有 `const [showNaming, setShowNaming] = useState(false);` 下方加：

```tsx
const [showInspiration, setShowInspiration] = useState(false);
```

- [ ] **Step 3: 加按钮样式**

在现有 `namingToggleBtn` 样式定义下方加（同级 css 模板字符串）：

```tsx
const inspireToggleBtn = css`
  background: none;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.15rem 0.5rem;
  cursor: pointer;
  &:hover { background: var(--haze-color-bg-hover, rgba(255,255,255,0.05)); }
`;
```

- [ ] **Step 4: 在工具栏渲染区加按钮和 picker**

在 JSX 的 `{showNaming && <NamingPanel projectId={projectId} />}` 之前插入：

```tsx
<button
  className={inspireToggleBtn}
  onClick={() => setShowInspiration((v) => !v)}
>
  {showInspiration ? '▾ 收起灵感' : '💡 灵感'}
</button>
```

在 `{showNaming && <NamingPanel projectId={projectId} />}` 之后插入：

```tsx
{showInspiration && <InspirationPicker />}
```

- [ ] **Step 5: 验证 typecheck**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/web/components/views/CharacterView.tsx
git commit -m "feat: add inspiration button to CharacterView toolbar"
```

---

## Task 4: ChatPanel 监听灵感事件

**Files:**
- Modify: `src/web/components/ChatPanel.tsx`

- [ ] **Step 1: 加 import**

在 ChatPanel.tsx 顶部 import 区，现有 `import { REVISE_TO_CHAT_EVENT } from '@/web/hooks/useFileRevision';` 下方加：

```tsx
import { INSPIRE_TO_CHAT_EVENT } from '../InspirationPicker';
```

- [ ] **Step 2: 加 useEffect 监听**

在现有 `REVISE_TO_CHAT_EVENT` 的 useEffect 监听块（约 95-105 行）之后，加一个新的 useEffect：

```tsx
  // 灵感注入：来自视图 💡 按钮 dispatch 的事件，直接 sendMessage（消息已组装好）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message: string };
      sendMessage({
        projectId,
        agentId,
        skillId,
        stage,
        message: detail.message,
      });
    };
    window.addEventListener(INSPIRE_TO_CHAT_EVENT, handler);
    return () => window.removeEventListener(INSPIRE_TO_CHAT_EVENT, handler);
  }, [sendMessage, projectId, agentId, skillId, stage]);
```

- [ ] **Step 3: 验证 typecheck**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/web/components/ChatPanel.tsx
git commit -m "feat: ChatPanel listens for inspiration events and sends to chat"
```

---

## Task 5: 全量验证

**Files:**
- 无新文件

- [ ] **Step 1: 全部单元测试通过**

Run: `pnpm vitest run`
Expected: 全部 PASS，无回归

- [ ] **Step 2: typecheck 全量通过**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: build 通过**

Run: `pnpm build`
Expected: 成功产出 dual bundles

- [ ] **Step 4: 手动冒烟（可选，需运行时环境）**

1. 启动 dev server
2. 打开角色视图
3. 点 `💡 灵感` → 展开 picker
4. 选「门派/势力」→ 填「明教」→ 点「生成灵感」
5. 确认右侧 ChatPanel 出现组装好的消息并开始 agent 响应
