import { describe, it, expect } from 'vitest';
import { convertSessionUpdate, extractAcpModelInfo, isAcpFailure } from '@/agent/acp-bridge';
import type { StreamEvent } from '@/agent/types';

describe('convertSessionUpdate', () => {
  it('把 agent_message_chunk 文本转为 text_delta', () => {
    const events = convertSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '你好' },
      messageId: 'm1',
    } as any);
    expect(events).toEqual<StreamEvent[]>([
      { type: 'text_delta', delta: '你好' },
    ]);
  });

  it('忽略非文本 agent_message_chunk', () => {
    const events = convertSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image' } as any,
      messageId: 'm1',
    } as any);
    expect(events).toEqual([]);
  });

  it('把 agent_thought_chunk 文本转为 thinking_delta', () => {
    const events = convertSessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '思考中' },
      messageId: 'm2',
    } as any);
    expect(events).toEqual<StreamEvent[]>([
      { type: 'thinking_delta', delta: '思考中' },
    ]);
  });

  it('把 tool_call 转为 tool_use', () => {
    const events = convertSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc1',
      title: 'Read file',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: '/tmp/a.md' },
    } as any);
    expect(events).toEqual<StreamEvent[]>([
      { type: 'tool_use', id: 'tc1', name: 'Read file', input: { path: '/tmp/a.md' } },
    ]);
  });

  it('tool_call 无 title 时用 kind 作 name', () => {
    const events = convertSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc2',
      kind: 'edit',
      status: 'pending',
    } as any);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tool_use', name: 'edit' });
  });

  it('把 completed tool_call_update 转为 tool_result', () => {
    const events = convertSessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'completed',
      rawOutput: '文件内容',
    } as any);
    expect(events).toEqual<StreamEvent[]>([
      { type: 'tool_result', toolUseId: 'tc1', content: '文件内容', isError: false },
    ]);
  });

  it('把 failed tool_call_update 转为 isError=true 的 tool_result', () => {
    const events = convertSessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc3',
      status: 'failed',
      rawOutput: { error: 'not found' },
    } as any);
    expect(events).toEqual<StreamEvent[]>([
      { type: 'tool_result', toolUseId: 'tc3', content: JSON.stringify({ error: 'not found' }), isError: true },
    ]);
  });

  it('忽略 in_progress 的 tool_call_update（不发 tool_result）', () => {
    const events = convertSessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'in_progress',
    } as any);
    expect(events).toEqual([]);
  });

  it('忽略 plan 等无关 sessionUpdate', () => {
    expect(convertSessionUpdate({ sessionUpdate: 'plan' } as any)).toEqual([]);
  });

  it('把 usage_update 转为 runtime_usage 事件（含 cost）', () => {
    const events = convertSessionUpdate({
      sessionUpdate: 'usage_update',
      used: 12500,
      size: 200000,
      cost: { amount: 0.05, currency: 'USD' },
    } as any);
    expect(events).toEqual([
      { type: 'runtime_usage', used: 12500, size: 200000, costUsd: 0.05 },
    ]);
  });

  it('usage_update 无 cost 时 costUsd 为 null', () => {
    const events = convertSessionUpdate({
      sessionUpdate: 'usage_update',
      used: 500,
      size: 1000,
    } as any);
    expect(events).toEqual([
      { type: 'runtime_usage', used: 500, size: 1000, costUsd: null },
    ]);
  });

  it('把 available_commands_update 转为 commands 事件', () => {
    const events = convertSessionUpdate({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'compact', description: '压缩对话历史', input: { hint: '[mode]' } },
        { name: 'model', description: '切换模型' },
      ],
    } as any);
    expect(events).toEqual<StreamEvent[]>([
      {
        type: 'commands',
        commands: [
          { name: 'compact', description: '压缩对话历史', inputHint: '[mode]' },
          { name: 'model', description: '切换模型', inputHint: undefined },
        ],
      },
    ]);
  });
});

describe('extractAcpModelInfo', () => {
  it('从 category=model 的 select 提取模型列表', () => {
    const info = extractAcpModelInfo([
      {
        id: 'mode',
        name: 'Mode',
        type: 'select',
        category: 'mode',
        currentValue: 'agent',
        options: [{ value: 'agent', name: 'Agent' }],
      },
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        category: 'model',
        currentValue: 'sensenova/deepseek-v4-flash',
        options: [
          { value: 'sensenova/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { value: 'zhipu/glm-5.2', name: 'GLM 5.2' },
        ],
      },
    ] as any);
    expect(info).not.toBeNull();
    expect(info!.configId).toBe('model');
    expect(info!.currentModelId).toBe('sensenova/deepseek-v4-flash');
    expect(info!.models).toEqual([
      { id: 'sensenova/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'zhipu/glm-5.2', label: 'GLM 5.2' },
    ]);
  });

  it('也识别 category=model_config', () => {
    const info = extractAcpModelInfo([
      {
        id: 'mdl',
        name: 'Model',
        type: 'select',
        category: 'model_config',
        currentValue: 'a',
        options: [{ value: 'a', name: 'A' }],
      },
    ] as any);
    expect(info?.configId).toBe('mdl');
  });

  it('展开分组的 options（group/name 格式）', () => {
    const info = extractAcpModelInfo([
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        category: 'model',
        currentValue: 'anthropic/sonnet',
        options: [
          {
            group: 'anthropic',
            name: 'Anthropic',
            options: [
              { value: 'anthropic/sonnet', name: 'Sonnet' },
              { value: 'anthropic/opus', name: 'Opus' },
            ],
          },
        ],
      },
    ] as any);
    expect(info?.models).toEqual([
      { id: 'anthropic/sonnet', label: 'Anthropic / Sonnet' },
      { id: 'anthropic/opus', label: 'Anthropic / Opus' },
    ]);
  });

  it('无 model category 时返回 null', () => {
    expect(extractAcpModelInfo([
      { id: 'mode', name: 'Mode', type: 'select', category: 'mode', currentValue: 'a', options: [] },
    ] as any)).toBeNull();
  });

  it('configOptions 为 null/空时返回 null', () => {
    expect(extractAcpModelInfo(null)).toBeNull();
    expect(extractAcpModelInfo([])).toBeNull();
    expect(extractAcpModelInfo(undefined)).toBeNull();
  });

  it('忽略 boolean 类型的 config option', () => {
    expect(extractAcpModelInfo([
      { id: 'model', name: 'Model', type: 'boolean', category: 'model', currentValue: true },
    ] as any)).toBeNull();
  });
});

/**
 * isAcpFailure：判定 ACP 会话的 stopReason 是否为显式失败。
 *
 * 核心语义：只有 refusal / max_turn_requests / error 是显式失败；
 * null（close 在 runAcpTurn resolve 前触发，如 timeout/进程退出）按非失败处理，
 * 避免误丢已产生的 agent 响应。
 */
describe('isAcpFailure', () => {
  it('null（未决态）不算失败——close 競态时不误丢响应', () => {
    expect(isAcpFailure(null)).toBe(false);
  });

  it('undefined 不算失败', () => {
    expect(isAcpFailure(undefined)).toBe(false);
  });

  it('end_turn 是正常成功', () => {
    expect(isAcpFailure('end_turn')).toBe(false);
  });

  it('max_tokens 不算失败（有输出）', () => {
    expect(isAcpFailure('max_tokens')).toBe(false);
  });

  it('stopped 不算失败', () => {
    expect(isAcpFailure('stopped')).toBe(false);
  });

  it('refusal 是显式失败', () => {
    expect(isAcpFailure('refusal')).toBe(true);
  });

  it('max_turn_requests 是显式失败', () => {
    expect(isAcpFailure('max_turn_requests')).toBe(true);
  });

  it('error 是显式失败', () => {
    expect(isAcpFailure('error')).toBe(true);
  });
});
