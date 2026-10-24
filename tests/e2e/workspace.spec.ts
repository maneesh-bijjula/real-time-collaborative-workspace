import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { Pool } from 'pg';

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
  await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
  await context.setOffline(true);
  await expect(page.getByText('Offline mode', { exact: true })).toBeVisible();
  await expect(page.getByTestId('database-save-status')).toHaveText('Database save unconfirmed');
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
  await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
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
  await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({ path: 'docs/screenshots/mobile.png', fullPage: true });
});

test('database confirmation includes deletions and survives a fresh browser session', async ({
  page,
  browser,
}) => {
  const url = await createDocument(page, 'Confirmed deletions');
  const editor = page.getByRole('textbox', { name: 'Document editor' });
  await editor.fill('abcdef');
  await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
  await editor.evaluate((element) => {
    element.focus();
    const text = element.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 3);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await editor.press('Backspace');
  await expect(editor).toHaveText('adef');
  await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
  // Close the original editor so remote cursor-name decorations do not become
  // part of the fresh editor's DOM text assertion.
  await page.close();
  const freshContext = await browser.newContext();
  try {
    const fresh = await freshContext.newPage();
    await fresh.goto(url);
    await expect(fresh.getByRole('textbox', { name: 'Document editor' })).toHaveText('adef');
    await expect(fresh.getByTestId('database-save-status')).toHaveText('Saved to database');
  } finally {
    await freshContext.close();
  }
});

test('shows a delayed database save while collaboration continues, then retries without another edit', async ({
  page,
}) => {
  const databaseUrl = process.env.DATABASE_URL;
  test.skip(
    !databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'),
    'Fault injection requires an isolated test database',
  );
  const url = await createDocument(page, 'Database retry status');
  const id = new URL(url).pathname.split('/').at(-1)!;
  const name = 'e2e_fail_save_' + id.replaceAll('-', '');
  const pool = new Pool({ connectionString: databaseUrl });
  await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
  try {
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${id}'::uuid THEN RAISE EXCEPTION 'Injected browser save failure'; END IF; RETURN NEW; END $$`);
    await pool.query(
      `CREATE TRIGGER ${name} BEFORE UPDATE OF state ON documents FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    await page
      .getByRole('textbox', { name: 'Document editor' })
      .fill('An edit waiting for PostgreSQL.');
    await expect(page.getByText('Changes synced', { exact: true })).toBeVisible();
    await expect(page.getByTestId('database-save-status')).toHaveText(
      'Database save delayed; retrying…',
    );
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${name} ON documents`);
    await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
    await pool.end();
  }
  await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toHaveText(
    'An edit waiting for PostgreSQL.',
  );
});

test('recovers an open editor after PostgreSQL connections are interrupted', async ({ page }) => {
  const databaseUrl = process.env.DATABASE_URL;
  const database = databaseUrl ? new URL(databaseUrl) : null;
  const name = database?.pathname.slice(1) || '';
  test.skip(
    !/^workspace(?:_\w+)?_test$/.test(name),
    'Connection failure injection requires the dedicated workspace test database',
  );
  await createDocument(page, 'Database connection recovery');
  await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
  // Keep the administrative connection in a different database, so recovery
  // remains possible while application-database connections are disabled.
  database!.pathname = '/postgres';
  const admin = new Pool({ connectionString: database!.toString() });
  try {
    await admin.query(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS false`);
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [name],
    );
    await page
      .getByRole('textbox', { name: 'Document editor' })
      .fill('Recover without another keystroke.');
    await expect(page.getByText('Changes synced', { exact: true })).toBeVisible();
    await expect(page.getByTestId('database-save-status')).toHaveText(
      'Database save delayed; retrying…',
    );
  } finally {
    await admin.query(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS true`);
    await admin.end();
  }
  await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toHaveText(
    'Recover without another keystroke.',
  );
});
