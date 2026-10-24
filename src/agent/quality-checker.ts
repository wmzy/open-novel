import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 自动化质量检查器（纯 TypeScript 文本分析，不调用 AI）。
 *
 * 三类检查：
 * 1. 反 AI 味检测（detectAiPatterns）：基于 SKILL.md 定义的 6 种"AI 腔"模式，
 *    用正则 + 统计分析给出 0-100 的相似度评分与逐条修改建议。
 * 2. 伏笔遗忘检测（checkForeshadows）：读取 foreshadow.json 与各章正文，
 *    用关键词匹配统计伏笔在后续章节的提及情况，找出疑似遗忘/已回收/健康的伏笔。
 * 3. 人物 OOC 检测（detectOoc）：比对角色档案（性格设定）与章节正文中的台词/行为，
 *    找出与设定严重偏离的表现。
 * 4. 事实核查（detectMechanicalFactIssues / buildFactCheckPrompt）：
 *    机械规则检查 POV 知情越界与人名近似笔误；语义核查由 agent 按 prompt 输出
 *    POV 泄漏 / 姓名别名 / 设定时间线三类问题。均为报告型，不阻断写作。
 *
 * 设计原则：
 * - 纯分析逻辑（analyzeXxx）与文件读取分离，便于单元测试。
 * - 所有小说文件都在项目目录的 `.novel/` 下，入参 projectDir 为项目根目录
 *   （与 context-manager 保持一致）。
 */

// ===== 常量 =====

const NOVEL_DIR = '.novel';
const CHAPTERS_DIR = 'chapters';
const FORESHADOW_FILE = 'foreshadow.json';
const PROFILES_FILE = path.join('characters', 'profiles.md');

/** 章节正文文件名，例如 `.novel/chapters/chapter-1.md`。 */
const CHAPTER_FILE_RE = /^chapter-(\d+)\.md$/i;
/** 备选章节文件名，例如 `.novel/chapters/第1章.md`。 */
const CHAPTER_FILE_RE_CN = /^第(\d+)章\.md$/;
/** 章节摘要文件名（检测正文时需排除），例如 `.novel/chapters/第1章.summary.md`。 */
const SUMMARY_FILE_RE = /^第(\d+)章\.summary\.md$/;

/** 伏笔疑似遗忘阈值：连续 N 章正文未提及即标记为"疑似遗忘"。 */
const FORGOTTEN_CHAPTER_THRESHOLD = 5;

/** OOC 检测：寡言角色连续长台词的判定句数。 */
const QUIET_LONG_LINE_COUNT = 3;
/** OOC 检测：长台词的字符下限。 */
const LONG_LINE_MIN_CHARS = 15;

// ===== 反 AI 味：类型定义 =====

/** 6 种反 AI 味模式的标识。 */
export type AiPatternType =
  | '抽象情绪标签'
  | '模板心理独白'
  | '排比堆砌'
  | '万能形容词'
  | '转折滥用'
  | '情节概括';

export interface AiPatternIssue {
  type: AiPatternType;
  snippet: string;
  suggestion: string;
}

export interface AiPatternReport {
  score: number; // 0-100，越高越像 AI
  issues: AiPatternIssue[];
}

// ===== 反 AI 味：词库与正则 =====

const TEMPLATE_MONOLOGUE_WORDS = [
  '心中一动', '心头一震', '心头一紧', '心中一凛', '眼中闪过', '眼神一凝',
  '目光一沉', '不禁', '忍不住', '暗自', '默默地', '缓缓地', '淡淡地',
  '微微一笑', '莞尔一笑', '愣了愣', '苦笑', '叹了口气', '心如刀绞', '五味杂陈',
];

const GENERIC_ADJECTIVES = [
  '美丽', '温暖', '深邃', '神秘', '孤独', '寂寞', '忧伤', '璀璨',
  '迷人', '温柔', '坚强', '勇敢', '善良', '宁静', '苍茫', '壮阔', '凄美',
];

const TRANSITION_WORDS_FULL = ['然而', '但是', '不过', '可是'];
const TRANSITION_WORD_QUE = '却';

const PLOT_SUMMARY_PHRASES = [
  '随着时间的推移', '经过了一段时间', '在接下来的日子里', '日子一天天过去',
  '时光飞逝', '时光荏苒', '岁月如梭', '转眼间', '不知不觉', '就这样',
  '自此之后', '此后的日子里',
];

const ABSTRACT_EMOTION_RES: RegExp[] = [
  /(他|她|它|你|我)(感到|觉得|感觉到|感受到)/g,
  /心(?:里|中|头|底)?(?:涌起|升起|泛起|生起|涌上|一紧|一沉|一颤|一惊)/g,
  /(?:涌起|升起|弥漫|洋溢|充满)(?:一股|一阵|一种)?/g,
  /(?:一种|一股|一阵)[^，。！？\n]{1,8}(?:的感觉|之感|之情|的滋味)/g,
];

// ===== 反 AI 味：纯分析逻辑 =====

function perThousand(matches: number, charLen: number): number {
  if (charLen <= 0) return 0;
  return (matches / charLen) * 1000;
}

function snippetAround(text: string, matchStr: string, index: number): string {
  const start = Math.max(0, index - 8);
  const end = Math.min(text.length, index + matchStr.length + 8);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (end < text.length) s = s + '…';
  return s;
}

interface CategoryResult {
  issues: AiPatternIssue[];
  points: number;
}

function detectAbstractEmotion(text: string, charLen: number): CategoryResult {
  const max = 18;
  let count = 0;
  const issues: AiPatternIssue[] = [];
  for (const re of ABSTRACT_EMOTION_RES) {
    const fresh = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = fresh.exec(text)) !== null) {
      count++;
      if (issues.length < 3) {
        issues.push({
          type: '抽象情绪标签',
          snippet: snippetAround(text, m[0], m.index),
          suggestion: '不要直接报告情绪，用可观察的动作/感官细节让读者自己读出情绪（Show, Don\'t Tell）。',
        });
      }
    }
  }
  return { issues, points: Math.min(max, Math.round((perThousand(count, charLen) / 2) * max)) };
}

function detectTemplateMonologue(text: string, charLen: number): CategoryResult {
  const max = 18;
  let count = 0;
  const issues: AiPatternIssue[] = [];
  for (const word of TEMPLATE_MONOLOGUE_WORDS) {
    let idx = text.indexOf(word);
    while (idx !== -1) {
      count++;
      if (issues.length < 4) {
        issues.push({
          type: '模板心理独白',
          snippet: snippetAround(text, word, idx),
          suggestion: `"${word}" 是高频套话，换用更具体、贴合此刻人物的动作或神态。`,
        });
      }
      idx = text.indexOf(word, idx + word.length);
    }
  }
  return { issues, points: Math.min(max, Math.round((perThousand(count, charLen) / 3) * max)) };
}

function detectParallelism(text: string): CategoryResult {
  const max = 16;
  const issues: AiPatternIssue[] = [];
  const sentences = text.split(/[。！？\n]+/).filter((s) => s.trim().length > 0);
  let totalRuns = 0;
  for (const sentence of sentences) {
    const clauses = sentence.split(/[，、；,:]/).map((c) => c.trim()).filter((c) => c.length >= 3);
    if (clauses.length < QUIET_LONG_LINE_COUNT) continue;
    let runStart = 0;
    for (let i = 1; i <= clauses.length; i++) {
      const prev = clauses[i - 1];
      const cur = clauses[i];
      const samePrefix = cur && prev && cur[0] === prev[0];
      const similarLen = cur && prev && Math.abs(cur.length - prev.length) <= 2;
      if (samePrefix && similarLen) continue;
      const runLen = i - runStart;
      if (runLen >= QUIET_LONG_LINE_COUNT) {
        totalRuns++;
        if (issues.length < 4) {
          issues.push({
            type: '排比堆砌',
            snippet: clauses.slice(runStart, i).join('，'),
            suggestion: '连续同构短句显得机械，打散句式、变换主语或用细节替代重复结构。',
          });
        }
      }
      runStart = i;
    }
  }
  return { issues, points: Math.min(max, totalRuns * 8) };
}

function detectGenericAdjectives(text: string, charLen: number): CategoryResult {
  const max = 16;
  let count = 0;
  const issues: AiPatternIssue[] = [];
  for (const word of GENERIC_ADJECTIVES) {
    let idx = text.indexOf(word);
    while (idx !== -1) {
      count++;
      if (issues.length < 4) {
        issues.push({
          type: '万能形容词',
          snippet: snippetAround(text, word, idx),
          suggestion: `"${word}" 过于空泛，用具体到能反驳的细节替代（不是"冷"，是"石板从脚心往上蹿的冷"）。`,
        });
      }
      idx = text.indexOf(word, idx + word.length);
    }
  }
  return { issues, points: Math.min(max, Math.round((perThousand(count, charLen) / 2) * max)) };
}

function detectTransitionAbuse(text: string, charLen: number): CategoryResult {
  const max = 16;
  let count = 0;
  const issues: AiPatternIssue[] = [];
  for (const word of TRANSITION_WORDS_FULL) {
    let idx = text.indexOf(word);
    while (idx !== -1) {
      count++;
      if (issues.length < 3) {
        issues.push({
          type: '转折滥用',
          snippet: snippetAround(text, word, idx),
          suggestion: `"${word}" 密度过高，AI 常靠转折硬接逻辑；尝试用因果或动作自然过渡。`,
        });
      }
      idx = text.indexOf(word, idx + word.length);
    }
  }
  let queIdx = text.indexOf(TRANSITION_WORD_QUE);
  while (queIdx !== -1) {
    count += 0.3;
    queIdx = text.indexOf(TRANSITION_WORD_QUE, queIdx + 1);
  }
  return { issues, points: Math.min(max, Math.round((perThousand(count, charLen) / 2.7) * max)) };
}

function detectPlotSummary(text: string): CategoryResult {
  const max = 16;
  const issues: AiPatternIssue[] = [];
  let count = 0;
  for (const phrase of PLOT_SUMMARY_PHRASES) {
    let idx = text.indexOf(phrase);
    while (idx !== -1) {
      count++;
      if (issues.length < 4) {
        issues.push({
          type: '情节概括',
          snippet: snippetAround(text, phrase, idx),
          suggestion: `"${phrase}" 是概括而非描写；用一个具体场景承载时间流逝，而非一句话带过。`,
        });
      }
      idx = text.indexOf(phrase, idx + phrase.length);
    }
  }
  return { issues, points: Math.min(max, count * 8) };
}

/** 反 AI 味检测：综合 6 种模式给出 0-100 评分与逐条建议。纯函数。 */
export function detectAiPatterns(text: string): AiPatternReport {
  const normalized = (text ?? '').replace(/\r\n/g, '\n');
  const charLen = normalized.replace(/\s/g, '').length;
  const categories: CategoryResult[] = [
    detectAbstractEmotion(normalized, charLen),
    detectTemplateMonologue(normalized, charLen),
    detectParallelism(normalized),
    detectGenericAdjectives(normalized, charLen),
    detectTransitionAbuse(normalized, charLen),
    detectPlotSummary(normalized),
  ];
  const score = Math.min(100, categories.reduce((sum, c) => sum + c.points, 0));
  const issues = categories.flatMap((c) => c.issues);
  return { score, issues };
}

// ===== 伏笔遗忘检测：类型定义 =====

export interface Foreshadow {
  id: number;
  content: string;
  status: string;
  plantedIn?: number | null;
  resolvedIn?: number | null;
}

export interface ChapterContent {
  chapter: number;
  content: string;
}

export interface ForgottenForeshadow {
  id: number;
  content: string;
  lastSeenChapter: number;
  chaptersSinceLastSeen: number;
}

export interface ResolvedForeshadow {
  id: number;
  content: string;
  resolvedIn: number | null;
}

export interface HealthyForeshadow {
  id: number;
  content: string;
  lastSeenChapter: number;
}

export interface ForeshadowReport {
  forgotten: ForgottenForeshadow[];
  resolved: ResolvedForeshadow[];
  healthy: HealthyForeshadow[];
}

// ===== 伏笔遗忘检测：纯分析逻辑 =====

const FUNCTIONAL_CHARS = new Set('的了是在和与也都很又就把被让地去来');

function extractForeshadowKeywords(content: string): string[] {
  const cleaned = (content ?? '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  if (!cleaned) return [];
  const keywords = new Set<string>();
  keywords.add(cleaned);
  for (let i = 0; i + 2 <= cleaned.length; i++) {
    const gram = cleaned.slice(i, i + 2);
    if (!FUNCTIONAL_CHARS.has(gram[0]) && !FUNCTIONAL_CHARS.has(gram[1])) {
      keywords.add(gram);
    }
  }
  return [...keywords];
}

/** 伏笔分析纯函数。 */
export function analyzeForeshadows(
  foreshadows: Foreshadow[],
  chapters: ChapterContent[],
  threshold: number = FORGOTTEN_CHAPTER_THRESHOLD,
): ForeshadowReport {
  const report: ForeshadowReport = { forgotten: [], resolved: [], healthy: [] };
  if (chapters.length === 0) return report;
  const maxChapter = chapters[chapters.length - 1].chapter;

  for (const f of foreshadows) {
    if (!f || !f.content) continue;
    if (f.status === 'resolved') {
      report.resolved.push({ id: f.id, content: f.content, resolvedIn: typeof f.resolvedIn === 'number' ? f.resolvedIn : null });
      continue;
    }
    const keywords = extractForeshadowKeywords(f.content);
    const plantChapter = typeof f.plantedIn === 'number' ? f.plantedIn : 0;
    let lastSeenChapter = 0;
    for (const ch of chapters) {
      if (ch.chapter < plantChapter) continue;
      if (keywords.some((k) => ch.content.includes(k))) {
        lastSeenChapter = Math.max(lastSeenChapter, ch.chapter);
      }
    }
    if (lastSeenChapter === 0) lastSeenChapter = plantChapter;
    const chaptersSinceLastSeen = Math.max(0, maxChapter - lastSeenChapter);
    if (chaptersSinceLastSeen >= threshold) {
      report.forgotten.push({ id: f.id, content: f.content, lastSeenChapter, chaptersSinceLastSeen });
    } else {
      report.healthy.push({ id: f.id, content: f.content, lastSeenChapter });
    }
  }
  return report;
}

// ===== 伏笔遗忘检测：文件 IO =====

export function normalizeForeshadows(input: unknown): Foreshadow[] {
  // 严格只认标准 schema：{ foreshadows: [{ id, content, status, plantedIn, resolvedIn }] }
  // status 必须是 pending/planted/progressing/resolved；content 必须是字符串。非标准条目跳过。
  if (!input || typeof input !== 'object') return [];
  const obj = input as { foreshadows?: unknown };
  if (!Array.isArray(obj.foreshadows)) return [];
  const VALID_STATUS = new Set(['pending', 'planted', 'progressing', 'resolved']);
  return obj.foreshadows
    .map((f, idx): Foreshadow | null => {
      if (!f || typeof f !== 'object') return null;
      const o = f as Record<string, unknown>;
      if (typeof o.content !== 'string' || typeof o.status !== 'string' || !VALID_STATUS.has(o.status)) return null;
      let id: number;
      if (typeof o.id === 'number') id = o.id;
      else if (typeof o.id === 'string') {
        const parsed = parseInt(o.id, 10);
        id = Number.isNaN(parsed) ? idx + 1 : parsed;
      } else id = idx + 1;
      return {
        id,
        content: o.content,
        status: o.status,
        plantedIn: typeof o.plantedIn === 'number' ? o.plantedIn : null,
        resolvedIn: typeof o.resolvedIn === 'number' ? o.resolvedIn : null,
      };
    })
    .filter((f): f is Foreshadow => f !== null);
}

/** 伏笔遗忘检测：读取 foreshadow.json 与章节正文，返回分类报告。 */
export async function checkForeshadows(
  projectDir: string,
  threshold: number = FORGOTTEN_CHAPTER_THRESHOLD,
): Promise<ForeshadowReport> {
  const foreshadowsRaw = await readNovelFile(projectDir, FORESHADOW_FILE);
  let foreshadows: Foreshadow[] = [];
  if (foreshadowsRaw) {
    try {
      foreshadows = normalizeForeshadows(JSON.parse(foreshadowsRaw));
    } catch {
      foreshadows = [];
    }
  }
  const chapters = await readAllChapters(projectDir);
  return analyzeForeshadows(foreshadows, chapters, threshold);
}

// ===== 人物 OOC 检测：类型与词库 =====

export interface CharacterProfile {
  name: string;
  personality: string;
}

export interface OocIssue {
  character: string;
  chapter: number;
  issue: string;
  profileExpectation: string;
  actualBehavior: string;
}

export interface OocReport {
  oocIssues: OocIssue[];
}

const QUIET_TRAITS = [
  '沉默', '寡言', '内向', '冷漠', '冷淡', '木讷', '沉稳', '沉静',
  '孤僻', '安静', '少言', '话少', '不苟言笑',
];

const CONTRADICTION_RULES: Array<{
  traits: string[];
  contradictWords: string[];
  expectation: string;
  behavior: string;
}> = [
  {
    traits: ['温柔', '温和', '善良', '斯文', '儒雅'],
    contradictWords: ['滚', '闭嘴', '蠢货', '废物', '白痴', '去死', '杀了你', '贱人'],
    expectation: '档案设定为温和善良，措辞应避免粗鄙',
    behavior: '台词中出现粗暴用词',
  },
  {
    traits: ['暴躁', '急躁', '易怒', '冲动', '火爆', '桀骜'],
    contradictWords: ['请您', '劳驾', '不胜感激', '诚惶诚恐', '小的', '奴才'],
    expectation: '档案设定为暴躁冲动，语气应直率少客套',
    behavior: '台词中出现过度谦卑/客套的用词',
  },
];

// ===== 人物 OOC 检测：纯分析逻辑 =====

/** 从 profiles.md 解析角色档案（姓名 + 性格）。支持两种格式：标准字段列表与标题式档案。 */
export function parseCharacterProfiles(profilesText: string): CharacterProfile[] {
  const profiles: CharacterProfile[] = [];
  // 主路径：从「- 姓名：/- 性格：」字段列表解析
  const fieldRe = /^[-*]\s*(姓名|性格)\s*[:：]\s*(.+?)\s*$/gm;
  const fields: Array<{ field: string; value: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(profilesText)) !== null) {
    fields.push({ field: m[1], value: m[2].trim() });
  }
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].field !== '姓名') continue;
    const name = fields[i].value;
    if (!name) continue;
    let personality = '';
    for (let j = i + 1; j < fields.length; j++) {
      if (fields[j].field === '姓名') break;
      if (fields[j].field === '性格') {
        personality = fields[j].value;
        break;
      }
    }
    profiles.push({ name, personality });
  }
  // 容错路径：无「姓名：」字段时，从「## 角色名（注释）」标题提取姓名，
  // 并在标题后的内容块里搜性格字段。覆盖 agent 产出的标题式档案格式。
  if (profiles.length === 0) {
    const headingRe = /^##\s+(.+?)\s*$/gm;
    const personalityRe = /(?:性格|性情|脾气|为人|特质)\s*[:：]\s*(.+)$/;
    const lines = profilesText.split('\n');
    const seen = new Set<string>();
    let hm: RegExpExecArray | null;
    while ((hm = headingRe.exec(profilesText)) !== null) {
      // 去掉标题中的括号注释，如「林冲（主角）」→「林冲」
      const name = hm[1].replace(/[（(].*$/, '').trim();
      if (!name || seen.has(name)) continue;
      const startLine = profilesText.slice(0, hm.index).split('\n').length - 1;
      let personality = '';
      for (let li = startLine + 1; li < lines.length; li++) {
        if (/^##\s/.test(lines[li])) break; // 下一个角色
        const pm = lines[li].match(personalityRe);
        if (pm) { personality = pm[1].trim(); break; }
      }
      seen.add(name);
      profiles.push({ name, personality });
    }
  }
  return profiles;
}

interface ExtractedDialogue {
  quotes: Array<{ quote: string; paraIndex: number }>;
  paragraphs: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 引号配对。 */
const QUOTE_PAIRS: Array<[string, string]> = [
  ['\u201c', '\u201d'],
  ['\u300c', '\u300d'],
  ['\u300e', '\u300f'],
  ['"', '"'],
];

/** 提取所有引号包裹的台词，记录所在段落索引。 */
function extractQuotes(text: string): ExtractedDialogue {
  const quotes: Array<{ quote: string; paraIndex: number }> = [];
  const paragraphs = text.split(/\n+/);
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi];
    for (const [open, close] of QUOTE_PAIRS) {
      const inner = open === close
        ? `([^${escapeRegExp(open)}]{1,})`
        : `([^${escapeRegExp(open)}${escapeRegExp(close)}]{1,})`;
      const re = new RegExp(`${escapeRegExp(open)}${inner}${escapeRegExp(close)}`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(para)) !== null) {
        quotes.push({ quote: m[1], paraIndex: pi });
      }
    }
  }
  return { quotes, paragraphs };
}

/** 统计某角色台词。台词与角色名可能不在同一行，因此把台词所在段落及其前后各一行都纳入匹配范围。 */
function quotesForCharacter(dialogue: ExtractedDialogue, name: string): string[] {
  const { quotes, paragraphs } = dialogue;
  const result: string[] = [];
  for (const q of quotes) {
    const around = [paragraphs[q.paraIndex - 1], paragraphs[q.paraIndex], paragraphs[q.paraIndex + 1]]
      .filter(Boolean).join('');
    if (around.includes(name)) result.push(q.quote);
  }
  return result;
}

function matchesAnyTrait(personality: string, traits: string[]): boolean {
  return traits.some((t) => personality.includes(t));
}

/** 人物 OOC 分析纯函数。 */
export function analyzeOoc(
  profiles: CharacterProfile[],
  chapter: number,
  chapterContent: string,
): OocReport {
  const issues: OocIssue[] = [];
  if (!chapterContent || profiles.length === 0) return { oocIssues: issues };

  const dialogue = extractQuotes(chapterContent);

  for (const profile of profiles) {
    if (!profile.personality) continue;
    const lines = quotesForCharacter(dialogue, profile.name);
    if (lines.length === 0) continue;

    if (matchesAnyTrait(profile.personality, QUIET_TRAITS)) {
      const longLines = lines.filter((d) => d.length >= LONG_LINE_MIN_CHARS);
      if (longLines.length >= QUIET_LONG_LINE_COUNT) {
        const maxLen = longLines.reduce((mx, d) => Math.max(mx, d.length), 0);
        issues.push({
          character: profile.name,
          chapter,
          issue: '档案标注沉默寡言，但本章有连续多句长台词，与设定不符',
          profileExpectation: profile.personality,
          actualBehavior: `共 ${longLines.length} 句 ≥${LONG_LINE_MIN_CHARS} 字的台词，最长 ${maxLen} 字`,
        });
      }
    }

    for (const rule of CONTRADICTION_RULES) {
      if (!matchesAnyTrait(profile.personality, rule.traits)) continue;
      const hits = rule.contradictWords.filter((w) => lines.some((d) => d.includes(w)));
      if (hits.length > 0) {
        issues.push({
          character: profile.name,
          chapter,
          issue: `${rule.behavior}（命中：${hits.join('、')}）`,
          profileExpectation: rule.expectation,
          actualBehavior: `台词含"${hits.join('、')}"`,
        });
      }
    }
  }

  return { oocIssues: issues };
}

// ===== 人物 OOC 检测：文件 IO =====

/** 人物 OOC 检测：读取角色档案与指定章节正文，返回偏离报告。 */
export async function detectOoc(projectDir: string, chapterNum: number): Promise<OocReport> {
  const profilesText = await readNovelFile(projectDir, PROFILES_FILE);
  const profiles = parseCharacterProfiles(profilesText);
  const chapterContent = await readChapter(projectDir, chapterNum);
  return analyzeOoc(profiles, chapterNum, chapterContent);
}

// ===== 通用文件读取辅助 =====

async function readNovelFile(projectDir: string, relativePath: string): Promise<string> {
  try {
    const full = path.join(projectDir, NOVEL_DIR, relativePath);
    return (await fs.readFile(full, 'utf-8')).trim();
  } catch {
    return '';
  }
}

/** 读取指定章节正文（依次尝试 chapter-N.md / 第N章.md），失败返回空串。导出供路由复用。 */
export async function readChapter(projectDir: string, chapterNum: number): Promise<string> {
  const candidates = [
    path.join(CHAPTERS_DIR, `第${chapterNum}章.md`),
    path.join(CHAPTERS_DIR, `chapter-${chapterNum}.md`),
  ];
  for (const rel of candidates) {
    const content = await readNovelFile(projectDir, rel);
    if (content) return content;
  }
  return '';
}

/** 读取第 N 章语义摘要（`.novel/chapters/第N章.summary.md`），失败返回空串。 */
export async function readChapterSummary(projectDir: string, chapterNum: number): Promise<string> {
  if (!Number.isFinite(chapterNum) || chapterNum < 1) return '';
  return readNovelFile(projectDir, path.join(CHAPTERS_DIR, `第${chapterNum}章.summary.md`));
}

/** 读取全部章节正文（排除 .summary.md 摘要），按章节号升序返回。 */
async function readAllChapters(projectDir: string): Promise<ChapterContent[]> {
  const chaptersDir = path.join(projectDir, NOVEL_DIR, CHAPTERS_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(chaptersDir);
  } catch {
    return [];
  }
  const chapters: ChapterContent[] = [];
  for (const name of entries) {
    if (SUMMARY_FILE_RE.test(name)) continue;
    let num: number | null = null;
    let m = CHAPTER_FILE_RE.exec(name);
    if (m) num = parseInt(m[1], 10);
    else {
      m = CHAPTER_FILE_RE_CN.exec(name);
      if (m) num = parseInt(m[1], 10);
    }
    const content = await readNovelFile(projectDir, path.join(CHAPTERS_DIR, name));
    if (!content) continue;
    chapters.push({ chapter: num ?? chapters.length + 1, content });
  }
  chapters.sort((a, b) => a.chapter - b.chapter);
  return chapters;
}

// ===== 流层退化检测（watchdog） =====

export interface DegradationResult {
  detected: boolean;
  repeatedPhrase: string;
  count: number;
  totalGrams: number;
  ratio: number;
}

/**
 * 从角色名列表生成要排除的 CJK 2-gram 集合。
 *
 * 角色名（如「林冲」「孙二娘」）在聚焦章节中天然高频，
 * 不排除会导致 detectDegradation 对对话密集章误报。
 * 2 字名 → 1 个 2-gram；3 字名 → 2 个 2-gram，以此类推。
 */
export function buildExcludeGrams(names: string[]): string[] {
  const grams: string[] = [];
  for (const name of names) {
    const chars = [...name].filter((c) => c >= '\u4e00' && c <= '\u9fff');
    for (let i = 0; i < chars.length - 1; i++) {
      grams.push(chars[i]! + chars[i + 1]!);
    }
  }
  return grams;
}

/**
 * 流层退化检测：在滑动窗口内统计 CJK 2-gram 频率。
 *
 * 最高频 2-gram 占比超过 threshold 时判定退化。
 * 依据：正常中文文本最高频 2-gram（如「是一」「的一」）占比约 1-3%；
 * 退化文本（如「今日今日今日…」）中「今日」占比可达 10%+。
 * 5% 是安全分界线，同时要求绝对出现次数 ≥ minCount 避免短文本误报。
 *
 * 可传入 excludeGrams 排除角色名等天然高频 2-gram，避免聚焦章误报。
 * 分母（totalGrams）仍为全部 CJK 2-gram 数量，排除只影响候选 maxGram。
 */
export function detectDegradation(
  text: string,
  options?: { threshold?: number; minCount?: number; excludeGrams?: string[] },
): DegradationResult {
  const threshold = options?.threshold ?? 0.05;
  const minCount = options?.minCount ?? 5;
  const excludeSet = options?.excludeGrams ? new Set(options.excludeGrams) : null;

  const cjkChars = [...text].filter((c) => c >= '\u4e00' && c <= '\u9fff');
  const totalGrams = Math.max(0, cjkChars.length - 1);
  if (totalGrams < Math.max(minCount, 4)) {
    return { detected: false, repeatedPhrase: '', count: 0, totalGrams, ratio: 0 };
  }

  const grams = new Map<string, number>();
  for (let i = 0; i < cjkChars.length - 1; i++) {
    const gram = cjkChars[i]! + cjkChars[i + 1]!;
    if (excludeSet?.has(gram)) continue; // 跳过角色名等天然高频 2-gram
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }

  let maxGram = '';
  let maxCount = 0;
  for (const [gram, count] of grams) {
    if (count > maxCount) {
      maxGram = gram;
      maxCount = count;
    }
  }

  const ratio = maxCount / totalGrams;
  return {
    detected: ratio >= threshold && maxCount >= minCount,
    repeatedPhrase: maxGram,
    count: maxCount,
    totalGrams,
    ratio,
  };
}

// ===== 事实核查（POV 知情边界 / 人名 / 设定时间线） =====
//
// 机械检查（无需 agent）：
// - detectNameAnomalies：与角色名册仅差一个编辑距离的疑似人名笔误；
// - detectPovLeakage：POV 角色在同一段落使用了「尚不知」或「尚未获知」的信息。
// 语义检查（需 agent）：
// - buildFactCheckPrompt / parseFactCheckResponse：构造核查 prompt，解析严格 JSON 结果。
//
// 所有检查都是「只报告、不阻断」：不写文件、不影响样章门禁/字数阈值。

export type FactIssueType = 'pov-leakage' | 'name-inconsistency' | 'canon-contradiction';
export type FactSeverity = 'blocker' | 'major' | 'minor';
export type FactIssueSource = 'mechanical' | 'semantic';

/** 统一的事实核查问题条目。前端 QualityCheckPanel 镜像该结构。 */
export interface FactCheckFinding {
  type: FactIssueType;
  severity: FactSeverity;
  chapter: number;
  /** 涉及的角色（人名不一致时为规范角色名）。 */
  character?: string;
  /** 原文引证（逐字摘录，供作者定位）。 */
  quote: string;
  detail: string;
  suggestion?: string;
  /** mechanical = 纯文本规则；semantic = AI 语义核查。 */
  source: FactIssueSource;
}

/** 名册输入：别名可归属到规范角色名。 */
export interface RosterNameInput {
  name: string;
  /** 别名对应的规范角色名；缺省即 name。 */
  canonical?: string;
}

/** 知情边界的最小结构（与 context-manager 的 CharacterKnowledge 兼容）。 */
export interface FactKnowledgeInput {
  name: string;
  knows: Array<{ fact: string; learnedIn?: number }>;
  doesNotKnow: string[];
}

// ---- 人名近似检测 ----

/** 人名后常见的言语/动作字（用于判定候选片段处在「人物名」位置）。 */
const NAME_AFTER_CHARS = new Set(
  [...'说道问答笑哭喊叫看望听走跑站坐卧握皱点摇转叹俯抬伸缩冲退跪躺靠应嗯咳哼愣怔瞥盯瞪抿咬挥拔推拉踢举低回停望'],
);
/** 人名两侧的标点/空白边界。 */
const NAME_BOUNDARY_CHARS = new Set(
  [...'，。！？、；：,.!?;:""\'「」『』（）()【】《》 \n\t\r'],
);
/** 人名前常见的边界/介词/动词字。 */
const NAME_BEFORE_CHARS = new Set(
  [...NAME_BOUNDARY_CHARS, ...'对向朝被让给和与跟同冲问叫喊见望请替为'],
);

/** 候选片段两侧是否像一个人物名（避免把「林间小路」误判为「林青」的笔误）。 */
function hasNameContext(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : '';
  const after = end < text.length ? text[end] : '';
  const beforeOk = !before || NAME_BEFORE_CHARS.has(before);
  const afterOk = !after || NAME_AFTER_CHARS.has(after) || NAME_BOUNDARY_CHARS.has(after);
  return beforeOk && afterOk;
}

/** 两个字符串是否恰好相差一次替换/插入/删除。 */
export function isSingleEditApart(a: string, b: string): boolean {
  if (a === b) return false;
  const diff = b.length - a.length;
  if (diff < -1 || diff > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (diff === 0) return a.slice(i + 1) === b.slice(i + 1);
  if (diff === 1) return a.slice(i) === b.slice(i + 1);
  return a.slice(i + 1) === b.slice(i);
}

/**
 * 名册人名近似检测：扫描与已知姓名/别名编辑距离为 1、且处在人物名位置（后接说话/动作字或标点）的片段。
 * 纯函数，不读文件。默认只报告 minor（可能是笔误，也可能是尚未登记的新称呼）。
 */
export function detectNameAnomalies(
  text: string,
  chapter: number,
  roster: Array<string | RosterNameInput>,
): FactCheckFinding[] {
  if (!text || roster.length === 0) return [];

  const entries: Array<{ name: string; canonical: string }> = [];
  for (const raw of roster) {
    const name = (typeof raw === 'string' ? raw : raw.name ?? '').trim();
    if (!/^[\u4e00-\u9fff]{2,6}$/.test(name)) continue;
    const canonical = (typeof raw === 'string' ? name : (raw.canonical ?? name)).trim() || name;
    if (!entries.some((e) => e.name === name && e.canonical === canonical)) {
      entries.push({ name, canonical });
    }
  }
  if (entries.length === 0) return [];

  const knownList = [...new Set(entries.map((e) => e.name))];
  const knownSet = new Set(knownList);
  const findings: FactCheckFinding[] = [];
  const seen = new Set<string>();
  const perNameCount = new Map<string, number>();

  for (const entry of entries) {
    if ((perNameCount.get(entry.name) ?? 0) >= 3) continue;
    const nameLength = [...entry.name].length;
    for (let len = Math.max(2, nameLength - 1); len <= nameLength + 1; len++) {
      if ((perNameCount.get(entry.name) ?? 0) >= 3) break;
      for (let start = 0; start + len <= text.length; start++) {
        const candidate = text.slice(start, start + len);
        if (!/^[\u4e00-\u9fff]+$/.test(candidate)) continue;
        if (candidate === entry.name || knownSet.has(candidate)) continue;
        // 长一字的窗口若就是「姓名 + 后接动词」（如「林青说」），不是笔误
        if (len === nameLength + 1 && (candidate.startsWith(entry.name) || candidate.endsWith(entry.name))) continue;
        // 候选与另一个已知名字互为子串时跳过（如「林青」vs「林青儿」已登记）
        if (knownList.some((k) => k !== entry.name && (k.includes(candidate) || candidate.includes(k)))) continue;
        if (candidate[0] !== entry.name[0]) continue;
        if (!isSingleEditApart(entry.name, candidate)) continue;
        if (!hasNameContext(text, start, start + len)) continue;
        const key = `${entry.canonical}|${candidate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        perNameCount.set(entry.name, (perNameCount.get(entry.name) ?? 0) + 1);

        const aliasNote = entry.canonical !== entry.name
          ? `（「${entry.name}」是「${entry.canonical}」的别名）`
          : '';
        findings.push({
          type: 'name-inconsistency',
          severity: 'minor',
          chapter,
          character: entry.canonical,
          quote: snippetAround(text, candidate, start),
          detail: `发现疑似人名笔误「${candidate}」：与角色名册中的「${entry.name}」${aliasNote}仅差一个字符。`,
          suggestion: `若确为笔误，请统一为「${entry.name}」；若是有意的新称呼，请登记到角色名册。`,
          source: 'mechanical',
        });
        if (findings.length >= 20) return findings;
        if ((perNameCount.get(entry.name) ?? 0) >= 3) break;
      }
    }
  }

  return findings;
}

// ---- POV 知情越界（机械启发式） ----

/** 事实关键词提取时丢弃的结构性词。 */
const TERM_STOPWORDS = new Set([
  '自己', '对方', '别人', '其他', '事情', '东西', '时候', '地方', '问题', '信息',
  '情况', '真实', '真正', '一直', '已经', '现在', '这里', '那里', '什么', '怎么',
  '知道', '不知道', '明白', '清楚', '关于', '对于', '这个', '那个', '一个',
]);

/** 去掉事实前的否定/所属前缀与首尾助词：「不知道自己的真实身世」→「真实身世」。 */
function cleanKnowledgeClause(clause: string): string {
  let s = clause.trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(
      /^(?:并不知道|不知道|尚未知道|还未知道|未曾知道|不曾知道|并不知晓|不知晓|尚未|还未|未曾|不曾|没有|关于|对于|自己的|自己|他的|她的|它的|其)/,
      '',
    );
    s = s.replace(/^(?:是|的|了|着|过|有|会|能|要|将|把|被|在|和|与|跟)/, '');
    s = s.replace(/(?:的|了|着|过)$/, '');
    if (s === before) break;
  }
  return s.trim();
}

/** 从一条知情事实提取可用于文本匹配的关键词（完整短语 + 后缀 4/3/2-gram）。 */
export function extractKnowledgeTerms(fact: string): string[] {
  const terms = new Set<string>();
  for (const rawClause of String(fact ?? '').split(/[，。；;、,：:\s]+/)) {
    const clause = cleanKnowledgeClause(rawClause);
    if (!clause) continue;
    for (const run of clause.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
      if (run.length <= 16 && !TERM_STOPWORDS.has(run)) terms.add(run);
      for (const size of [4, 3, 2]) {
        if (run.length > size) {
          const gram = run.slice(-size);
          if (!TERM_STOPWORDS.has(gram)) terms.add(gram);
        }
      }
    }
  }
  return [...terms]
    .filter((t) => t.length >= 2 && !TERM_STOPWORDS.has(t))
    .sort((a, b) => b.length - a.length)
    .slice(0, 12);
}

/** 关键词前是否紧跟「不知道/尚未…」的否定表述（用于避免把「林青并不知道自己的身世」误判为越界）。 */
function isNegatedOccurrence(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 16), index);
  return /(?:并不知道|不知道|不知(?!不觉)|并不知|不晓得|尚未|还未|未曾|不曾|没能|没有|没)[^。！？\n]{0,10}$/.test(before);
}

/**
 * POV 知情越界机械检查。
 * 只在「POV 角色名与命中关键词出现在同一段落」时报问题，宁可漏报也避免大面积误报。
 * - doesNotKnow 条目命中 → major；
 * - knows 条目 learnedIn 大于当前章（提前知情）→ major。
 */
export function detectPovLeakage(
  text: string,
  chapter: number,
  pov: string,
  knowledge?: FactKnowledgeInput | null,
): FactCheckFinding[] {
  const povName = (pov ?? '').trim();
  if (!povName || !text || !knowledge) return [];

  const forbidden: Array<{ term: string; fact: string; reason: 'unknown' | 'premature'; learnedIn?: number }> = [];
  for (const raw of knowledge.doesNotKnow ?? []) {
    const fact = String(raw ?? '').trim();
    if (!fact) continue;
    for (const term of extractKnowledgeTerms(fact)) {
      forbidden.push({ term, fact, reason: 'unknown' });
    }
  }
  for (const known of knowledge.knows ?? []) {
    if (typeof known?.learnedIn !== 'number' || known.learnedIn <= chapter) continue;
    const fact = String(known.fact ?? '').trim();
    if (!fact) continue;
    for (const term of extractKnowledgeTerms(fact)) {
      forbidden.push({ term, fact, reason: 'premature', learnedIn: known.learnedIn });
    }
  }
  if (forbidden.length === 0) return [];

  const findings: FactCheckFinding[] = [];
  const seen = new Set<string>();
  for (const paragraph of text.split(/\n+/)) {
    const para = paragraph.trim();
    if (!para || !para.includes(povName)) continue;
    for (const item of forbidden) {
      let index = para.indexOf(item.term);
      while (index !== -1 && isNegatedOccurrence(para, index)) {
        index = para.indexOf(item.term, index + item.term.length);
      }
      if (index === -1) continue;
      const key = `${item.reason}|${item.term}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        type: 'pov-leakage',
        severity: 'major',
        chapter,
        character: povName,
        quote: snippetAround(para, item.term, index),
        detail: item.reason === 'unknown'
          ? `POV 角色「${povName}」在本章出现与「尚不知」条目「${item.fact}」相关的叙述（命中「${item.term}」），可能使用了尚未获知的信息。`
          : `POV 角色「${povName}」在本章使用了第 ${item.learnedIn} 章才获知的信息「${item.fact}」（命中「${item.term}」），构成提前知情。`,
        suggestion: '核对该角色此刻是否应知道此事；若不应知道，删除相关认知/行动，或补写获知过程。',
        source: 'mechanical',
      });
      if (findings.length >= 18) return findings;
    }
  }
  return findings;
}

export interface MechanicalFactCheckInput {
  chapterText: string;
  chapter: number;
  pov?: string;
  roster?: Array<string | RosterNameInput>;
  knowledge?: FactKnowledgeInput | null;
}

/** 运行全部机械事实检查，按严重度排序返回。 */
export function detectMechanicalFactIssues(input: MechanicalFactCheckInput): FactCheckFinding[] {
  const findings = [
    ...detectPovLeakage(input.chapterText, input.chapter, input.pov ?? '', input.knowledge),
    ...detectNameAnomalies(input.chapterText, input.chapter, input.roster ?? []),
  ];
  const rank: Record<FactSeverity, number> = { blocker: 0, major: 1, minor: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---- 语义事实核查：prompt 与解析 ----

/** 正文注入上限（防止超长章节撑爆上下文）。 */
const FACT_CHECK_CHAPTER_MAX_CHARS = 18000;
/** 单段背景上下文注入上限。 */
const FACT_CHECK_CONTEXT_MAX_CHARS = 1800;

function clipForPrompt(text: string | undefined, max: number): string {
  const value = (text ?? '').replace(/\r\n/g, '\n').trim();
  if (value.length <= max) return value;
  return value.slice(0, max) + '\n…（已截断）';
}

export interface FactCheckPromptInput {
  chapter: number;
  chapterText: string;
  pov?: string;
  roster?: Array<{ name: string; aliases: string[] }>;
  knowledge?: FactKnowledgeInput | null;
  timeline?: string;
  previousSummary?: string;
  outline?: string;
}

/**
 * 构造「写后语义事实核查」prompt。
 * agent 只读上下文并输出 JSON，不得修改文件；结果是报告型的，不阻断写作。
 */
export function buildFactCheckPrompt(input: FactCheckPromptInput): string {
  const chapterText = clipForPrompt(input.chapterText, FACT_CHECK_CHAPTER_MAX_CHARS);
  const rosterLines = (input.roster ?? []).slice(0, 50).map((entry) => {
    const aliases = (entry.aliases ?? []).slice(0, 6);
    return `- ${entry.name}${aliases.length > 0 ? `（别名：${aliases.join('、')}）` : ''}`;
  });
  const knownLines = (input.knowledge?.knows ?? [])
    .filter((fact) => typeof fact.learnedIn !== 'number' || fact.learnedIn <= input.chapter)
    .slice(0, 16)
    .map((fact) =>
      `- ${clipForPrompt(fact.fact, 200)}${typeof fact.learnedIn === 'number' ? `（第${fact.learnedIn}章获知）` : ''}`,
    );
  const unknownLines = (input.knowledge?.doesNotKnow ?? []).slice(0, 16).map((fact) =>
    `- ${clipForPrompt(fact, 200)}`,
  );

  const sections: string[] = [];
  sections.push(
    '你是小说事实核查员。你只做审查，绝不修改任何文件，也不要调用任何写入工具。'
    + '请只根据下方提供的材料判断，不要臆测未提供的情节。',
  );
  sections.push(`## 一、本章正文（第${input.chapter}章）\n\n${chapterText}`);

  if (rosterLines.length > 0) {
    sections.push(`## 二、角色名册（姓名与别名）\n\n${rosterLines.join('\n')}`);
  }

  if (input.pov || knownLines.length > 0 || unknownLines.length > 0) {
    const povLine = input.pov ? `视点角色：${input.pov}` : '视点角色：未指定';
    const knownBlock = knownLines.length > 0 ? `**已知**\n${knownLines.join('\n')}` : '**已知**\n（未记录）';
    const unknownBlock = unknownLines.length > 0
      ? `**尚不知（该角色此时不应据此行动）**\n${unknownLines.join('\n')}`
      : '**尚不知（未记录）**';
    sections.push(`## 三、POV 知情边界\n\n${povLine}\n\n${knownBlock}\n\n${unknownBlock}`);
  }

  const canonSections: string[] = [];
  if (input.timeline) canonSections.push(`### 时间线\n${clipForPrompt(input.timeline, FACT_CHECK_CONTEXT_MAX_CHARS)}`);
  if (input.previousSummary) canonSections.push(`### 最近章节摘要\n${clipForPrompt(input.previousSummary, FACT_CHECK_CONTEXT_MAX_CHARS)}`);
  if (input.outline) canonSections.push(`### 本章大纲\n${clipForPrompt(input.outline, FACT_CHECK_CONTEXT_MAX_CHARS)}`);
  if (canonSections.length > 0) {
    sections.push(`## 四、已确立的设定与时间线\n\n${canonSections.join('\n\n')}`);
  }

  sections.push(
    '## 五、核查项\n\n'
    + '1. **POV 知情越界**：视点角色是否依据「尚不知」中的信息行动、推理、认出某人或说出答案？\n'
    + '2. **姓名/别名不一致**：是否出现与名册不符的人名、错字、张冠李戴的别名，或同一人被写成不同名字？\n'
    + '3. **设定/时间线矛盾**：是否与时间线、最近章节摘要或本章大纲中的既有事实冲突（地点、时间、生死、关系、能力等）？\n\n'
    + '只报告有文本证据的问题；文风、节奏、AI 味不在本次核查范围。',
  );

  sections.push(
    '## 六、输出格式（严格遵守）\n\n'
    + '只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。格式：\n'
    + '{"findings":[{"type":"pov-leakage|name-inconsistency|canon-contradiction","severity":"blocker|major|minor","chapter":'
    + `${input.chapter},"character":"涉及角色名（可省略）","quote":"逐字摘录本章原文（≤120字）","detail":"问题说明","suggestion":"可操作的修改建议"}]}\n\n`
    + 'severity 定义：blocker=直接破坏因果/时间线/视点边界；major=明显的设定或人名矛盾；minor=称呼/用词不统一。\n'
    + '没有问题时输出 {"findings":[]}。每条 finding 必须带 quote，且 quote 必须逐字来自本章正文。',
  );

  return sections.join('\n\n');
}

/** 宽松归一化 agent 返回的 type 字段。 */
function normalizeFindingType(value: unknown): FactIssueType | null {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!s) return null;
  if (/pov|viewpoint|视点|视角|知情|泄漏|泄露/.test(s)) return 'pov-leakage';
  if (/name|alias|人名|姓名|别名|称呼/.test(s)) return 'name-inconsistency';
  if (/canon|timeline|设定|时间线|时间轴|矛盾|continuity/.test(s)) return 'canon-contradiction';
  return null;
}

/** 宽松归一化 severity；未知值降级为 minor（报告型检查，不夸大严重度）。 */
function normalizeFindingSeverity(value: unknown): FactSeverity {
  if (typeof value !== 'string') return 'minor';
  const s = value.trim().toLowerCase();
  if (/blocker|critical|high|阻断|严重|高|致命/.test(s)) return 'blocker';
  if (/major|warning|medium|中|重要/.test(s)) return 'major';
  return 'minor';
}

function normalizeFindings(list: unknown[], defaultChapter: number): FactCheckFinding[] {
  const findings: FactCheckFinding[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const type = normalizeFindingType(o.type);
    if (!type) continue;
    const quoteRaw = typeof o.quote === 'string'
      ? o.quote
      : typeof o.evidence === 'string' ? o.evidence
        : typeof o.text === 'string' ? o.text : '';
    const quote = quoteRaw.trim().slice(0, 300);
    if (!quote) continue;
    const chapter = typeof o.chapter === 'number' && Number.isFinite(o.chapter)
      ? Math.trunc(o.chapter)
      : defaultChapter;
    const detailRaw = typeof o.detail === 'string'
      ? o.detail
      : typeof o.issue === 'string' ? o.issue
        : typeof o.description === 'string' ? o.description : '';
    const suggestionRaw = typeof o.suggestion === 'string'
      ? o.suggestion
      : typeof o.fix === 'string' ? o.fix
        : typeof o.fix_instruction === 'string' ? o.fix_instruction : '';
    const character = typeof o.character === 'string' ? o.character.trim().slice(0, 40) : '';

    const key = `${type}|${chapter}|${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const finding: FactCheckFinding = {
      type,
      severity: normalizeFindingSeverity(o.severity),
      chapter,
      quote,
      detail: detailRaw.trim().slice(0, 600),
      source: 'semantic',
    };
    if (character) finding.character = character;
    const suggestion = suggestionRaw.trim().slice(0, 400);
    if (suggestion) finding.suggestion = suggestion;
    findings.push(finding);
    if (findings.length >= 30) break;
  }
  return findings;
}

/**
 * 解析 agent 的语义核查输出。
 * 返回 null 表示无法解析（不是「没有问题」——没有问题返回空数组）。
 */
export function parseFactCheckResponse(output: string, chapter: number): FactCheckFinding[] | null {
  if (!output || !output.trim()) return null;
  const cleaned = output.replace(/```json/gi, '```').replace(/```/g, '');

  const objectStart = cleaned.indexOf('{');
  const objectEnd = cleaned.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      const parsed = JSON.parse(cleaned.slice(objectStart, objectEnd + 1)) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).findings)
          ? (parsed as { findings: unknown[] }).findings
          : null;
      if (list) return normalizeFindings(list, chapter);
    } catch {
      // 落到数组解析尝试
    }
  }

  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (arrayStart === -1 || arrayEnd <= arrayStart) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1)) as unknown;
    if (!Array.isArray(parsed)) return null;
    return normalizeFindings(parsed, chapter);
  } catch {
    return null;
  }
}
