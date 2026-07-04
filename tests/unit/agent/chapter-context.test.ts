import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractChapterOutline } from '../../../src/agent/chapter-context';

describe('extractChapterOutline', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-cc-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function writeOutline(content: string) {
    await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
    await fs.writeFile(path.join(dir, '.novel', 'outline-detailed.md'), content, 'utf-8');
  }

  it('extracts a single chapter block by anchor', async () => {
    await writeOutline(`# 卷一

#### 第1章：启程前夜
| POV | 武松 |
| 核心事件 | 磨剑 |

#### 第2章：下山
| POV | 武松 |
| 核心事件 | 下山 |`);
    const block = await extractChapterOutline(dir, 1);
    expect(block).toContain('第1章');
    expect(block).toContain('磨剑');
    expect(block).not.toContain('下山');
  });

  it('matches range chapters (第16-17章)', async () => {
    await writeOutline(`#### 第16-17章：江湖初涉
| POV | 武松 |
| 核心事件 | 接触江湖 |`);
    expect(await extractChapterOutline(dir, 16)).toContain('江湖初涉');
    expect(await extractChapterOutline(dir, 17)).toContain('江湖初涉');
  });

  it('matches wider range (第27-30章)', async () => {
    await writeOutline(`#### 第27-30章：棋局
| POV | 世子 |`);
    expect(await extractChapterOutline(dir, 29)).toContain('棋局');
  });

  it('returns placeholder when chapter not found', async () => {
    await writeOutline(`#### 第1章：a\n| POV | x |`);
    const block = await extractChapterOutline(dir, 99);
    expect(block).toContain('未在 outline-detailed.md 中规划');
  });

  it('returns empty string when outline file missing', async () => {
    const block = await extractChapterOutline(dir, 1);
    expect(block).toBe('');
  });
});
