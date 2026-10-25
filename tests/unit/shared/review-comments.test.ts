/**
 * 行内评论存储（src/shared/review-comments.ts）单测：
 * append-only jsonl 落盘、同 id 后写覆盖、损坏行容忍、尾行残迹防粘连、分组排序。
 * 原子性说明：写入走 fs.appendFile（O_APPEND 单次 write，POSIX 下单行追加原子），
 * 并发追加不丢行——用 Promise.all 并发追加断言无丢失覆盖该性质；
 * 「临时文件+rename」模式对 append-only 日志反而引入读改写窗口，未采用（见模块头注释）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listReviewComments,
  addReviewComment,
  resolveReviewComment,
  commentsByFile,
} from '../../../src/shared/review-comments';
import type { ReviewComment } from '../../../src/shared/review-comments';

let tmpDir: string;

function commentsPath(): string {
  return path.join(tmpDir, '.novel', 'review', 'comments.jsonl');
}

function readLines(): string[] {
  return fs.readFileSync(commentsPath(), 'utf-8').split('\n').filter((l) => l.trim() !== '');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-comments-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('addReviewComment / listReviewComments', () => {
  it('追加 jsonl 行并读回（带/不带行号）', async () => {
    const c1 = await addReviewComment(tmpDir, { file: 'chapters/第1章.md', line: 12, body: '这句节奏太赶' });
    const c2 = await addReviewComment(tmpDir, { file: 'concept.md', body: '整体设定再想想' });

    expect(c1.id).toMatch(/^[0-9a-f]{8}$/);
    expect(c1.resolved).toBe(false);
    expect(c1.author).toBe('user');
    expect(c1.createdAt).toBeTruthy();

    // 落盘为 jsonl：每行一条 JSON 记录
    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ id: c1.id, file: 'chapters/第1章.md', line: 12, body: '这句节奏太赶' });
    expect(JSON.parse(lines[1])).toMatchObject({ id: c2.id, file: 'concept.md' });
    expect(JSON.parse(lines[1]).line).toBeUndefined();

    const list = await listReviewComments(tmpDir);
    expect(list.map((c) => c.id)).toEqual([c1.id, c2.id]);
    expect(list[0]).toMatchObject({ file: 'chapters/第1章.md', line: 12, body: '这句节奏太赶', resolved: false });
    expect(list[1].line).toBeUndefined();
  });

  it('文件不存在时 list 返回空数组', async () => {
    expect(await listReviewComments(tmpDir)).toEqual([]);
  });

  it('连续追加 id 不重复', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add((await addReviewComment(tmpDir, { file: 'a.md', body: `c${i}` })).id);
    }
    expect(ids.size).toBe(50);
    expect((await listReviewComments(tmpDir)).length).toBe(50);
  });

  it('并发追加不丢行（O_APPEND 单写原子）', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => addReviewComment(tmpDir, { file: 'a.md', body: `c${i}` })),
    );
    const list = await listReviewComments(tmpDir);
    expect(list).toHaveLength(20);
    expect(readLines()).toHaveLength(20);
  });
});

describe('resolveReviewComment（jsonl 后写覆盖语义）', () => {
  it('resolve 追加同 id 覆盖记录：读回一条且已解决，历史行保留', async () => {
    const c = await addReviewComment(tmpDir, { file: 'a.md', line: 3, body: 'x' });
    const resolved = await resolveReviewComment(tmpDir, c.id, true);

    expect(resolved).not.toBeNull();
    expect(resolved).toMatchObject({ id: c.id, resolved: true });
    expect(resolved!.resolvedAt).toBeTruthy();

    // jsonl 两行（原始 + 覆盖），读取合并为一条
    expect(readLines()).toHaveLength(2);
    const list = await listReviewComments(tmpDir);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: c.id, resolved: true, resolvedAt: resolved!.resolvedAt });
  });

  it('unresolve 再追加一条：resolved=false 且 resolvedAt 清空', async () => {
    const c = await addReviewComment(tmpDir, { file: 'a.md', body: 'x' });
    await resolveReviewComment(tmpDir, c.id, true);
    const reopened = await resolveReviewComment(tmpDir, c.id, false);

    expect(reopened).toMatchObject({ id: c.id, resolved: false });
    expect(reopened!.resolvedAt).toBeUndefined();

    const list = await listReviewComments(tmpDir);
    expect(list).toHaveLength(1);
    expect(list[0].resolved).toBe(false);
    expect(list[0].resolvedAt).toBeUndefined();
    // 三行历史完整保留（原始 + resolve + unresolve）
    expect(readLines()).toHaveLength(3);
  });

  it('resolve 未知 id 返回 null（不落盘）', async () => {
    expect(await resolveReviewComment(tmpDir, 'deadbeef', true)).toBeNull();
    expect(fs.existsSync(commentsPath())).toBe(false);
  });
});

describe('损坏容忍', () => {
  it('非 JSON 行 / 缺核心字段行 / 空白行跳过，不影响其余', async () => {
    const c = await addReviewComment(tmpDir, { file: 'a.md', body: 'ok' });
    fs.appendFileSync(commentsPath(), 'not-json{{{', 'utf-8'); // 崩溃残迹（无尾换行）
    fs.appendFileSync(commentsPath(), '\n{"id":"broken"}\n\n   \n', 'utf-8'); // 缺 file/body + 空白行
    const c2 = await addReviewComment(tmpDir, { file: 'b.md', body: 'ok2' });

    const list = await listReviewComments(tmpDir);
    expect(list.map((x) => x.id)).toEqual([c.id, c2.id]);
  });

  it('尾行无换行的完整记录不粘连新记录（防重复行尾补齐）', async () => {
    fs.mkdirSync(path.dirname(commentsPath()), { recursive: true });
    // 直接写入一条完整但缺尾换行的记录（模拟上次写入被截断在换行前）
    const partial = JSON.stringify({
      id: 'aa112233', file: 'a.md', body: '完整但无换行', createdAt: '2026-01-01T00:00:00Z', resolved: false,
    });
    fs.writeFileSync(commentsPath(), partial, 'utf-8');

    const c = await addReviewComment(tmpDir, { file: 'a.md', body: '新评论' });

    // 新记录落在独立行上，两条都可读回
    const list = await listReviewComments(tmpDir);
    expect(list.map((x) => x.id)).toEqual(['aa112233', c.id]);
    expect(list[1].body).toBe('新评论');
  });

  it('多行正文（含换行）不破坏 jsonl 行结构', async () => {
    const c = await addReviewComment(tmpDir, { file: 'a.md', body: '第一行\n第二行' });
    expect(readLines()).toHaveLength(1);
    const list = await listReviewComments(tmpDir);
    expect(list[0].body).toBe('第一行\n第二行');
    expect(list[0].id).toBe(c.id);
  });
});

describe('commentsByFile（纯函数）', () => {
  const mk = (id: string, file: string, line: number | undefined, createdAt: string): ReviewComment => ({
    id,
    file,
    ...(line !== undefined ? { line } : {}),
    body: `b-${id}`,
    createdAt,
    resolved: false,
  });

  it('按文件分组；组内行号升序、无行号靠后、同行号按创建时间', () => {
    const comments = [
      mk('a', 'x.md', 10, '2026-01-03T00:00:00Z'),
      mk('b', 'y.md', undefined, '2026-01-01T00:00:00Z'),
      mk('c', 'x.md', 2, '2026-01-02T00:00:00Z'),
      mk('d', 'x.md', 10, '2026-01-01T00:00:00Z'),
      mk('e', 'x.md', undefined, '2026-01-01T00:00:00Z'),
    ];
    const byFile = commentsByFile(comments);
    expect(Object.keys(byFile)).toEqual(['x.md', 'y.md']);
    expect(byFile['x.md'].map((c) => c.id)).toEqual(['c', 'd', 'a', 'e']);
    expect(byFile['y.md'].map((c) => c.id)).toEqual(['b']);
  });

  it('空输入返回空对象', () => {
    expect(commentsByFile([])).toEqual({});
  });
});
