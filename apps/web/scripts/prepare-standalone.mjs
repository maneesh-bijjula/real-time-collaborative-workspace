import { cp, mkdir } from 'node:fs/promises';

// Next's standalone server needs its static assets alongside the traced runtime.
const source = new URL('../.next/static/', import.meta.url);
const target = new URL('../.next/standalone/apps/web/.next/static/', import.meta.url);
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
