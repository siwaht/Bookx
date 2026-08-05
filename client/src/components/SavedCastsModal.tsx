import React, { useEffect, useState } from 'react';
import { BookCopy, Check, Layers, Loader, Save, Users } from 'lucide-react';
import { castings as castingsApi } from '../services/api';
import { toast } from './Toast';
import type { VoiceCasting } from '../types';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { field, icon, text, weight } from './ui/tokens';

interface SavedCastsModalProps {
  open: boolean;
  onClose: () => void;
  bookId: string;
  /** How many characters in this book currently have a voice. */
  voicedCount: number;
  suggestedName: string;
  /** Set when this book belongs to a series, so its shared cast can be called out. */
  seriesId?: string | null;
  seriesName?: string | null;
  /** Called after a cast is applied so the page can reload characters. */
  onApplied: (result: { updated: number; created: number; castName: string }) => void | Promise<void>;
}

/**
 * The cast library: save this project's character voices under a name, and drop
 * a saved cast onto this book. This is how a series keeps one voice per
 * character across volumes — save it on volume one, apply it on volume two.
 */
export function SavedCastsModal({
  open,
  onClose,
  bookId,
  voicedCount,
  suggestedName,
  seriesId,
  seriesName,
  onApplied,
}: SavedCastsModalProps) {
  const [casts, setCasts] = useState<VoiceCasting[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [justSavedId, setJustSavedId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await castingsApi.list();
      setCasts(Array.isArray(data) ? data : []);
    } catch {
      /* non-critical */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setName(suggestedName);
    setJustSavedId(null);
    load();
  }, [open, suggestedName]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const cast = await castingsApi.syncFromBook(bookId, { name: name.trim() });
      const n = cast.members?.length || 0;
      setJustSavedId(cast.id);
      toast.success(`Saved "${cast.name}" with ${n} voice${n === 1 ? '' : 's'}. Apply it to your next volume from here.`);
      await load();
    } catch (err: any) {
      toast.error(err.message || 'Could not save this cast');
    } finally {
      setSaving(false);
    }
  };

  const handleApply = async (cast: VoiceCasting) => {
    setApplyingId(cast.id);
    try {
      const result = await castingsApi.applyToBook(cast.id, bookId);
      await onApplied({ updated: result.updated, created: result.created, castName: cast.name });
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'Could not apply that cast');
    } finally {
      setApplyingId(null);
    }
  };

  // A cast belonging to this book's series is the one you almost always want on
  // the next volume, so it's pulled to the top and labelled.
  const seriesCasts = seriesId ? casts.filter((c) => c.series_id === seriesId) : [];
  const otherCasts = casts.filter((c) => !seriesId || c.series_id !== seriesId);

  const renderCast = (cast: VoiceCasting, isSeries: boolean) => (
    <div key={cast.id} style={S.castRow}>
      <div style={{ ...S.castIcon, ...(isSeries ? { color: 'var(--purple)', background: 'var(--purple-subtle)' } : {}) }}>
        {isSeries ? <Layers size={icon.sm} /> : <Users size={icon.sm} />}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={S.castName}>
          {cast.name}
          {cast.id === justSavedId && (
            <span style={S.savedTag}>
              <Check size={11} /> saved
            </span>
          )}
        </div>
        <div style={S.castMeta}>
          {cast.voiced_count ?? 0} voice{(cast.voiced_count ?? 0) === 1 ? '' : 's'}
          {isSeries && seriesName ? ` · shared across ${seriesName}` : ''}
        </div>
      </div>
      <Button
        size="sm"
        variant={isSeries ? 'subtle' : 'secondary'}
        loading={applyingId === cast.id}
        onClick={() => handleApply(cast)}
        icon={<BookCopy size={icon.xs} />}
      >
        Apply
      </Button>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={620}
      title="Cast library"
      subtitle="Save a cast once, then reuse the same voices on the next volume, sequel, or episode."
    >
      <section style={S.section}>
        <h3 style={S.sectionTitle}>Save this project's cast</h3>
        <div style={S.row}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            placeholder="Name this cast"
            style={{ ...field, flex: 1 }}
            aria-label="Cast name"
          />
          <Button
            variant="primary"
            loading={saving}
            disabled={!name.trim() || voicedCount === 0}
            onClick={handleSave}
            icon={<Save size={icon.sm} />}
            title={voicedCount === 0 ? 'Assign at least one voice first' : 'Save this cast for reuse'}
          >
            Save
          </Button>
        </div>
        <p style={S.hint}>
          {voicedCount === 0
            ? 'Assign at least one voice before saving.'
            : `Stores the ${voicedCount} voice${voicedCount === 1 ? '' : 's'} you've assigned, matched by character name.`}
        </p>
      </section>

      <section style={{ ...S.section, marginBottom: 0 }}>
        <h3 style={S.sectionTitle}>Apply a saved cast</h3>

        {loading && (
          <div style={S.state}>
            <Loader size={icon.sm} className="spin" /> Loading…
          </div>
        )}

        {!loading && casts.length === 0 && (
          <div style={S.state}>
            Nothing saved yet. Save this project's cast above, then it'll be available for every other volume.
          </div>
        )}

        {!loading && seriesCasts.length > 0 && (
          <>
            <div style={S.groupLabel}>From this series</div>
            <div style={S.list}>{seriesCasts.map((c) => renderCast(c, true))}</div>
          </>
        )}

        {!loading && otherCasts.length > 0 && (
          <>
            {seriesCasts.length > 0 && <div style={{ ...S.groupLabel, marginTop: 18 }}>All saved casts</div>}
            <div style={S.list}>{otherCasts.map((c) => renderCast(c, false))}</div>
          </>
        )}

        {!loading && casts.length > 0 && (
          <p style={S.hint}>
            Applying matches characters by name. Anyone in the cast who isn't in this book yet gets added;
            characters unique to this book keep whatever voice they already have.
          </p>
        )}
      </section>
    </Modal>
  );
}

const S: Record<string, React.CSSProperties> = {
  section: { display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 30 },
  sectionTitle: {
    fontSize: text.body,
    fontWeight: weight.semibold,
    color: 'var(--text-primary)',
    margin: 0,
  },
  row: { display: 'flex', gap: 10, alignItems: 'stretch' },
  hint: { fontSize: text.meta, color: 'var(--text-muted)', margin: 0, lineHeight: 1.55 },
  groupLabel: {
    fontSize: text.micro,
    fontWeight: weight.semibold,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  state: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '18px 16px',
    fontSize: text.label,
    color: 'var(--text-tertiary)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    lineHeight: 1.55,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
  },
  castRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '14px 16px',
    background: 'var(--bg-surface)',
    borderBottom: '1px solid var(--border-subtle)',
  },
  castIcon: {
    width: 36,
    height: 36,
    flexShrink: 0,
    borderRadius: 'var(--radius-md)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg-elevated)',
    color: 'var(--text-tertiary)',
  },
  castName: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: text.body,
    fontWeight: weight.medium,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  savedTag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    fontSize: text.micro,
    fontWeight: weight.semibold,
    color: 'var(--success)',
    background: 'var(--success-subtle)',
    padding: '2px 8px',
    borderRadius: 20,
  },
  castMeta: { fontSize: text.meta, color: 'var(--text-muted)', marginTop: 3 },
};
