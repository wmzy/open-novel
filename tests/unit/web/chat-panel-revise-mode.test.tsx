/**
 * ChatPanel 修订模式测试。
 *
 * 来源：修订改造——视图/卡片 ✎ 不再独立 POST，改为 dispatch open-novel:revise-to-chat 事件，
 * ChatPanel 监听后进入「修订模式」，显示提示条、发送时带 mode/targetFile/revisionNote。
 *
 * 归并建议：未来若有更多 ChatPanel 行为测试（命令拦截、autocomplete 等），追加到本文件。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { REVISE_TO_CHAT_EVENT } from '@/web/hooks/useFileRevision';

// jsdom 缺 scrollIntoView，ChatPanel 的 auto-scroll effect 需要
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// useRun 的 sendMessage 用 spy 捕获，验证 revise 字段透传
const sendMessageSpy = vi.fn();
const useRunMock = {
  messages: [],
  isRunning: false,
  status: '',
  activeRunCount: 0,
  availableCommands: [],
  pendingAsk: null,
  resolveAsk: vi.fn(),
  sendMessage: (...args: unknown[]) => sendMessageSpy(...args),
  cancel: vi.fn(),
  conversationId: null,
  resetConversation: vi.fn(),
  loadConversation: vi.fn(),
};
vi.mock('@/web/hooks/useRun', () => ({ useRun: () => useRunMock }));

vi.mock('@/web/hooks/useModels', () => ({
  useModels: () => ({ data: [] }),
  useModelSelection: () => ['default', vi.fn()],
}));
vi.mock('@/web/hooks/useConversations', () => ({ useConversations: () => ({ data: [] }) }));
vi.mock('@/web/hooks/useAgents', () => ({
  useAgents: () => ({
    data: [{ id: 'claude', name: 'Claude', available: true }],
    isLoading: false,
  }),
}));
vi.mock('@/web/hooks/useAgentCommands', () => ({ useAgentCommands: () => ({ data: [] }) }));
vi.mock('@/web/hooks/useFileAutocomplete', () => ({
  useFileAutocomplete: () => ({
    filterFiles: () => [],
    showAutocomplete: false,
    activeIndex: 0,
    setActiveIndex: vi.fn(),
    closeAutocomplete: vi.fn(),
    checkMention: vi.fn(),
  }),
}));

import ChatPanel from '@/web/components/ChatPanel';

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function renderPanel() {
  return render(
    createElement(ChatPanel, {
      projectId: 'p1',
      agentId: 'claude',
      skillId: 'novel',
      stage: 'concept',
    }),
    { wrapper: makeWrapper() },
  );
}

describe('ChatPanel 修订模式', () => {
  beforeEach(() => {
    sendMessageSpy.mockReset();
  });
  afterEach(() => cleanup());

  it('收到 revise-to-chat 事件后显示修订提示条', () => {
    renderPanel();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(REVISE_TO_CHAT_EVENT, {
          detail: { targetFile: 'concept.md', sectionTitle: '核心冲突' },
        }),
      );
    });
    expect(screen.getByText(/正在修订 concept\.md/)).toBeInTheDocument();
    expect(screen.getByText(/核心冲突/)).toBeInTheDocument();
  });

  it('点 ✕ 清空修订模式', () => {
    renderPanel();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(REVISE_TO_CHAT_EVENT, {
          detail: { targetFile: 'concept.md' },
        }),
      );
    });
    fireEvent.click(screen.getByTitle('退出修订模式'));
    expect(screen.queryByText(/正在修订/)).not.toBeInTheDocument();
  });

  it('修订模式下发送：sendMessage 收到 mode/targetFile/revisionNote', () => {
    renderPanel();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(REVISE_TO_CHAT_EVENT, {
          detail: { targetFile: 'concept.md' },
        }),
      );
    });
    const ta = screen.getByPlaceholderText(/输入对 concept\.md 的修订意见/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '主角太冷，加温情戏' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const arg = sendMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.mode).toBe('revise');
    expect(arg.targetFile).toBe('concept.md');
    expect(arg.revisionNote).toBe('主角太冷，加温情戏');
    expect(arg.message).toBe('主角太冷，加温情戏');
  });

  it('section 级修订：revisionNote 前置定向锚点，message 保持原文', () => {
    renderPanel();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(REVISE_TO_CHAT_EVENT, {
          detail: { targetFile: 'concept.md', sectionTitle: '核心冲突' },
        }),
      );
    });
    const ta = screen.getByPlaceholderText(/输入对 concept\.md 的修订意见/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '改成双线叙事' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    const arg = sendMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.message).toBe('改成双线叙事');
    expect(String(arg.revisionNote)).toContain('【定向修订：仅修改「核心冲突」这一节】');
    expect(String(arg.revisionNote)).toContain('改成双线叙事');
  });

  it('非修订模式发送：sendMessage 不带 mode/targetFile', () => {
    renderPanel();
    const ta = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '普通消息' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    const arg = sendMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.mode).toBeUndefined();
    expect(arg.targetFile).toBeUndefined();
  });

  it('发送后退出修订模式（提示条消失）', () => {
    renderPanel();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(REVISE_TO_CHAT_EVENT, {
          detail: { targetFile: 'concept.md' },
        }),
      );
    });
    const ta = screen.getByPlaceholderText(/输入对 concept\.md 的修订意见/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '改一下' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(screen.queryByText(/正在修订/)).not.toBeInTheDocument();
  });
});
