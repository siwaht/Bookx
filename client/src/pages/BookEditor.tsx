import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { books, elevenlabs, chapters as chaptersApi, characters as charsApi, timeline as timelineApi } from '../services/api';
import { useAppStore } from '../stores/appStore';
import type { Book } from '../types';
import {
  ArrowLeft, FileText, Users, LayoutDashboard, CheckCircle, Check, Download,
  Music, Settings, BookOpen, BarChart3, BookMarked, Sparkles, Zap,
  type LucideIcon,
} from 'lucide-react';
import { icon, text, weight } from '../components/ui/tokens';

interface Section {
  /** Stable id used to key the status map. */
  key: string;
  /** Route path relative to /book/:bookId. */
  to: string;
  icon: LucideIcon;
  label: string;
  podcastLabel: string;
  /** Visual chunking only; carries no ordering meaning. */
  group: string;
  /** Exact-match routing, needed for the index route. */
  end?: boolean;
}

/**
 * Every section of the editor, reachable at any time.
 *
 * These are areas of the project, not ordered steps: you can add music before
 * importing text, or listen back before casting. `done` marks are informational
 * only — nothing here gates anything else.
 *
 * `group` is purely for visual chunking. The `key` is what `status` is keyed by,
 * so the two can be reordered independently.
 */
const SECTIONS: Section[] = [
  { key: 'text', to: '', icon: FileText, label: 'Manuscript', podcastLabel: 'Script', group: 'Content', end: true },
  { key: 'cast', to: 'cast', icon: Users, label: 'Cast', podcastLabel: 'Cast', group: 'Content' },
  { key: 'pronunciation', to: 'pronunciation', icon: BookOpen, label: 'Pronunciation', podcastLabel: 'Pronunciation', group: 'Content' },

  { key: 'sound', to: 'studio', icon: Music, label: 'Music & effects', podcastLabel: 'Music & effects', group: 'Audio' },
  { key: 'generate', to: 'generation', icon: Zap, label: 'Generate speech', podcastLabel: 'Generate speech', group: 'Audio' },
  { key: 'enhance', to: 'boost', icon: Sparkles, label: 'Auto sound design', podcastLabel: 'Auto sound design', group: 'Audio' },

  { key: 'timeline', to: 'timeline', icon: LayoutDashboard, label: 'Timeline', podcastLabel: 'Timeline', group: 'Assemble' },
  { key: 'review', to: 'qc', icon: CheckCircle, label: 'Listen & check', podcastLabel: 'Listen & check', group: 'Assemble' },
  { key: 'export', to: 'export', icon: Download, label: 'Export', podcastLabel: 'Export', group: 'Assemble' },
];

export function BookEditor() {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { setCurrentBook, setCapabilities } = useAppStore();
  const [book, setBook] = useState<Book | null>(null);
  const [status, setStatus] = useState<Record<string, boolean>>({});

  /**
   * Informational only. Tells you what already has content so you can pick up
   * where you left off; it never disables or hides a section.
   */
  const refreshStatus = useCallback(async () => {
    if (!bookId) return;
    try {
      const [chapterList, charList, trackList] = await Promise.all([
        chaptersApi.list(bookId).catch(() => []),
        charsApi.list(bookId).catch(() => []),
        timelineApi.tracks(bookId).catch(() => []),
      ]);
      const hasVoices = charList.some((c: any) => c.voice_id);
      const hasAudio = chapterList.some((ch: any) => ch.stats?.with_audio > 0);
      const hasClips = trackList.some((t: any) => t.clips && t.clips.length > 0);
      const soundTracks = trackList.filter((t: any) => t.type === 'music' || t.type === 'sfx');

      setStatus({
        text: chapterList.length > 0,
        cast: hasVoices,
        sound: soundTracks.some((t: any) => t.clips && t.clips.length > 0),
        generate: hasAudio,
        timeline: hasClips,
        review: hasAudio && hasClips,
      });
    } catch {
      /* status badges are non-critical */
    }
  }, [bookId]);

  useEffect(() => {
    if (!bookId) return;
    books.get(bookId).then((b) => { setBook(b); setCurrentBook(b); }).catch(console.error);
    elevenlabs.capabilities().then(setCapabilities).catch(() => {});
    refreshStatus();
    return () => setCurrentBook(null);
  }, [bookId, refreshStatus]);

  useEffect(() => { refreshStatus(); }, [location.pathname, refreshStatus]);

  if (!book) return (
    <div style={S.loading}>Loading project…</div>
  );

  const isPodcast = book.project_type === 'podcast';

  return (
    <div style={S.layout}>
      <nav style={S.sidebar} aria-label="Project sections">
        <button onClick={() => navigate('/')} style={S.backBtn}>
          <ArrowLeft size={icon.sm} />
          <span>All projects</span>
        </button>

        <div style={S.bookInfo}>
          <span style={{
            ...S.typeBadge,
            background: isPodcast ? 'var(--purple-subtle)' : 'var(--accent-subtle)',
            color: isPodcast ? 'var(--purple)' : 'var(--accent)',
          }}>
            {isPodcast ? 'Podcast' : 'Audiobook'}
          </span>
          <h2 style={S.bookTitle}>{book.title}</h2>
          {book.author && <p style={S.bookAuthor}>{book.author}</p>}
          {book.library_book_id && (
            <button onClick={() => navigate('/library')} style={S.libraryLink}>
              <BookMarked size={icon.xs} /> From library
            </button>
          )}
        </div>

        <div style={S.navList}>
          {SECTIONS.map((item, idx) => {
            const isFirstOfGroup = idx === 0 || SECTIONS[idx - 1].group !== item.group;
            const done = !!status[item.key];
            return (
              <React.Fragment key={item.key}>
                {isFirstOfGroup && <div style={S.groupLabel}>{item.group}</div>}
                <NavLink
                  to={item.to}
                  end={item.end}
                  style={({ isActive }) => ({
                    ...S.navItem,
                    ...(isActive ? S.navItemActive : {}),
                  })}
                >
                  {({ isActive }: { isActive: boolean }) => (
                    <>
                      <item.icon
                        size={icon.md}
                        style={{ flexShrink: 0, opacity: isActive ? 1 : 0.62 }}
                      />
                      <span style={{
                        ...S.navLabel,
                        color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                        fontWeight: isActive ? weight.semibold : weight.medium,
                      }}>
                        {isPodcast ? item.podcastLabel : item.label}
                      </span>
                      {done && (
                        <Check
                          size={icon.xs}
                          strokeWidth={3}
                          color="var(--success)"
                          style={{ flexShrink: 0 }}
                          aria-label="has content"
                        />
                      )}
                    </>
                  )}
                </NavLink>
              </React.Fragment>
            );
          })}
        </div>

        <div style={S.sidebarFooter}>
          <NavLink to={`/book/${bookId}/usage`} style={({ isActive }) => ({
            ...S.footerLink,
            ...(isActive ? { color: 'var(--accent)', borderColor: 'var(--border-accent)', background: 'var(--accent-subtle)' } : {}),
          })}>
            <BarChart3 size={icon.sm} /> Usage &amp; costs
          </NavLink>
          <button onClick={() => navigate('/settings')} style={S.footerLink}>
            <Settings size={icon.sm} /> Settings
          </button>
        </div>
      </nav>
      <main style={S.main}>
        <Outlet />
      </main>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  loading: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '100vh', background: 'var(--bg-deep)',
    color: 'var(--text-tertiary)', fontSize: text.body,
  },
  layout: { display: 'flex', minHeight: '100vh', background: 'var(--bg-deep)' },
  sidebar: {
    width: 262, background: 'var(--bg-base)', padding: '12px 0',
    display: 'flex', flexDirection: 'column',
    borderRight: '1px solid var(--border-subtle)', flexShrink: 0,
    overflow: 'hidden',
  },
  backBtn: {
    display: 'flex', alignItems: 'center', gap: 8, background: 'none',
    border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
    padding: '10px 18px', fontSize: text.label, fontWeight: weight.medium,
    whiteSpace: 'nowrap',
  },
  bookInfo: {
    padding: '10px 18px 18px', borderBottom: '1px solid var(--border-subtle)',
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  typeBadge: {
    fontSize: text.micro, padding: '3px 10px', borderRadius: 20,
    fontWeight: weight.semibold, alignSelf: 'flex-start',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  bookTitle: { fontSize: text.title, fontWeight: weight.semibold, color: 'var(--text-primary)', lineHeight: 1.3, letterSpacing: '-0.02em' },
  bookAuthor: { fontSize: text.label, color: 'var(--text-tertiary)' },
  libraryLink: {
    display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none',
    color: 'var(--purple)', cursor: 'pointer', fontSize: text.meta,
    padding: 0, fontWeight: weight.medium, alignSelf: 'flex-start',
  },

  navList: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, padding: '8px 10px', overflowY: 'auto' },
  groupLabel: {
    fontSize: text.micro, color: 'var(--text-muted)', letterSpacing: 1,
    fontWeight: weight.semibold, textTransform: 'uppercase', padding: '14px 10px 5px',
  },
  navItem: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '11px 12px',
    minHeight: 44, textDecoration: 'none', cursor: 'pointer',
    borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)',
  },
  navItemActive: { background: 'var(--accent-subtle)' },
  navLabel: { flex: 1, minWidth: 0, fontSize: text.body },

  sidebarFooter: {
    padding: '12px 14px', borderTop: '1px solid var(--border-subtle)',
    display: 'flex', flexDirection: 'column', gap: 7,
  },
  footerLink: {
    display: 'flex', alignItems: 'center', gap: 9, background: 'none',
    border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)',
    cursor: 'pointer', padding: '10px 12px', borderRadius: 'var(--radius-md)',
    fontSize: text.label, width: '100%', fontWeight: weight.medium, textDecoration: 'none',
    minHeight: 40,
  },
  main: { flex: 1, overflow: 'auto', background: 'var(--bg-deep)' },
};
