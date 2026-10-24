/**
 * ForeshadowView 五列看板 + 债务摘要条测试。
 *
 * 来源：伏笔债务系统改造包（第 1 包）——伏笔从静态清单升级为债务系统，
 * 视图为 待埋/已埋/推进中/已收/放弃 五列 + 顶部债务摘要（总数/债务分/逾期/密度预算）。
 * 图表组件（CollapsibleDiagram/MermaidDiagram）在此 mock 掉——
 * 图表源码构建逻辑已由 tests/unit/shared/diagram-builders.test.ts 覆盖。
 *
 * 归并建议：后续 ForeshadowView 的交互测试（编辑/拖拽变更状态等）直接追加到本文件。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../../src/web/components/MermaidDiagram', () => ({
  CollapsibleDiagram: () => null,
}));

import ForeshadowView from '../../../src/web/components/views/ForeshadowView';
import { computeForeshadowStats, type Foreshadow } from '../../../src/shared/foreshadow';

/** 覆盖五种状态 + 逾期/推进/重磅/依赖链的测试数据。 */
const FORESHADOWS: Foreshadow[] = [
  { id: 1, content: '待埋伏笔', type: 'world', status: 'pending', plantedIn: 12, resolveDeadline: 18, resolvedIn: null, progressedIn: [], dependsOn: [], weight: 'light' },
  { id: 2, content: '已埋逾期伏笔', type: 'identity', status: 'planted', plantedIn: 2, resolveDeadline: 8, resolvedIn: null, progressedIn: [], dependsOn: [1], weight: 'major' },
  { id: 3, content: '已收伏笔', type: 'chekhov', status: 'resolved', plantedIn: 1, resolveDeadline: 9, resolvedIn: 9, progressedIn: [6], dependsOn: [], weight: 'light' },
  { id: 4, content: '放弃伏笔', type: 'emotional', status: 'dropped', plantedIn: 3, resolveDeadline: null, resolvedIn: null, progressedIn: [], dependsOn: [], weight: 'light' },
  { id: 5, content: '推进中伏笔', type: 'chekhov', status: 'progressing', plantedIn: 2, resolveDeadline: 16, resolvedIn: null, progressedIn: [5, 7], dependsOn: [], weight: 'light' },
];
const CURRENT_CHAPTER = 10;
const CHAPTER_COUNT = 20;
const STATS = computeForeshadowStats(FORESHADOWS, CURRENT_CHAPTER, CHAPTER_COUNT);

function renderView() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ForeshadowView projectId="proj_1" />
    </QueryClientProvider>,
  );
}

function mockApi(payload: unknown, ok = true) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/projects/proj_1/foreshadows')) {
      return new Response(ok ? JSON.stringify(payload) : 'null', {
        status: ok ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not Found', { status: 404 });
  });
}

describe('ForeshadowView 债务看板', () => {
  beforeEach(() => {
    mockApi({
      foreshadows: FORESHADOWS,
      stats: STATS,
      migrated: true,
      warnings: ['第 5 条伏笔 status 非法（"unknown"），已丢弃'],
      currentChapter: CURRENT_CHAPTER,
      chapterCount: CHAPTER_COUNT,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染 待埋/已埋/推进中/已收/放弃 五列且各列计数正确', async () => {
    renderView();
    expect(await screen.findByText('待埋')).toBeTruthy();
    expect(screen.getByText('已埋')).toBeTruthy();
    expect(screen.getByText('推进中')).toBeTruthy();
    expect(screen.getByText('已收')).toBeTruthy();
    expect(screen.getByText('放弃')).toBeTruthy();
    // 五列各有 1 条
    expect(screen.getAllByText('（1）')).toHaveLength(5);
    // 五条内容各归其列
    expect(screen.getByText('待埋伏笔')).toBeTruthy();
    expect(screen.getByText('已埋逾期伏笔')).toBeTruthy();
    expect(screen.getByText('推进中伏笔')).toBeTruthy();
    expect(screen.getByText('已收伏笔')).toBeTruthy();
    expect(screen.getByText('放弃伏笔')).toBeTruthy();
  });

  it('渲染债务摘要条：总数/债务分/逾期/密度预算', async () => {
    renderView();
    expect(await screen.findByText('总数')).toBeTruthy();
    expect(screen.getByText('债务分')).toBeTruthy();
    expect(screen.getByText('逾期未收')).toBeTruthy();
    expect(screen.getByText('即将到期')).toBeTruthy();
    expect(screen.getByText(/密度预算（每3章≤2条）/)).toBeTruthy();
    // 窗口 [8,10] 内无实际新埋 → 0/2 条
    expect(screen.getByText(/近3章新埋 0\/2 条/)).toBeTruthy();
    // 债务分 = #1 light + #2 major + #5 light = 4；逾期 1 条、即将到期 2 条（#1 期限18、#5 期限16）
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getAllByText('1')).toHaveLength(1);
    expect(screen.getAllByText('2')).toHaveLength(1);
  });

  it('卡片带类型/权重/逾期徽章、推进记录与依赖链', async () => {
    renderView();
    expect(await screen.findByText('身份之谜')).toBeTruthy();
    expect(screen.getByText('重磅')).toBeTruthy();
    expect(screen.getByText('世界观')).toBeTruthy();
    expect(screen.getByText('逾期')).toBeTruthy();
    expect(screen.getByText(/期限第8章（已逾期）/)).toBeTruthy();
    expect(screen.getByText(/期限第18章/)).toBeTruthy();
    expect(screen.getByText(/埋于第2章｜前置依赖：#1/)).toBeTruthy();
    // 推进中卡片显示推进章号
    expect(screen.getByText(/埋于第2章｜推进于第5章、第7章/)).toBeTruthy();
    // 已收卡片显示回收章号
    expect(screen.getByText(/埋于第1章｜收于第9章/)).toBeTruthy();
  });

  it('显示迁移提示与解析警告', async () => {
    renderView();
    expect(await screen.findByText(/已自动迁移/)).toBeTruthy();
    expect(screen.getByText(/status 非法/)).toBeTruthy();
  });

  it('接口不可用或无数据时显示空态提示', async () => {
    mockApi(null, false);
    renderView();
    expect(await screen.findByText(/尚未创建伏笔/)).toBeTruthy();
  });
});
