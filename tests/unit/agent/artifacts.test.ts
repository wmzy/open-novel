import { describe, it, expect } from 'vitest';
import { collectWrittenPaths, deriveFileOps } from '../../../src/agent/artifacts';
import type { AgentEvent } from '../../../src/agent/types';

describe('collectWrittenPaths', () => {
  it('returns empty set for empty events', () => {
    expect(collectWrittenPaths([])).toEqual(new Set());
  });

  it('collects successful Write tool_use + tool_result', () => {
    const events = [
      { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/project/.novel/chapter-01.md' } },
      { type: 'tool_result', toolUseId: 'tu1', content: '', isError: false },
    ];
    const result = collectWrittenPaths(events);
    expect(result).toEqual(new Set(['/project/.novel/chapter-01.md']));
  });

  it('skips tool_result with isError: true', () => {
    const events = [
      { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/project/.novel/chapter-01.md' } },
      { type: 'tool_result', toolUseId: 'tu1', content: 'error', isError: true },
    ];
    expect(collectWrittenPaths(events)).toEqual(new Set());
  });

  it('skips tool_use with no matching tool_result', () => {
    const events = [
      { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/project/.novel/chapter-01.md' } },
    ];
    expect(collectWrittenPaths(events)).toEqual(new Set());
  });

  it('deduplicates same file written twice', () => {
    const events = [
      { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/project/.novel/chapter-01.md' } },
      { type: 'tool_result', toolUseId: 'tu1', content: '', isError: false },
      { type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: '/project/.novel/chapter-01.md' } },
      { type: 'tool_result', toolUseId: 'tu2', content: '', isError: false },
    ];
    const result = collectWrittenPaths(events);
    expect(result.size).toBe(1);
    expect(result.has('/project/.novel/chapter-01.md')).toBe(true);
  });

  it('ignores read-only tools', () => {
    const events = [
      { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/project/.novel/chapter-01.md' } },
      { type: 'tool_result', toolUseId: 'tu1', content: 'content', isError: false },
    ];
    expect(collectWrittenPaths(events)).toEqual(new Set());
  });

  it('recognizes various write/edit tool names', () => {
    const toolNames = ['Write', 'write', 'Edit', 'edit', 'create_file', 'str_replace_edit', 'MultiEdit', 'multi_edit'];
    for (const name of toolNames) {
      const events = [
        { type: 'tool_use', id: 'tu1', name, input: { file_path: '/test.md' } },
        { type: 'tool_result', toolUseId: 'tu1', content: '', isError: false },
      ];
      const result = collectWrittenPaths(events);
      expect(result.has('/test.md'), `tool name "${name}" should be recognized`).toBe(true);
    }
  });

  it('extracts path from various input shapes', () => {
    const shapes = [
      { file_path: '/a.md' },
      { path: '/b.md' },
      { filename: '/c.md' },
      { file: '/d.md' },
    ];
    for (const input of shapes) {
      const events = [
        { type: 'tool_use', id: 'tu1', name: 'Write', input },
        { type: 'tool_result', toolUseId: 'tu1', content: '', isError: false },
      ];
      const result = collectWrittenPaths(events);
      expect(result.size, `input shape ${JSON.stringify(input)} should extract path`).toBe(1);
    }
  });
});

describe('deriveFileOps', () => {
  it('returns empty array for empty events', () => {
    expect(deriveFileOps([])).toEqual([]);
  });

  it('derives write operations from tool_use + tool_result', () => {
    const events: AgentEvent[] = [
      { kind: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/project/.novel/chapter-01.md' } },
      { kind: 'tool_result', toolUseId: 'tu1', content: '', isError: false },
    ];
    const result = deriveFileOps(events);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/project/.novel/chapter-01.md');
    expect(result[0].opCounts.write).toBe(1);
    expect(result[0].status).toBe('done');
  });

  it('marks running when tool_result is missing', () => {
    const events: AgentEvent[] = [
      { kind: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/project/.novel/chapter-01.md' } },
    ];
    const result = deriveFileOps(events);
    expect(result[0].status).toBe('running');
    expect(result[0].total).toBe(1);
  });

  it('marks error when tool_result has isError', () => {
    const events: AgentEvent[] = [
      { kind: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/project/.novel/chapter-01.md' } },
      { kind: 'tool_result', toolUseId: 'tu1', content: 'error', isError: true },
    ];
    const result = deriveFileOps(events);
    expect(result[0].status).toBe('error');
  });

  it('distinguishes read from write ops', () => {
    const events: AgentEvent[] = [
      { kind: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/project/.novel/concept.md' } },
      { kind: 'tool_result', toolUseId: 'tu1', content: 'content', isError: false },
      { kind: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: '/project/.novel/chapter-01.md' } },
      { kind: 'tool_result', toolUseId: 'tu2', content: '', isError: false },
    ];
    const result = deriveFileOps(events);
    expect(result).toHaveLength(2);
    expect(result[0].opCounts.read).toBe(1);
    expect(result[1].opCounts.write).toBe(1);
  });
});
