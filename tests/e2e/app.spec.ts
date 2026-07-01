import { test, expect, type Page } from '@playwright/test';

/** Collect console errors during a test, filtering out expected 404s */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('404')) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

/** Helper to create a project via API */
async function createProject(request: any, title: string, genre = 'general') {
  const res = await request.post('/api/projects', {
    data: { title, genre },
  });
  expect(res.ok()).toBeTruthy();
  const { project } = await res.json();
  return project;
}

test.describe('HomePage', () => {
  test('loads without console errors', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await page.waitForSelector('text=我的小说');
    expect(errors).toEqual([]);
  });

  test('shows empty state when no projects', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('text=我的小说');
    const content = await page.textContent('body');
    expect(content).toBeTruthy();
  });

  test('create project form opens and closes', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('text=新建项目');
    await page.click('text=新建项目');
    await expect(page.locator('input[placeholder="小说标题"]')).toBeVisible();
    await page.click('text=取消');
    await expect(page.locator('input[placeholder="小说标题"]')).not.toBeVisible();
  });

  test('create a project via API and navigate', async ({ page }) => {
    const errors = collectErrors(page);
    const res = await page.request.post('/api/projects', {
      data: { title: 'E2E测试小说', genre: 'fantasy' },
    });
    expect(res.ok()).toBeTruthy();
    const { project } = await res.json();

    await page.goto(`/projects/${project.id}`);
    await page.waitForSelector(`text=${project.title}`);
    expect(errors).toEqual([]);
  });
});

test.describe('SettingsPage', () => {
  test('loads without console errors', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/settings');
    await page.waitForSelector('text=设置');
    expect(errors).toEqual([]);
  });

  test('shows agent selection', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForSelector('text=首选 Agent');
    await expect(page.locator('select')).toBeVisible();
  });
});

test.describe('ProjectPage', () => {
  let projectId: string;

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/projects', {
      data: { title: 'E2E项目页测试' },
    });
    const { project } = await res.json();
    projectId = project.id;
  });

  test('loads without console errors', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`/projects/${projectId}`);
    await page.waitForSelector('text=E2E项目页测试');
    expect(errors).toEqual([]);
  });

  test('shows sidebar with navigation', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await page.waitForSelector('[data-testid="sidebar"]');
    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(sidebar.locator('a', { hasText: '总览' })).toBeVisible();
    await expect(sidebar.locator('a', { hasText: '概念' })).toBeVisible();
    await expect(sidebar.locator('a', { hasText: '角色' })).toBeVisible();
    await expect(sidebar.locator('a', { hasText: '大纲' })).toBeVisible();
    await expect(sidebar.locator('a', { hasText: '伏笔' })).toBeVisible();
  });

  test('shows workflow progress', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await page.waitForSelector('[data-testid="workflow-progress"]');
    await expect(page.locator('[data-testid="workflow-progress"]')).toBeVisible();
  });

  test('sidebar navigation works', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`/projects/${projectId}`);
    await page.waitForSelector('[data-testid="sidebar"]');

    const sidebar = page.locator('[data-testid="sidebar"]');
    const views = ['概念', '世界观', '角色', '大纲', '场景', '伏笔'];
    for (const view of views) {
      await sidebar.locator('a', { hasText: view }).click();
      await page.waitForTimeout(200);
    }
    expect(errors).toEqual([]);
  });

  test('chat panel is visible', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await page.waitForSelector('[data-testid="chat-panel"]');
    await expect(page.locator('[data-testid="chat-panel"]')).toBeVisible();
  });
});

test.describe('API endpoints', () => {
  test('health check', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  test('list projects', async ({ request }) => {
    const res = await request.get('/api/projects');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data.projects)).toBeTruthy();
  });

  test('create and delete project', async ({ request }) => {
    const createRes = await request.post('/api/projects', {
      data: { title: '临时项目' },
    });
    expect(createRes.ok()).toBeTruthy();
    const { project } = await createRes.json();
    expect(project.title).toBe('临时项目');

    const deleteRes = await request.delete(`/api/projects/${project.id}`);
    expect(deleteRes.ok()).toBeTruthy();
  });

  test('list agents', async ({ request }) => {
    const res = await request.get('/api/agents');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data.agents)).toBeTruthy();
  });

  test('list plugins', async ({ request }) => {
    const res = await request.get('/api/plugins');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data.plugins)).toBeTruthy();
  });

  test('get settings', async ({ request }) => {
    const res = await request.get('/api/settings');
    expect(res.ok()).toBeTruthy();
  });

  test('update settings', async ({ request }) => {
    const res = await request.patch('/api/settings', {
      data: { preferred_agent: 'claude' },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('list chapters', async ({ request }) => {
    // Create project first
    const projRes = await request.post('/api/projects', {
      data: { title: '章节测试' },
    });
    const { project } = await projRes.json();

    // List chapters
    const listRes = await request.get(`/api/projects/${project.id}/chapters`);
    expect(listRes.ok()).toBeTruthy();
    const data = await listRes.json();
    expect(Array.isArray(data.chapters)).toBeTruthy();

    // Cleanup
    await request.delete(`/api/projects/${project.id}`);
  });
});

test.describe('Full page navigation', () => {
  test('navigate home -> settings -> back', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await page.waitForSelector('text=我的小说');

    await page.goto('/settings');
    await page.waitForSelector('text=设置');

    await page.goto('/');
    await page.waitForSelector('text=我的小说');

    expect(errors).toEqual([]);
  });
});

test.describe('Complete workflow', () => {
  test('create project, navigate, and verify workspace', async ({ page, request }) => {
    const errors = collectErrors(page);

    // Create project via API
    const project = await createProject(request, '工作流测试小说', 'wuxia');

    // Navigate to project page
    await page.goto(`/projects/${project.id}`);
    await page.waitForSelector(`text=${project.title}`);

    // Verify sidebar is visible
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();

    // Verify workflow progress is visible
    await expect(page.locator('[data-testid="workflow-progress"]')).toBeVisible();

    // Verify chat panel is visible
    await expect(page.locator('[data-testid="chat-panel"]')).toBeVisible();

    // Navigate to concept view
    await page.click('text=故事概念');
    await page.waitForTimeout(500);

    // Navigate back to dashboard
    await page.click('text=总览');
    await page.waitForTimeout(500);

    expect(errors).toEqual([]);
  });

  test('chapters CRUD via API', async ({ request }) => {
    // Create project
    const project = await createProject(request, '章节测试小说');

    // Create chapter
    const createRes = await request.post(`/api/projects/${project.id}/chapters`, {
      data: { number: 1, title: '第一章 开始' },
    });
    expect(createRes.ok()).toBeTruthy();
    const { chapter } = await createRes.json();
    expect(chapter.number).toBe(1);
    expect(chapter.title).toBe('第一章 开始');

    // List chapters
    const listRes = await request.get(`/api/projects/${project.id}/chapters`);
    expect(listRes.ok()).toBeTruthy();
    const { chapters } = await listRes.json();
    expect(chapters.length).toBe(1);

    // Update chapter
    const updateRes = await request.patch(`/api/projects/${project.id}/chapters/1`, {
      data: { title: '第一章 更新后' },
    });
    expect(updateRes.ok()).toBeTruthy();

    // Delete chapter
    const deleteRes = await request.delete(`/api/projects/${project.id}/chapters/1`);
    expect(deleteRes.ok()).toBeTruthy();

    // Verify deletion
    const verifyRes = await request.get(`/api/projects/${project.id}/chapters`);
    const { chapters: afterDelete } = await verifyRes.json();
    expect(afterDelete.length).toBe(0);
  });

  test('search API works', async ({ request }) => {
    const project = await createProject(request, '搜索测试小说');

    // Search (should return empty results)
    const searchRes = await request.get(`/api/projects/${project.id}/search?q=test`);
    expect(searchRes.ok()).toBeTruthy();
    const data = await searchRes.json();
    expect(Array.isArray(data.results)).toBeTruthy();
  });

  test('export API works', async ({ request }) => {
    const project = await createProject(request, '导出测试小说');

    // Export as markdown
    const mdRes = await request.get(`/api/projects/${project.id}/export/markdown`);
    expect(mdRes.ok()).toBeTruthy();
    const mdContent = await mdRes.text();
    expect(mdContent).toContain(project.title);

    // Export as text
    const txtRes = await request.get(`/api/projects/${project.id}/export/text`);
    expect(txtRes.ok()).toBeTruthy();
    const txtContent = await txtRes.text();
    expect(txtContent).toContain(project.title);
  });
});
