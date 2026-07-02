import fs from 'node:fs/promises';
import path from 'node:path';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chapters } from '../db/schema';
import type { AgentEvent } from './types';

// Tool names that write or edit files (Claude + Codex + MCP variants)
const WRITE_OR_EDIT_TOOL_NAMES = new Set([
  'Write', 'write',
  'Edit', 'edit',
  'create_file', 'create_file_with_text',
  'str_replace_edit', 'str_replace_editor',
  'MultiEdit', 'multi_edit',
  'write_file', 'update_file',
]);

interface ToolResultInfo {
  isError: boolean;
}

interface RunEventLike {
  type?: string;
  [key: string]: unknown;
}

/**
 * Collect distinct file paths that were successfully written/edited during a run.
 * Two-pass algorithm: index tool_results first, then match tool_uses.
 */
export function collectWrittenPaths(events: RunEventLike[]): Set<string> {
  const resultByToolUseId = new Map<string, ToolResultInfo>();

  // Pass 1: Index tool_result events
  for (const ev of events) {
    if (ev.type === 'tool_result' && ev.toolUseId) {
      resultByToolUseId.set(ev.toolUseId as string, {
        isError: ev.isError === true,
      });
    }
  }

  // Pass 2: Match tool_use events with results
  const writtenPaths = new Set<string>();
  for (const ev of events) {
    if (ev.type !== 'tool_use' || !ev.name) continue;
    if (!WRITE_OR_EDIT_TOOL_NAMES.has(ev.name as string)) continue;

    const result = resultByToolUseId.get(ev.id as string);
    if (!result || result.isError) continue;

    const filePath = extractFilePath(ev.input);
    if (filePath) writtenPaths.add(filePath);
  }

  return writtenPaths;
}

function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  // Common tool input shapes
  if (typeof obj.file_path === 'string') return obj.file_path;
  if (typeof obj.path === 'string') return obj.path;
  if (typeof obj.filename === 'string') return obj.filename;
  if (typeof obj.file === 'string') return obj.file;
  return null;
}

// --- Client-side file ops derivation ---

export type FileOpKind = 'read' | 'write' | 'edit';
export type FileOpStatus = 'running' | 'done' | 'error';

export interface FileOpEntry {
  path: string;
  ops: FileOpKind[];
  opCounts: Record<FileOpKind, number>;
  total: number;
  status: FileOpStatus;
}

const READ_TOOL_NAMES = new Set(['Read', 'read', 'read_file', 'view_file']);

/**
 * Derive per-file operation summaries from agent events (client-side).
 */
export function deriveFileOps(events: AgentEvent[]): FileOpEntry[] {
  const byPath = new Map<string, { ops: FileOpKind[]; hasError: boolean; pending: number }>();

  for (const ev of events) {
    if (ev.kind === 'tool_use') {
      const filePath = extractFilePath(ev.input);
      if (!filePath) continue;

      const isWrite = WRITE_OR_EDIT_TOOL_NAMES.has(ev.name);
      const isRead = READ_TOOL_NAMES.has(ev.name);
      if (!isWrite && !isRead) continue;

      if (!byPath.has(filePath)) {
        byPath.set(filePath, { ops: [], hasError: false, pending: 0 });
      }
      const entry = byPath.get(filePath)!;
      entry.ops.push(isWrite ? (ev.name.toLowerCase().includes('edit') ? 'edit' : 'write') : 'read');
      entry.pending++;
    }

    if (ev.kind === 'tool_result') {
      // Find the matching tool_use to get the path
      const toolUse = events.find(
        (e) => e.kind === 'tool_use' && e.id === ev.toolUseId
      );
      if (!toolUse || toolUse.kind !== 'tool_use') continue;

      const filePath = extractFilePath(toolUse.input);
      if (!filePath || !byPath.has(filePath)) continue;

      const entry = byPath.get(filePath)!;
      entry.pending--;
      if (ev.isError) entry.hasError = true;
    }
  }

  return [...byPath.entries()].map(([path, data]) => {
    const opCounts: Record<FileOpKind, number> = { read: 0, write: 0, edit: 0 };
    for (const op of data.ops) opCounts[op]++;

    let status: FileOpStatus = 'done';
    if (data.pending > 0) status = 'running';
    if (data.hasError) status = 'error';

    return { path, ops: data.ops, opCounts, total: data.ops.length, status };
  });
}

// --- File-to-DB sync ---

const CHAPTER_PATTERN = /(\d+)/;

/**
 * Sync chapter files back to DB after agent writes.
 */
export async function syncFilesToDb(projectId: string, paths: Set<string>, projectDir: string): Promise<void> {
  for (const filePath of paths) {
    // Only process .md files that look like chapters
    if (!filePath.endsWith('.md')) continue;
    const basename = path.basename(filePath, '.md');
    // 跳过章节摘要文件（第N章.summary.md），避免把摘要误当作章节正文同步
    if (basename.endsWith('.summary')) continue;
    const match = basename.match(CHAPTER_PATTERN);
    if (!match) continue;

    const chapterNum = parseInt(match[1], 10);
    const fullPath = path.join(projectDir, filePath);

    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const wordCount = content.split(/\s+/).filter(Boolean).length;

      const existing = await db.select().from(chapters)
        .where(and(eq(chapters.projectId, projectId), eq(chapters.number, chapterNum)))
        .limit(1);

      if (existing.length > 0) {
        await db.update(chapters)
          .set({ wordCount, updatedAt: new Date() })
          .where(eq(chapters.id, existing[0].id));
      } else {
        await db.insert(chapters).values({
          id: `ch_${projectId}_${chapterNum}`,
          projectId,
          number: chapterNum,
          title: `Chapter ${chapterNum}`,
          wordCount,
        });
      }
    } catch { /* skip unreadable files */ }
  }
}

// --- File snapshot for diff ---

export interface FileSnapshot {
  path: string;
  content: string;
}

/**
 * Read current content of files before a run starts (for later diff).
 */
export async function readFileSnapshot(projectDir: string, paths: string[]): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const filePath of paths) {
    try {
      const fullPath = path.join(projectDir, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      snapshot.set(filePath, content);
    } catch { /* file may not exist yet */ }
  }
  return snapshot;
}

/**
 * Compute a simple diff between old and new content.
 * Returns an array of diff hunks.
 */
export function computeDiff(oldContent: string, newContent: string): DiffHunk[] {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const hunks: DiffHunk[] = [];

  // Simple line-by-line diff (not optimal but works for our use case)
  const maxLen = Math.max(oldLines.length, newLines.length);
  let currentHunk: DiffHunk | null = null;

  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine === newLine) {
      if (currentHunk) {
        hunks.push(currentHunk);
        currentHunk = null;
      }
      continue;
    }

    if (!currentHunk) {
      currentHunk = { startLine: i + 1, removes: [], adds: [] };
    }

    if (oldLine !== undefined) currentHunk.removes.push(oldLine);
    if (newLine !== undefined) currentHunk.adds.push(newLine);
  }

  if (currentHunk) hunks.push(currentHunk);
  return hunks;
}

export interface DiffHunk {
  startLine: number;
  removes: string[];
  adds: string[];
}
