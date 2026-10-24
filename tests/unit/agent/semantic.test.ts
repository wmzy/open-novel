import { describe, it, expect, vi } from 'vitest';
import {
  chunkText,
  chunkHashesMatch,
  hashText,
  cosineSimilarity,
  normalizeEmbeddingConfig,
  embeddingsEndpoint,
  SEMANTIC_CHUNK_MAX_CHARS,
  type EmbeddingConfig,
} from '../../../src/shared/semantic';
import {
  embedTexts,
  EmbeddingError,
  EMBEDDING_BATCH_SIZE,
} from '../../../src/agent/embeddings';
import { searchSemanticChunks } from '../../../src/agent/semantic-index';

const CONFIG: EmbeddingConfig = {
  baseUrl: 'https://embeddings.example.test/v1',
  model: 'test-embedding',
  apiKey: 'sk-secret-do-not-leak',
};

function vectorFor(text: string): number[] {
  return [
    (text.match(/龙/g) ?? []).length,
    (text.match(/雨/g) ?? []).length,
    (text.match(/剑/g) ?? []).length,
    (text.match(/灯/g) ?? []).length,
  ].map((n) => n + 0.01); // 避免零向量导致余弦为 0
}

function embeddingResponse(inputs: string[]): Response {
  return new Response(JSON.stringify({
    data: inputs.map((input, index) => ({ index, embedding: vectorFor(input) })),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('chunkText', () => {
  it('空文本返回空数组', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('短文本生成单块并给出稳定哈希', () => {
    const chunks = chunkText('# 第一章\n\n宋公明推开门，风雪涌了进来。');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].hash).toBe(hashText(chunks[0].content));
    // 相同内容哈希稳定
    expect(chunkText('# 第一章\n\n宋公明推开门，风雪涌了进来。')[0].hash).toBe(chunks[0].hash);
  });

  it('长文本按段落切块、限制块长并保留重叠', () => {
    const first = '甲'.repeat(300);
    const second = '乙'.repeat(300);
    const chunks = chunkText(`${first}\n\n${second}`, {
      maxChars: 400,
      overlapChars: 60,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(400);
    }
    // 第二块以第一块尾部重叠开头
    expect(chunks[1].content.startsWith('甲'.repeat(60))).toBe(true);
    // 索引连续
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('超长单段按句读边界切分，且不超过块长', () => {
    const text = '风雪很大。'.repeat(400); // 2000 字符，无空行
    const chunks = chunkText(text, { maxChars: SEMANTIC_CHUNK_MAX_CHARS });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(SEMANTIC_CHUNK_MAX_CHARS);
    }
  });

  it('遵守 maxChunks 上限', () => {
    const text = Array.from({ length: 20 }, (_, i) => `第${i}段内容。`).join('\n\n');
    const chunks = chunkText(text, { maxChars: 12, overlapChars: 0, maxChunks: 3 });
    expect(chunks).toHaveLength(3);
  });

  it('内容变化会产生不同哈希（增量索引依据）', () => {
    const a = chunkText('宋公明推门。')[0];
    const b = chunkText('宋公明关门。')[0];
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('chunkHashesMatch（增量索引判定）', () => {
  const chunks = chunkText(`${'甲'.repeat(40)}\n\n${'乙'.repeat(40)}`, {
    maxChars: 50,
    overlapChars: 0,
  });

  it('哈希序列完全一致时返回 true（整章跳过）', () => {
    expect(chunkHashesMatch(chunks.map((c) => c.hash), chunks)).toBe(true);
  });

  it('块数变化 / 任一位置哈希变化时返回 false', () => {
    expect(chunkHashesMatch(chunks.map((c) => c.hash).slice(0, 1), chunks)).toBe(false);

    const changed = [chunks[0], { ...chunks[1], hash: hashText('第二段改写。') }];
    expect(chunkHashesMatch(chunks.map((c) => c.hash), changed)).toBe(false);
  });

  it('顺序变化也视为不一致（按 chunkIndex 位置比较）', () => {
    const reversed = [...chunks].reverse();
    if (chunks.length > 1) {
      expect(chunkHashesMatch(chunks.map((c) => c.hash), reversed)).toBe(false);
    }
  });
});

describe('cosineSimilarity', () => {
  it('相同 / 正交 / 相反向量', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('维度不一致 / 零向量 / 非有限值返回 0', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([1, Number.NaN], [1, 2])).toBe(0);
  });
});

describe('normalizeEmbeddingConfig', () => {
  it('未配置或缺项时返回 null（默认关闭）', () => {
    expect(normalizeEmbeddingConfig({})).toBeNull();
    expect(normalizeEmbeddingConfig({ embedding_baseUrl: 'https://x.test/v1' })).toBeNull();
    expect(normalizeEmbeddingConfig({ embedding_model: 'm' })).toBeNull();
  });

  it('显式关闭时返回 null', () => {
    expect(normalizeEmbeddingConfig({
      embedding_enabled: 'false',
      embedding_baseUrl: 'https://x.test/v1',
      embedding_model: 'm',
    })).toBeNull();
  });

  it('配置完整时归一化尾部斜杠，密钥可省略', () => {
    expect(normalizeEmbeddingConfig({
      embedding_baseUrl: ' https://x.test/v1/ ',
      embedding_model: ' text-embedding-3-small ',
      embedding_apiKey: 'sk-1',
    })).toEqual({
      baseUrl: 'https://x.test/v1',
      model: 'text-embedding-3-small',
      apiKey: 'sk-1',
    });

    expect(normalizeEmbeddingConfig({
      embedding_baseUrl: 'http://localhost:11434/v1',
      embedding_model: 'nomic-embed-text',
    })?.apiKey).toBeNull();
  });

  it('非法 URL 视为未配置', () => {
    expect(normalizeEmbeddingConfig({
      embedding_baseUrl: 'not-a-url',
      embedding_model: 'm',
    })).toBeNull();
  });

  it('endpoint 拼接不重复 /embeddings', () => {
    expect(embeddingsEndpoint('https://x.test/v1')).toBe('https://x.test/v1/embeddings');
    expect(embeddingsEndpoint('https://x.test/v1/')).toBe('https://x.test/v1/embeddings');
    expect(embeddingsEndpoint('https://x.test/v1/embeddings')).toBe('https://x.test/v1/embeddings');
  });
});

describe('searchSemanticChunks 回退原因', () => {
  it('未配置时返回 not-configured（路由回退文本搜索）', async () => {
    const result = await searchSemanticChunks('p1', '龙', { config: null });
    expect(result).toMatchObject({
      configured: false,
      results: [],
      reason: 'not-configured',
    });
  });

  it('嵌入调用失败时返回 embedding-error 且不查询数据库', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    try {
      const result = await searchSemanticChunks('p1', '龙', { config: CONFIG });
      expect(result.configured).toBe(true);
      expect(result.results).toEqual([]);
      expect(result.reason).toBe('embedding-error');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('embedTexts', () => {
  it('发送 OpenAI 兼容请求并按 index 排序返回', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://embeddings.example.test/v1/embeddings');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('test-embedding');
      expect(body.input).toEqual(['龙', '雨']);
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer sk-secret-do-not-leak',
      );
      // 故意倒序返回，验证按 index 排序
      return new Response(JSON.stringify({
        data: [
          { index: 1, embedding: vectorFor('雨') },
          { index: 0, embedding: vectorFor('龙') },
        ],
      }), { status: 200 });
    });

    const vectors = await embedTexts(['龙', '雨'], CONFIG, { fetchImpl: fetchMock });
    expect(vectors).toEqual([vectorFor('龙'), vectorFor('雨')]);
  });

  it('按 batchSize 拆分请求', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return embeddingResponse(body.input);
    });
    const texts = Array.from({ length: EMBEDDING_BATCH_SIZE + 3 }, (_, i) => `龙${i}`);
    const vectors = await embedTexts(texts, CONFIG, { fetchImpl: fetchMock, batchSize: EMBEDDING_BATCH_SIZE });
    expect(vectors).toHaveLength(texts.length);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('HTTP 错误抛出 EmbeddingError，且消息不泄露密钥', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    const err = await embedTexts(['x'], CONFIG, { fetchImpl: fetchMock }).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err.code).toBe('http');
    expect(err.message).toContain('401');
    expect(err.message).not.toContain('sk-secret');
  });

  it('超时抛出 timeout 错误', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'TimeoutError';
          reject(e);
        });
      });
    });
    const err = await embedTexts(['x'], CONFIG, {
      fetchImpl: fetchMock,
      timeoutMs: 10,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err.code).toBe('timeout');
    expect(err.message).not.toContain('sk-secret');
  });

  it('响应数量/维度不合法时抛 invalid-response', async () => {
    const badCount = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await expect(embedTexts(['x'], CONFIG, { fetchImpl: badCount })).rejects.toMatchObject({
      code: 'invalid-response',
    });

    const badDim = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { index: 0, embedding: [1, 2] },
        { index: 1, embedding: [1, 2, 3] },
      ],
    }), { status: 200 }));
    await expect(embedTexts(['x', 'y'], CONFIG, { fetchImpl: badDim })).rejects.toMatchObject({
      code: 'invalid-response',
    });
  });

  it('空输入不发请求', async () => {
    const fetchMock = vi.fn();
    await expect(embedTexts([], CONFIG, { fetchImpl: fetchMock })).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
