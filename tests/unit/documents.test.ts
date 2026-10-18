import { describe, expect, it } from 'vitest';
import {
  createDocumentBody,
  documentId,
  hashToken,
  validToken,
} from '../../apps/server/src/documents.js';

describe('document request boundaries', () => {
  it('trims human-readable titles', () =>
    expect(createDocumentBody.parse({ title: '  Team notes  ' })).toEqual({ title: 'Team notes' }));
  it.each([
    { title: '' },
    { title: ' '.repeat(4) },
    { title: 'x'.repeat(121) },
    { title: 'bad\u0000title' },
    { title: 'ok', token: 'injected' },
    { title: 12 },
  ])('rejects invalid input %j', (body) =>
    expect(createDocumentBody.safeParse(body).success).toBe(false),
  );
  it('accepts a UUID and rejects SQL-like identifiers', () => {
    expect(documentId.safeParse('16d3f83f-b3eb-42a4-9f81-66d93dced721').success).toBe(true);
    expect(documentId.safeParse("'; DROP TABLE documents; --").success).toBe(false);
  });
});

describe('document access tokens', () => {
  const token = 'a'.repeat(43);
  it('matches a valid token to its SHA-256 hash', () =>
    expect(validToken(token, hashToken(token))).toBe(true));
  it('rejects a different token', () =>
    expect(validToken('b'.repeat(43), hashToken(token))).toBe(false));
  it.each(['', 'short', 'a'.repeat(44), '!'.repeat(43)])('rejects malformed token %s', (value) =>
    expect(validToken(value, hashToken(token))).toBe(false),
  );
  it('rejects invalid hash lengths without throwing', () =>
    expect(validToken(token, new Uint8Array(1))).toBe(false));
});
