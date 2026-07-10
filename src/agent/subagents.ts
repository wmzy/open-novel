/**
 * SubAgent 角色定义与部署。
 *
 * open-novel 通过外部 CLI（CC / OMP / OpenCode）驱动写作。不同 CLI 的 agent 委托能力不同：
 * - Claude Code：`--plugin-dir <path>` 加载 `.claude-plugin/plugin.json` + `agents/*.md`，session 级，不污染项目目录。
 * - OMP：扫描 `~/.omp/agent/agents/*.md`（用户级），无需启动参数。
 * - OpenCode：不支持外部 agent 定义，回退为 composePrompt 内联指令。
 *
 * 部署在服务启动时执行一次（deploySubagents），prompt 指导在 composePrompt 中按 agentId 注入。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── 路径 ────────────────────────────────────────────────────────────

/** open-novel 管理的配置根目录。 */
const OPEN_NOVEL_HOME = path.join(os.homedir(), '.open-novel');

/** CC plugin 目录：含 .claude-plugin/plugin.json + agents/*.md。启动时经 --plugin-dir 注入。 */
export const CC_PLUGIN_DIR = path.join(OPEN_NOVEL_HOME, 'agents');

/** OMP 用户级 agent 发现路径。 */
const OMP_AGENTS_DIR = path.join(os.homedir(), '.omp', 'agent', 'agents');

// ─── SubAgent 定义 ──────────────────────────────────────────────────

export interface SubAgentDef {
  name: string;
  description: string;
  systemPrompt: string;
  /** 限制工具白名单（CC frontmatter 的 tools 字段）。 */
  tools?: string;
  /** 模型偏好（'haiku' 等便宜模型 | 'inherit' 跟随主 agent）。 */
  model?: string;
}

/**
 * 写作流程中的 SubAgent 角色。
 *
 * 设计依据：denova 的 reviewer + memory-patcher 角色，适配小说创作场景。
 * chapter-reviewer 对标 denova reviewer（只读审查，独立 context window）；
 * state-patcher 对标 denova memory-patcher（定稿后更新状态追踪）。
 */
export const WRITING_SUBAGENTS: SubAgentDef[] = [
  {
    name: 'chapter-reviewer',
    description:
      '审查小说章节正文的质量。当章节写完或修订后，用于检查剧情连续性、角色一致性（OOC）、节奏、文笔和 AI 痕迹。只审稿不改文。',
    tools: 'Read, Grep, Glob',
    model: 'haiku',
    systemPrompt: `你是一位严格的小说审稿人。你只审查，绝不修改正文或写入文件。

## 审查维度
1. **剧情连续性**：与前文章节（.novel/chapters/）的情节衔接是否自然，有无逻辑断裂。
2. **角色一致性**：角色的性格、说话方式、能力是否与设定（.novel/characters/）一致，有无 OOC。
3. **节奏**：场景转换是否突兀，信息密度是否均匀，有无拖沓或跳跃。
4. **文笔质量**：用词是否精准，句式是否多样，有无陈词滥调。
5. **AI 痕迹**：检测过度对称结构、空泛抒情、重复句式、套话堆砌等 AI 写作特征。

## 输出格式
对每个问题输出：
- **severity**: blocker / major / minor
- **dimension**: 上述 5 个维度之一
- **evidence**: 引用原文中的具体段落或句子
- **impact**: 这个问题对读者体验的影响
- **fix_instruction**: 具体修改建议（一句话，可操作）

如果章节质量合格、无 blocker 级问题，明确说"审查通过"。`,
  },
  {
    name: 'state-patcher',
    description:
      '章节定稿后更新所有状态追踪文件：章节摘要、角色状态、写作进度、结构化状态、伏笔追踪。当章节正文写完并保存后使用。',
    tools: 'Read, Write, Edit',
    model: 'inherit',
    systemPrompt: `你是状态更新助手。章节定稿后，基于正文内容更新项目的所有状态追踪文件。

## 职责（按顺序完成）

1. **生成章节摘要**：在 .novel/chapters/第N章.summary.md 生成本章约 200 字的语义摘要。
   摘要必须包含：情节推进、角色状态变化、伏笔兑现或新增。严禁复制正文原文段落。

2. **更新角色状态**：更新 .novel/character-states.md
   每个在场角色的：当前位置、情绪状态、当前目标、关系变化。
   只记录本章定稿后的当前状态，不写未来规划。

3. **更新写作进度**：更新 .novel/progress.md
   当前进度（已写到第N章）、最近章节的一句话摘要、下一步写作衔接提示。

4. **更新结构化状态**：更新 .novel/state.json
   只保留结构化字段：lastUpdatedChapter、timeline、activeForeshadows（所有 status 为 planted 的伏笔 ID 列表）、updatedAt 时间戳。角色详细状态不要再写入 state.json 的 characters 字段。

5. **更新伏笔追踪**：更新 .novel/foreshadow.json
   本章是否埋设了新伏笔（plantedIn），是否回收了已有伏笔（resolvedIn）。
   - 若本章**新埋设**了一条伏笔（首次在正文中植入线索）且大纲阶段未预登：**新增一条**，id 取现有最大 id + 1，content 写具体描述，status 设为 "planted"，plantedIn 填当前章号，resolvedIn 为 null。
   - 若大纲阶段已预登该伏笔为 pending：将其 status 从 "pending" 改为 "planted"。
   - 若本章**回收**了某条伏笔（线索得到兑现/揭晓）：将 status 改为 "resolved" 并填写 resolvedIn 为当前章号。
   - 标准 schema：{ "foreshadows": [{ "id": 1, "content": "具体描述", "status": "planted", "plantedIn": 3, "resolvedIn": null }] }。顶层键为 foreshadows（不是 items），内容字段为 content（不是 description），status 取值 pending/planted/resolved。

## 原则
- 只基于章节正文的确认内容更新，不推测或虚构。
- 状态变更要具体（"从A地移动到B地"而非"位置变了"）。
- 摘要聚焦情节推进和状态变化，不摘抄环境描写。`,
  },
];

// ─── 部署 ──────────────────────────────────────────────────────────

/** CC plugin manifest（最小可用）。 */
const CC_PLUGIN_MANIFEST = {
  name: 'open-novel',
  description: 'Open-novel writing subagents',
  version: '1.0.0',
};

/** 格式化单个 agent 为 CC/OMP 通用的 .md 文件内容。 */
function formatAgentMd(def: SubAgentDef): string {
  const lines = ['---', `name: ${def.name}`, `description: ${def.description}`];
  if (def.tools) lines.push(`tools: ${def.tools}`);
  if (def.model && def.model !== 'inherit') lines.push(`model: ${def.model}`);
  lines.push('---', '', def.systemPrompt);
  return lines.join('\n');
}

/**
 * 将 SubAgent 定义部署到 CC plugin 目录和 OMP agents 目录。
 *
 * 幂等：重复调用安全（覆盖写）。在服务启动时调用一次。
 * - CC：写入 CC_PLUGIN_DIR/.claude-plugin/plugin.json + agents/*.md
 * - OMP：写入 ~/.omp/agent/agents/*.md
 */
export function deploySubagents(): void {
  // CC plugin 目录
  const ccAgentsDir = path.join(CC_PLUGIN_DIR, 'agents');
  const ccManifestDir = path.join(CC_PLUGIN_DIR, '.claude-plugin');
  try {
    mkdirSync(ccAgentsDir, { recursive: true });
    mkdirSync(ccManifestDir, { recursive: true });
    writeFileSync(
      path.join(ccManifestDir, 'plugin.json'),
      JSON.stringify(CC_PLUGIN_MANIFEST, null, 2),
    );
    for (const def of WRITING_SUBAGENTS) {
      writeFileSync(path.join(ccAgentsDir, `${def.name}.md`), formatAgentMd(def));
    }
  } catch {
    // 非致命：部署失败只意味着 CC 无法使用 subagent，主流程不受影响。
  }

  // OMP agents 目录（用户级）
  try {
    mkdirSync(OMP_AGENTS_DIR, { recursive: true });
    for (const def of WRITING_SUBAGENTS) {
      writeFileSync(path.join(OMP_AGENTS_DIR, `${def.name}.md`), formatAgentMd(def));
    }
  } catch {
    // 同上
  }
}

/** CC plugin 目录是否已部署（供 registry.ts buildArgs 判断是否加 --plugin-dir）。 */
export function isCcPluginReady(): boolean {
  return existsSync(path.join(CC_PLUGIN_DIR, '.claude-plugin', 'plugin.json'));
}

// ─── Prompt 指导 ────────────────────────────────────────────────────

/**
 * 按 agent CLI 返回 subagent 使用指导文本，供 composePrompt 注入。
 *
 * - CC / OMP：subagent 已部署，指导主 agent 何时委托。
 * - OpenCode：不支持 subagent，回退为内联指令（自行完成审查和状态更新）。
 * - undefined（未指定）：不注入。
 */
export function getSubagentGuidance(agentId?: string): string {
  if (!agentId) return '';

  if (agentId === 'opencode') {
    // OpenCode 不支持外部 agent 定义，内联指导。
    return `## 质量自审与状态更新（当前 Agent 不支持 SubAgent 委托）

**章节写完后，你需要自行完成以下工作（不要委托）：**

1. **自审**：通读本章，检查剧情连续性、角色一致性、节奏、AI 痕迹。如果发现 blocker 级问题，直接修订。
2. **状态更新**（正文写完并保存后，依次完成）：
   - .novel/chapters/第N章.summary.md（本章语义摘要，约200字）
   - .novel/character-states.md（角色当前位置/情绪/目标/关系变化）
   - .novel/progress.md（写作进度、最近章节摘要、下一步提示）
   - .novel/state.json（lastUpdatedChapter、timeline、activeForeshadows、updatedAt）
   - .novel/foreshadow.json（本章是否埋设或回收伏笔）
3. **正文与状态更新分离**：先把整章正文写完保存，再逐个更新状态文件，不要写到一半停下来更新。`;
  }

  // CC 用 Agent 工具，OMP 用 task 工具
  const toolName = agentId === 'omp' ? 'task' : 'Agent';

  return `## SubAgent 使用指导

你可以通过 **${toolName} 工具** 委托以下专业 SubAgent 完成辅助工作：

### chapter-reviewer（审稿）
- **何时委托**：章节正文写完或修订完成后，委托它审查质量。
- **委托方式**：告知章节文件路径（如 .novel/chapters/第3章.md），让它自行读取。不要把正文粘贴给它。
- **收到反馈后**：根据 severity=blocker 和 major 的意见修订正文；minor 问题酌情处理。

### state-patcher（状态更新）
- **何时委托**：章节正文写完并保存后，委托它更新所有状态追踪文件。
- **委托方式**：告知章节文件路径和章号即可。它能自行读取正文和现有状态文件。
- **它会完成**：
  - .novel/chapters/第N章.summary.md（本章语义摘要，约200字）
  - .novel/character-states.md（角色当前位置/情绪/目标/关系变化）
  - .novel/progress.md（写作进度、最近章节摘要、下一步提示）
  - .novel/state.json（lastUpdatedChapter、timeline、activeForeshadows、updatedAt）
  - .novel/foreshadow.json（伏笔状态更新）

### 使用原则
- **先写完再委托**：不要写到一半就委托审查——先完成整章初稿。
- **不要替代自检**：SubAgent 审查是补充，你自己在写作过程中仍需把控质量。
- **一次一托**：同一时刻只委托一个 SubAgent 任务，等它返回后再继续。`;
}
