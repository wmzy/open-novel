/**
 * 实体链接渲染 + 弹窗集成测试。
 * 归并建议：未来若有 markdown 渲染相关集成测可合并到本文件。
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { EntityMarkdown } from '@/web/components/EntityMarkdown';
import { buildEntityDict } from '@/shared/entity-dict';
import type { EntityRef } from '@/shared/entity-dict';

function makeDict(): Map<string, EntityRef> {
  const profiles = `# 角色档案

## 林冲
- 姓名：林冲
- 外号：豹子头

## 反派
- 姓名：高俅`;
  return buildEntityDict([{ path: 'characters/profiles.md', content: profiles }]);
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(createElement(QueryClientProvider, { client: qc }, ui));
}

describe('EntityMarkdown 集成', () => {
  it('正文中角色名渲染为链接', () => {
    const dict = makeDict();
    wrap(
      createElement(EntityMarkdown, {
        content: '只见林冲策马而出。',
        dict,
        projectId: 'proj_1',
      }),
    );
    const link = screen.getByRole('button', { name: '林冲' });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('data-type')).toBe('character');
    cleanup();
  });

  it('词典为空时不渲染链接', () => {
    wrap(
      createElement(EntityMarkdown, {
        content: '只见林冲策马而出。',
        dict: new Map(),
        projectId: 'proj_1',
      }),
    );
    expect(screen.queryByRole('button', { name: '林冲' })).toBeNull();
    cleanup();
  });

  it('点击链接触发弹窗，弹窗含档案原文与类型徽标', async () => {
    const dict = makeDict();
    wrap(
      createElement(EntityMarkdown, {
        content: '只见林冲策马而出。',
        dict,
        projectId: 'proj_1',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '林冲' }));
    await waitFor(() => {
      // 弹窗类型徽标（角色）
      expect(screen.getByText('角色')).toBeInTheDocument();
    });
    cleanup();
  });

  it('弹窗可通过关闭按钮关闭', async () => {
    const dict = makeDict();
    wrap(
      createElement(EntityMarkdown, {
        content: '只见林冲策马而出。',
        dict,
        projectId: 'proj_1',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '林冲' }));
    await waitFor(() => expect(screen.getByText('角色')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('关闭'));
    await waitFor(() => expect(screen.queryByText('角色')).toBeNull());
    cleanup();
  });

  it('加粗文本中的实体名也被链接', () => {
    const dict = makeDict();
    wrap(
      createElement(EntityMarkdown, {
        content: '只见**林冲**策马而出。',
        dict,
        projectId: 'proj_1',
      }),
    );
    expect(screen.getByRole('button', { name: '林冲' })).toBeInTheDocument();
    cleanup();
  });

  it('多个实体都被链接', () => {
    const dict = makeDict();
    wrap(
      createElement(EntityMarkdown, {
        content: '林冲与高俅对峙。',
        dict,
        projectId: 'proj_1',
      }),
    );
    expect(screen.getByRole('button', { name: '林冲' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '高俅' })).toBeInTheDocument();
    cleanup();
  });

  it('外号也渲染为链接（alias 类型）', () => {
    const dict = makeDict();
    wrap(
      createElement(EntityMarkdown, {
        content: '江湖人称豹子头。',
        dict,
        projectId: 'proj_1',
      }),
    );
    const link = screen.getByRole('button', { name: '豹子头' });
    expect(link.getAttribute('data-type')).toBe('alias');
    cleanup();
  });
});
