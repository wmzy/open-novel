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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
});
