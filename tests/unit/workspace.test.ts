import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accessToken,
  initials,
  normalizeProfile,
  readDocuments,
  rememberDocument,
  sharePath,
  textStats,
  type SavedDocument,
} from '../../apps/web/lib/workspace';

describe('workspace utilities', () => {
  it('counts Unicode characters and whitespace-separated words', () =>
    expect(textStats('hi 😀\n你好')).toEqual({ words: 3, characters: 7 }));
  it('handles an empty document', () =>
    expect(textStats('  ')).toEqual({ words: 0, characters: 2 }));
  it('keeps display names bounded and rejects CSS-like colors', () =>
    expect(normalizeProfile({ name: '  A'.repeat(40), color: 'url(evil)' })).toEqual({
      name: ('A' + '  A'.repeat(39)).slice(0, 40),
      color: '#7856b6',
    }));
  it('uses a fallback for blank names', () =>
    expect(normalizeProfile({ name: ' ' }).name).toBe('Guest'));
  it('creates Unicode-aware initials', () => expect(initials('  Alex   Rivera ')).toBe('AR'));
});

describe('local document bookmarks', () => {
  const memory = new Map<string, string>();
  const first: SavedDocument = {
    id: '16d3f83f-b3eb-42a4-9f81-66d93dced721',
    token: 'a'.repeat(43),
    title: 'First',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  beforeEach(() => {
    memory.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
    });
  });
  it('updates an existing bookmark rather than duplicating it', () => {
    rememberDocument(first);
    rememberDocument({ ...first, title: 'Updated' });
    expect(readDocuments()).toHaveLength(1);
    expect(readDocuments()[0]?.title).toBe('Updated');
  });
  it('puts the token in the fragment rather than the path or query', () => {
    const url = new URL(sharePath(first), 'http://localhost:3000');
    expect(url.search).toBe('');
    expect(url.hash).toBe('#key=' + first.token);
    expect(url.pathname).not.toContain(first.token);
  });
  it('imports a valid link and falls back to a remembered token', () => {
    expect(accessToken(first.id, '#key=' + first.token)).toBe(first.token);
    rememberDocument(first);
    expect(accessToken(first.id, '')).toBe(first.token);
  });
  it('rejects malformed storage without crashing', () => {
    memory.set('commonplace.documents.v1', 'not-json');
    expect(readDocuments()).toEqual([]);
    memory.set('commonplace.documents.v1', '[null,{},false]');
    expect(readDocuments()).toEqual([]);
  });
});
