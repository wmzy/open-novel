import { useEffect, useRef, useState } from 'react';
import { css } from '@linaria/core';

const diagramFrame = css`
  position: relative;
  background: var(--haze-color-bg-secondary);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
`;

const scrollArea = css`
  overflow: auto;
  max-height: 80vh;
  min-height: 240px;
  padding: 1rem;
`;

const svgWrap = css`
  overflow: hidden;
  user-select: none;
`;

const controls = css`
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.2rem;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.15rem;
  font-size: 0.72rem;
  z-index: 1;
`;

const ctrlBtn = css`
  background: none;
  border: none;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  padding: 0.2rem 0.4rem;
  border-radius: 4px;
  line-height: 1;
  font-size: 0.85rem;
  &:hover {
    color: var(--haze-color-text);
    background: var(--haze-color-bg-secondary);
  }
`;

const scaleLabel = css`
  color: var(--haze-color-text-secondary);
  min-width: 2.6rem;
  text-align: center;
  font-variant-numeric: tabular-nums;
`;

const msg = css`
  padding: 1.5rem 1rem;
  color: var(--haze-color-text-secondary);
  font-size: 0.85rem;
  text-align: center;
`;

/** mermaid 动态加载单例——只在首次渲染图表时加载（~1MB）。 */
let mermaidPromise: Promise<typeof import('mermaid')['default']> | null = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      const mermaid = m.default;
      mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: {
          primaryColor: '#1e293b',
          primaryTextColor: '#e2e8f0',
          primaryBorderColor: '#475569',
          lineColor: '#64748b',
          secondaryColor: '#334155',
          tertiaryColor: '#0f172a',
          background: '#0f172a',
          mainBkg: '#1e293b',
          secondBkg: '#334155',
          fontSize: '13px',
          // gantt
          sectionBkgColor: '#1e293b',
          sectionBkgColor2: '#334155',
          altSectionBkgColor: '#0f172a',
          gridColor: '#334155',
          tickColor: '#475569',
          activeTaskBorderColor: '#0ea5e9',
          doneTaskBkgColor: '#475569',
          doneTaskBorderColor: '#334155',
          critBkgColor: '#7f1d1d',
          critBorderColor: '#ef4444',
          taskBkgColor: '#0ea5e9',
          taskTextColor: '#fff',
          taskTextDarkColor: '#e2e8f0',
          taskTextLightColor: '#e2e8f0',
          taskTextOutsideColor: '#e2e8f0',
        },
        gantt: { useWidth: 900 },
        flowchart: { useMaxWidth: false },
        sequence: { useMaxWidth: false },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

// SVG 矢量图放大不失真，限制仅出于可用性（极端放大后文字巨大、平移难导航）
const MIN_SCALE = 0.2;
const MAX_SCALE = 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * 渲染 mermaid 源码为 SVG，支持缩放与拖拽平移。
 * - 缩放：右上角控件 −/[百分比]/+/⟲；范围 30%–300%
 * - 平移：scale>1 时拖拽平移（pointer capture，拖出元素仍跟踪）
 * - 图按原始尺寸渲染（解除 mermaid max-width:100% 压缩），超出视区时滚动区域双向滚动
 * 动态加载 mermaid，渲染失败时降级为提示。
 */
export function MermaidDiagram({ chart }: { chart: string }) {
  const elRef = useRef<HTMLDivElement>(null);
  const svgElRef = useRef<SVGSVGElement | null>(null);
  const [state, setState] = useState<'loading' | 'done' | 'error'>('loading');
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setScale(1);
    setPan({ x: 0, y: 0 });

    loadMermaid().then(async (mermaid) => {
      if (cancelled) return;
      try {
        const id = `mmd-${Math.random().toString(36).slice(2, 9)}`;
        const { svg } = await mermaid.render(id, chart);
        if (cancelled) return;
        if (elRef.current) {
          elRef.current.innerHTML = svg;
          const svgEl = elRef.current.querySelector('svg');
          if (svgEl) {
            svgElRef.current = svgEl;
            // 从 viewBox 提取原始宽度，设固定 width + 解除 max-width:100%
            // 避免宽图被压缩到容器宽度内（节点压成点）
            const vb = svgEl.getAttribute('viewBox');
            if (vb) {
              const w = Number(vb.split(/\s+/)[2]);
              if (w > 0) svgEl.style.width = `${w}px`;
            }
            svgEl.style.maxWidth = 'none';
          }
        }
        setState('done');
      } catch {
        if (!cancelled) setState('error');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [chart]);

  // 应用 transform 到 SVG（transform-origin 0 0，从左上角缩放）
  useEffect(() => {
    const svg = svgElRef.current;
    if (!svg) return;
    svg.style.transformOrigin = '0 0';
    svg.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
  }, [scale, pan, state]);

  const zoomIn = () => setScale((s) => clamp(+(s * 1.2).toFixed(3), MIN_SCALE, MAX_SCALE));
  const zoomOut = () => setScale((s) => clamp(+(s / 1.2).toFixed(3), MIN_SCALE, MAX_SCALE));
  const reset = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  // 拖拽平移：仅 scale>1 时启用
  const onPointerDown = (e: React.PointerEvent) => {
    if (scale <= 1) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y };
    setDragging(true);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) });
  };
  const onPointerUp = () => {
    dragRef.current = null;
    setDragging(false);
  };

  if (state === 'error') {
    return <div className={msg}>图表数据格式异常或数据不足</div>;
  }
  return (
    <div className={diagramFrame}>
      {state === 'done' && (
        <div className={controls}>
          <button type="button" className={ctrlBtn} onClick={zoomOut} aria-label="缩小">−</button>
          <span className={scaleLabel}>{Math.round(scale * 100)}%</span>
          <button type="button" className={ctrlBtn} onClick={zoomIn} aria-label="放大">+</button>
          <button type="button" className={ctrlBtn} onClick={reset} aria-label="重置">⟲</button>
        </div>
      )}
      <div className={scrollArea}>
        {state === 'loading' && <div className={msg}>渲染中…</div>}
        <div
          ref={elRef}
          className={svgWrap}
          style={{ cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </div>
    </div>
  );
}

// ── CollapsibleDiagram：封装 toggle + 图表，三视图复用 ──

const diagramWrap = css`
  margin-bottom: 1.5rem;
`;

const toggleBar = css`
  display: flex;
  align-items: center;
  gap: 0.4rem;
  background: none;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.35rem 0.8rem;
  font-size: 0.82rem;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  margin-bottom: 0.5rem;
  &:hover {
    color: var(--haze-color-text);
    border-color: var(--haze-color-primary);
  }
`;

/**
 * 可折叠图表：chart 为 null 时整体不渲染（数据不足）。
 * defaultShow 控制初始展开状态（默认 true）；视点轮换分块时首块展开、其余折叠。
 */
export function CollapsibleDiagram({ chart, title, defaultShow = true }: { chart: string | null; title: string; defaultShow?: boolean }) {
  const [show, setShow] = useState(defaultShow);
  if (!chart) return null;
  return (
    <div className={diagramWrap}>
      <button type="button" className={toggleBar} onClick={() => setShow(!show)}>
        {show ? '▾' : '▸'} {title}
      </button>
      {show && <MermaidDiagram chart={chart} />}
    </div>
  );
}
