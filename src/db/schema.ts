import { pgTable, varchar, integer, timestamp, index, uniqueIndex, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const projects = pgTable('projects', {
  id: varchar('id', { length: 25 }).primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  path: varchar('path', { length: 500 }).notNull(),
  genre: varchar('genre', { length: 50 }).notNull().default('general'),
  targetWords: integer('target_words').notNull().default(100000),
  chapterCount: integer('chapter_count').notNull().default(20),
  theme: varchar('theme', { length: 500 }),
  perspective: varchar('perspective', { length: 50 }).notNull().default('third-person'),
  currentStage: varchar('current_stage', { length: 50 }).notNull().default('concept'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('projects_created_at_idx').on(table.createdAt),
]);

export const chapters = pgTable('chapters', {
  id: varchar('id', { length: 25 }).primaryKey(),
  projectId: varchar('project_id', { length: 25 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  number: integer('number').notNull(),
  title: varchar('title', { length: 200 }),
  wordCount: integer('word_count').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  uniqueIndex('chapters_project_number_idx').on(table.projectId, table.number),
]);

export const conversations = pgTable('conversations', {
  id: varchar('id', { length: 25 }).primaryKey(),
  projectId: varchar('project_id', { length: 25 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  agentId: varchar('agent_id', { length: 50 }).notNull(),
  stage: varchar('stage', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
});

export const messages = pgTable('messages', {
  id: varchar('id', { length: 25 }).primaryKey(),
  conversationId: varchar('conversation_id', { length: 25 }).notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 20 }).notNull(),
  content: varchar('content', { length: 100000 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
});

export const runs = pgTable('runs', {
  id: varchar('id', { length: 50 }).primaryKey(),
  conversationId: varchar('conversation_id', { length: 25 }).references(() => conversations.id, { onDelete: 'set null' }),
  agent: varchar('agent', { length: 50 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('queued'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
});

export const runEvents = pgTable('run_events', {
  id: varchar('id', { length: 25 }).primaryKey(),
  runId: varchar('run_id', { length: 50 }).notNull().references(() => runs.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  type: varchar('type', { length: 50 }).notNull(),
  data: jsonb('data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  uniqueIndex('run_events_run_seq_idx').on(table.runId, table.seq),
]);

export const userSettings = pgTable('user_settings', {
  id: varchar('id', { length: 25 }).primaryKey(),
  key: varchar('key', { length: 100 }).notNull(),
  value: varchar('value', { length: 5000 }).notNull(),
}, (table) => [
  uniqueIndex('user_settings_key_idx').on(table.key),
]);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Chapter = typeof chapters.$inferSelect;
export type NewChapter = typeof chapters.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
export type UserSetting = typeof userSettings.$inferSelect;
