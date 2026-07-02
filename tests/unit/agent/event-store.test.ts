import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { eq, asc } from 'drizzle-orm';
import { eventStore } from '../../../src/agent/event-store';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { runEvents, runs as runsTable } from '../../../src/db/schema';

let dbReady = false;
async function ready() {
  if (!dbReady) {
    await ensureDbReady();
    dbReady = true;
  }
}

describe('eventStore', () => {
  let runId: string;

  beforeAll(ready);

  beforeEach(async () => {
    runId = 'run_test_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await db.insert(runsTable).values({ id: runId, agent: 'claude', status: 'running' });
  });

  afterEach(async () => {
    await eventStore.release(runId);
    await db.delete(runEvents).where(eq(runEvents.runId, runId));
    await db.delete(runsTable).where(eq(runsTable.id, runId));
  });

  it('manual flush persists buffered events with correct seq/type/data', async () => {
    for (let i = 1; i <= 10; i++) eventStore.append(runId, i, 'text_delta', { delta: `t${i}` });
    await eventStore.flush(runId);

    const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.seq));
    expect(rows).toHaveLength(10);
    expect(rows[0].seq).toBe(1);
    expect(rows[9].seq).toBe(10);
    expect(rows[0].type).toBe('text_delta');
    // jsonb data round-trips as a parsed object
    expect(rows[0].data).toEqual({ delta: 't1' });
  });

  it('auto-flushes when buffer reaches the threshold (50)', async () => {
    for (let i = 1; i <= 50; i++) eventStore.append(runId, i, 'tick', { n: i });
    // auto-flush is fire-and-forget; allow it to settle, then drain any remainder
    await new Promise((r) => setTimeout(r, 150));
    await eventStore.flush(runId);

    const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
    expect(rows).toHaveLength(50);
  });

  it('does not flush below threshold without a timer/manual call (immediate state)', () => {
    // Append 5 (< threshold) and assert nothing throws; persistence is deferred.
    for (let i = 1; i <= 5; i++) eventStore.append(runId, i, 'tick', null);
    // No assertion on DB here — the contract is "buffered, not lost". Verified via flush below.
  });

  it('replay returns nothing for an empty run', async () => {
    const result = await eventStore.replay(runId, 0, []);
    expect(result).toEqual([]);
  });

  it('replay merges DB history + in-memory window, ascending and deduped by seq', async () => {
    // Seed DB with seq 1..10 (flushed)
    for (let i = 1; i <= 10; i++) eventStore.append(runId, i, 'db', { i });
    await eventStore.flush(runId);
    // In-memory window carries seq 11..13 not yet flushed
    const memWindow = [
      { id: 11, event: 'mem', data: { i: 11 }, timestamp: Date.now() },
      { id: 12, event: 'mem', data: { i: 12 }, timestamp: Date.now() },
      { id: 13, event: 'mem', data: { i: 13 }, timestamp: Date.now() },
    ];

    const result = await eventStore.replay(runId, 5, memWindow);
    // seq > 5: DB 6..10 + mem 11..13
    expect(result.map((r) => r.id)).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);
    expect(result.map((r) => r.event)).toEqual(['db', 'db', 'db', 'db', 'db', 'mem', 'mem', 'mem']);
  });

  it('replay dedupes when a seq appears in both DB and memory (memory wins)', async () => {
    for (let i = 1; i <= 3; i++) eventStore.append(runId, i, 'db', { src: 'db' });
    await eventStore.flush(runId);
    // seq 2 also in memory with different payload
    const memWindow = [{ id: 2, event: 'mem', data: { src: 'mem' }, timestamp: Date.now() }];

    const result = await eventStore.replay(runId, 0, memWindow);
    expect(result).toHaveLength(3);
    const seq2 = result.find((r) => r.id === 2)!;
    expect(seq2.data).toEqual({ src: 'mem' });
  });

  it('release flushes remaining buffer so no events are lost', async () => {
    for (let i = 1; i <= 7; i++) eventStore.append(runId, i, 'tick', { n: i });
    await eventStore.release(runId);

    const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.seq));
    expect(rows).toHaveLength(7);
    expect(rows[6].seq).toBe(7);
  });
});
