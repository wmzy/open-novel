import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// mock mermaid：避免 jsdom 加载 1MB 库，返回固定 SVG
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg width="100" height="100"><rect /></svg>' })),
  },
}));

import { MermaidDiagram } from '../../../src/web/components/MermaidDiagram';

describe('MermaidDiagram 缩放', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染后显示缩放控件，初始 100%', async () => {
    render(<MermaidDiagram chart={'graph TD; A-->B'} />);
    const label = await screen.findByText('100%');
    expect(label).toBeTruthy();
    expect(screen.getByLabelText('放大')).toBeTruthy();
    expect(screen.getByLabelText('缩小')).toBeTruthy();
    expect(screen.getByLabelText('重置')).toBeTruthy();
  });

  it('放大按钮递增到 120%/144%，缩小递减', async () => {
    render(<MermaidDiagram chart={'graph TD; A-->B'} />);
    await screen.findByText('100%');
    fireEvent.click(screen.getByLabelText('放大'));
    expect(screen.getByText('120%')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('放大'));
    expect(screen.getByText('144%')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('缩小'));
    expect(screen.getByText('120%')).toBeTruthy();
  });

  it('重置回到 100%', async () => {
    render(<MermaidDiagram chart={'graph TD; A-->B'} />);
    await screen.findByText('100%');
    fireEvent.click(screen.getByLabelText('放大'));
    fireEvent.click(screen.getByLabelText('放大'));
    expect(screen.getByText('144%')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('重置'));
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('transform 应用到 SVG（scale 随缩放变化）', async () => {
    const { container } = render(<MermaidDiagram chart={'graph TD; A-->B'} />);
    await screen.findByText('100%');
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg).toBeTruthy();
    expect(svg.style.transform).toContain('scale(1)');

    fireEvent.click(screen.getByLabelText('放大'));
    await waitFor(() => {
      expect(svg.style.transform).toContain('scale(1.2)');
    });
  });

  it('缩小不低于下限 20%', async () => {
    render(<MermaidDiagram chart={'graph TD; A-->B'} />);
    await screen.findByText('100%');
    // 连续缩小直到触底
    for (let i = 0; i < 40; i++) fireEvent.click(screen.getByLabelText('缩小'));
    expect(screen.getByText('20%')).toBeTruthy();
  });

  it('放大不高于上限 1000%（矢量图支持大幅放大）', async () => {
    render(<MermaidDiagram chart={'graph TD; A-->B'} />);
    await screen.findByText('100%');
    for (let i = 0; i < 40; i++) fireEvent.click(screen.getByLabelText('放大'));
    expect(screen.getByText('1000%')).toBeTruthy();
  });

  it('chart 变化后重置缩放', async () => {
    const { rerender } = render(<MermaidDiagram chart={'graph TD; A-->B'} />);
    await screen.findByText('100%');
    fireEvent.click(screen.getByLabelText('放大'));
    expect(screen.getByText('120%')).toBeTruthy();
    rerender(<MermaidDiagram chart={'graph TD; B-->C'} />);
    await waitFor(() => expect(screen.getByText('100%')).toBeTruthy());
  });

  it('渲染失败显示降级提示', async () => {
    const mermaid = (await import('mermaid')).default;
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error('boom'));
    render(<MermaidDiagram chart={'bad'} />);
    await waitFor(() => {
      expect(screen.getByText('图表数据格式异常或数据不足')).toBeTruthy();
    });
  });
});
