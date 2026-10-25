/**
 * Canon 台账 + 章节合同（长篇一致性基础层）。
 *
 * 文件位置（全部在项目 `.novel/` 下）：
 * - `.novel/canon/canon.json`：实体、事实、角色知情边界的结构化快照；
 * - `.novel/canon/changes.jsonl`：append-only 变更日志（每次写入追加一行）；
 * - `.novel/contracts/第N章.json`：章节合同（POV / 出场 / beat / 揭示 / 字数）。
 *
 * 设计原则：
 * - 文件是事实源，git 快照天然覆盖；
 * - 读取宽容：损坏/缺失返回空台账，不阻断写作；
 * - 写入原子：临时文件 + rename；
 * - 校验纯函数，便于测试与前端复用。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const CANON_DIR = 'canon';
export const CANON_FILE = 'canon.json';
export const CANON_CHANGES_FILE = 'changes.jsonl';
export const CONTRACTS_DIR = 'contracts';

export type CanonEntityType = 'character' | 'location' | 'faction' | 'item' | 'concept' | 'other';
export type CanonEntityStatus = 'active' | 'dead' | 'lost' | 'archived';
export type CanonFactStatus = 'active' | 'superseded' | 'retracted';

export interface CanonEntity {
  id: string;
  name: string;
  type: CanonEntityType;
  aliases: string[];
  description?: string;
  sourceChapter?: number;
  status: CanonEntityStatus;
}

export interface CanonFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  validFrom: number;
  validTo?: number | null;
  sourceChapter?: number;
  status: CanonFactStatus;
  confidence: 'confirmed' | 'proposed';
}

export interface CanonKnowledgeEntry {
  knows: string[];
  doesNotKnow: string[];
  updatedChapter?: number;
}

export interface CanonLedger {
  version: 1;
  entities: CanonEntity[];
  facts: CanonFact[];
  knowledge: Record<string, CanonKnowledgeEntry>;
  updatedAt: string;
}

export interface CanonChanges {
  entities?: Array<Partial<CanonEntity> & { name: string }>;
  facts?: Array<Partial<CanonFact> & { subject: string; predicate: string; object: string }>;
  knowledge?: Record<string, Partial<CanonKnowledgeEntry>>;
}

export interface ChapterContract {
  version: 1;
  chapter: number;
  pov: string;
  cast: string[];
  beats: string[];
  mustReveal: string[];
  mustNotReveal: string[];
  wordBudget?: {
    min?: number;
    max?: number;
    target?: number;
  };
  status: 'draft' | 'frozen';
  updatedAt: string;
}

export type ContractSeverity = 'blocker' | 'major' | 'minor';

export interface ContractFinding {
  severity: ContractSeverity;
  code:
    | 'pov-missing'
    | 'cast-missing'
    | 'must-reveal-missing'
    | 'must-not-reveal-present'
    | 'word-budget'
    | 'unknown-cast'
    | 'contract-draft';
  message: string;
  quote?: string;
}

/** 每次返回全新数组/对象，避免调用方 push 污染模块级空值。 */
function emptyLedger(updatedAt = ''): CanonLedger {
  return { version: 1, entities: [], facts: [], knowledge: {}, updatedAt };
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean))];
}

function asChapter(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function slug(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'entity';
}

function normalizeEntity(raw: unknown, index: number): CanonEntity | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const name = asString(obj.name);
  if (!name) return null;
  const type = asString(obj.type) as CanonEntityType;
  const allowed: CanonEntityType[] = ['character', 'location', 'faction', 'item', 'concept', 'other'];
  return {
    id: asString(obj.id) || `${slug(name)}-${index + 1}`,
    name,
    type: allowed.includes(type) ? type : 'other',
    aliases: asStringArray(obj.aliases),
    description: typeof obj.description === 'string' ? obj.description.trim() : undefined,
    sourceChapter: typeof obj.sourceChapter === 'number' ? asChapter(obj.sourceChapter) : undefined,
    status: (['active', 'dead', 'lost', 'archived'].includes(asString(obj.status))
      ? asString(obj.status)
      : 'active') as CanonEntityStatus,
  };
}

function normalizeFact(raw: unknown, index: number, chapterFallback: number): CanonFact | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const subject = asString(obj.subject);
  const predicate = asString(obj.predicate);
  const object = asString(obj.object);
  if (!subject || !predicate || !object) return null;
  const validFrom = typeof obj.validFrom === 'number' ? asChapter(obj.validFrom, chapterFallback) : chapterFallback;
  return {
    id: asString(obj.id) || `fact-${index + 1}-${slug(subject)}-${slug(predicate)}`,
    subject,
    predicate,
    object,
    validFrom,
    validTo: typeof obj.validTo === 'number' ? asChapter(obj.validTo) : null,
    sourceChapter: typeof obj.sourceChapter === 'number' ? asChapter(obj.sourceChapter) : undefined,
    status: (['active', 'superseded', 'retracted'].includes(asString(obj.status))
      ? asString(obj.status)
      : 'active') as CanonFactStatus,
    confidence: asString(obj.confidence) === 'proposed' ? 'proposed' : 'confirmed',
  };
}

/** 宽容归一化任意输入；未知字段丢弃，缺失字段补默认值。 */
export function normalizeCanon(raw: unknown, chapterFallback = 0): CanonLedger {
  if (!raw || typeof raw !== 'object') return emptyLedger(new Date().toISOString());
  const obj = raw as Record<string, unknown>;
  const entities = Array.isArray(obj.entities)
    ? obj.entities.map((e, i) => normalizeEntity(e, i)).filter((e): e is CanonEntity => e !== null)
    : [];
  const facts = Array.isArray(obj.facts)
    ? obj.facts.map((f, i) => normalizeFact(f, i, chapterFallback)).filter((f): f is CanonFact => f !== null)
    : [];
  const knowledge: Record<string, CanonKnowledgeEntry> = {};
  if (obj.knowledge && typeof obj.knowledge === 'object' && !Array.isArray(obj.knowledge)) {
    for (const [name, value] of Object.entries(obj.knowledge as Record<string, unknown>)) {
      if (!name.trim() || !value || typeof value !== 'object') continue;
      const k = value as Record<string, unknown>;
      knowledge[name.trim()] = {
        knows: asStringArray(k.knows),
        doesNotKnow: asStringArray(k.doesNotKnow),
        updatedChapter: typeof k.updatedChapter === 'number' ? asChapter(k.updatedChapter) : undefined,
      };
    }
  }
  return {
    version: 1,
    entities,
    facts,
    knowledge,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
  };
}

function canonPath(projectDir: string): string {
  return path.join(projectDir, '.novel', CANON_DIR);
}

export function canonFilePath(projectDir: string): string {
  return path.join(canonPath(projectDir), CANON_FILE);
}

export function canonChangesFilePath(projectDir: string): string {
  return path.join(canonPath(projectDir), CANON_CHANGES_FILE);
}

export function contractFilePath(projectDir: string, chapter: number): string {
  return path.join(projectDir, '.novel', CONTRACTS_DIR, `第${chapter}章.json`);
}

/** 作者强制定稿时留痕，便于审阅/回滚时追溯。 */
export async function recordContractOverride(
  projectDir: string,
  chapter: number,
  findings: ContractFinding[],
  reason?: string,
): Promise<void> {
  const file = path.join(canonPath(projectDir), 'overrides.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(
    file,
    JSON.stringify({ chapter, at: new Date().toISOString(), reason: reason ?? '', findings }) + '\n',
    'utf-8',
  );
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  await fs.rename(tmp, filePath);
}

/** 读取台账；缺失/损坏返回空台账（写入方会在下次变更时重建）。 */
export async function readCanon(projectDir: string): Promise<CanonLedger> {
  try {
    const raw = await fs.readFile(canonFilePath(projectDir), 'utf-8');
    return normalizeCanon(JSON.parse(raw));
  } catch {
    return emptyLedger();
  }
}

export async function writeCanon(projectDir: string, ledger: CanonLedger): Promise<CanonLedger> {
  const normalized = normalizeCanon({ ...ledger, updatedAt: new Date().toISOString() });
  await writeJsonAtomic(canonFilePath(projectDir), normalized);
  return normalized;
}

/**
 * 追加一组变更：更新快照 + 追加 JSONL 日志。
 *
 * 同一 subject/predicate 的 active 事实会被新事实 supersede；
 * 事实 id 重复时保留新值。返回 warnings（例如 fact 指向未知实体）。
 */
export async function appendCanonChanges(
  projectDir: string,
  changes: CanonChanges,
  chapter: number,
): Promise<{ ledger: CanonLedger; warnings: string[] }> {
  const ledger = await readCanon(projectDir);
  const warnings: string[] = [];
  const entityIds = new Set(ledger.entities.map((e) => e.id));
  const entityNames = new Set(ledger.entities.map((e) => e.name));

  for (const [index, raw] of (changes.entities ?? []).entries()) {
    const entity = normalizeEntity({ ...raw, sourceChapter: raw.sourceChapter ?? chapter }, index);
    if (!entity) {
      warnings.push(`实体第 ${index + 1} 条缺少 name，已忽略`);
      continue;
    }
    const existing = ledger.entities.find((e) => e.id === entity.id || e.name === entity.name);
    if (existing) {
      Object.assign(existing, entity, { id: existing.id, sourceChapter: existing.sourceChapter ?? entity.sourceChapter });
    } else {
      ledger.entities.push(entity);
      entityIds.add(entity.id);
      entityNames.add(entity.name);
    }
  }

  const factIndexBase = ledger.facts.length;
  for (const [index, raw] of (changes.facts ?? []).entries()) {
    const fact = normalizeFact(
      { ...raw, validFrom: raw.validFrom ?? chapter, sourceChapter: raw.sourceChapter ?? chapter },
      factIndexBase + index,
      chapter,
    );
    if (!fact) {
      warnings.push(`事实第 ${index + 1} 条缺少 subject/predicate/object，已忽略`);
      continue;
    }
    if (!entityIds.has(fact.subject) && !entityNames.has(fact.subject) && !ledger.knowledge[fact.subject]) {
      warnings.push(`事实 ${fact.id} 的 subject「${fact.subject}」不在 canon 实体表中`);
    }
    for (const existing of ledger.facts) {
      if (
        existing.status === 'active'
        && existing.id !== fact.id
        && existing.subject === fact.subject
        && existing.predicate === fact.predicate
      ) {
        existing.status = 'superseded';
        existing.validTo = Math.max(0, fact.validFrom - 1);
      }
    }
    const sameId = ledger.facts.findIndex((f) => f.id === fact.id);
    if (sameId >= 0) ledger.facts[sameId] = fact;
    else ledger.facts.push(fact);
  }

  for (const [name, raw] of Object.entries(changes.knowledge ?? {})) {
    const key = name.trim();
    if (!key) continue;
    const current = ledger.knowledge[key] ?? { knows: [], doesNotKnow: [] };
    const knows = asStringArray([...(current.knows ?? []), ...(raw.knows ?? [])]);
    const doesNotKnow = asStringArray([...(current.doesNotKnow ?? []), ...(raw.doesNotKnow ?? [])])
      .filter((item) => !knows.includes(item));
    ledger.knowledge[key] = {
      knows,
      doesNotKnow,
      updatedChapter: Math.max(current.updatedChapter ?? 0, chapter),
    };
  }

  const saved = await writeCanon(projectDir, ledger);

  try {
    const logPath = canonChangesFilePath(projectDir);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(
      logPath,
      JSON.stringify({ chapter, at: new Date().toISOString(), changes }) + '\n',
      'utf-8',
    );
  } catch {
    warnings.push('changes.jsonl 追加失败（快照已更新）');
  }

  return { ledger: saved, warnings };
}

export function normalizeChapterContract(raw: unknown, chapter: number): ChapterContract {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const budgetRaw = obj.wordBudget && typeof obj.wordBudget === 'object'
    ? (obj.wordBudget as Record<string, unknown>)
    : {};
  const budget: ChapterContract['wordBudget'] = {};
  for (const key of ['min', 'max', 'target'] as const) {
    const value = budgetRaw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) budget[key] = Math.trunc(value);
  }
  return {
    version: 1,
    chapter: asChapter(obj.chapter, chapter) || chapter,
    pov: asString(obj.pov),
    cast: asStringArray(obj.cast),
    beats: asStringArray(obj.beats),
    mustReveal: asStringArray(obj.mustReveal),
    mustNotReveal: asStringArray(obj.mustNotReveal),
    wordBudget: Object.keys(budget).length > 0 ? budget : undefined,
    status: asString(obj.status) === 'frozen' ? 'frozen' : 'draft',
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
  };
}

export async function readChapterContract(projectDir: string, chapter: number): Promise<ChapterContract | null> {
  try {
    const raw = await fs.readFile(contractFilePath(projectDir, chapter), 'utf-8');
    return normalizeChapterContract(JSON.parse(raw), chapter);
  } catch {
    return null;
  }
}

export async function removeChapterContract(projectDir: string, chapter: number): Promise<void> {
  try {
    await fs.unlink(contractFilePath(projectDir, chapter));
  } catch { /* 不存在 */ }
}

/** 删除第 deletedNum 章后，后续合同章号前移一位。 */
export async function shiftChapterContracts(projectDir: string, deletedNum: number): Promise<void> {
  const dir = path.join(projectDir, '.novel', CONTRACTS_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const nums = entries
    .map((name) => {
      const match = /^第(\d+)章\.json$/.exec(name);
      return match ? Number(match[1]) : null;
    })
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  // 先删除被删章的合同，再升序前移，避免降序 rename 覆盖仍存在的目标。
  try {
    await fs.unlink(contractFilePath(projectDir, deletedNum));
  } catch { /* 不存在 */ }
  for (const num of nums) {
    if (num <= deletedNum) continue;
    try {
      await fs.rename(contractFilePath(projectDir, num), contractFilePath(projectDir, num - 1));
    } catch { /* 单条失败不影响其余 */ }
  }
}

export async function writeChapterContract(
  projectDir: string,
  chapter: number,
  contract: unknown,
): Promise<ChapterContract> {
  const normalized = normalizeChapterContract(
    { ...(contract as Record<string, unknown>), chapter, updatedAt: new Date().toISOString() },
    chapter,
  );
  await writeJsonAtomic(contractFilePath(projectDir, chapter), normalized);
  return normalized;
}

function countCjk(text: string): number {
  return (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
}

function entityMatches(name: string, ledger: CanonLedger): boolean {
  const needle = name.trim();
  if (!needle) return false;
  return ledger.entities.some(
    (entity) => entity.name === needle || entity.aliases.includes(needle) || entity.id === needle,
  );
}

function aliasesFor(name: string, ledger: CanonLedger): string[] {
  const entity = ledger.entities.find(
    (e) => e.name === name || e.aliases.includes(name) || e.id === name,
  );
  return entity ? [entity.name, ...entity.aliases, entity.id] : [name];
}

/**
 * 确定性合同校验（不调用模型）。
 *
 * blocker 用于“定稿阻断”：POV 缺失、mustNotReveal 泄漏；
 * major 用于出场缺失 / 字数越界；minor 用于合同未冻结、未知角色等提示。
 */
export function validateChapterContract(input: {
  content: string;
  contract: ChapterContract;
  canon?: CanonLedger;
}): ContractFinding[] {
  const { content, contract } = input;
  const ledger = input.canon ?? emptyLedger();
  const findings: ContractFinding[] = [];

  if (contract.status !== 'frozen') {
    findings.push({
      severity: 'minor',
      code: 'contract-draft',
      message: '章节合同尚未冻结（status=draft），建议先确认 POV/出场/字数再写作',
    });
  }

  if (contract.pov) {
    const names = aliasesFor(contract.pov, ledger);
    if (!names.some((name) => content.includes(name))) {
      findings.push({
        severity: 'blocker',
        code: 'pov-missing',
        message: `POV 角色「${contract.pov}」未在正文中出现`,
      });
    }
  }

  for (const name of contract.cast) {
    const names = aliasesFor(name, ledger);
    if (!names.some((alias) => content.includes(alias))) {
      findings.push({
        severity: 'major',
        code: 'cast-missing',
        message: `合同出场角色「${name}」未在正文中出现`,
      });
    }
    if (ledger.entities.length > 0 && !entityMatches(name, ledger)) {
      findings.push({
        severity: 'minor',
        code: 'unknown-cast',
        message: `合同出场角色「${name}」不在 canon 实体表中`,
      });
    }
  }

  for (const term of contract.mustNotReveal) {
    if (term && content.includes(term)) {
      findings.push({
        severity: 'blocker',
        code: 'must-not-reveal-present',
        message: `合同中禁止提前揭示的内容出现在正文：「${term}」`,
        quote: term,
      });
    }
  }

  for (const term of contract.mustReveal) {
    if (term && !content.includes(term)) {
      findings.push({
        severity: 'major',
        code: 'must-reveal-missing',
        message: `合同要求揭示的内容未在正文中出现：「${term}」`,
        quote: term,
      });
    }
  }

  if (contract.wordBudget) {
    const count = countCjk(content);
    const { min, max, target } = contract.wordBudget;
    if (typeof min === 'number' && count < min) {
      findings.push({
        severity: 'major',
        code: 'word-budget',
        message: `正文 CJK 字数 ${count} 低于合同下限 ${min}`,
      });
    }
    if (typeof max === 'number' && count > max) {
      findings.push({
        severity: 'major',
        code: 'word-budget',
        message: `正文 CJK 字数 ${count} 超过合同上限 ${max}`,
      });
    }
    if (typeof target === 'number' && target > 0) {
      const deviation = Math.abs(count - target) / target;
      if (deviation > 0.3) {
        findings.push({
          severity: 'major',
          code: 'word-budget',
          message: `正文 CJK 字数 ${count} 与目标 ${target} 偏差 ${(deviation * 100).toFixed(0)}%（>30%）`,
        });
      } else if (deviation > 0.15) {
        findings.push({
          severity: 'minor',
          code: 'word-budget',
          message: `正文 CJK 字数 ${count} 与目标 ${target} 偏差 ${(deviation * 100).toFixed(0)}%（>15%）`,
        });
      }
    }
  }

  const rank: Record<ContractSeverity, number> = { blocker: 0, major: 1, minor: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** 给写作 prompt 注入的 canon 摘要（按需裁剪，避免上下文膨胀）。 */
export async function buildCanonContext(
  projectDir: string,
  chapter: number,
  names: string[],
): Promise<string> {
  const ledger = await readCanon(projectDir);
  if (ledger.entities.length === 0 && ledger.facts.length === 0 && Object.keys(ledger.knowledge).length === 0) {
    return '';
  }

  const focus = new Set(names.filter(Boolean));
  const lines: string[] = ['### Canon 台账（结构化事实，硬约束）'];
  const entities = ledger.entities.filter((entity) => {
    if (focus.size === 0) return true;
    return focus.has(entity.name) || entity.aliases.some((alias) => focus.has(alias)) || focus.has(entity.id);
  });
  if (entities.length > 0) {
    lines.push('**实体**');
    for (const entity of entities) {
      const alias = entity.aliases.length > 0 ? `（别名：${entity.aliases.join('、')}）` : '';
      const source = entity.sourceChapter ? `，第 ${entity.sourceChapter} 章起` : '';
      lines.push(`- ${entity.name}${alias} [${entity.type}/${entity.status}${source}]${entity.description ? `：${entity.description}` : ''}`);
    }
  }

  const facts = ledger.facts.filter((fact) => {
    if (fact.status !== 'active') return false;
    if (fact.validFrom > chapter) return false;
    if (focus.size === 0) return true;
    return focus.has(fact.subject) || focus.has(fact.object) || entities.some((e) => e.name === fact.subject);
  });
  if (facts.length > 0) {
    lines.push('**当前有效事实**');
    for (const fact of facts) {
      lines.push(`- ${fact.subject} · ${fact.predicate} = ${fact.object}（第 ${fact.validFrom} 章起）`);
    }
  }

  const knowledgeEntries = Object.entries(ledger.knowledge).filter(([name]) => focus.size === 0 || focus.has(name));
  if (knowledgeEntries.length > 0) {
    lines.push('**知情边界**');
    for (const [name, entry] of knowledgeEntries) {
      if (entry.knows.length > 0) lines.push(`- ${name} 已知：${entry.knows.join('；')}`);
      if (entry.doesNotKnow.length > 0) lines.push(`- ${name} 尚不知：${entry.doesNotKnow.join('；')}`);
    }
  }

  let result = lines.join('\n');
  if (result.length > 6000) result = result.slice(0, 6000) + '…';
  return result;
}

/** 给写作 prompt 注入的章节合同（硬约束）。 */
export async function buildContractContext(projectDir: string, chapter: number): Promise<string> {
  const contract = await readChapterContract(projectDir, chapter);
  if (!contract) return '';
  const lines = [
    `### 章节合同（第${chapter}章，${contract.status === 'frozen' ? '已冻结，必须遵守' : '草稿，可调整'}）`,
    contract.pov ? `- POV：${contract.pov}` : '',
    contract.cast.length > 0 ? `- 必须出场：${contract.cast.join('、')}` : '',
    contract.beats.length > 0 ? `- 关键 beat：${contract.beats.join('；')}` : '',
    contract.mustReveal.length > 0 ? `- 必须揭示：${contract.mustReveal.join('、')}` : '',
    contract.mustNotReveal.length > 0 ? `- 禁止提前揭示：${contract.mustNotReveal.join('、')}` : '',
    contract.wordBudget
      ? `- 字数预算：${contract.wordBudget.min ? `下限 ${contract.wordBudget.min}` : ''}${contract.wordBudget.max ? `，上限 ${contract.wordBudget.max}` : ''}${contract.wordBudget.target ? `，目标 ${contract.wordBudget.target}` : ''}（CJK 字数）`
      : '',
    '',
    '合同是本章的硬约束；如必须偏离，请在章末摘要中记录偏离原因，并更新合同而不是静默忽略。',
  ].filter(Boolean);
  return lines.join('\n');
}
