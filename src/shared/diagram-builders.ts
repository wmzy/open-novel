/**
 * Mermaid 图表构建器：纯函数，将结构化数据转为 mermaid 源码字符串。
 * 调用方拿到字符串后交给 MermaidDiagram 组件渲染。
 * 所有函数返回 null 表示数据不足——调用方应显示提示而非空图。
 */

// ── 输入类型（与数据源对齐，只取图表所需字段） ──

export interface ForeshadowItem {
  id: number;
  content: string;
  status: string;
  plantedIn: number;
  resolvedIn?: number;
}

export interface CharRelState {
  name: string;
  relationships: Record<string, string>;
}

export interface OutlineMeta {
  actBreaks: [number, number];
  chapters: Array<{ chapter: number; pov: string }>;
}

// ── 工具 ──

/** 清理 mermaid 文本：去掉会破坏语法的分隔符，压缩空白。 */
function sanitize(text: string, maxLen = 15): string {
  return text
    .replace(/[\n\r":<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** 取伏笔内容的简短标签（第一个分句，截断）。 */
function foreshadowLabel(content: string): string {
  const first = content.split(/[，。；,;.。\n]/)[0].trim();
  return first.length > 12 ? first.slice(0, 12) + '…' : first;
}

// ── ① 伏笔-回收甘特图 ──

/**
 * 从 foreshadow.json 派生甘特图：横轴=章节号，每条=伏笔从埋设章到回收章。
 * 按 status 分 section（待埋/待回收/已回收），一眼看出哪条逾期、哪条扎堆。
 */
export function buildForeshadowGantt(items: ForeshadowItem[]): string | null {
  if (!items || items.length === 0) return null;

  const maxChapter = Math.max(...items.map((f) => f.resolvedIn ?? f.plantedIn ?? 1));

  const sections: Array<{ title: string; state: string; group: ForeshadowItem[] }> = [
    { title: '待埋', state: 'crit', group: items.filter((f) => f.status === 'pending') },
    { title: '待回收', state: 'active', group: items.filter((f) => f.status === 'planted') },
    { title: '已回收', state: 'done', group: items.filter((f) => f.status === 'resolved' && f.resolvedIn != null) },
  ];

  const lines: string[] = [
    'gantt',
    '    title 伏笔埋设→回收周期',
    '    dateFormat X',
    '    axisFormat %s 章',
  ];

  for (const { title, state, group } of sections) {
    if (group.length === 0) continue;
    lines.push(`    section ${title}`);
    for (const f of group) {
      const start = f.plantedIn || 1;
      const end = f.resolvedIn ?? maxChapter;
      const dur = Math.max(1, end - start);
      lines.push(`    ${sanitize(foreshadowLabel(f.content))} :${state}, f${f.id}, ${start}, ${dur}`);
    }
  }

  // 只有标题行 = 全部数据无效
  return lines.length <= 4 ? null : lines.join('\n');
}

// ── ② 人物关系图 ──

/**
 * 从 state.json relationships 派生关系图：节点=角色，边=关系描述。
 * 双向关系（A→B 和 B→A）会出现两条边——这是有意的，让矛盾的关系描述可见。
 */
export function buildRelationshipGraph(chars: CharRelState[]): string | null {
  if (!chars || chars.length === 0) return null;

  const withRels = chars.filter((c) => Object.keys(c.relationships).length > 0);
  if (withRels.length === 0) return null;

  // 收集所有名字（含 relationships 中的目标角色）
  const nameSet = new Set<string>();
  for (const c of chars) {
    nameSet.add(c.name);
    for (const r of Object.keys(c.relationships)) nameSet.add(r);
  }
  const names = [...nameSet];
  const nameToId = new Map(names.map((n, i) => [n, `n${i}`]));

  const lines: string[] = ['graph LR'];

  for (let i = 0; i < names.length; i++) {
    lines.push(`    n${i}("${sanitize(names[i], 20)}")`);
  }

  const seen = new Set<string>();
  for (const c of chars) {
    for (const [target, rel] of Object.entries(c.relationships)) {
      const fromId = nameToId.get(c.name);
      const toId = nameToId.get(target);
      if (!fromId || !toId) continue;
      const key = `${fromId}|${toId}|${rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`    ${fromId} ---|"${sanitize(rel, 20)}"| ${toId}`);
    }
  }

  return lines.length <= names.length + 1 ? null : lines.join('\n');
}

// ── ③ 三幕节奏图 ──

/**
 * 从 outline-meta actBreaks 派生三幕结构图。
 * 不画每章节点（太多），只画三幕分段 + 关键节拍 + 转折点。
 */
export function buildArcDiagram(meta: OutlineMeta): string | null {
  if (!meta?.chapters?.length) return null;
  const total = meta.chapters.length;
  const [act1End, act2End] = meta.actBreaks;

  const lines: string[] = ['graph TB'];
  lines.push(`    subgraph 第一幕["第一幕 · 设置（第 1–${act1End} 章）"]`);
  lines.push(`        A1["开场：建立日常"]`);
  lines.push(`    end`);
  lines.push(`    subgraph 第二幕["第二幕 · 对抗（第 ${act1End + 1}–${act2End} 章）"]`);
  const mid = Math.round((act1End + 1 + act2End) / 2);
  lines.push(`        B1["冲突升级"]`);
  if (mid > act1End + 1 && mid < act2End) {
    lines.push(`        B2["中点转折（~第${mid}章）"]`);
    lines.push(`        B1 --> B2`);
    lines.push(`        B2 --> B3`);
  } else {
    lines.push(`        B1 --> B3`);
  }
  lines.push(`        B3["灵魂黑夜"]`);
  lines.push(`    end`);
  lines.push(`    subgraph 第三幕["第三幕 · 解决（第 ${act2End + 1}–${total} 章）"]`);
  lines.push(`        C1["最终对决"]`);
  lines.push(`        C2["新常态"]`);
  lines.push(`        C1 --> C2`);
  lines.push(`    end`);
  lines.push(`    A1 --> B1`);
  lines.push(`    B3 --> C1`);

  lines.push(`    classDef turn fill:#f59e0b,color:#1e293b,stroke:#d97706,stroke-width:2px;`);
  lines.push(`    class A1,B3,C1 turn;`);

  return lines.join('\n');
}

// ── ④ 视点轮换时间线 ──

const POV_COLORS = ['#0ea5e9', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899', '#64748b'];

/**
 * 从 outline-meta chapters 派生视点轮换图：每章一个节点，按视点角色着色。
 * 一眼看出某角色是否长期缺席、视点切换是否有节奏。
 */
export function buildPovTimeline(meta: OutlineMeta): string | null {
  if (!meta?.chapters?.length) return null;

  const povs = [...new Set(meta.chapters.map((c) => c.pov).filter(Boolean))];
  if (povs.length === 0) return null;

  const lines: string[] = ['graph LR'];

  for (const ch of meta.chapters) {
    lines.push(`    ch${ch.chapter}("${ch.chapter}\\n${sanitize(ch.pov, 8)}")`);
  }
  for (let i = 0; i < meta.chapters.length - 1; i++) {
    lines.push(`    ch${meta.chapters[i].chapter} --> ch${meta.chapters[i + 1].chapter}`);
  }

  // 按视点角色着色
  povs.forEach((pov, i) => {
    const color = POV_COLORS[i % POV_COLORS.length];
    const ids = meta.chapters.filter((c) => c.pov === pov).map((c) => `ch${c.chapter}`);
    lines.push(`    classDef pov${i} fill:${color},color:#fff,stroke:none;`);
    lines.push(`    class ${ids.join(',')} pov${i};`);
  });

  return lines.join('\n');
}

// ── ⑤ 故事脉络时间线 ──

export interface OutlineChapter {
  number: number;
  title: string;
  pov: string;
  /** 出场角色名（已去括号批注）；无出场角色行时为空数组 */
  cast: string[];
  /** 该章所属 section 标题（最近的 ## 标题） */
  section: string;
}

/** 清理出场角色名：去括号批注、按顿号/逗号切分、去群像词缀。 */
function parseCastList(raw: string): string[] {
  return raw
    .replace(/[（(][^)）]*[)）]/g, '') // 去括号批注
    .split(/[、，,]/)
    .map((s) => s.trim())
    .filter((s) => s && !/(群像|路人|背景)$/.test(s)); // 去掉"…群像"等非具名
}

/**
 * 解析大纲全文，提取所有章节的结构化信息。
 * 章节锚点：`#### 第N章：标题` 或 `#### 第N-M章：标题`（连读章节取首章号）。
 * section：最近的上一个 `## ` 标题。
 */
export function parseOutlineChapters(outline: string): OutlineChapter[] {
  if (!outline) return [];
  const lines = outline.split('\n');
  const chapters: OutlineChapter[] = [];
  let currentSection = '';

  const anchorRe = /^####\s+第([\d]+)(?:-[\d]+)?章[：:]?\s*(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const secMatch = lines[i].match(/^##\s+(.+)$/);
    if (secMatch) {
      currentSection = secMatch[1].trim();
      continue;
    }
    const anchorMatch = lines[i].match(anchorRe);
    if (!anchorMatch) continue;

    const number = parseInt(anchorMatch[1], 10);
    const title = anchorMatch[2].trim();
    // 向下扫描表格行找 POV 和出场角色（到下一个 #### 或 ### 之前）
    let pov = '';
    let castRaw = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (/^#{3,4}\s/.test(lines[j])) break;
      const povMatch = lines[j].match(/^\|\s*POV\s*\|\s*(.+?)\s*\|/);
      if (povMatch) pov = povMatch[1].trim();
      const castMatch = lines[j].match(/^\|\s*出场角色\s*\|\s*(.+?)\s*\|/);
      if (castMatch) castRaw = castMatch[1].trim();
    }

    chapters.push({
      number,
      title,
      pov,
      cast: parseCastList(castRaw),
      section: currentSection,
    });
  }

  return chapters;
}

/**
 * 从解析后的章节列表生成 mermaid timeline 源码。
 * section = 章节的 section 字段；节点标注章号+标题+POV。
 * 返回 null 表示无数据。
 */
export function buildStoryTimeline(chapters: OutlineChapter[]): string | null {
  if (!chapters || chapters.length === 0) return null;

  const lines: string[] = ['timeline', '    title 故事脉络'];
  let lastSection = '';

  for (const ch of chapters) {
    if (ch.section && ch.section !== lastSection) {
      lines.push(`    section ${sanitize(ch.section, 30)}`);
      lastSection = ch.section;
    }
    const povLabel = ch.pov ? `POV ${sanitize(ch.pov, 10)}` : 'POV ?';
    lines.push(`        第${ch.number}章 ${sanitize(ch.title, 20)} : ${povLabel}`);
  }

  return lines.join('\n');
}
