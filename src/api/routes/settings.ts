import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { userSettings } from '../../db/schema';
import { generateId } from '../../utils/id';

const settingsRouter = new Hono();

settingsRouter.get('/', async (c) => {
  const all = await db.select().from(userSettings);
  const settings: Record<string, string> = {};
  for (const s of all) settings[s.key] = s.value;
  return c.json({ settings });
});

settingsRouter.patch('/', async (c) => {
  const body = await c.req.json();
  for (const [key, value] of Object.entries(body)) {
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
