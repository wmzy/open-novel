/**
 * 文本实体切片纯函数。
 * 把一段纯文本按实体词典切成普通文本段 + 实体引用段的有序数组。
 *
 * 匹配策略：
 *  1. 词典按 name 长度降序（最长优先，解决「林冲」vs「林冲之」）
 *  2. 从左到右扫描正文每个位置，取该位置能匹配的最长词典项
 *  3. 边界规则：仅当实体名首字符是 [A-Za-z] 时检查前导字符是否为 [A-Za-z0-9]（是则拒绝）；
 *     仅当实体名末字符是 [A-Za-z] 时检查后继字符是否为 [A-Za-z0-9]（是则拒绝）。
 *     汉字实体名不做边界检查（汉字不会出现在英文词中间，无误伤风险）。
 *  4. 已匹配区间不再参与后续匹配（左到右扫描天然保证）。
 */
import type { EntityRef } from './entity-dict';

export interface TextSegment {
  /** 普通文本段（与 ref 二选一）。 */
  text?: string;
  /** 命中实体（与 text 二选一）。 */
  ref?: EntityRef;
}

const ALPHA = /[A-Za-z]/;
const ALNUM = /[A-Za-z0-9]/;

/** 边界检查：返回 true 表示允许在此位置匹配。 */
function boundaryOk(text: string, start: number, len: number): boolean {
  const firstChar = text[start];
  const lastChar = text[start + len - 1];
  if (ALPHA.test(firstChar)) {
    if (start > 0 && ALNUM.test(text[start - 1])) return false;
  }
  if (ALPHA.test(lastChar)) {
    if (start + len < text.length && ALNUM.test(text[start + len])) return false;
  }
  return true;
}

export function splitTextByEntities(
  text: string,
  dict: Map<string, EntityRef>,
): TextSegment[] {
  if (dict.size === 0 || text.length === 0) {
    return text.length > 0 ? [{ text }] : [];
  }

  // 按长度降序：最长优先匹配
  const names = Array.from(dict.keys()).sort((a, b) => b.length - a.length);
  const segments: TextSegment[] = [];
  let i = 0;
  let textStart = 0;

  while (i < text.length) {
    let matchedRef: EntityRef | null = null;
    let matchedLen = 0;

    for (const name of names) {
      const len = name.length;
      if (len === 0 || i + len > text.length) continue;
      if (text.startsWith(name, i) && boundaryOk(text, i, len)) {
        matchedRef = dict.get(name)!;
        matchedLen = len;
        break; // names 降序，首个命中即最长
      }
    }

    if (matchedRef) {
      if (i > textStart) segments.push({ text: text.slice(textStart, i) });
      segments.push({ ref: matchedRef });
      i += matchedLen;
      textStart = i;
    } else {
      i++;
    }
  }

  if (textStart < text.length) segments.push({ text: text.slice(textStart) });
  return segments;
}
