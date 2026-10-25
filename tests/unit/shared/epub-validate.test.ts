// @vitest-environment node
// fflate 的 ZIP 构造/解压是纯 Node 逻辑（同 export.test.ts 的环境说明）。
import { describe, it, expect } from 'vitest';
import { strToU8, unzipSync, zipSync, type Unzipped, type Zippable } from 'fflate';
import { buildEpub, validateEpub } from '../../../src/shared/ebook-export';

/** 双章 + 空章名的最小合法输入。 */
const INPUT = {
  id: 'proj_test',
  title: '校验测试书',
  language: 'zh',
  chapters: [
    { number: 1, title: '起风', content: '正文第一段。\n\n第二段。' },
    { number: 2, title: '', content: '第二章正文。' },
  ],
};

/** 以原包为基础重建 ZIP：mimetype 保持首条且 stored，其余默认压缩。 */
function rebuild(zip: Unzipped): Uint8Array {
  const files: Zippable = {
    mimetype: [zip['mimetype'], { level: 0 }],
  };
  for (const [name, data] of Object.entries(zip)) {
    if (name === 'mimetype') continue;
    files[name] = data;
  }
  return zipSync(files, { level: 6 }) as Uint8Array;
}

/** 从原包解出的条目表删除指定条目后重建。 */
function without(...names: string[]): Uint8Array {
  const zip = unzipSync(buildEpub(INPUT));
  for (const name of names) delete zip[name];
  return rebuild(zip);
}

describe('validateEpub', () => {
  it('buildEpub 产物通过校验（契约：生成器与规范一致）', () => {
    const result = validateEpub(buildEpub(INPUT));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('空章节项目（兜底占位 section）同样通过', () => {
    const result = validateEpub(buildEpub({ ...INPUT, chapters: [] }));
    expect(result.ok).toBe(true);
  });

  it('不是 ZIP 时报解析失败', () => {
    const result = validateEpub(strToU8('这不是一个zip文件'));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('ZIP 解析失败');
  });

  it('删除 container.xml 报缺条目', () => {
    const result = validateEpub(without('META-INF/container.xml'));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('缺少 META-INF/container.xml');
  });

  it('删除 spine 引用的章节文件报资源缺失', () => {
    const result = validateEpub(without('OEBPS/text/chapter-2.xhtml'));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('manifest 资源不在包内');
    expect(result.errors.join('\n')).toContain('chapter-2.xhtml');
  });

  it('mimetype 内容错误被检出', () => {
    const zip = unzipSync(buildEpub(INPUT));
    zip['mimetype'] = strToU8('application/epub+zip-wrong');
    const result = validateEpub(rebuild(zip));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('mimetype 内容不是 application/epub+zip');
  });

  it('mimetype 被压缩（非 stored 首条）被检出', () => {
    const zip = unzipSync(buildEpub(INPUT));
    const files: Zippable = { mimetype: zip['mimetype'] }; // 不带 level:0 → deflate
    for (const [name, data] of Object.entries(zip)) {
      if (name !== 'mimetype') files[name] = data;
    }
    const result = validateEpub(zipSync(files, { level: 6 }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('stored');
  });

  it('OPF 去掉 nav 属性时报缺少导航文档', () => {
    const zip = unzipSync(buildEpub(INPUT));
    zip['OEBPS/content.opf'] = strToU8(
      strFrom(zip['OEBPS/content.opf']).replace(' properties="nav"', ''),
    );
    const result = validateEpub(rebuild(zip));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('properties="nav"');
  });

  it('OPF 指向不存在的路径时报 OPF 缺失', () => {
    const zip = unzipSync(buildEpub(INPUT));
    zip['META-INF/container.xml'] = strToU8(
      strFrom(zip['META-INF/container.xml']).replace('OEBPS/content.opf', 'OEBPS/missing.opf'),
    );
    const result = validateEpub(rebuild(zip));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('OPF 文件不在包内');
  });
});

/** 解码辅助（避免在每个用例里重复 import strFromU8）。 */
function strFrom(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
