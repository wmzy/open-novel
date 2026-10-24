// @vitest-environment node
// fflate 的 zip/unzip 用 instanceof Uint8Array 判定叶子；jsdom 环境下 TextEncoder
// 产出的数组来自 Node realm，会被误判为嵌套对象。本模块是纯 Node 逻辑，用 node 环境。
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { extractEpubText, htmlToPlainText, isZipBytes } from '../../../src/shared/epub-text';

function buildEpub(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return zipSync(entries);
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>山河入梦</dc:title>
  </metadata>
  <manifest>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="ch2"/>
    <itemref idref="ch1"/>
  </spine>
</package>`;

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title><style>.x{color:red}</style></head>
<body><h1>第一章 少年</h1><p>少年正文&nbsp;甲。</p><p>第二段<br/>换行后内容。</p><script>alert('x')</script></body></html>`;

const CH2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第二章 重逢</h1><p>重逢正文乙 &amp; 丙。</p></body></html>`;

describe('extractEpubText', () => {
  it('按 spine 顺序提取纯文本并解析书名', () => {
    const epub = buildEpub({
      'META-INF/container.xml': CONTAINER_XML,
      'OEBPS/content.opf': OPF,
      'OEBPS/text/ch1.xhtml': CH1,
      'OEBPS/text/ch2.xhtml': CH2,
      'OEBPS/nav.xhtml': '<html><body><a href="text/ch1.xhtml">目录</a></body></html>',
    });

    expect(isZipBytes(epub)).toBe(true);
    const result = extractEpubText(epub);

    expect(result.title).toBe('山河入梦');
    // spine 顺序 ch2 → ch1，与文件名顺序相反
    expect(result.text.indexOf('第二章 重逢')).toBeGreaterThanOrEqual(0);
    expect(result.text.indexOf('第二章 重逢')).toBeLessThan(result.text.indexOf('第一章 少年'));
    // HTML 标签/脚本/样式被剔除，实体解码
    expect(result.text).toContain('少年正文 甲。');
    expect(result.text).toContain('第二段\n换行后内容。');
    expect(result.text).toContain('重逢正文乙 & 丙。');
    expect(result.text).not.toContain('<p>');
    expect(result.text).not.toContain('alert');
    expect(result.text).not.toContain('color:red');
    // h1 保留为 Markdown 标题（没有「第N章」标记的 EPUB 也能按标题层级切章）
    expect(result.text).toContain('# 第一章 少年');
    expect(result.text).toContain('# 第二章 重逢');
    // nav 文档不进入正文
    expect(result.text).not.toContain('目录');
  });

  it('缺少 container.xml 时降级按文件名读取并 warning', () => {
    const epub = buildEpub({
      'OEBPS/text/b.xhtml': '<html><body><p>乙章。</p></body></html>',
      'OEBPS/text/a.xhtml': '<html><body><p>甲章。</p></body></html>',
    });
    const result = extractEpubText(epub);
    expect(result.warnings.some((w) => w.includes('container.xml'))).toBe(true);
    expect(result.text.indexOf('甲章。')).toBeLessThan(result.text.indexOf('乙章。'));
  });

  it('没有任何正文文本时抛错', () => {
    const epub = buildEpub({
      'META-INF/container.xml': CONTAINER_XML,
      'OEBPS/content.opf': '<package><metadata><dc:title>x</dc:title></metadata></package>',
    });
    expect(() => extractEpubText(epub)).toThrow('未提取到正文');
  });

  it('拒绝非 ZIP 数据', () => {
    expect(() => extractEpubText(strToU8('not a zip'))).toThrow('解压失败');
  });
});

describe('htmlToPlainText', () => {
  it('块级标签转换行、解码实体、清理空白', () => {
    const html = '<div><p>第一段&#12290;</p><p>第二段&amp;内容</p><h2>标题</h2><ul><li>条目</li></ul></div>';
    const text = htmlToPlainText(html);
    expect(text).toContain('第一段。');
    expect(text).toContain('第二段&内容');
    expect(text).toContain('标题');
    expect(text).toContain('条目');
  });
});
