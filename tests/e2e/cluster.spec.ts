import { expect, test } from '@playwright/test';

const endpoints = process.env.E2E_CLUSTER_WEBSOCKETS?.split(',') || [];

test('four browser sessions use separate instances and merge offline formatting on another instance', async ({
  browser,
  baseURL,
}) => {
  test.skip(endpoints.length !== 4, 'Requires the isolated four-instance packaged deployment');
  const contexts = await Promise.all(endpoints.map(() => browser.newContext()));
  try {
    const pages = await Promise.all(
      contexts.map(async (context, index) => {
        // Test-only routing pins each session to a different actual server. The
        // product normally uses the shared gateway URL, with automatic retries.
        await context.addInitScript(
          ({ endpoint }) => {
            const Original = window.WebSocket;
            window.WebSocket = class extends Original {
              constructor(address: string | URL, protocols?: string | string[]) {
                super(
                  String(address).includes('/collaboration')
                    ? sessionStorage.getItem('commonplace.test.endpoint') || endpoint
                    : address,
                  protocols,
                );
              }
            };
          },
          { endpoint: endpoints[index]! },
        );
        return context.newPage();
      }),
    );
    const first = pages[0]!;
    await first.goto(baseURL!);
    await first.getByRole('button', { name: 'New document', exact: true }).last().click();
    await first
      .getByLabel('Document title', { exact: true })
      .fill('Four-instance browser recovery');
    await first.getByRole('button', { name: 'Create document', exact: true }).click();
    const editor = first.getByRole('textbox', { name: 'Document editor' });
    await expect(editor).toBeVisible();
    await editor.fill('Starting point.');
    const url = first.url();
    for (const page of pages.slice(1)) await page.goto(url);
    for (const page of pages) {
      await expect(page.getByRole('textbox', { name: 'Document editor' })).toContainText(
        'Starting point.',
      );
      await expect(page.getByText('4 people in this document', { exact: true })).toBeVisible();
    }
    await contexts[0]!.setOffline(true);
    await expect(first.getByText('Offline mode', { exact: true })).toBeVisible();
    await editor.click();
    await editor.press('ControlOrMeta+End');
    await editor.pressSequentially(' Offline addition.');
    await editor.press('ControlOrMeta+a');
    await first.getByRole('button', { name: 'Bold', exact: true }).click();
    const peer = pages[1]!.getByRole('textbox', { name: 'Document editor' });
    await peer.click();
    await peer.press('ControlOrMeta+End');
    await peer.pressSequentially(' Online addition.');
    await first.evaluate(
      (endpoint) => sessionStorage.setItem('commonplace.test.endpoint', endpoint),
      endpoints[3]!,
    );
    await contexts[0]!.setOffline(false);
    for (const page of pages) {
      const text = page.getByRole('textbox', { name: 'Document editor' });
      await expect(text).toContainText('Offline addition.');
      await expect(text).toContainText('Online addition.');
      await expect(text.locator('strong')).toContainText('Offline addition.');
      await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
      await expect(page.getByText('4 people in this document', { exact: true })).toBeVisible();
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
