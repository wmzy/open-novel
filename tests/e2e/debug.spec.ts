import { test } from '@playwright/test';

test('debug project page content', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => logs.push(`[PAGE_ERROR] ${err.message}`));

  // Capture ALL responses to find the 500
  const failedResponses: Array<{ url: string; status: number; body: string }> = [];
  page.on('response', async (response) => {
    if (response.status() >= 400) {
      let body = '';
      try {
        body = await response.text();
      } catch (e) {
        body = `(cannot read: ${e})`;
      }
      failedResponses.push({ url: response.url(), status: response.status(), body: body.substring(0, 500) });
    }
  });

  const res = await page.request.post('/api/projects', { data: { title: 'Debug' } });
  const { project } = await res.json();

  await page.goto(`/projects/${project.id}`);
  await page.waitForTimeout(3000);

  console.log('=== CONSOLE ERRORS ===');
  logs.filter(l => l.includes('[error]') || l.includes('[PAGE_ERROR]')).forEach(l => console.log(l));
  console.log('=== FAILED RESPONSES ===');
  failedResponses.forEach(r => {
    console.log(`[${r.status}] ${r.url}`);
    if (r.body) console.log(`  Body: ${r.body}`);
  });
  console.log('=== BODY TEXT ===');
  const bodyText = await page.textContent('body');
  console.log(bodyText?.substring(0, 300));
});
