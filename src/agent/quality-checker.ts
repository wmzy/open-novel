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

/** 从对象中按候选键名取首个数值字段，均无效返回 null。容错 agent 产出的字段名变体。 */
function pickNumField(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const parsed = parseInt(v, 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

export function normalizeForeshadows(input: unknown): Foreshadow[] {
  if (!input || typeof input !== 'object') return [];
  // 容错两种顶层键：标准 `foreshadows` 与逆向/enrich 产出的 `items`
  const obj = input as { foreshadows?: unknown; items?: unknown };
  const arr = Array.isArray(obj.foreshadows) ? obj.foreshadows : obj.items;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((f, idx): Foreshadow | null => {
      if (!f || typeof f !== 'object') return null;
      const o = f as Record<string, unknown>;
      // 内容字段容错：content / description / text
      const content = typeof o.content === 'string' ? o.content
        : typeof o.description === 'string' ? o.description
          : typeof o.text === 'string' ? o.text : null;
      if (content === null) return null;
      // id 容错：number 优先；string 尝试 parse，失败用序号
      let id: number;
      if (typeof o.id === 'number') id = o.id;
      else if (typeof o.id === 'string') {
        const parsed = parseInt(o.id, 10);
        id = Number.isNaN(parsed) ? idx + 1 : parsed;
      } else id = idx + 1;
      return {
        id,
        content,
        status: typeof o.status === 'string' ? o.status : 'pending',
        // 章节字段容错：多种常见命名变体
        plantedIn: pickNumField(o, ['plantedIn', 'plantedChapter', 'planted_chapter', 'planted']),
        resolvedIn: pickNumField(o, ['resolvedIn', 'resolvedChapter', 'expectedPayoffChapter', 'expected_payoff_chapter', 'payoffChapter']),
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
