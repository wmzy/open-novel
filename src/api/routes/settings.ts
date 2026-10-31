import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { userSettings } from '../../db/schema';
import { generateId } from '../../utils/id';
import {
  EMBEDDING_SECRET_SETTING_KEYS,
  EMBEDDING_SETTING_KEYS,
} from '../../shared/semantic';
import { PI_SECRET_SETTING_KEYS } from '../../agent/pi/config';
import { scheduleSemanticReindexAll } from '../../agent/semantic-index';

const settingsRouter = new Hono();

const SECRET_KEYS = new Set<string>([
  ...EMBEDDING_SECRET_SETTING_KEYS,
  ...PI_SECRET_SETTING_KEYS,
]);

/**
 * GET /api/settings
 *
 * 键值设置，密钥类设置（嵌入服务 API Key）永不回显——只返回
 * `embedding_apiKeySet` 布尔字符串，供前端显示「已保存」占位。
 */
settingsRouter.get('/', async (c) => {
  const all = await db.select().from(userSettings);
  const settings: Record<string, string> = {};
  let embeddingKeySet = false;
  let piKeySet = false;
  for (const s of all) {
    if (SECRET_KEYS.has(s.key)) {
      if (s.key === 'pi_api_key') piKeySet = piKeySet || s.value.trim().length > 0;
      else embeddingKeySet = embeddingKeySet || s.value.trim().length > 0;
      continue;
    }
    settings[s.key] = s.value;
  }
  settings.embedding_apiKeySet = embeddingKeySet ? 'true' : 'false';
  settings.pi_apiKeySet = piKeySet ? 'true' : 'false';
  return c.json({ settings });
});

/**
 * PATCH /api/settings
 *
 * 密钥清空约定：`{ "embedding_apiKey": "" }` 删除该设置（而不是存空串），
 * 便于用户彻底移除凭据。
 *
 * 嵌入模型/地址变更后：已有语义索引的向量按旧模型生成，换模型后立即失效
 * （检索会退化为 index-empty、写作期语义回忆为空）。这里调度一次全量重建，
 * 让「换模型」当场生效，而不是等下一次章节同步。
 */
settingsRouter.patch('/', async (c) => {
  const body = await c.req.json();
  let embeddingTargetChanged = false;
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;

    if (SECRET_KEYS.has(key) && String(value).trim() === '') {
      await db.delete(userSettings).where(eq(userSettings.key, key));
      if (key === EMBEDDING_SETTING_KEYS.apiKey) embeddingTargetChanged = true;
      continue;
    }

    const existing = await db.select().from(userSettings).where(eq(userSettings.key, key)).limit(1);
    if (existing.length > 0) {
      if (
        (key === EMBEDDING_SETTING_KEYS.model || key === EMBEDDING_SETTING_KEYS.baseUrl)
        && existing[0].value !== String(value)
      ) {
        embeddingTargetChanged = true;
      }
      await db.update(userSettings).set({ value: String(value) }).where(eq(userSettings.key, key));
    } else {
      await db.insert(userSettings).values({ id: generateId('set_'), key, value: String(value) });
      if (
        key === EMBEDDING_SETTING_KEYS.model
        || key === EMBEDDING_SETTING_KEYS.baseUrl
        || key === EMBEDDING_SETTING_KEYS.apiKey
      ) {
        embeddingTargetChanged = true;
      }
    }
  }
  if (embeddingTargetChanged) scheduleSemanticReindexAll();
  return c.json({ ok: true });
});

export default settingsRouter;
