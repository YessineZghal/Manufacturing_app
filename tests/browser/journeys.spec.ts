import { test, expect } from '@playwright/test';
test('an operator assesses, refreshes, recovers and inspects correlated evidence', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ingest next cycle' })).toBeEnabled();
  await page.getByRole('button', { name: 'Ingest next cycle' }).click();
  await expect(page.getByText('Assessment recorded and saved.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.assessment .badge')).toHaveText(['healthy']);
  await expect(page.locator('.engine-option', { hasText: 'Engine T-25' })).toContainText(
    '11 cycles left',
  );
  await page.getByRole('button', { name: 'Run guided recovery drill' }).click();
  await expect(page.getByText('Recovery independently checked', { exact: true })).toBeVisible({
    timeout: 45000,
  });
  await expect(page.locator('.assessment .badge')).toHaveText(['healthy']);
  await page.getByRole('button', { name: 'Assessment telemetry' }).click();
  await expect(page.getByRole('heading', { name: 'Assessment request traces' })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(6);
  await page.locator('.trace-link').first().click();
  await expect(page.getByRole('heading', { name: 'Correlated signals' })).toBeVisible();
  await expect(page.locator('.signal-grid pre')).toHaveCount(3);
  await page.getByRole('button', { name: 'Recovery evidence', exact: true }).click();
  await expect(page.getByText('Recovery independently checked', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'rul-fd001-v2' })).toBeVisible();
  const response = await page.request.get('/api/evidence');
  expect(response.ok()).toBeTruthy();
  const evidence = await response.json();
  expect(evidence.incident.status).toBe('recovered');
  expect(evidence.incident.verification.accurate).toBe(true);
  expect(evidence.assessments.filter((r: { probe: boolean }) => !r.probe)).toHaveLength(1);
  expect(errors).toEqual([]);
});
test('the maintenance board flags a near-failure engine as critical', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ingest next cycle' })).toBeEnabled();
  await page.locator('.engine-option', { hasText: 'Engine T-34' }).click();
  for (let n = 0; n < 12; n++) {
    await page.getByRole('button', { name: 'Ingest next cycle' }).click();
    await expect(page.locator('.engine-option', { hasText: 'Engine T-34' })).toContainText(
      `${11 - n} cycles left`,
    );
  }
  await expect(page.getByRole('button', { name: 'Ingest next cycle' })).toBeDisabled();
  const row = page.locator('tbody tr', { hasText: 'Engine T-34' });
  await expect(row).toContainText('critical');
  await expect(row).toContainText('Schedule maintenance now');
});
test('unsupported faults require review and manual restore', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run guided recovery drill' })).toBeEnabled();
  await page.getByLabel('Failure scenario').selectOption('unknown_dependency');
  await page.getByRole('button', { name: 'Run guided recovery drill' }).click();
  await expect(page.getByText('escalated', { exact: true })).toBeVisible({ timeout: 45000 });
  await expect(page.getByRole('button', { name: 'Restore manually' })).toBeEnabled();
  await page.getByRole('button', { name: 'Restore manually' }).click();
  await expect(page.getByText('cancelled', { exact: true })).toBeVisible();
});
test('an escalation after a failed verification can still be closed by an engineer', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run guided recovery drill' })).toBeEnabled();
  // Exhaust the probe budget so verification fails after a successful repair.
  for (let n = 0; n < 80; n++)
    expect(
      (
        await page.request.post('/api/probe', {
          headers: { 'idempotency-key': `budget_probe_${n}` },
          data: {},
        })
      ).status(),
    ).toBe(201);
  await page.getByRole('button', { name: 'Run guided recovery drill' }).click();
  await expect(page.getByText('escalated', { exact: true })).toBeVisible({ timeout: 45000 });
  await expect(page.getByText('Available', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Restore manually' }).click();
  await expect(page.getByText('cancelled', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run guided recovery drill' })).toBeEnabled();
});
test('two browser contexts cannot affect each other', async ({ browser }) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  try {
    const pa = await a.newPage(),
      pb = await b.newPage();
    await pa.goto('/');
    await pb.goto('/');
    await expect(pa.getByRole('button', { name: 'Inject fault only' })).toBeEnabled();
    await expect(pb.getByRole('button', { name: 'Ingest next cycle' })).toBeEnabled();
    await pa.getByRole('button', { name: 'Inject fault only' }).click();
    await expect(pa.getByText('Interrupted', { exact: true })).toBeVisible();
    await pb.getByRole('button', { name: 'Ingest next cycle' }).click();
    await expect(pb.getByText('Assessment recorded and saved.', { exact: true })).toBeVisible();
  } finally {
    await a.close();
    await b.close();
  }
});
test('mobile layout, keyboard entry and public project pages', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ingest next cycle' })).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.goto('/tracker');
  await expect(page.getByRole('heading', { name: 'Work with acceptance criteria.' })).toBeVisible();
  await expect(page.locator('article')).toHaveCount(7);
  await page.goto('/guide');
  await expect(page.getByRole('heading', { name: 'Predictions need evidence.' })).toBeVisible();
});

test('every back link and sidebar link navigates without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  for (const path of ['/guide', '/tracker', '/report']) {
    await page.goto(path);
    await page.getByRole('link', { name: '← Maintenance workspace' }).click();
    await expect(page.getByRole('button', { name: 'Ingest next cycle' })).toBeVisible();
  }
  for (const [name, heading] of [
    ['Field guide', 'Predictions need evidence.'],
    ['Public task tracker', 'Work with acceptance criteria.'],
    ['Executive report', /where can the AI agent act on its own/],
  ] as const) {
    await page.goto('/');
    await page.getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('the executive report turns a verified recovery into leadership measures', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run guided recovery drill' })).toBeEnabled();
  await page.getByRole('button', { name: 'Run guided recovery drill' }).click();
  await expect(page.getByText('Recovery independently checked', { exact: true })).toBeVisible({
    timeout: 45000,
  });
  await page.goto('/report');
  await expect(
    page.getByRole('heading', { name: /where can the AI agent act on its own/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Decisions for the leadership team' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Model quality' })).toBeVisible();
  await expect(page.locator('.report-kpis .stat-value').first()).toHaveText('100%');
  await expect(page.getByText('Gather evidence', { exact: true })).toBeVisible();
});
