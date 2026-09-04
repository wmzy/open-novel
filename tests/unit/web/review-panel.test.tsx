import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock RevisionDiffPanel：其差异渲染已在别处测试，这里只验证 ReviewPanel 的接线
vi.mock('../../../src/web/components/RevisionDiffPanel', () => ({
  default: (props: { targetFile: string; diff: string; addedLines: number; removedLines: number }) => (
    <div data-testid="diff-panel" data-file={props.targetFile}>
      {props.diff}
    </div>
  ),
}));

import ReviewPanel from '../../../src/web/components/ReviewPanel';
import type { ReviewResult } from '../../../src/web/hooks/useReview';

const emptyReview: ReviewResult = { commits: [], files: [], totalAdded: 0, totalRemoved: 0 };
const sampleReview: ReviewResult = {
  commits: [{ hash: 'abc1234', message: '[auto] 写第一章', date: '2026-07-27T00:00:00+08:00' }],
  files: [
    { path: 'chapters/第1章.md', status: 'added', addedLines: 5, removedLines: 0, diff: '+第一章内容\n' },
    { path: 'concept.md', status: 'modified', addedLines: 2, removedLines: 1, diff: '-old\n+new\n' },
  ],
  totalAdded: 7,
  totalRemoved: 1,
};

describe('ReviewPanel', () => {
  const baseProps = {
    review: sampleReview,
    onMerge: vi.fn(),
    onDiscard: vi.fn(),
    merging: false,
    discarding: false,
    fileBusy: false,
    onAcceptFile: vi.fn(),
    onRejectFile: vi.fn(),
    onClose: vi.fn(),
  };

  it('空审阅时显示"无待审阅"', () => {
    render(<ReviewPanel {...baseProps} review={emptyReview} />);
    expect(screen.getByText('无待审阅')).toBeInTheDocument();
  });

  it('渲染文件列表 + 增删摘要', () => {
    render(<ReviewPanel {...baseProps} />);
    expect(screen.getByText('chapters/第1章.md')).toBeInTheDocument();
    expect(screen.getByText('concept.md')).toBeInTheDocument();
    expect(screen.getByText(/\+7/)).toBeInTheDocument();
  });

  it('点文件展开 diff', () => {
    render(<ReviewPanel {...baseProps} />);
    fireEvent.click(screen.getByText('chapters/第1章.md'));
    expect(screen.getByText(/第一章内容/)).toBeInTheDocument();
  });

  it('点合并调用 onMerge', () => {
    const onMerge = vi.fn();
    render(<ReviewPanel {...baseProps} onMerge={onMerge} />);
    fireEvent.click(screen.getByText('合并'));
    expect(onMerge).toHaveBeenCalledOnce();
  });

  it('点丢弃需二次确认', () => {
    const onDiscard = vi.fn();
    render(<ReviewPanel {...baseProps} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByText('丢弃'));
    expect(onDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('确认丢弃'));
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it('逐文件接受/拒绝调用对应 handler', () => {
    const onAcceptFile = vi.fn();
    const onRejectFile = vi.fn();
    render(<ReviewPanel {...baseProps} onAcceptFile={onAcceptFile} onRejectFile={onRejectFile} />);
    // 每个文件都有一组接受/拒绝按钮，取第一组
    fireEvent.click(screen.getAllByText('✓ 接受')[0]);
    expect(onAcceptFile).toHaveBeenCalledWith('chapters/第1章.md');
    fireEvent.click(screen.getAllByText('✗ 拒绝')[0]);
    expect(onRejectFile).toHaveBeenCalledWith('chapters/第1章.md');
  });

  it('fileBusy 时逐文件按钮禁用', () => {
    render(<ReviewPanel {...baseProps} fileBusy />);
    expect(screen.getAllByText('✓ 接受')[0]).toBeDisabled();
    expect(screen.getAllByText('✗ 拒绝')[0]).toBeDisabled();
  });
});
