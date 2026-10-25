/**
 * P1-a：LLM 语义 canon 变更自动提取（改进计划-内置Pi-SDK 遗留项）。
 *
 * 章节写完后用内置 Pi（callPiOnce）从正文提取 CanonChanges JSON 并写回台账，
 * 实现「无需手工改 state」。设计约束：
 * - 绝不抛出：任何异常（模型失败/输出不合法/写盘失败）都折叠为 { ok:false }，
 *   调用方（finalizePiRun / 手动补录端点）据此只 emit 事件，不阻断主流程；
 * - 解析健壮：剥 ```json 围栏、从杂文中用括号计数取第一个平衡的 {...}、
 *   JSON.parse 后做形状清洗（非数组字段丢弃），解析失败即 ok:false；
 * - 可测试：call 可注入（替身替换 callPiOnce），buildExtractionPrompt 为纯函数。
 */
import { callPiOnce } from './pi/runtime';
import { appendCanonChanges, readCanon, type CanonChanges } from '../shared/canon';
import { config } from '../config';

/** 正文超长时保留的头/尾字符数（头尾信息密度最高：开篇设定 + 收尾转折）。 */
const CONTENT_HEAD_CHARS = 8000;
const CONTENT_TAIL_CHARS = 4000;
/** 注入 prompt 的现有实体名上限，防止大台账撑爆上下文。 */
const MAX_ENTITY_NAMES = 60;

export interface ExtractCanonInput {
  projectDir: string;
  chapter: number;
  content: string;
  model?: string | null;
  timeoutMs?: number;
  /** 默认 callPiOnce；测试注入替身。签名固定三参（prompt, cwd, timeoutMs）。 */
  call?: (prompt: string, cwd: string, timeoutMs: number) => Promise<string>;
}

export interface ExtractCanonResult {
  ok: boolean;
  applied: boolean;
  entities: number;
  facts: number;
  knowledge: number;
  warnings: string[];
  error?: string;
}

/** 超长正文截断：头 8000 + 尾 4000，中间用省略标记（纯函数，便于单测）。 */
function truncateContent(content: string): string {
  if (content.length <= CONTENT_HEAD_CHARS + CONTENT_TAIL_CHARS) return content;
  return (
    content.slice(0, CONTENT_HEAD_CHARS)
    + '\n\n……（中间内容省略）……\n\n'
    + content.slice(-CONTENT_TAIL_CHARS)
  );
}

/**
 * 构建提取 prompt（纯函数）。
 * @param chapter 章号
 * @param content 章节正文（函数内部做超长截断）
 * @param entityNames 现有 canon 实体名列表（供对齐 subject 命名；空表示台账为空可自建）
 */
export function buildExtractionPrompt(chapter: number, content: string, entityNames: string[]): string {
  const names = entityNames.filter(Boolean).slice(0, MAX_ENTITY_NAMES);
  const more = entityNames.length > names.length ? ` 等 ${entityNames.length} 个` : '';
  const nameSection = names.length > 0
    ? `现有 canon 实体名（facts 的 subject 尽量对齐这些名字；新实体须先在 entities 登记）：\n${names.join('、')}${more}`
    : '当前 canon 台账为空，可自建新实体。';

  return [
    `你是小说一致性台账的维护者。请从第 ${chapter} 章正文中提取 canon 变更（本章明确建立或改变的设定事实）。`,
    '',
    nameSection,
    '',
    '输出要求：',
    '- 只输出一个 JSON 对象，允许用 ```json 围栏包裹，不要输出任何解释文字；',
    '- 只提取本章明确建立/改变的事实，不确定的不写；三段都没有变更时输出空对象 {}；',
    '- knowledge 只写 POV 角色与本章主要角色的知情边界；',
    '- entities 的 type 取 character/location/faction/item/concept/other 之一，status 取 active/dead/lost/archived 之一；',
    '- facts 的 confidence 取 confirmed（正文明确）/ proposed（推测）。',
    '',
    'JSON 结构（字段均可省略，未知字段会被忽略）：',
    '{',
    '  "entities": [{ "name": "实体名(必填)", "type": "character", "aliases": ["别名"], "description": "一句话描述", "status": "active" }],',
    '  "facts": [{ "subject": "主体(必填)", "predicate": "关系/属性(必填)", "object": "值(必填)", "confidence": "confirmed" }],',
    '  "knowledge": { "角色名": { "knows": ["已知道的事"], "doesNotKnow": ["尚不知道的事"] } }',
    '}',
    '',
    '紧凑示例：',
    '```json',
    '{"entities":[{"name":"沈青梧","type":"character","description":"北境药师，左臂有旧伤"}],"facts":[{"subject":"沈青梧","predicate":"效力于","object":"北境军"}],"knowledge":{"沈青梧":{"knows":["主帅已阵亡"],"doesNotKnow":["幕后主使身份"]}}}',
    '```',
    '',
    `第 ${chapter} 章正文如下：`,
    truncateContent(content),
  ].join('\n');
}

/**
 * 从模型输出中提取平衡的 {...} 子串（括号计数，跳过字符串字面量内的括号）。
 * 天然兼容 ```json 围栏与前后杂文：围栏标记与说明文字不含顶层花括号，
 * 从第一个 { 起计数到深度归零即首个完整 JSON 对象。找不到平衡对象返回 null。
 */
export function extractBalancedJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 解析模型输出为形状清洗后的 CanonChanges。
 * 解析失败/非对象返回 null；三段全空（或字段形状非法被丢弃）返回空变更对象。
 */
export function parseExtractedChanges(raw: string): CanonChanges | null {
  const candidate = extractBalancedJson(raw);
  if (candidate === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const changes: CanonChanges = {};
  if (Array.isArray(obj.entities)) changes.entities = obj.entities as CanonChanges['entities'];
  if (Array.isArray(obj.facts)) changes.facts = obj.facts as CanonChanges['facts'];
  if (obj.knowledge && typeof obj.knowledge === 'object' && !Array.isArray(obj.knowledge)) {
    changes.knowledge = obj.knowledge as CanonChanges['knowledge'];
  }
  return changes;
}

/**
 * 提取一章正文的 canon 变更并写回台账。绝不抛出：
 * - 模型调用失败/输出不合法 → { ok:false, applied:false, error }；
 * - 三段全空 → { ok:true, applied:false }（不写盘）；
 * - 成功 → appendCanonChanges（supersede 旧事实 + 追加 changes.jsonl），
 *   返回三段提交计数 + warnings 透传。
 * 计数口径：解析后提交给 appendCanonChanges 的条目数（被台账丢弃的条目
 * 由 warnings 说明，如「实体第 N 条缺少 name」）。
 */
export async function extractCanonChanges(input: ExtractCanonInput): Promise<ExtractCanonResult> {
  const empty = (error?: string): ExtractCanonResult => ({
    ok: false,
    applied: false,
    entities: 0,
    facts: 0,
    knowledge: 0,
    warnings: [],
    ...(error !== undefined ? { error } : {}),
  });
  try {
    // 现有实体名列表：供 prompt 对齐 subject 命名；台账为空时说明可自建
    const ledger = await readCanon(input.projectDir);
    const entityNames = ledger.entities.map((e) => e.name);

    const prompt = buildExtractionPrompt(input.chapter, input.content, entityNames);
    const timeoutMs = input.timeoutMs ?? Math.min(config.agent.timeoutMs, 5 * 60_000);
    const invoke = input.call
      ?? ((p: string, cwd: string, t: number) => callPiOnce(p, cwd, t, { model: input.model ?? null }));
    const raw = await invoke(prompt, input.projectDir, timeoutMs);

    const changes = parseExtractedChanges(raw);
    if (changes === null) {
      return empty('模型输出不是合法的 JSON 对象');
    }
    const entities = changes.entities?.length ?? 0;
    const facts = changes.facts?.length ?? 0;
    const knowledge = Object.keys(changes.knowledge ?? {}).length;
    if (entities === 0 && facts === 0 && knowledge === 0) {
      return { ok: true, applied: false, entities: 0, facts: 0, knowledge: 0, warnings: [] };
    }
    const { warnings } = await appendCanonChanges(input.projectDir, changes, input.chapter);
    return { ok: true, applied: true, entities, facts, knowledge, warnings };
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err));
  }
}
