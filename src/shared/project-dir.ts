import { eq } from 'drizzle-orm';
import path from 'node:path';
import { db } from '../db/drizzle';
import { projects } from '../db/schema';

/**
 * Resolve the .novel directory for a project by reading its `path` from the DB.
 */
export async function resolveNovelDir(projectId: string): Promise<string> {
  const [project] = await db
    .select({ path: projects.path })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) throw new Error(`Project not found: ${projectId}`);
  return path.join(project.path, '.novel');
}

/**
 * Resolve the project root directory from the DB.
 */
export async function resolveProjectDir(projectId: string): Promise<string> {
  const [project] = await db
    .select({ path: projects.path })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project.path;
}
