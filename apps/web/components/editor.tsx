'use client';

import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import {
  Bold,
  Check,
  ChevronDown,
  Code2,
  Download,
  Heading2,
  Italic,
  List,
  ListOrdered,
  LoaderCircle,
  Quote,
  Redo2,
  Undo2,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  initials,
  normalizeProfile,
  textStats,
  type Profile,
  type SavedDocument,
} from '@/lib/workspace';

interface Session {
  document: Y.Doc;
  provider: HocuspocusProvider;
}

export function CollaborativeEditor({
  document,
  profile,
  onNotice,
}: {
  document: SavedDocument;
  profile: Profile;
  onNotice: (message: string) => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState('connecting');
  const [synced, setSynced] = useState(false);
  const [unsynced, setUnsynced] = useState(0);
  const [localCopy, setLocalCopy] = useState(false);
  const [people, setPeople] = useState<(Profile & { id: number })[]>([]);

  useEffect(() => {
    let disposed = false;
    const ydoc = new Y.Doc();
    const persistence = new IndexeddbPersistence(`commonplace:${document.id}`, ydoc);
    const provider = new HocuspocusProvider({
      url: process.env.NEXT_PUBLIC_COLLABORATION_URL || 'ws://localhost:4000/collaboration',
      name: document.id,
      token: document.token,
      document: ydoc,
      onStatus: ({ status }) => {
        if (!disposed) setStatus(status);
      },
      onSynced: ({ state }) => {
        if (!disposed) setSynced(state);
      },
      onUnsyncedChanges: ({ number }) => {
        if (!disposed) setUnsynced(number);
      },
      onAuthenticationFailed: () => {
        if (!disposed) {
          setStatus('denied');
          onNotice('Document access was denied. Check your share link.');
        }
      },
    });
    const awareness = provider.awareness;
    const updatePresence = () => {
      if (disposed || !awareness) return;
      setPeople(
        Array.from(awareness.getStates())
          .filter(([, state]) => state.user)
          .map(([id, state]) => ({ id, ...normalizeProfile(state.user) })),
      );
    };
    awareness?.on('change', updatePresence);
    const offline = () => {
      provider.disconnect();
      setStatus('disconnected');
    };
    const online = () => {
      void provider.connect().catch(() => onNotice('Trying to reconnect to the workspace…'));
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    setSession({ document: ydoc, provider });
    persistence.whenSynced
      .then(() => {
        if (!disposed) setLocalCopy(true);
      })
      .catch(() => {
        if (!disposed)
          onNotice('Offline storage is unavailable in this browser. Keep the document online.');
      });
    return () => {
      disposed = true;
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      awareness?.off('change', updatePresence);
      provider.destroy();
      void persistence.destroy().finally(() => ydoc.destroy());
    };
    // Profile changes are applied to the existing awareness session by the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id, document.token]);

  const live = status === 'connected' && synced;
  const participantCount = Math.max(1, people.length);
  return (
    <>
      <div className="session-bar">
        <div className={`connection-badge ${live ? 'connected' : ''}`}>
          {live ? (
            <span className="small-dot" />
          ) : status === 'disconnected' ? (
            <WifiOff size={13} />
          ) : (
            <LoaderCircle size={13} className="spinning" />
          )}
          {live
            ? 'Live collaboration'
            : status === 'disconnected'
              ? 'Offline mode'
              : status === 'denied'
                ? 'Access denied'
                : 'Connecting…'}
        </div>
        <div className="participants">
          <div className="avatar-stack">
            {people.slice(0, 4).map((person) => (
              <span
                className="avatar avatar-small"
                key={person.id}
                style={{ background: person.color }}
                title={person.name}
              >
                {initials(person.name)}
              </span>
            ))}
          </div>
          <span>
            <Users size={13} />
            {participantCount} {participantCount === 1 ? 'person' : 'people'} in this document
          </span>
        </div>
      </div>
      {session ? (
        <EditorSurface
          session={session}
          profile={profile}
          title={document.title}
          disabled={status === 'denied'}
        />
      ) : (
        <div className="editor-loading">
          <LoaderCircle className="spinning" size={20} />
          Preparing your page…
        </div>
      )}
      <footer className="editor-footer">
        <span>
          {live ? (
            <>
              <Check size={13} />
              {unsynced ? 'Syncing changes…' : 'Changes synced'}
            </>
          ) : (
            <>
              <WifiOff size={13} />
              Offline edits will sync when connected
            </>
          )}
        </span>
        <span>
          {localCopy ? 'Offline copy enabled' : 'Preparing offline copy…'}
          <span className="footer-separator">·</span>Commonplace
        </span>
      </footer>
    </>
  );
}

function EditorSurface({
  session,
  profile,
  title,
  disabled,
}: {
  session: Session;
  profile: Profile;
  title: string;
  disabled: boolean;
}) {
  const [stats, setStats] = useState({ words: 0, characters: 0 });
  const editor = useEditor(
    {
      immediatelyRender: false,
      shouldRerenderOnTransaction: true,
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({ document: session.document }),
        CollaborationCaret.configure({ provider: session.provider, user: profile }),
      ],
      editorProps: {
        attributes: {
          class: 'document-editor',
          'aria-label': 'Document editor',
          role: 'textbox',
          'aria-multiline': 'true',
          spellcheck: 'true',
        },
      },
      onCreate: ({ editor }) => setStats(textStats(editor.getText())),
      onUpdate: ({ editor }) => setStats(textStats(editor.getText())),
    },
    [session],
  );
  useEffect(() => {
    editor?.commands.updateUser(normalizeProfile(profile));
  }, [editor, profile]);
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  function download() {
    if (!editor) return;
    const url = URL.createObjectURL(
      new Blob([editor.getText()], { type: 'text/plain;charset=utf-8' }),
    );
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `${title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 80) || 'document'}.txt`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (!editor) return <div className="editor-loading">Preparing your page…</div>;
  return (
    <>
      <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
        <div className="toolbar-group">
          <Tool
            label="Undo"
            icon={<Undo2 size={17} />}
            disabled={!editor.can().undo()}
            action={() => editor.chain().focus().undo().run()}
          />
          <Tool
            label="Redo"
            icon={<Redo2 size={17} />}
            disabled={!editor.can().redo()}
            action={() => editor.chain().focus().redo().run()}
          />
        </div>
        <div className="toolbar-group">
          <span className="text-style-label">Text style</span>
          <Tool
            label="Heading"
            icon={<Heading2 size={18} />}
            active={editor.isActive('heading', { level: 2 })}
            action={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          />
        </div>
        <div className="toolbar-group">
          <Tool
            label="Bold"
            icon={<Bold size={17} />}
            active={editor.isActive('bold')}
            action={() => editor.chain().focus().toggleBold().run()}
          />
          <Tool
            label="Italic"
            icon={<Italic size={17} />}
            active={editor.isActive('italic')}
            action={() => editor.chain().focus().toggleItalic().run()}
          />
        </div>
        <div className="toolbar-group">
          <Tool
            label="Bullet list"
            icon={<List size={18} />}
            active={editor.isActive('bulletList')}
            action={() => editor.chain().focus().toggleBulletList().run()}
          />
          <Tool
            label="Numbered list"
            icon={<ListOrdered size={18} />}
            active={editor.isActive('orderedList')}
            action={() => editor.chain().focus().toggleOrderedList().run()}
          />
          <Tool
            label="Quote"
            icon={<Quote size={17} />}
            active={editor.isActive('blockquote')}
            action={() => editor.chain().focus().toggleBlockquote().run()}
          />
          <Tool
            label="Code block"
            icon={<Code2 size={18} />}
            active={editor.isActive('codeBlock')}
            action={() => editor.chain().focus().toggleCodeBlock().run()}
          />
        </div>
        <Tool label="Download text" icon={<Download size={17} />} action={download} />
        <span className="toolbar-word-count">
          {stats.words} {stats.words === 1 ? 'word' : 'words'}
        </span>
      </div>
      <div className="document-canvas">
        <div className="page-gutter">
          YOUR SHARED CANVAS <span>Write something worth sharing.</span>
        </div>
        <article className="document-paper">
          <div className="paper-eyebrow">COMMONPLACE / A WORK IN PROGRESS</div>
          <EditorContent editor={editor} />
          <div className="paper-bottom">
            <span>{stats.characters.toLocaleString()} characters</span>
            <span>01</span>
          </div>
        </article>
        <p className="canvas-caption">A little space to think. A lot of room to grow.</p>
      </div>
    </>
  );
}

function Tool({
  label,
  icon,
  action,
  active,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  action: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`tool-button ${active ? 'is-active' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={action}
    >
      {icon}
    </button>
  );
}
