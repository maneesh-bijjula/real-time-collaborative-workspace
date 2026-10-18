'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowDownWideNarrow,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  FileText,
  FolderOpen,
  Layers2,
  Plus,
  Search,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { Brand } from './brand';
import {
  api,
  initials,
  readDocuments,
  readProfile,
  rememberDocument,
  saveProfile,
  sharePath,
  type DocumentMetadata,
  type Profile,
  type SavedDocument,
} from '@/lib/workspace';

export function Dashboard() {
  const router = useRouter();
  const [documents, setDocuments] = useState<SavedDocument[]>([]);
  const [query, setQuery] = useState('');
  const [profile, setProfile] = useState<Profile>({ name: 'Your workspace', color: '#7856b6' });
  const [dialog, setDialog] = useState(false);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [sortNewest, setSortNewest] = useState(true);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let alive = true;
    const saved = readDocuments();
    setDocuments(saved);
    const person = readProfile();
    saveProfile(person);
    setProfile(person);
    void Promise.all(
      saved.map(async (item) => {
        try {
          return {
            ...(await api<DocumentMetadata>(`/api/documents/${item.id}`, { token: item.token })),
            token: item.token,
          };
        } catch {
          return item;
        }
      }),
    ).then((updated) => {
      if (!alive) return;
      for (const item of updated) rememberDocument(item);
      setDocuments(updated);
    });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (dialog) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [dialog]);

  async function createDocument(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError('');
    try {
      const document = await api<SavedDocument>('/api/documents', {
        method: 'POST',
        body: { title: title.trim() || 'Untitled document' },
      });
      rememberDocument(document);
      router.push(sharePath(document));
    } catch {
      setError('Could not create a document. Check your connection and try again.');
      setCreating(false);
    }
  }

  const visible = documents
    .filter((document) => document.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) =>
      sortNewest ? b.updatedAt.localeCompare(a.updatedAt) : a.title.localeCompare(b.title),
    );

  return (
    <div className="workspace-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-switch">
          <span className="workspace-icon">M</span>
          <div>
            My workspace<small>A place to think together</small>
          </div>
          <ChevronDown size={15} />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Workspace navigation">
          <a className="nav-item active" href="/">
            <FolderOpen size={18} />
            All documents<span className="nav-count">{documents.length}</span>
          </a>
          <button
            className="nav-item"
            onClick={() => {
              setTitle('');
              setDialog(true);
            }}
          >
            <Plus size={18} />
            New document
          </button>
        </nav>
        <div className="sidebar-note">
          <div className="note-art">
            <Users size={27} strokeWidth={1.25} />
            <span className="note-star">✳</span>
          </div>
          <h3>Better, together.</h3>
          <p>Share a link. Bring another perspective. Make something good.</p>
          <button
            onClick={() => {
              setTitle('');
              setDialog(true);
            }}
          >
            Start collaborating <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="sidebar-footer">
          <span className="avatar" style={{ background: profile.color }}>
            {initials(profile.name)}
          </span>
          <div>
            {profile.name}
            <small>Personal workspace</small>
          </div>
          <span className="online-indicator" title="Local profile" />
        </div>
      </aside>

      <main className="dashboard-main">
        <header className="dashboard-topbar">
          <div className="breadcrumb">
            <Layers2 size={16} /> Workspace <span>/</span> <strong>Documents</strong>
          </div>
          <span className="topbar-caption">
            <span className="small-dot" /> Made for working together
          </span>
        </header>
        <div className="dashboard-content">
          <section className="welcome-panel">
            <div>
              <span className="eyebrow">
                <Sparkles size={13} /> A LITTLE ROOM FOR BIG IDEAS
              </span>
              <h1>
                Your next good idea
                <br />
                starts <em>here.</em>
              </h1>
              <p>
                A shared space to write, find your flow,
                <br className="desktop-break" /> and turn a first thought into something more.
              </p>
              <button
                className="button button-dark"
                onClick={() => {
                  setTitle('');
                  setDialog(true);
                }}
              >
                Create a document <ArrowRight size={16} />
              </button>
            </div>
            <div className="welcome-art" aria-hidden="true">
              <div className="art-dot dot-one" />
              <div className="art-dot dot-two" />
              <div className="art-paper paper-back" />
              <div className="art-paper paper-front">
                <span className="art-paper-label">A THOUGHT IN PROGRESS</span>
                <span className="art-script">
                  What if we
                  <br />
                  made it together?
                </span>
                <div className="art-lines">
                  <i />
                  <i />
                  <i />
                </div>
                <span className="art-cursor">
                  <i />
                  you
                </span>
              </div>
              <span className="art-flower">✳</span>
              <span className="art-pencil" />
            </div>
          </section>

          <section className="documents-section" aria-labelledby="documents-heading">
            <div className="section-heading">
              <div>
                <h2 id="documents-heading">
                  Your documents <span>{documents.length}</span>
                </h2>
                <p>Pick up where you left off, or start something new.</p>
              </div>
              <button
                className="button button-primary"
                onClick={() => {
                  setTitle('');
                  setDialog(true);
                }}
              >
                <Plus size={17} />
                New document
              </button>
            </div>
            <div className="documents-controls">
              <label className="search-box">
                <Search size={17} />
                <input
                  aria-label="Search documents"
                  placeholder="Search your documents..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <kbd>⌕</kbd>
              </label>
              <button className="sort-button" onClick={() => setSortNewest(!sortNewest)}>
                <ArrowDownWideNarrow size={16} />
                {sortNewest ? 'Recently edited' : 'Title A–Z'}
                <ChevronDown size={13} />
              </button>
            </div>
            {visible.length ? (
              <div className="document-grid">
                {visible.map((document, index) => (
                  <button
                    className="document-card"
                    key={document.id}
                    onClick={() => router.push(sharePath(document))}
                  >
                    <div className={`document-preview tone-${index % 4}`}>
                      <FileText size={26} strokeWidth={1.3} />
                      <div className="preview-lines">
                        <i />
                        <i />
                        <i />
                      </div>
                      <span>COMMONPLACE / DOC</span>
                    </div>
                    <div className="document-card-content">
                      <span className="document-type">SHARED DOCUMENT</span>
                      <h3>{document.title}</h3>
                      <div className="card-meta">
                        <span>Opened in this browser</span>
                        <ArrowUpRight size={15} />
                      </div>
                    </div>
                  </button>
                ))}
                <button
                  className="new-document-card"
                  onClick={() => {
                    setTitle('');
                    setDialog(true);
                  }}
                >
                  <span>
                    <Plus size={24} />
                  </span>
                  <strong>Room for another idea</strong>
                  <small>Create a new document</small>
                </button>
              </div>
            ) : (
              <div className="empty-documents">
                <span className="empty-icon">
                  <BookOpen size={30} strokeWidth={1.25} />
                </span>
                <h3>
                  {query ? 'No matching documents' : 'Every good thing starts with a blank page.'}
                </h3>
                <p>
                  {query
                    ? 'Try a different title or clear your search.'
                    : 'Create your first document, then invite someone to make it better.'}
                </p>
                {!query && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setTitle('');
                      setDialog(true);
                    }}
                  >
                    Let’s write something <ArrowRight size={15} />
                  </button>
                )}
              </div>
            )}
          </section>
          <footer className="dashboard-footer">
            <span>
              <span className="small-dot" /> Your ideas, in good company.
            </span>
            <span>Write. Share. Make it yours.</span>
          </footer>
        </div>
      </main>

      <dialog
        ref={dialogRef}
        className="create-dialog"
        aria-labelledby="create-document-heading"
        onCancel={() => setDialog(false)}
        onClick={(event) => {
          if (event.target === dialogRef.current) setDialog(false);
        }}
      >
        <form onSubmit={createDocument}>
          <button
            className="icon-button dialog-close"
            type="button"
            aria-label="Close dialog"
            onClick={() => setDialog(false)}
          >
            <X size={19} />
          </button>
          <span className="dialog-icon">
            <FileText size={25} />
          </span>
          <h2 id="create-document-heading">Create a document</h2>
          <p>A blank page, a fresh perspective.</p>
          <label htmlFor="document-title">Document title</label>
          <input
            id="document-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Untitled document"
            maxLength={120}
            autoFocus
          />
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
          <button className="button button-primary" type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create document'}
            <ArrowRight size={16} />
          </button>
        </form>
      </dialog>
    </div>
  );
}
