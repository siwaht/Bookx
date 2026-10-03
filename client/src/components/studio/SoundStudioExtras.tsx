import { useRef, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { LoaderCircle, Music2, Pause, Play, Plus, Trash2, Upload, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { readFileAsBase64 } from "@/lib/files";
import type { AppRouter } from "../../../../server/routers";
import { SOUND_OPTION_LIMITS, type SoundOptions } from "@shared/soundOptions";
import { ConfirmDialog } from "./ConfirmDialog";
import { Badge, RangeField, ui } from "./studioUi";

type Overview = inferRouterOutputs<AppRouter>["bookx"]["soundDesign"];
type Chapter = Overview["chapters"][number];
type Cue = Chapter["cues"][number];

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Compact selects; their text size comes from the element around them. */
const compactSelect = "rounded-lg border border-[#dce4dd] bg-white px-2 py-1 text-[#4b5d60]";

function useRefresh(projectId: string) {
  const utils = trpc.useUtils();
  return () => {
    void utils.bookx.soundDesign.invalidate({ projectId });
    void utils.bookx.exportReadiness.invalidate({ projectId });
    void utils.studio.chapterPlayback.invalidate();
  };
}

const db = (value: number) => `${value > 0 ? "+" : ""}${value} dB`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s`;

/** "Rain ×6 · Knock ×2 · Tense music ×3": what actually plays in the book. */
export function SoundsSummary({ chapters, effectsOn, musicOn }: { chapters: Chapter[]; effectsOn: boolean; musicOn: boolean }) {
  const counts = new Map<string, { label: string; kind: Cue["kind"]; count: number; chapters: Set<string> }>();
  for (const chapter of chapters) {
    for (const cue of chapter.cues) {
      if (!cue.enabled) continue;
      const key = `${cue.kind}:${cue.label}`;
      const entry = counts.get(key) ?? { label: cue.label, kind: cue.kind, count: 0, chapters: new Set<string>() };
      entry.count++;
      entry.chapters.add(chapter.id);
      counts.set(key, entry);
    }
  }
  const entries = [...counts.values()].sort((left, right) => right.count - left.count);
  if (!entries.length) return null;
  return (
    <div className={ui.cardQuiet}>
      <span className={ui.eyebrow}>WHAT PLAYS IN THIS BOOK</span>
      <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Sounds used in the book">
        {entries.map(entry => {
          const on = entry.kind === "sfx" ? effectsOn : musicOn;
          return (
            <li key={`${entry.kind}-${entry.label}`} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${entry.kind === "music" ? "bg-[#f6ecd9] text-[#7d5a17]" : "bg-[#e3eef4] text-[#3f647a]"} ${on ? "" : "opacity-60"}`}>
              {entry.kind === "music" && <Music2 aria-hidden="true" size={10} />}
              {entry.label}{entry.kind === "music" ? " music" : ""} ×{entry.count}
              <span className="font-normal">· {entry.chapters.size} ch.</span>
              {!on && <span className="sr-only">(switched off)</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Book-wide music and mixing controls. */
export function MusicSettingsPanel({ projectId, data }: { projectId: string; data: Overview }) {
  const refresh = useRefresh(projectId);
  const save = trpc.studio.updateSoundOptions.useMutation({
    onSuccess: refresh,
    onError: error => toast.error(error.message || "Prosecast could not save the music settings."),
  });
  const options = data.options;
  const update = (patch: SoundOptions) => save.mutate({ projectId, options: patch });
  const musicTags = data.tags.filter(tag => tag.kind === "music");
  const ownTracks = data.assets.filter(asset => asset.kind === "music");
  const track = options.bedAssetId ? `asset:${options.bedAssetId}` : `tag:${options.bedTag}`;
  const usesTrack = options.musicMode === "bed" || options.intro.enabled || options.outro.enabled;

  return (
    <div className={`${ui.card} min-w-0`}>
      <span className={ui.eyebrow}>MUSIC AND MIX</span>
      {!data.settings.music && <p className={`mt-2 text-[11px] leading-5 ${ui.muted}`}>Background music is off. These settings apply when you turn it on.</p>}

      <fieldset className="mt-3">
        <legend className={ui.label}>Music style</legend>
        <div className="grid gap-2">
          {([["swells", "Scene swells", "A few seconds of music as each scene opens, matched to its mood."], ["bed", "Continuous bed", "One track under the whole chapter, dipping whenever someone speaks."]] as const).map(([value, label, detail]) => (
            <label key={value} className={`flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 ${options.musicMode === value ? "border-[#9fc6bb] bg-[#eef7f2]" : "border-[#e3e8e2] bg-white"}`}>
              <input type="radio" name="music-mode" className="mt-0.5 accent-[#3f817a]" checked={options.musicMode === value} onChange={() => update({ musicMode: value })} />
              <span><strong className="block text-xs text-[#34484b]">{label}</strong><span className={`text-[11px] leading-4 ${ui.muted}`}>{detail}</span></span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="mt-3 block text-xs">
        <span className={ui.label}>Track for the bed, intro and outro</span>
        <select
          className="input select"
          value={track}
          onChange={event => {
            const [kind, value] = event.target.value.split(":") as ["tag" | "asset", string];
            update(kind === "asset" ? { bedAssetId: value } : { bedTag: value, bedAssetId: null });
          }}
        >
          <optgroup label="Library">
            {musicTags.map(tag => <option key={tag.tag} value={`tag:${tag.tag}`}>{tag.label} music</option>)}
          </optgroup>
          {ownTracks.length > 0 && (
            <optgroup label="Your tracks">
              {ownTracks.map(asset => <option key={asset.id} value={`asset:${asset.id}`}>{asset.title}</option>)}
            </optgroup>
          )}
        </select>
        {!usesTrack && <span className={`mt-1 block text-[10px] ${ui.faint}`}>Used when the bed, intro or outro is on. Scene swells pick music by each scene's mood.</span>}
      </label>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <ToggleSeconds label="Intro" value={options.intro} limits={SOUND_OPTION_LIMITS.introSeconds} onChange={intro => update({ intro })} hint="Music alone before the first line" />
        <ToggleSeconds label="Outro" value={options.outro} limits={SOUND_OPTION_LIMITS.outroSeconds} onChange={outro => update({ outro })} hint="Music alone after the last line" />
      </div>

      <div className="mt-4 space-y-3">
        <DeferredRange id="music-gain" label="Music volume" value={options.musicGainDb} min={SOUND_OPTION_LIMITS.gainDb.min} max={SOUND_OPTION_LIMITS.gainDb.max} step={1} format={db} onCommit={musicGainDb => update({ musicGainDb })} hint="On top of the level chosen above." />
        <DeferredRange id="sfx-gain" label="Effects volume" value={options.sfxGainDb} min={SOUND_OPTION_LIMITS.gainDb.min} max={SOUND_OPTION_LIMITS.gainDb.max} step={1} format={db} onCommit={sfxGainDb => update({ sfxGainDb })} hint="Raise this if the effects are too quiet to notice." />
        <DeferredRange id="music-fade-in" label="Music fade in" value={options.musicFadeInMs} min={SOUND_OPTION_LIMITS.fadeInMs.min} max={SOUND_OPTION_LIMITS.fadeInMs.max} step={100} format={seconds} onCommit={musicFadeInMs => update({ musicFadeInMs })} />
        <DeferredRange id="music-fade-out" label="Music fade out" value={options.musicFadeOutMs} min={SOUND_OPTION_LIMITS.fadeOutMs.min} max={SOUND_OPTION_LIMITS.fadeOutMs.max} step={100} format={seconds} onCommit={musicFadeOutMs => update({ musicFadeOutMs })} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <label className="block min-w-0">
          <span className={ui.label}>Dip under the voice</span>
          <select className="input select" value={options.duck} onChange={event => update({ duck: event.target.value as SoundOptions["duck"] })}>
            <option value="light">Light</option>
            <option value="medium">Medium</option>
            <option value="strong">Strong</option>
          </select>
        </label>
        <label className="block min-w-0">
          <span className={ui.label}>Effect length</span>
          <select className="input select" value={options.effectLength} onChange={event => update({ effectLength: event.target.value as SoundOptions["effectLength"] })}>
            <option value="short">Short (1.6 s)</option>
            <option value="medium">Medium (3 s)</option>
            <option value="long">Long (6 s)</option>
          </select>
        </label>
      </div>
      {save.isPending && <p className={`mt-2 text-[11px] ${ui.faint}`} aria-live="polite">Saving…</p>}
    </div>
  );
}

/** A slider that saves when released, not on every step. */
function DeferredRange(props: { id: string; label: string; value: number; min: number; max: number; step: number; format: (value: number) => string; onCommit: (value: number) => void; hint?: string }) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? props.value;
  const commit = () => {
    if (draft !== null && draft !== props.value) props.onCommit(draft);
    setDraft(null);
  };
  return (
    <div onPointerUp={commit} onKeyUp={commit}>
      <RangeField id={props.id} label={props.label} value={shown} min={props.min} max={props.max} step={props.step} format={props.format} hint={props.hint} onChange={setDraft} />
    </div>
  );
}

function ToggleSeconds({ label, value, limits, onChange, hint }: { label: string; value: { enabled: boolean; seconds: number }; limits: { min: number; max: number }; onChange: (value: { enabled: boolean; seconds: number }) => void; hint: string }) {
  const id = `toggle-${label.toLowerCase()}`;
  return (
    <div className="min-w-0 rounded-xl border border-[#e3e8e2] bg-white p-2.5">
      <label htmlFor={id} className="flex items-center justify-between gap-2 text-xs font-bold text-[#34484b]">
        {label}
        <input id={id} type="checkbox" className="h-4 w-4 accent-[#3f817a]" checked={value.enabled} onChange={event => onChange({ ...value, enabled: event.target.checked })} />
      </label>
      <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[#5d7072]">
        <input
          type="number"
          className="w-16 rounded-lg border border-[#dce4dd] bg-white px-2 py-1"
          min={limits.min}
          max={limits.max}
          value={value.seconds}
          disabled={!value.enabled}
          aria-label={`${label} length in seconds`}
          onChange={event => {
            const next = Math.min(limits.max, Math.max(limits.min, Math.round(Number(event.target.value) || limits.min)));
            onChange({ ...value, seconds: next });
          }}
        /> s
      </label>
      <span className={`mt-1 block text-[10px] leading-4 ${ui.faint}`}>{hint}</span>
    </div>
  );
}

/** One chapter without music, or with its own track. */
export function ChapterMusicSelect({ projectId, chapter, data }: { projectId: string; chapter: Chapter; data: Overview }) {
  const refresh = useRefresh(projectId);
  const save = trpc.studio.updateChapterSoundOptions.useMutation({ onSuccess: refresh, onError: error => toast.error(error.message || "Prosecast could not save that.") });
  const options = chapter.soundOptions;
  const value = options?.music === "off" ? "off" : options?.bedAssetId ? `asset:${options.bedAssetId}` : options?.bedTag ? `tag:${options.bedTag}` : "inherit";
  return (
    <span className="min-w-0 text-[11px]">
      <select
        aria-label={`Music in ${chapter.title}`}
        className={`${compactSelect} max-w-[180px]`}
        value={value}
        disabled={save.isPending}
        onClick={event => event.stopPropagation()}
        onChange={event => {
          const next = event.target.value;
          if (next === "inherit") save.mutate({ projectId, chapterId: chapter.id, music: "inherit", bedTag: null, bedAssetId: null });
          else if (next === "off") save.mutate({ projectId, chapterId: chapter.id, music: "off" });
          else {
            const [kind, id] = next.split(":") as ["tag" | "asset", string];
            save.mutate({ projectId, chapterId: chapter.id, music: "inherit", bedTag: kind === "tag" ? id : null, bedAssetId: kind === "asset" ? id : null });
          }
        }}
      >
        <option value="inherit">Music: book default</option>
        <option value="off">Music: off in this chapter</option>
        {data.tags.filter(tag => tag.kind === "music").map(tag => <option key={tag.tag} value={`tag:${tag.tag}`}>Music: {tag.label}</option>)}
        {data.assets.filter(asset => asset.kind === "music").map(asset => <option key={asset.id} value={`asset:${asset.id}`}>Music: {asset.title}</option>)}
      </select>
    </span>
  );
}

/** Placement, timing, length, own sound and removal for one cue. */
export function CueExtras({ projectId, cue, data }: { projectId: string; cue: Cue; data: Overview }) {
  const refresh = useRefresh(projectId);
  const edit = trpc.studio.editSoundCue.useMutation({ onSuccess: refresh, onError: error => toast.error(error.message || "Prosecast could not change that sound.") });
  const remove = trpc.studio.removeSoundCue.useMutation({ onSuccess: () => { refresh(); toast("Sound removed."); }, onError: error => toast.error(error.message || "Prosecast could not remove that sound.") });
  const own = data.assets.filter(asset => asset.kind === cue.kind);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
      <select aria-label={`When ${cue.label} plays`} className={compactSelect} value={cue.placement} onChange={event => edit.mutate({ projectId, cueId: cue.id, placement: event.target.value as "before" | "after" })}>
        <option value="after">After the line</option>
        <option value="before">Before the line</option>
      </select>
      <select aria-label={`Nudge ${cue.label}`} className={compactSelect} value={cue.offsetMs} onChange={event => edit.mutate({ projectId, cueId: cue.id, offsetMs: Number(event.target.value) })}>
        {[-2000, -1000, -500, 0, 500, 1000, 2000, 3000, 5000].map(value => <option key={value} value={value}>{value === 0 ? "On time" : `${value > 0 ? "+" : ""}${value / 1000} s`}</option>)}
      </select>
      <select aria-label={`Length of ${cue.label}`} className={compactSelect} value={cue.lengthMs ?? ""} onChange={event => edit.mutate({ projectId, cueId: cue.id, lengthMs: event.target.value ? Number(event.target.value) : null })}>
        <option value="">Natural length</option>
        {[1000, 2000, 3000, 5000, 8000, 12000, 20000, 30000].map(value => <option key={value} value={value}>{value / 1000} s</option>)}
      </select>
      {own.length > 0 && (
        <select aria-label={`Use one of your own sounds for ${cue.label}`} className={compactSelect} value={cue.custom ? cue.assetId ?? "" : ""} onChange={event => event.target.value && edit.mutate({ projectId, cueId: cue.id, assetId: event.target.value })}>
          <option value="">{cue.custom ? "Your sound" : "Use your own sound…"}</option>
          {own.map(asset => <option key={asset.id} value={asset.id}>{asset.title}</option>)}
        </select>
      )}
      <button type="button" className="inline-flex min-h-[24px] items-center gap-1 rounded-lg px-2 py-1 text-[#8f4a36] hover:bg-[#fbe9e4] disabled:opacity-40" disabled={remove.isPending} onClick={() => remove.mutate({ projectId, cueId: cue.id })} aria-label={`Remove ${cue.label}`}>
        <Trash2 aria-hidden="true" size={11} /><span className={ui.linkText}>Remove</span>
      </button>
    </div>
  );
}

/** Adds a sound at any line of a chapter. */
export function AddCueForm({ projectId, chapter, data }: { projectId: string; chapter: Chapter; data: Overview }) {
  const refresh = useRefresh(projectId);
  const [open, setOpen] = useState(false);
  const [line, setLine] = useState(chapter.lines[0]?.id ?? "");
  const [kind, setKind] = useState<"sfx" | "music">("sfx");
  const [sound, setSound] = useState("");
  const [placement, setPlacement] = useState<"before" | "after">("after");
  const add = trpc.studio.addSoundCue.useMutation({
    onSuccess: () => { refresh(); toast.success("Sound added. Prepare the sounds to hear it in a mix."); setOpen(false); setSound(""); },
    onError: error => toast.error(error.message || "Prosecast could not add that sound."),
  });
  if (!chapter.lines.length) return null;
  const tags = data.tags.filter(tag => tag.kind === kind);
  const own = data.assets.filter(asset => asset.kind === kind);
  if (!open) {
    return (
      <button type="button" className={`m-3 ${ui.linkButton}`} onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" size={12} /><span className={ui.linkText}>Add a sound at a line</span>
      </button>
    );
  }
  return (
    <form
      className="m-3 grid grid-cols-1 gap-2 rounded-xl border border-[#d8e4dd] bg-white p-3 text-xs sm:grid-cols-2"
      onSubmit={event => {
        event.preventDefault();
        if (!line || !sound) return;
        const [source, id] = sound.split(":") as ["tag" | "asset", string];
        add.mutate({ projectId, segmentId: line, kind, placement, ...(source === "asset" ? { assetId: id } : { tag: id }) });
      }}
    >
      <label className="block min-w-0 sm:col-span-2">
        <span className={ui.label}>Line</span>
        <select className="input select" value={line} onChange={event => setLine(event.target.value)}>
          {chapter.lines.map(item => <option key={item.id} value={item.id}>{item.index + 1}. {item.text.slice(0, 90)}</option>)}
        </select>
      </label>
      <label className="block min-w-0">
        <span className={ui.label}>Kind</span>
        <select className="input select" value={kind} onChange={event => { setKind(event.target.value as "sfx" | "music"); setSound(""); }}>
          <option value="sfx">Sound effect</option>
          <option value="music">Music swell</option>
        </select>
      </label>
      <label className="block min-w-0">
        <span className={ui.label}>When</span>
        <select className="input select" value={placement} onChange={event => setPlacement(event.target.value as "before" | "after")}>
          <option value="after">After the line</option>
          <option value="before">Before the line</option>
        </select>
      </label>
      <label className="block min-w-0 sm:col-span-2">
        <span className={ui.label}>Sound</span>
        <select className="input select" value={sound} onChange={event => setSound(event.target.value)} required>
          <option value="">Choose a sound…</option>
          <optgroup label="Library">{tags.map(tag => <option key={tag.tag} value={`tag:${tag.tag}`}>{tag.label}</option>)}</optgroup>
          {own.length > 0 && <optgroup label="Your sounds">{own.map(asset => <option key={asset.id} value={`asset:${asset.id}`}>{asset.title}</option>)}</optgroup>}
        </select>
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" className="btn-primary" disabled={!sound || add.isPending}>{add.isPending && <LoaderCircle aria-hidden="true" className="animate-spin" size={13} />} Add sound</button>
        <button type="button" className="btn-soft" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

/** The book's own sounds: upload a file, or describe one for ElevenLabs to make. */
export function SoundLibraryPanel({ projectId, data }: { projectId: string; data: Overview }) {
  const refresh = useRefresh(projectId);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const preview = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [uploadKind, setUploadKind] = useState<"sfx" | "music">("music");
  const [generate, setGenerate] = useState<{ kind: "sfx" | "music"; title: string; prompt: string; seconds: number; loop: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const upload = trpc.studio.uploadSound.useMutation({
    onSuccess: result => { refresh(); toast.success(`${result.title} added to your sounds.`); },
    onError: error => toast.error(error.message || "Prosecast could not add that file."),
  });
  const make = trpc.studio.generateSound.useMutation({
    onSuccess: result => { refresh(); toast.success(`${result.title} is ready.`); setGenerate(null); setConfirming(false); },
    onError: error => { toast.error(error.message || "ElevenLabs could not make that sound."); setConfirming(false); },
  });

  const choose = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) { toast.error("Sound files can be up to 15 MB."); return; }
    if (!/\.(mp3|wav)$/i.test(file.name)) { toast.error("Use an MP3 or WAV file."); return; }
    const base64 = await readFileAsBase64(file);
    upload.mutate({ projectId, kind: uploadKind, title: file.name.replace(/\.[^.]+$/, "").slice(0, 120), filename: file.name, base64 });
  };

  const toggle = (id: string, url: string) => {
    const element = preview.current;
    if (!element) return;
    if (playing === id) { element.pause(); setPlaying(null); return; }
    element.src = url;
    void element.play().then(() => setPlaying(id)).catch(() => setPlaying(null));
  };

  return (
    <div className={`${ui.card} min-w-0`}>
      <audio ref={preview} onEnded={() => setPlaying(null)} onPause={() => setPlaying(null)} className="hidden" />
      <span className={ui.eyebrow}>YOUR SOUNDS</span>
      <p className={`mt-2 text-[11px] leading-5 ${ui.muted}`}>Upload your own music or effects, or describe one for ElevenLabs to make. Use them for the bed, a chapter, or any cue.</p>

      {data.assets.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {data.assets.map(asset => (
            <li key={asset.id} className="flex items-center gap-2 rounded-xl border border-[#e8ece6] bg-[#fbfcf9] px-2.5 py-2">
              <button type="button" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-[#d8e4dd] bg-white text-[#37746d]" onClick={() => toggle(asset.id, asset.url)} aria-label={playing === asset.id ? `Stop ${asset.title}` : `Play ${asset.title}`}>
                {playing === asset.id ? <Pause aria-hidden="true" size={11} /> : <Play aria-hidden="true" size={11} />}
              </button>
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[#34484b]">{asset.title}</span>
              <Badge tone={asset.kind === "music" ? "warn" : "info"}>{asset.kind === "music" ? "Music" : "Effect"}</Badge>
              <span className={`text-[10px] ${ui.faint} ${ui.numbers}`}>{seconds(asset.durationMs)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
        <select className={compactSelect} value={uploadKind} onChange={event => setUploadKind(event.target.value as "sfx" | "music")} aria-label="Kind of file to upload">
          <option value="music">Music track</option>
          <option value="sfx">Sound effect</option>
        </select>
        <button type="button" className="btn-soft px-3 py-2" onClick={() => fileInput.current?.click()} disabled={upload.isPending}>
          {upload.isPending ? <LoaderCircle aria-hidden="true" className="animate-spin" size={13} /> : <Upload aria-hidden="true" size={13} />} Upload MP3 or WAV
        </button>
        <input ref={fileInput} type="file" accept=".mp3,.wav,audio/mpeg,audio/wav" className="hidden" onChange={event => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
        <button type="button" className="btn-soft px-3 py-2" onClick={() => setGenerate({ kind: "music", title: "", prompt: "", seconds: 30, loop: true })} disabled={!data.availability.elevenLabs} title={data.availability.elevenLabs ? "Describe a sound for ElevenLabs to make" : "Connect ElevenLabs in Settings"}>
          <Wand2 aria-hidden="true" size={13} /> Generate
        </button>
      </div>

      {generate && (
        <form className="mt-3 grid grid-cols-1 gap-2 rounded-xl border border-[#d8e4dd] bg-white p-3 text-xs" onSubmit={event => { event.preventDefault(); setConfirming(true); }}>
          <label className="block min-w-0">
            <span className={ui.label}>Kind</span>
            <select className="input select" value={generate.kind} onChange={event => setGenerate({ ...generate, kind: event.target.value as "sfx" | "music", loop: event.target.value === "music" })}>
              <option value="music">Music track (loops)</option>
              <option value="sfx">Sound effect</option>
            </select>
          </label>
          <label className="block min-w-0">
            <span className={ui.label}>Name</span>
            <input className="input" value={generate.title} maxLength={120} required onChange={event => setGenerate({ ...generate, title: event.target.value })} placeholder="Harbour at dusk" />
          </label>
          <label className="block min-w-0">
            <span className={ui.label}>Describe it</span>
            <textarea className="input min-h-16" value={generate.prompt} maxLength={450} required onChange={event => setGenerate({ ...generate, prompt: event.target.value })} placeholder="Soft felt piano and distant gulls, slow and wistful" />
          </label>
          <RangeField id="generate-seconds" label="Length" value={generate.seconds} min={1} max={30} step={1} format={value => `${value} s`} onChange={value => setGenerate({ ...generate, seconds: value })} />
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={!generate.title.trim() || generate.prompt.trim().length < 3}>Generate</button>
            <button type="button" className="btn-soft" onClick={() => setGenerate(null)}>Cancel</button>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={confirming && Boolean(generate)}
        onOpenChange={setConfirming}
        title={`Generate “${generate?.title ?? ""}”?`}
        description="ElevenLabs makes the sound from your description. It is stored with the book and can be used anywhere in the mix."
        cost={generate ? `About ${(generate.seconds * 40).toLocaleString()} ElevenLabs credits (40 per second, ${generate.seconds} s). This is a paid request.` : null}
        confirmLabel="Generate sound"
        pending={make.isPending}
        onConfirm={() => generate && make.mutate({ projectId, ...generate, title: generate.title.trim(), prompt: generate.prompt.trim() })}
      />
    </div>
  );
}
