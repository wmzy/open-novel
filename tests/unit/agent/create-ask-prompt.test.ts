import { describe, it, expect } from 'vitest';
import { createAskPrompt } from '../../../src/agent/acp-bridge';

/**
 * createAskPrompt：从 ACP elicitation/create 请求参数构建 AskPrompt。
 * 纯函数，测 4 种 schema.type 映射 + 降级。
 */
describe('createAskPrompt', () => {
  it('string + enum → select（单选）', () => {
    const ask = createAskPrompt('选一个角色', {
      properties: { value: { type: 'string', enum: ['武松', '何九叔'] } },
    });
    expect(ask.kind).toBe('select');
    expect(ask.options).toEqual(['武松', '何九叔']);
    expect(ask.message).toBe('选一个角色');
  });

  it('string + oneOf[].const → select（单选）', () => {
    const ask = createAskPrompt('选择', {
      properties: {
        value: {
          type: 'string',
          oneOf: [{ const: 'A' }, { const: 'B' }, { const: 'C' }],
        },
      },
    });
    expect(ask.kind).toBe('select');
    expect(ask.options).toEqual(['A', 'B', 'C']);
  });

  it('string 无 enum → input（文本输入）', () => {
    const ask = createAskPrompt('角色名', {
      properties: { value: { type: 'string', description: '请输入角色名' } },
    });
    expect(ask.kind).toBe('input');
    expect(ask.placeholder).toBe('请输入角色名');
  });

  it('boolean → confirm（确认）', () => {
    const ask = createAskPrompt('确认删除？', {
      properties: { value: { type: 'boolean' } },
    });
    expect(ask.kind).toBe('confirm');
  });

  it('array → multiselect（多选）', () => {
    const ask = createAskPrompt('选择多个标签', {
      properties: {
        value: {
          type: 'array',
          items: { type: 'string', enum: ['悲壮', '热血', '权谋'] },
        },
      },
    });
    expect(ask.kind).toBe('multiselect');
    expect(ask.optionsMulti).toEqual(['悲壮', '热血', '权谋']);
  });

  it('未知类型降级为 input', () => {
    const ask = createAskPrompt('问题', {
      properties: { value: { type: 'number' } },
    });
    expect(ask.kind).toBe('input');
  });

  it('requestedSchema 为 null 降级为 input', () => {
    const ask = createAskPrompt('问题', null);
    expect(ask.kind).toBe('input');
  });

  it('无 value 属性降级为 input', () => {
    const ask = createAskPrompt('问题', { properties: {} });
    expect(ask.kind).toBe('input');
  });

  it('每次生成唯一 askId', () => {
    const a = createAskPrompt('q', { properties: { value: { type: 'boolean' } } });
    const b = createAskPrompt('q', { properties: { value: { type: 'boolean' } } });
    expect(a.askId).toBeTruthy();
    expect(b.askId).toBeTruthy();
    expect(a.askId).not.toBe(b.askId);
  });
});
