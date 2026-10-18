'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileText,
  Link2,
  LoaderCircle,
  Pencil,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { Brand } from './brand';
import {
  accessToken,
  api,
  ApiError,
  COLORS,
  initials,
  normalizeProfile,
  readDocuments,
  readProfile,
  rememberDocument,
  saveProfile,
  sharePath,
  type DocumentMetadata,
  type Profile,
  type SavedDocument,
} from '@/lib/workspace';
import { CollaborativeEditor } from './editor';

export function DocumentWorkspace({ id }: { id: string }) {
  const [document, setDocument] = useState<SavedDocument | null>(null);
  const [profile, setProfile] = useState<Profile>({ name: 'Guest', color: COLORS[0]! });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');

  useEffect(() => {
    let alive = true;
    const person = readProfile();
    setProfile(person);
    saveProfile(person);
    const token = accessToken(id, window.location.hash);
    if (!token) {
      setError(
        'This document needs its private share link. Ask a collaborator to send you the complete link.',
      );
      return;
    }
    const cached = readDocuments().find((item) => item.id === id && item.token === token);
    api<DocumentMetadata>(`/api/documents/${encodeURIComponent(id)}`, { token })
      .then((metadata) => {
        if (!alive) return;
        const saved = { ...metadata, token };
        rememberDocument(saved);
        setDocument(saved);
        setDraftTitle(saved.title);
      })
      .catch((failure: unknown) => {
        if (!alive) return;
        if (cached && !(failure instanceof ApiError && failure.status === 404)) {
          setDocument(cached);
          setDraftTitle(cached.title);
        } else
          setError(
            failure instanceof ApiError && failure.status === 404
              ? 'This link is invalid or the document is unavailable.'
              : 'The workspace server is unavailable. Please try again when it is running.',
          );
      });
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  function updateProfile(next: Profile) {
    setProfile(next);
    saveProfile(normalizeProfile(next));
  }
  async function share() {
    if (!document) return;
    try {
      await navigator.clipboard.writeText(window.location.origin + sharePath(document));
      setNotice('Share link copied. Anyone with this link can edit.');
    } catch {
      setNotice('Copy the complete address from your browser to share this document.');
    }
  }
  async function rename(event: React.FormEvent) {
    event.preventDefault();
    if (!document || !draftTitle.trim()) return;
    try {
      const metadata = await api<DocumentMetadata>(`/api/documents/${document.id}`, {
        method: 'PATCH',
        token: document.token,
        body: { title: draftTitle.trim() },
      });
      const saved = { ...metadata, token: document.token };
      setDocument(saved);
      rememberDocument(saved);
      setRenaming(false);
    } catch {
      setNotice('Could not rename the document. Please try again online.');
    }
  }

  if (error)
    return (
      <main className="state-page">
        <Brand />
        <div className="state-card">
          <FileText size={35} strokeWidth={1.3} />
          <h1>A small pause.</h1>
          <p role="alert">{error}</p>
          <Link className="button button-primary" href="/">
            Back to workspace <ArrowLeft size={16} />
          </Link>
        </div>
      </main>
    );
  if (!document)
    return (
      <main className="loading-page">
        <LoaderCircle className="spinning" size={22} />
        <span>Opening your document…</span>
      </main>
    );

  return (
    <main className="editor-workspace">
      <header className="editor-header">
        <div className="editor-identity">
          <Brand compact />
          <span className="header-divider" />
          <Link href="/" className="back-link" aria-label="Back to documents">
            <ArrowLeft size={17} />
          </Link>
          <div className="document-heading">
            {renaming ? (
              <form onSubmit={rename}>
                <input
                  aria-label="Rename document"
                  autoFocus
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  maxLength={120}
                />
                <button className="icon-button" aria-label="Save title" type="submit">
                  <Check size={15} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Cancel rename"
                  onClick={() => setRenaming(false)}
                >
                  <X size={15} />
                </button>
              </form>
            ) : (
              <button
                className="document-title-button"
                onClick={() => {
                  setDraftTitle(document.title);
                  setRenaming(true);
                }}
              >
                <h1>{document.title}</h1>
                <Pencil size={12} />
              </button>
            )}
            <span>
              My workspace <span>/</span> Shared document
            </span>
          </div>
        </div>
        <div className="editor-header-actions">
          <button
            className="profile-button"
            onClick={() => setProfileOpen(!profileOpen)}
            aria-label="Edit your display name"
          >
            <span className="avatar" style={{ background: profile.color }}>
              {initials(profile.name)}
            </span>
          </button>
          <button className="button button-primary share-button" onClick={share}>
            <Link2 size={16} />
            Share document
          </button>
        </div>
      </header>
      {profileOpen && (
        <section className="profile-popover" aria-label="Your profile">
          <strong>Your presence</strong>
          <p>Choose how collaborators see you.</p>
          <label>
            Display name
            <input
              aria-label="Your display name"
              maxLength={40}
              value={profile.name}
              onChange={(event) => updateProfile({ ...profile, name: event.target.value })}
            />
          </label>
          <div className="color-options">
            {COLORS.map((color) => (
              <button
                key={color}
                aria-label={`Use color ${color}`}
                aria-pressed={profile.color === color}
                style={{ background: color }}
                onClick={() => updateProfile({ ...profile, color })}
              >
                {profile.color === color && <Check size={14} />}
              </button>
            ))}
          </div>
          <button className="text-button" onClick={() => setProfileOpen(false)}>
            Done <Check size={14} />
          </button>
        </section>
      )}
      <CollaborativeEditor document={document} profile={profile} onNotice={setNotice} />
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
    </main>
  );
}
