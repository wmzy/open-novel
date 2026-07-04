import { describe, it, expect } from 'vitest';

import {
  buildForeshadowGantt,
  buildRelationshipGraph,
  buildArcDiagram,
  buildPovTimeline,
  type ForeshadowItem,
  type CharRelState,
  type OutlineMeta,
} from '../../../src/shared/diagram-builders';
import { parseOutlineMeta, defaultOutlineMeta } from '../../../src/shared/outline-meta';

describe('buildForeshadowGantt', () => {
  it('空数组返回 null', () => {
    expect(buildForeshadowGantt([])).toBeNull();
  });

  it('正常伏笔生成含 section 的 gantt 源码', () => {
    const items: ForeshadowItem[] = [
      { id: 1, content: '半截食指——小时候送剑烫掉的', status: 'resolved', plantedIn: 1, resolvedIn: 6 },
      { id: 2, content: '红绳打结', status: 'planted', plantedIn: 4, resolvedIn: 12 },
      { id: 3, content: '待埋的伏笔', status: 'pending', plantedIn: 8, resolvedIn: 16 },
    ];
    const gantt = buildForeshadowGantt(items);
    expect(gantt).not.toBeNull();
    expect(gantt!).toContain('gantt');
    expect(gantt!).toContain('section 已回收');
    expect(gantt!).toContain('section 待回收');
    expect(gantt!).toContain('section 待埋');
    // resolved 的 start=1 dur=5
    expect(gantt!).toContain('f1, 1, 5');
    // pending 标记为 crit
    expect(gantt!).toContain('crit');
  });

  it('待埋伏笔无 resolvedIn 时 dur 延伸到最大章节', () => {
    const items: ForeshadowItem[] = [
      { id: 1, content: '短伏笔', status: 'pending', plantedIn: 3, resolvedIn: 20 },
    ];
    const gantt = buildForeshadowGantt(items);
    expect(gantt).toContain('f1, 3, 17'); // 20-3=17
  });

  it('长内容标签被截断', () => {
    const long = '这是一段非常非常非常非常非常非常非常非常长的伏笔描述文字不应该全部显示';
    const items: ForeshadowItem[] = [
      { id: 1, content: long, status: 'pending', plantedIn: 1, resolvedIn: 10 },
    ];
    const gantt = buildForeshadowGantt(items)!;
    // label 被 sanitize 截断到 ≤15 字符（含省略号）
    const taskLine = gantt.split('\n').find((l) => l.includes(':crit'))!;
    const label = taskLine.split(' :crit')[0].trim();
    expect(label.length).toBeLessThanOrEqual(15);
  });
});

describe('buildRelationshipGraph', () => {
  it('空角色数组返回 null', () => {
    expect(buildRelationshipGraph([])).toBeNull();
  });

  it('全空 relationships 返回 null', () => {
    const chars: CharRelState[] = [{ name: '林冲', relationships: {} }];
    expect(buildRelationshipGraph(chars)).toBeNull();
  });

  it('正常关系生成 graph LR 并包含边', () => {
    const chars: CharRelState[] = [
      { name: '林冲', relationships: { 孙二娘: '脆弱的盟友', 宋江: '被隐瞒真相' } },
      { name: '孙二娘', relationships: { 林冲: '亦敌亦友' } },
    ];
    const graph = buildRelationshipGraph(chars);
    expect(graph).not.toBeNull();
    expect(graph!).toContain('graph LR');
    // 节点声明
    expect(graph!).toContain('("林冲")');
    expect(graph!).toContain('("孙二娘")');
    expect(graph!).toContain('("宋江")');
    // 边
    expect(graph!).toContain('脆弱的盟友');
    expect(graph!).toContain('亦敌亦友');
  });

  it('关系描述含特殊字符被清理', () => {
    const chars: CharRelState[] = [
      { name: 'A', relationships: { B: '冒号:测试<>管道|' } },
    ];
    const graph = buildRelationshipGraph(chars)!;
    // sanitize 应移除 <> | : 等会破坏 mermaid 语法的字符
    expect(graph).not.toContain('测试<>');
    expect(graph).not.toContain('管道|');
  });
});

describe('buildArcDiagram', () => {
  it('空 chapters 返回 null', () => {
    expect(buildArcDiagram({ actBreaks: [5, 15], chapters: [] })).toBeNull();
  });

  it('生成三幕 subgraph', () => {
    const meta: OutlineMeta = { actBreaks: [5, 15], chapters: Array.from({ length: 20 }, (_, i) => ({ chapter: i + 1, pov: '林冲' })) };
    const arc = buildArcDiagram(meta);
    expect(arc).not.toBeNull();
    expect(arc!).toContain('第一幕 · 设置');
    expect(arc!).toContain('第二幕 · 对抗');
    expect(arc!).toContain('第三幕 · 解决');
    expect(arc!).toContain('第 1–5 章');
    expect(arc!).toContain('第 6–15 章');
    expect(arc!).toContain('第 16–20 章');
  });

  it('第二幕够宽时包含中点转折', () => {
    const meta: OutlineMeta = { actBreaks: [5, 15], chapters: Array.from({ length: 20 }, (_, i) => ({ chapter: i + 1, pov: 'X' })) };
    const arc = buildArcDiagram(meta)!;
    expect(arc).toContain('中点转折');
    expect(arc).toContain('灵魂黑夜');
  });

  it('第二幕极窄时省略中点转折', () => {
    const meta: OutlineMeta = { actBreaks: [3, 5], chapters: Array.from({ length: 8 }, (_, i) => ({ chapter: i + 1, pov: 'X' })) };
    const arc = buildArcDiagram(meta)!;
    expect(arc).not.toContain('中点转折');
  });
});

describe('buildPovTimeline', () => {
  it('全空 pov 返回 null', () => {
    const meta: OutlineMeta = { actBreaks: [2, 4], chapters: [{ chapter: 1, pov: '' }, { chapter: 2, pov: '' }] };
    expect(buildPovTimeline(meta)).toBeNull();
  });

  it('无 chapters 返回 null', () => {
    expect(buildPovTimeline({ actBreaks: [2, 4], chapters: [] })).toBeNull();
  });

  it('短书（≤30章）返回单块，标题含范围', () => {
    const meta: OutlineMeta = {
      actBreaks: [2, 4],
      chapters: [
        { chapter: 1, pov: '林冲' },
        { chapter: 2, pov: '林冲' },
        { chapter: 3, pov: '孙二娘' },
        { chapter: 4, pov: '林冲' },
      ],
    };
    const chunks = buildPovTimeline(meta)!;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toBe('视点轮换（1-4章）');
    expect(chunks[0].chart).toContain('graph LR');
    expect(chunks[0].chart).toContain('ch1');
    expect(chunks[0].chart).toContain('ch1 --> ch2');
    // 两个 pov → 两组 classDef
    expect((chunks[0].chart.match(/classDef/g) || []).length).toBe(2);
  });

  it('长书按三幕断点分块，每块不超过 maxPerChunk', () => {
    // 50 章，断点 [15, 30]，三幕：1-15 / 16-30 / 31-50
    const meta: OutlineMeta = {
      actBreaks: [15, 30],
      chapters: Array.from({ length: 50 }, (_, i) => ({ chapter: i + 1, pov: i % 2 === 0 ? '甲' : '乙' })),
    };
    const chunks = buildPovTimeline(meta, 10)!;
    // 第一幕 15章→2块(10+5)，第二幕 15章→2块，第三幕 20章→2块 = 6块
    expect(chunks).toHaveLength(6);
    expect(chunks[0].title).toBe('第一幕（1-10章）');
    expect(chunks[1].title).toBe('第一幕（11-15章）');
    expect(chunks[2].title).toBe('第二幕（16-25章）');
    expect(chunks[5].title).toBe('第三幕（41-50章）');
    // 每块节点数 ≤ maxPerChunk
    for (const c of chunks) {
      const nodeCount = (c.chart.match(/^    ch\d+\(/gm) || []).length;
      expect(nodeCount).toBeLessThanOrEqual(10);
    }
  });

  it('着色全局一致——同一角色在所有块中颜色索引相同', () => {
    const meta: OutlineMeta = {
      actBreaks: [10, 20],
      chapters: Array.from({ length: 40 }, (_, i) => ({ chapter: i + 1, pov: ['甲', '乙', '丙'][i % 3] })),
    };
    const chunks = buildPovTimeline(meta, 10)!;
    // 甲在所有块中应为 pov0（fill:#0ea5e9）
    for (const c of chunks) {
      if (c.chart.includes('pov0')) {
        expect(c.chart).toContain('fill:#0ea5e9');
      }
    }
  });

  it('某幕断点越界（超过实际章数）时安全过滤', () => {
    // 只有 20 章，但 actBreaks=[50,80] 越界
    const meta: OutlineMeta = {
      actBreaks: [50, 80],
      chapters: Array.from({ length: 20 }, (_, i) => ({ chapter: i + 1, pov: '甲' })),
    };
    const chunks = buildPovTimeline(meta)!;
    // 20 章 ≤ 30 → 单块
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chart).toContain('ch1');
    expect(chunks[0].chart).toContain('ch20');
  });
});

describe('parseOutlineMeta', () => {
  it('合法 JSON 正确解析', () => {
    const raw = { actBreaks: [5, 15], chapters: [{ chapter: 1, pov: '林冲' }, { chapter: 2, pov: '孙二娘' }] };
    const meta = parseOutlineMeta(raw);
    expect(meta).not.toBeNull();
    expect(meta!.actBreaks).toEqual([5, 15]);
    expect(meta!.chapters.length).toBe(2);
  });

  it('缺 actBreaks 返回 null', () => {
    expect(parseOutlineMeta({ chapters: [] })).toBeNull();
  });

  it('chapters 非数组返回 null', () => {
    expect(parseOutlineMeta({ actBreaks: [5, 15], chapters: 'nope' })).toBeNull();
  });

  it('非对象返回 null', () => {
    expect(parseOutlineMeta('nope')).toBeNull();
    expect(parseOutlineMeta(null)).toBeNull();
  });
});

describe('defaultOutlineMeta', () => {
  it('20 章生成合理三幕边界', () => {
    const meta = defaultOutlineMeta(20);
    expect(meta.actBreaks[0]).toBe(5); // round(20*0.25)=5
    expect(meta.actBreaks[1]).toBe(15); // act3Start=16, act2End=15
    expect(meta.chapters.length).toBe(20);
    expect(meta.chapters[0]).toEqual({ chapter: 1, pov: '' });
  });

  it('小章节数每幕至少 1 章', () => {
    const meta = defaultOutlineMeta(4);
    expect(meta.actBreaks[0]).toBeGreaterThanOrEqual(1);
    expect(meta.actBreaks[1]).toBeGreaterThan(meta.actBreaks[0]);
    expect(meta.chapters.length).toBe(4);
  });
});
