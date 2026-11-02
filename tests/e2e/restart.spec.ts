import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('a fresh browser reads committed formatting and deletion after every packaged server restarts', async ({
  browser,
  baseURL,
}) => {
  test.skip(
    process.env.E2E_EXTERNAL !== '1',
    'Requires the guarded disposable packaged deployment',
  );
  test.setTimeout(90000);
  const project = process.env.CLUSTER_VERIFY_PROJECT || 'commonplace-verify';
  assert(
    ['commonplace-verify', 'commonplace-sprint2-verify', 'commonplace-sprint3-verify'].includes(
      project,
    ),
  );
  const execute = promisify(execFile);
  const args = [
    'compose',
    '-p',
    project,
    '-f',
    'compose.verify.yaml',
    '-f',
    'compose.cluster.yaml',
  ];
  const services = ['server', 'server2', 'server3', 'server4'];
  const first = await browser.newContext();
  let second: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const page = await first.newPage();
    await page.goto(baseURL!);
    await page.getByRole('button', { name: 'New document', exact: true }).last().click();
    await page.getByLabel('Document title', { exact: true }).fill('Packaged restart recovery');
    await page.getByRole('button', { name: 'Create document', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Document editor' });
    await expect(editor).toBeVisible();
    await editor.fill('confirmed restart content REMOVE');
    await editor.press('ControlOrMeta+End');
    for (let i = 0; i < 7; i++) await editor.press('Backspace');
    await editor.press('ControlOrMeta+a');
    await page.getByRole('button', { name: 'Bold', exact: true }).click();
    await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
    const link = page.url();
    assert(link.includes('#'));
    // Destroy the original browser storage/client before stopping all replicas.
    await first.close();
    await execute('docker', [...args, 'stop', '-t', '20', ...services], { timeout: 45000 });
    await execute('docker', [...args, 'up', '-d', '--wait', ...services], { timeout: 45000 });
    second = await browser.newContext();
    const restored = await second.newPage();
    await restored.goto(link);
    const recovered = restored.getByRole('textbox', { name: 'Document editor' });
    await expect(recovered).toHaveText('confirmed restart content');
    await expect(recovered.locator('strong')).toHaveText('confirmed restart content');
    await expect(recovered).not.toContainText('REMOVE');
    await expect(restored.getByTestId('database-save-status')).toHaveText('Saved to database');
  } finally {
    await first.close();
    await second?.close();
  }
});
