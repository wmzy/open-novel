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
  it('空审阅时显示"无待审阅"', () => {
    render(<ReviewPanel review={emptyReview} onMerge={vi.fn()} onDiscard={vi.fn()} merging={false} discarding={false} onClose={vi.fn()} />);
    expect(screen.getByText('无待审阅')).toBeInTheDocument();
  });

  it('渲染文件列表 + 增删摘要', () => {
    render(<ReviewPanel review={sampleReview} onMerge={vi.fn()} onDiscard={vi.fn()} merging={false} discarding={false} onClose={vi.fn()} />);
    expect(screen.getByText('chapters/第1章.md')).toBeInTheDocument();
    expect(screen.getByText('concept.md')).toBeInTheDocument();
    expect(screen.getByText(/\+7/)).toBeInTheDocument();
  });

  it('点文件展开 diff', () => {
    render(<ReviewPanel review={sampleReview} onMerge={vi.fn()} onDiscard={vi.fn()} merging={false} discarding={false} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('chapters/第1章.md'));
    expect(screen.getByText(/第一章内容/)).toBeInTheDocument();
  });

  it('点合并调用 onMerge', () => {
    const onMerge = vi.fn();
    render(<ReviewPanel review={sampleReview} onMerge={onMerge} onDiscard={vi.fn()} merging={false} discarding={false} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('合并'));
    expect(onMerge).toHaveBeenCalledOnce();
  });

  it('点丢弃需二次确认', () => {
    const onDiscard = vi.fn();
    render(<ReviewPanel review={sampleReview} onMerge={vi.fn()} onDiscard={onDiscard} merging={false} discarding={false} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('丢弃'));
    expect(onDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('确认丢弃'));
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});
