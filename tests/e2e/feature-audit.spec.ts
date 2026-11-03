import { expect, test, type Page } from '@playwright/test';
import * as Y from 'yjs';

async function create(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New document', exact: true }).last().click();
  await page.getByLabel('Document title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Create document', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toBeVisible();
  return page.url();
}

test('sharing a remembered document provides the complete private link when clipboard access fails', async ({
  page,
  browser,
}) => {
  const url = await create(page, 'Manual share fallback');
  await page.getByRole('textbox', { name: 'Document editor' }).fill('A shared fallback works.');
  await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) },
    });
  });
  const withoutKey = new URL(url);
  withoutKey.hash = '';
  await page.goto(withoutKey.toString());
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toBeVisible();
  await page.getByRole('button', { name: 'Share document', exact: true }).click();
  const link = page.getByRole('textbox', { name: 'Private share link', exact: true });
  await expect(link).toHaveValue(url);
  const fresh = await browser.newContext();
  try {
    const peer = await fresh.newPage();
    await peer.goto(await link.inputValue());
    await expect(peer.getByRole('textbox', { name: 'Document editor' })).toContainText(
      'A shared fallback works.',
    );
  } finally {
    await fresh.close();
  }
});

test('browser storage denial leaves online collaboration, database saving and export usable', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      get() {
        throw new DOMException('Browser storage disabled', 'SecurityError');
      },
    });
  });
  await create(page, 'Storage unavailable');
  const editor = page.getByRole('textbox', { name: 'Document editor' });
  await editor.fill('Still saved online.');
  await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
  await expect(page.getByText('Offline copy unavailable', { exact: false })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download text' }).click();
  expect((await download).suggestedFilename()).toBe('Storage unavailable.txt');
  expect(errors).toEqual([]);
});

test('all advertised formatting controls synchronize and undo preserves the other editor’s work', async ({
  page,
  browser,
}) => {
  const url = await create(page, 'Formatting audit');
  const editor = page.getByRole('textbox', { name: 'Document editor' });
  await editor.fill('Shared formatting');
  const context = await browser.newContext();
  try {
    const peer = await context.newPage();
    await peer.goto(url);
    const other = peer.getByRole('textbox', { name: 'Document editor' });
    await expect(other).toContainText('Shared formatting');
    await page.getByRole('button', { name: 'Edit your display name' }).click();
    await page.getByRole('textbox', { name: 'Your display name' }).fill('Audit author');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(peer.getByTitle('Audit author', { exact: true })).toBeVisible();
    for (const [label, selector] of [
      ['Heading', 'h2'],
      ['Bold', 'strong'],
      ['Italic', 'em'],
      ['Bullet list', 'ul'],
      ['Numbered list', 'ol'],
      ['Quote', 'blockquote'],
      ['Code block', 'pre'],
    ]) {
      const selectText = () =>
        editor.evaluate((element) => {
          const block = [...element.querySelectorAll('p,h2,pre')].find((node) =>
            node.textContent?.includes('Shared formatting'),
          )!;
          const range = document.createRange();
          range.selectNodeContents(block);
          element.focus();
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
        });
      await selectText();
      if (label === 'Heading') {
        await expect(
          peer.locator('.collaboration-carets__label', { hasText: 'Audit author' }),
        ).toBeVisible();
        await expect(peer.locator('.ProseMirror-yjs-selection').first()).toBeVisible();
      }
      await page.getByRole('button', { name: label!, exact: true }).click();
      await expect(other.locator(selector!)).toContainText('Shared formatting');
      await selectText();
      await page.getByRole('button', { name: label!, exact: true }).click();
      await expect(other.locator(selector!)).toHaveCount(0);
    }
    await editor.click();
    await editor.press('ControlOrMeta+End');
    await editor.pressSequentially(' local');
    await expect(other).toContainText(' local');
    // A different editor's transaction must survive our collaborative undo.
    await other.click();
    await other.press('ControlOrMeta+End');
    await other.pressSequentially(' peer');
    await expect(editor).toContainText(' peer');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(other).toContainText(' peer');
    await expect(other).not.toContainText(' local');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(other).toContainText(' local');
    await expect(other).toContainText(' peer');
  } finally {
    await context.close();
  }
});

for (const phase of ['upgrade', 'initial', 'later'] as const) {
  test(`an aborted ${phase} browser-storage transaction preserves online editing and the prior cache`, async ({
    page,
    browser,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.name));
    await page.addInitScript(
      ({ initial, upgrade }) => {
        const state = { abort: initial };
        Object.assign(window, { offlineFailure: state });
        if (upgrade) {
          IDBDatabase.prototype.createObjectStore = () => {
            throw new DOMException('Storage unavailable', 'QuotaExceededError');
          };
        }
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
          const transaction = original.apply(this, args);
          if (state.abort && transaction.mode === 'readwrite')
            queueMicrotask(() => transaction.abort());
          return transaction;
        };
      },
      { initial: phase === 'initial', upgrade: phase === 'upgrade' },
    );
    const url = await create(page, 'Browser transaction recovery');
    const editor = page.getByRole('textbox', { name: 'Document editor' });
    if (phase === 'later') {
      await expect(page.getByText('Offline copy enabled', { exact: false })).toBeVisible();
      await editor.fill('Prior cached state.');
      await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
      await expect
        .poll(async () => {
          const updates = await storedUpdates(page, url);
          return decodedText(updates);
        })
        .toContain('Prior cached state.');
      await page.evaluate(() => {
        (window as unknown as { offlineFailure: { abort: boolean } }).offlineFailure.abort = true;
      });
    }
    await editor.fill('Online storage remains healthy.');
    await expect(page.getByText('Offline copy unavailable', { exact: false })).toBeVisible();
    await expect(page.getByTestId('database-save-status')).toHaveText('Saved to database');
    const fresh = await browser.newContext();
    try {
      const peer = await fresh.newPage();
      await peer.goto(url);
      await expect(peer.getByRole('textbox', { name: 'Document editor' })).toContainText(
        'Online storage remains healthy.',
      );
    } finally {
      await fresh.close();
    }
    if (phase === 'later') {
      await page.routeWebSocket('**/collaboration', (socket) => socket.close());
      await page.reload();
      await expect(editor).toContainText('Prior cached state.');
      await expect(editor).not.toContainText('Online storage remains healthy.');
      await expect(page.getByText('Offline copy enabled', { exact: false })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}

async function storedUpdates(page: Page, url: string): Promise<number[][]> {
  return page.evaluate(
    (id) =>
      new Promise<number[][]>((resolve, reject) => {
        const request = indexedDB.open('commonplace:' + id);
        request.onerror = () => reject(new Error('Test cache read failed'));
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('updates', 'readonly');
          const read = transaction.objectStore('updates').getAll();
          transaction.oncomplete = () => {
            db.close();
            resolve(read.result.map((update: Uint8Array) => Array.from(update)));
          };
          transaction.onabort = () => {
            db.close();
            reject(new Error('Test cache read aborted'));
          };
        };
      }),
    new URL(url).pathname.split('/').at(-1)!,
  );
}
function decodedText(updates: number[][]) {
  const document = new Y.Doc();
  try {
    for (const update of updates) Y.applyUpdate(document, new Uint8Array(update));
    const text = (node: Y.XmlFragment | Y.XmlText): string =>
      node instanceof Y.XmlText
        ? node
            .toDelta()
            .map((item: { insert: unknown }) =>
              typeof item.insert === 'string' ? item.insert : '',
            )
            .join('')
        : node
            .toArray()
            .map((child) =>
              child instanceof Y.XmlElement || child instanceof Y.XmlText ? text(child) : '',
            )
            .join('');
    return text(document.getXmlFragment('default'));
  } finally {
    document.destroy();
  }
}

test('legacy binary offline copies retain deletions and concurrent tabs survive compaction', async ({
  page,
  context,
}) => {
  const url = await create(page, 'Existing offline copy');
  await expect(page.getByText('Offline copy enabled', { exact: false })).toBeVisible();
  await page.goto('/');
  const legacy = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  legacy.getXmlFragment('default').push([paragraph]);
  paragraph.push([text]);
  text.insert(0, 'Legacy content REMOVE');
  text.format(0, 6, { bold: true });
  text.delete(14, 7);
  const bytes = Array.from(Y.encodeStateAsUpdate(legacy));
  legacy.destroy();
  await page.evaluate(
    ({ id, bytes }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('commonplace:' + id);
        request.onerror = () => reject(new Error('Legacy fixture open failed'));
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('updates', 'readwrite');
          const store = transaction.objectStore('updates');
          store.clear();
          store.add(new Uint8Array(bytes));
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onabort = () => {
            db.close();
            reject(new Error('Legacy fixture write failed'));
          };
        };
      }),
    { id: new URL(url).pathname.split('/').at(-1)!, bytes },
  );
  await context.routeWebSocket('**/collaboration', (socket) => socket.close());
  await page.goto(url);
  const other = await context.newPage();
  await other.goto(url);
  for (const tab of [page, other]) {
    await expect(tab.getByText('Offline copy enabled', { exact: false })).toBeVisible();
    await expect(
      tab.getByRole('textbox', { name: 'Document editor' }).locator('strong'),
    ).toHaveText('Legacy');
  }
  const edit = async (tab: Page, character: string) => {
    const editor = tab.getByRole('textbox', { name: 'Document editor' });
    await editor.click();
    await editor.press('ControlOrMeta+End');
    await editor.pressSequentially(character.repeat(510));
  };
  await Promise.all([edit(page, 'a'), edit(other, 'b')]);
  await expect
    .poll(async () => {
      const value = decodedText(await storedUpdates(page, url));
      return { a: (value.match(/a/g) || []).length, b: (value.match(/b/g) || []).length };
    })
    .toEqual({ a: 511, b: 510 });
  await other.close();
  await page.reload();
  const editor = page.getByRole('textbox', { name: 'Document editor' });
  await expect(editor).not.toContainText('REMOVE');
  await expect(editor.locator('strong')).toHaveText('Legacy');
  expect((await editor.innerText()).match(/a/g)).toHaveLength(511);
  expect((await editor.innerText()).match(/b/g)).toHaveLength(510);
});
