import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import * as Y from 'yjs';
import { z } from 'zod';

export const documentId = z.uuid();
export const createDocumentBody = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((value) => !/[\u0000-\u001f]/u.test(value), 'Title contains control characters'),
  })
  .strict();

export interface DocumentMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface DocumentRow {
  id: string;
  title: string;
  access_token_hash: Buffer;
  state: Buffer | null;
  created_at: Date;
  updated_at: Date;
}

function metadata(row: DocumentRow): DocumentMetadata {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function validToken(token: string, hash: Uint8Array): boolean {
  return (
    /^[A-Za-z0-9_-]{43}$/.test(token) &&
    hash.byteLength === 32 &&
    timingSafeEqual(hashToken(token), hash)
  );
}

export class DocumentStore {
  constructor(private readonly pool: Pool) {}

  async create(title: string): Promise<DocumentMetadata & { token: string }> {
    const token = randomBytes(32).toString('base64url');
    const result = await this.pool.query<DocumentRow>(
      'INSERT INTO documents (id, title, access_token_hash) VALUES ($1, $2, $3) RETURNING *',
      [randomUUID(), title, hashToken(token)],
    );
    return { ...metadata(result.rows[0]!), token };
  }

  async authorize(id: string, token: string): Promise<DocumentMetadata | null> {
    if (!documentId.safeParse(id).success) return null;
    const result = await this.pool.query<DocumentRow>('SELECT * FROM documents WHERE id = $1', [
      id,
    ]);
    const row = result.rows[0];
    return row && validToken(token, row.access_token_hash) ? metadata(row) : null;
  }

  async rename(id: string, token: string, title: string): Promise<DocumentMetadata | null> {
    if (!(await this.authorize(id, token))) return null;
    const result = await this.pool.query<DocumentRow>(
      'UPDATE documents SET title = $1, updated_at = clock_timestamp() WHERE id = $2 RETURNING *',
      [title, id],
    );
    return result.rows[0] ? metadata(result.rows[0]) : null;
  }

  async load(id: string): Promise<Uint8Array | null> {
    const result = await this.pool.query<{ state: Buffer | null }>(
      'SELECT state FROM documents WHERE id = $1',
      [id],
    );
    if (!result.rows[0]) throw new Error('Document does not exist');
    return result.rows[0].state;
  }

  async store(id: string, state: Uint8Array): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ state: Buffer | null }>(
        'SELECT state FROM documents WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!result.rows[0]) throw new Error('Document does not exist');
      // Merge CRDT histories under the row lock, preventing a stale snapshot from overwriting newer edits.
      const existing = result.rows[0].state;
      const merged = existing ? Y.mergeUpdates([existing, state]) : state;
      await client.query(
        'UPDATE documents SET state = $1, updated_at = clock_timestamp() WHERE id = $2',
        [Buffer.from(merged), id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
