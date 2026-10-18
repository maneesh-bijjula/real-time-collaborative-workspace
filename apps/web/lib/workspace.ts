export interface DocumentMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavedDocument extends DocumentMetadata {
  token: string;
}
export interface Profile {
  name: string;
  color: string;
}
const DOCUMENTS_KEY = 'commonplace.documents.v1';
const PROFILE_KEY = 'commonplace.profile.v1';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const COLORS = ['#7856b6', '#277c73', '#b56a3f', '#3e71ae', '#ad5277', '#777c31'];

export function normalizeProfile(value: Partial<Profile>): Profile {
  return {
    name:
      typeof value.name === 'string' && value.name.trim()
        ? value.name.trim().slice(0, 40)
        : 'Guest',
    color:
      typeof value.color === 'string' && /^#[a-f\d]{6}$/i.test(value.color)
        ? value.color
        : COLORS[0]!,
  };
}

export function readProfile(): Profile {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    if (raw && typeof raw === 'object') return normalizeProfile(raw);
  } catch {
    /* Storage can be disabled in private browser sessions. */
  }
  return {
    name: 'Guest ' + Math.floor(100 + Math.random() * 900),
    color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
  };
}

export function saveProfile(profile: Profile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(normalizeProfile(profile)));
  } catch {
    /* Editing remains available without profile storage. */
  }
}

export function readDocuments(): SavedDocument[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DOCUMENTS_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is SavedDocument =>
          !!item &&
          typeof item === 'object' &&
          ID.test(item.id) &&
          TOKEN.test(item.token) &&
          typeof item.title === 'string' &&
          typeof item.updatedAt === 'string' &&
          typeof item.createdAt === 'string',
      )
      .slice(0, 50);
  } catch {
    return [];
  }
}

export function rememberDocument(document: SavedDocument): void {
  const documents = [document, ...readDocuments().filter((item) => item.id !== document.id)].slice(
    0,
    50,
  );
  try {
    localStorage.setItem(DOCUMENTS_KEY, JSON.stringify(documents));
  } catch {
    /* The share link still retains access when storage is unavailable. */
  }
}

export function sharePath(document: Pick<SavedDocument, 'id' | 'token'>): string {
  return `/documents/${encodeURIComponent(document.id)}#key=${encodeURIComponent(document.token)}`;
}

export function accessToken(id: string, hash: string): string | null {
  const fromLink = new URLSearchParams(hash.replace(/^#/, '')).get('key');
  if (fromLink && TOKEN.test(fromLink)) return fromLink;
  return readDocuments().find((document) => document.id === id)?.token ?? null;
}

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toUpperCase();
}

export function textStats(text: string): { words: number; characters: number } {
  return {
    words: text.trim() ? text.trim().split(/\s+/u).length : 0,
    characters: Array.from(text).length,
  };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: { token?: string; method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}${path}`,
    {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    },
  );
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, result.error || 'Request failed');
  return result as T;
}
