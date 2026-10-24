import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { userSettings } from '../../db/schema';
import { generateId } from '../../utils/id';
import {
  EMBEDDING_SECRET_SETTING_KEYS,
} from '../../shared/semantic';

const settingsRouter = new Hono();

const SECRET_KEYS = new Set<string>(EMBEDDING_SECRET_SETTING_KEYS);

/**
 * GET /api/settings
 *
 * 键值设置，密钥类设置（嵌入服务 API Key）永不回显——只返回
 * `embedding_apiKeySet` 布尔字符串，供前端显示「已保存」占位。
 */
settingsRouter.get('/', async (c) => {
  const all = await db.select().from(userSettings);
  const settings: Record<string, string> = {};
  let apiKeySet = false;
  for (const s of all) {
    if (SECRET_KEYS.has(s.key)) {
      apiKeySet = apiKeySet || s.value.trim().length > 0;
      continue;
    }
    settings[s.key] = s.value;
  }
  settings.embedding_apiKeySet = apiKeySet ? 'true' : 'false';
  return c.json({ settings });
});

/**
 * PATCH /api/settings
 *
 * 密钥清空约定：`{ "embedding_apiKey": "" }` 删除该设置（而不是存空串），
 * 便于用户彻底移除凭据。
 */
settingsRouter.patch('/', async (c) => {
  const body = await c.req.json();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;

    if (SECRET_KEYS.has(key) && String(value).trim() === '') {
      await db.delete(userSettings).where(eq(userSettings.key, key));
      continue;
    }

    const existing = await db.select().from(userSettings).where(eq(userSettings.key, key)).limit(1);
    if (existing.length > 0) {
      await db.update(userSettings).set({ value: String(value) }).where(eq(userSettings.key, key));
    } else {
      await db.insert(userSettings).values({ id: generateId('set_'), key, value: String(value) });
    }
  }
  return c.json({ ok: true });
});

export default settingsRouter;
