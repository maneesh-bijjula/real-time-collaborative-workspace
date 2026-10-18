import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

async function createDocument(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New document', exact: true }).last().click();
  await page.getByLabel('Document title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Create document', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toBeVisible();
  await expect(page.getByText('Live collaboration', { exact: true })).toBeVisible();
  return page.url();
}

test('two independent browser sessions edit, format, and see each other', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = await createDocument(page, 'Team launch notes');
  const editor = page.getByRole('textbox', { name: 'Document editor' });
  await editor.fill('A place for our best ideas.');
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await other.goto(url);
  const otherEditor = other.getByRole('textbox', { name: 'Document editor' });
  await expect(otherEditor).toContainText('A place for our best ideas.');
  await expect(page.getByText('2 people in this document', { exact: true })).toBeVisible();
  await otherEditor.click();
  await otherEditor.press('End');
  await otherEditor.pressSequentially(' Better together.');
  await expect(editor).toContainText('Better together.');
  await editor.click();
  await editor.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(otherEditor.locator('strong')).toContainText('Better together.');
  await page.getByRole('button', { name: 'Share document', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(/link|address/);
  if (process.env.CAPTURE_SCREENSHOTS) {
    await mkdir('docs/screenshots', { recursive: true });
    await page.screenshot({ path: 'docs/screenshots/editor.png', fullPage: true });
    await page.getByRole('link', { name: 'Back to documents' }).click();
    await expect(page.getByRole('heading', { name: /Your documents/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Team launch notes' })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/workspace.png', fullPage: true });
  }
  expect(errors).toEqual([]);
  await otherContext.close();
});

test('offline edits merge on reconnect and IndexedDB restores content without WebSocket access', async ({
  page,
  context,
  browser,
}) => {
  const url = await createDocument(page, 'Offline notebook');
  const editor = page.getByRole('textbox', { name: 'Document editor' });
  await editor.fill('Starting point.');
  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  await peer.goto(url);
  const peerEditor = peer.getByRole('textbox', { name: 'Document editor' });
  await expect(peerEditor).toContainText('Starting point.');
  await context.setOffline(true);
  await expect(page.getByText('Offline mode', { exact: true })).toBeVisible();
  await editor.click();
  await editor.press('End');
  await editor.pressSequentially(' Offline thought.');
  await peerEditor.click();
  await peerEditor.press('End');
  await peerEditor.pressSequentially(' Online thought.');
  await context.setOffline(false);
  await expect(peerEditor).toContainText('Offline thought.');
  await expect(editor).toContainText('Online thought.');
  await expect(page.getByText('Changes synced', { exact: true })).toBeVisible();
  await expect(page.getByText('Offline copy enabled', { exact: false })).toBeVisible();
  await page.routeWebSocket('**/collaboration', (socket) => socket.close());
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toContainText(
    'Offline thought.',
  );
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toContainText(
    'Online thought.',
  );
  await peerContext.close();
});

test('renames, exports, and filters documents from the workspace', async ({ page }) => {
  await createDocument(page, 'First draft');
  await page.getByRole('textbox', { name: 'Document editor' }).fill('An exportable note.');
  await page.getByRole('button', { name: 'First draft', exact: false }).click();
  await page.getByRole('textbox', { name: 'Rename document', exact: true }).fill('Design journal');
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Design journal' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download text', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Design journal.txt');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('utf8')).toBe('An exportable note.');
  await page.getByRole('link', { name: 'Back to documents' }).click();
  await page.getByRole('textbox', { name: 'Search documents' }).fill('missing');
  await expect(page.getByText('No matching documents', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search documents' }).fill('design');
  await expect(page.getByRole('heading', { name: 'Design journal' })).toBeVisible();
});

test('a document without its share key shows an access message', async ({ page }) => {
  await page.goto('/documents/16d3f83f-b3eb-42a4-9f81-66d93dced721');
  await expect(page.getByRole('alert').filter({ hasText: 'private share link' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toHaveCount(0);
});

test('mobile workspace and editor fit the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createDocument(page, 'Mobile ideas');
  await page.getByRole('textbox', { name: 'Document editor' }).fill('A thought on the go.');
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toContainText(
    'A thought on the go.',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({ path: 'docs/screenshots/mobile.png', fullPage: true });
});
