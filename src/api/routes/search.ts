import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveNovelDir } from '../../shared/project-dir';

const searchRouter = new Hono();

interface SearchResult {
  file: string;
  line: number;
  text: string;
  context: string;
}

// Full-text search across project files
searchRouter.get('/', async (c) => {
  const projectId = c.req.param('projectId') || '';
  const query = c.req.query('q');
  if (!query) return c.json({ error: 'q is required' }, 400);

  let projectDir: string;
  try {
    projectDir = await resolveNovelDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }
  const results: SearchResult[] = [];

  try {
    await searchDirectory(projectDir, '', query.toLowerCase(), results);
  } catch { /* ignore search errors */ }

  return c.json({ query, results: results.slice(0, 50) }); // Limit to 50 results
});

async function searchDirectory(dir: string, prefix: string, query: string, results: SearchResult[]): Promise<void> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await searchDirectory(fullPath, relPath, query, results);
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.json')) {
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(query)) {
              const context = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2)).join('\n');
              results.push({
                file: relPath,
                line: i + 1,
                text: lines[i].trim(),
                context,
              });
            }
          }
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* ignore directory read errors */ }
}

export default searchRouter;
