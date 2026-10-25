// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildExtractionPrompt,
  extractBalancedJson,
  extractCanonChanges,
  parseExtractedChanges,
} from '../../../src/agent/canon-extractor';
import { appendCanonChanges, canonChangesFilePath, readCanon } from '../../../src/shared/canon';

let projectDir: string;

/** 合法变更载荷（第二条 fact 的 subject「幽州军」不在实体表 → 产生 warning，用于透传断言）。 */
const VALID_CHANGES = JSON.stringify({
  entities: [{ name: '沈青梧', type: 'character', description: '北境药师，左臂有旧伤' }],
  facts: [
    { subject: '沈青梧', predicate: '效力于', object: '幽州军' },
    { subject: '幽州军', predicate: '驻地', object: '北境孤城' },
  ],
  knowledge: { 沈青梧: { knows: ['主帅已阵亡'], doesNotKnow: ['幕后主使身份'] } },
});

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-extract-'));
});

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
});

describe('buildExtractionPrompt', () => {
  it('包含章号、正文与现有实体名列表', () => {
    const prompt = buildExtractionPrompt(7, '沈青梧推门而入。', ['林青', '苏晚']);
    expect(prompt).toContain('第 7 章');
    expect(prompt).toContain('沈青梧推门而入。');
    expect(prompt).toContain('林青、苏晚');
    expect(prompt).toContain('只输出一个 JSON 对象');
  });

  it('实体名为空时说明可自建新实体', () => {
    const prompt = buildExtractionPrompt(1, '正文', []);
    expect(prompt).toContain('可自建新实体');
    expect(prompt).not.toContain('现有 canon 实体名');
  });

  it('超长正文截断为头 8000 + 尾 4000 并加省略标记', () => {
    const head = '头'.repeat(9000);
    const tail = '尾'.repeat(5000);
    const prompt = buildExtractionPrompt(2, head + tail, []);
    expect(prompt).toContain('（中间内容省略）');
    expect(prompt).not.toContain('头'.repeat(8001));
    expect(prompt).toContain('头'.repeat(8000));
    expect(prompt).toContain('尾'.repeat(4000));
    expect(prompt).not.toContain('尾'.repeat(4001));
  });
});

describe('extractBalancedJson / parseExtractedChanges', () => {
  it('从围栏与前后杂文中取第一个平衡对象', () => {
    const raw = '好的，以下是提取结果：\n```json\n' + VALID_CHANGES + '\n```\n以上供参考。';
    expect(extractBalancedJson(raw)).toBe(VALID_CHANGES);
    expect(parseExtractedChanges(raw)?.entities).toHaveLength(1);
  });

  it('字符串字面量内的花括号不干扰括号计数', () => {
    const raw = '{"facts":[{"subject":"甲","predicate":"持有","object":"刻着{密文}的铜牌"}]}';
    expect(extractBalancedJson(raw)).toBe(raw);
    expect(parseExtractedChanges(raw)?.facts).toHaveLength(1);
  });

  it('无花括号 / 括号不平衡 / 非对象 JSON 均返回 null', () => {
    expect(extractBalancedJson('没有任何对象')).toBeNull();
    expect(extractBalancedJson('前缀 {"a":1')).toBeNull();
    expect(parseExtractedChanges('["数组"]')).toBeNull();
    expect(parseExtractedChanges('```json\n{"entities": ')).toBeNull();
  });

  it('字段形状非法的段落被丢弃，其余保留', () => {
    const changes = parseExtractedChanges('{"entities":"不是数组","facts":[{"subject":"甲","predicate":"是","object":"主帅"}]}');
    expect(changes?.entities).toBeUndefined();
    expect(changes?.facts).toHaveLength(1);
  });
});

describe('extractCanonChanges', () => {
  it('合法 JSON → 写回台账 + changes.jsonl 一行，warnings 透传', async () => {
    const result = await extractCanonChanges({
      projectDir,
      chapter: 3,
      content: '沈青梧效力幽州军。',
      call: async () => VALID_CHANGES,
    });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.entities).toBe(1);
    expect(result.facts).toBe(2);
    expect(result.knowledge).toBe(1);
    // 第二条 fact 的 subject「幽州军」不在实体表 → appendCanonChanges 的 warning 透传
    expect(result.warnings.some((w) => w.includes('幽州军'))).toBe(true);

    const ledger = await readCanon(projectDir);
    expect(ledger.entities.map((e) => e.name)).toContain('沈青梧');
    expect(ledger.facts.some((f) => f.subject === '沈青梧' && f.predicate === '效力于')).toBe(true);
    expect(ledger.knowledge['沈青梧']?.knows).toContain('主帅已阵亡');

    const log = await fs.readFile(canonChangesFilePath(projectDir), 'utf-8');
    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).chapter).toBe(3);
  });

  it('围栏包裹 / 前后杂文的输出同样可解析写回', async () => {
    const fenced = await extractCanonChanges({
      projectDir,
      chapter: 1,
      content: '正文',
      call: async () => '```json\n' + VALID_CHANGES + '\n```',
    });
    expect(fenced.ok).toBe(true);
    expect(fenced.applied).toBe(true);

    const noisy = await extractCanonChanges({
      projectDir,
      chapter: 2,
      content: '正文',
      call: async () => '提取完成：\n' + VALID_CHANGES + '\n如需调整请告知。',
    });
    expect(noisy.ok).toBe(true);
    expect(noisy.applied).toBe(true);
    // 两次提取：第二次同 subject/predicate 的事实 supersede 旧的（保留历史），共 4 条、2 条 active
    const ledger = await readCanon(projectDir);
    expect(ledger.facts).toHaveLength(4);
    expect(ledger.facts.filter((f) => f.status === 'active')).toHaveLength(2);
  });

  it('非法 JSON → ok:false 不写盘不抛出', async () => {
    const result = await extractCanonChanges({
      projectDir,
      chapter: 5,
      content: '正文',
      call: async () => '抱歉，我无法完成提取。',
    });
    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.error).toBeTruthy();
    await expect(fs.access(canonChangesFilePath(projectDir))).rejects.toThrow();
    expect((await readCanon(projectDir)).entities).toHaveLength(0);
  });

  it('空变更（三段全空/空对象）→ ok:true 且不写盘', async () => {
    for (const emptyPayload of ['{}', '{"entities":[],"facts":[],"knowledge":{}}']) {
      const result = await extractCanonChanges({
        projectDir,
        chapter: 4,
        content: '正文',
        call: async () => emptyPayload,
      });
      expect(result.ok).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.entities).toBe(0);
    }
    await expect(fs.access(canonChangesFilePath(projectDir))).rejects.toThrow();
  });

  it('call 抛出异常 → 折叠为 ok:false 绝不抛出', async () => {
    const result = await extractCanonChanges({
      projectDir,
      chapter: 6,
      content: '正文',
      call: async () => { throw new Error('Pi 不可用'); },
    });
    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.error).toContain('Pi 不可用');
  });

  it('call 收到 projectDir 作为 cwd 与显式 timeoutMs', async () => {
    const seen: { cwd?: string; timeoutMs?: number } = {};
    await extractCanonChanges({
      projectDir,
      chapter: 1,
      content: '正文',
      timeoutMs: 1234,
      call: async (prompt, cwd, timeoutMs) => {
        seen.cwd = cwd;
        seen.timeoutMs = timeoutMs;
        expect(prompt).toContain('第 1 章');
        return '{}';
      },
    });
    expect(seen.cwd).toBe(projectDir);
    expect(seen.timeoutMs).toBe(1234);
  });

  it('prompt 注入已有实体名（第二次提取对齐命名）', async () => {
    await appendCanonChanges(projectDir, {
      entities: [{ name: '林青', type: 'character' }],
    }, 1);
    let captured = '';
    await extractCanonChanges({
      projectDir,
      chapter: 2,
      content: '正文',
      call: async (prompt) => {
        captured = prompt;
        return '{}';
      },
    });
    expect(captured).toContain('林青');
  });
});
