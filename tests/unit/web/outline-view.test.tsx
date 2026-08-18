/**
 * OutlineView 标签切换测试。
 *
 * 来源：outline-brief.md 由模板生成器落盘，但视图此前只读 outline-detailed.md，
 * 概览文件在 UI 上完全隐身。本次为 OutlineView 增加「概览/详细」标签切换，
 * 并修复 agent 落盘指令（outline.md → outline-detailed.md）。
 *
 * 归并建议：未来若有更多 OutlineView 测试（折叠状态、三幕图联动等），
 * 直接追加到本文件的现有 describe 内。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OutlineView from '../../../src/web/components/views/OutlineView';

const DETAILED = [
  '# 详细大纲',
  '## 第 1 章：起程',
  '- **主要场景**：主角踏出师门',
  '',
  '## 第 2 章：遇敌',
  '- **主要场景**：山道遇强敌',
].join('\n');

const BRIEF = [
  '# 简要大纲',
  '## 第一幕：设置（第 1–5 章，约 12500 字）',
  '- 引入主角、世界观与日常状态',
  '',
  '## 第二幕：对抗（第 6–15 章，约 25000 字）',
  '- 主角追求目标，遇到递进的障碍与冲突',
  '',
  '## 第三幕：解决（第 16–20 章，约 12500 字）',
  '- 最终对决：与反派正面交锋',
].join('\n');

/** 含承诺等级引用行元数据的滚动式大纲（三色徽标 / 待决策问题测试数据）。 */
const ROLLING = [
  '# 详细大纲',
  '## 第 1 章：起程',
  '> commitment: committed',
  '- **主要场景**：主角踏出师门',
  '',
  '## 第 2 章：遇敌',
  '> commitment: tentative',
  '- **主要场景**：山道遇强敌',
  '',
  '## 第 3 章：分岔',
  '> commitment: open',
  '> open-questions:',
  '>   - 敌人身份是否当场揭穿',
  '>   - 配角是否在此离队',
  '- **幕级骨架**：主角面临抉择',
].join('\n');

/** 章节头 button 的 accessible name 正则（含「第 N 章」）。 */
const CHAPTER_BTN = /第\s*\d+\s*章/;

function renderView() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <OutlineView projectId="proj_1" />
    </QueryClientProvider>,
  );
}

function mockFiles(map: Record<string, string | number>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    // 拆分文档合并接口
    if (url.includes('/document/')) {
      const docMatch = url.match(/\/document\/(concept|world|outline)$/);
      if (docMatch) {
        const docType = docMatch[1];
        // outline 合并接口返回 merge 后的内容
        const mergeKey = `${docType}-merged`;
        if (map[mergeKey] !== undefined) {
          if (typeof map[mergeKey] === 'number') {
            return new Response(JSON.stringify({ error: 'not found' }), { status: map[mergeKey] as number });
          }
          return new Response(JSON.stringify({ content: map[mergeKey] }));
        }
      }
    }
    // 文件读取接口
    for (const [key, val] of Object.entries(map)) {
      if (key.endsWith('-merged')) continue;
      if (url.includes(`path=${encodeURIComponent(key)}`)) {
        if (typeof val === 'number') {
          return new Response(JSON.stringify({ error: 'not found' }), { status: val });
        }
        return new Response(JSON.stringify({ content: val }));
      }
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  });
}

describe('OutlineView 标签切换', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('默认显示详细大纲', async () => {
    mockFiles({
      'outline-merged': DETAILED,
      'outline-brief.md': BRIEF,
      'outline-meta.json': 404,
    });
    renderView();

    // 详细 tab 默认激活；章节头是 button，应渲染出多个
    const chapters = await screen.findAllByRole('button', { name: CHAPTER_BTN });
    expect(chapters.length).toBeGreaterThanOrEqual(1);
  });

  it('切换到概览显示 outline-brief 内容', async () => {
    mockFiles({
      'outline-merged': DETAILED,
      'outline-brief.md': BRIEF,
      'outline-meta.json': 404,
    });
    renderView();

    await screen.findAllByRole('button', { name: CHAPTER_BTN });

    fireEvent.click(screen.getByText('概览'));

    // 概览大纲的幕标题出现（brief section 头是 div，非 button）
    await waitFor(() => {
      expect(screen.getByText(/第一幕：设置/)).toBeTruthy();
      expect(screen.getByText(/第三幕：解决/)).toBeTruthy();
    });
    // 详细章节 button 应消失
    expect(screen.queryAllByRole('button', { name: CHAPTER_BTN })).toHaveLength(0);
  });

  it('概览缺失时显示空态', async () => {
    mockFiles({
      'outline-merged': DETAILED,
      'outline-brief.md': 404,
      'outline-meta.json': 404,
    });
    renderView();

    await screen.findAllByRole('button', { name: CHAPTER_BTN });
    fireEvent.click(screen.getByText('概览'));

    expect(await screen.findByText('尚未创建概览大纲。')).toBeTruthy();
  });

  it('顶部说明条：近细远粗分级是设计意图', async () => {
    mockFiles({
      'outline-merged': DETAILED,
      'outline-brief.md': BRIEF,
      'outline-meta.json': 404,
    });
    renderView();

    expect(await screen.findByText(/远粗是滚动大纲的设计意图而非未完成/)).toBeTruthy();
  });

  it('章节卡片按承诺等级显示三色徽标', async () => {
    mockFiles({
      'outline-merged': ROLLING,
      'outline-brief.md': BRIEF,
      'outline-meta.json': 404,
    });
    renderView();

    await screen.findAllByRole('button', { name: CHAPTER_BTN });
    expect(screen.getByText('已定 · beat')).toBeTruthy();
    expect(screen.getByText('倾向 · arc')).toBeTruthy();
    expect(screen.getByText('待决 · 骨架')).toBeTruthy();
  });

  it('open 卡片展开显示待决策问题列表', async () => {
    mockFiles({
      'outline-merged': ROLLING,
      'outline-brief.md': BRIEF,
      'outline-meta.json': 404,
    });
    renderView();

    await screen.findAllByRole('button', { name: CHAPTER_BTN });
    const box = screen.getByText('待决策问题（open）').parentElement!;
    expect(within(box).getAllByText('敌人身份是否当场揭穿').length).toBeGreaterThanOrEqual(1);
    expect(within(box).getAllByText('配角是否在此离队').length).toBeGreaterThanOrEqual(1);
  });

  it('无元数据的旧卡片不显示承诺徽标（缺省 tentative 不打扰旧数据）', async () => {
    mockFiles({
      'outline-merged': DETAILED,
      'outline-brief.md': BRIEF,
      'outline-meta.json': 404,
    });
    renderView();

    await screen.findAllByRole('button', { name: CHAPTER_BTN });
    expect(screen.queryByText('已定 · beat')).toBeNull();
  });
});
