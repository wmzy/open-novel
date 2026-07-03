import { useEffect, useRef, useState } from 'react';
import { css } from '@linaria/core';

const wrap = css`
  background: var(--haze-color-bg-secondary);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  padding: 1rem;
  overflow-x: auto;
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
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/**
 * 渲染 mermaid 源码为 SVG。
 * 动态加载 mermaid，渲染失败时降级为提示。
 */
export function MermaidDiagram({ chart }: { chart: string }) {
  const elRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'done' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');

    loadMermaid().then(async (mermaid) => {
      if (cancelled) return;
      try {
        const id = `mmd-${Math.random().toString(36).slice(2, 9)}`;
        const { svg } = await mermaid.render(id, chart);
        if (cancelled) return;
        if (elRef.current) {
          elRef.current.innerHTML = svg;
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

  if (state === 'error') {
    return <div className={msg}>图表数据格式异常或数据不足</div>;
  }
  return (
    <div className={wrap}>
      {state === 'loading' && <div className={msg}>渲染中…</div>}
      <div ref={elRef} />
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
 * 各视图传入 builder 生成的 mermaid 源码即可。
 */
export function CollapsibleDiagram({ chart, title }: { chart: string | null; title: string }) {
  const [show, setShow] = useState(true);
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
