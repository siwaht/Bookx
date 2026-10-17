import { useMemo, useState } from "react";
import { BookOpenText, Check, ChevronDown, LoaderCircle, Play, RefreshCw, Search, Sparkles, Trash2, Volume2, Wand2, X } from "lucide-react";
import { filterVoices, voiceFacets } from "@shared/voicePicker";
import { StepTiming } from "./studio/StepTiming";

export type CastingCharacter = {
  id?: string;
  name: string;
  role: string;
  voice: string;
  accent: string;
  color: string;
  voiceId?: string;
  rationale?: string;
  sampleLine?: string;
  confidence?: number;
  previewUrl?: string;
  isNarrator?: boolean;
  lineCount?: number;
  gender?: string | null;
  ageGroup?: string | null;
  description?: string | null;
  assignmentSource?: "manual" | "llm" | "auto";
  /** Lines this character already has audio for in a different voice. */
  pendingVoiceLines?: number;
};

export type VoiceChoice = { id: string; name: string; detail: string; color: string; gender?: string | null; age?: string | null; accent?: string | null; useCase?: string | null };

export type CastAnalysisState = {
  status: "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";
  percent: number;
  message: string | null;
  errors: string[];
  jobId: string | null;
  /** Step counts and start time, for the time-left estimate. */
  totalSteps?: number;
  completedSteps?: number;
  startedAt?: string | null;
};

type NarrationStyle = "single" | "cast" | "narrator-cast";
type TraitKind = "gender" | "age" | "accent";

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "character";

/** The catalogs are structural; the picker only needs these fields. */
const pickable = (voices: readonly VoiceChoice[]) =>
  voices.map((voice) => ({ id: voice.id, label: voice.name, description: voice.detail, gender: voice.gender, age: voice.age, accent: voice.accent, useCase: voice.useCase }));

const CAN_PREVIEW_ON_LINE = "Plays this character's own line from your manuscript in the candidate voice.";

export function CastingReview({
  characters,
  voices,
  voicesLoading,
  allVoices,
  query,
  setQuery,
  onAutoCast,
  onAddCharacter,
  onPreview,
  onPreviewVoice,
  onPreviewVoiceFor,
  onVoiceChange,
  isCasting,
  modelLabel,
  prompt,
  setPrompt,
  onFindSimilar,
  libraryPreviewUrls,
  analysis,
  onCancelAnalysis,
  narrationStyle,
  onNarrationStyleChange,
  onAssignDefaults,
  assigningDefaults,
  onRemoveCharacter,
}: {
  characters: CastingCharacter[];
  voices: VoiceChoice[];
  voicesLoading?: boolean;
  /** The whole connected catalog, independent of the library search. */
  allVoices?: VoiceChoice[];
  query: string;
  setQuery: (value: string) => void;
  onAutoCast: () => void;
  onAddCharacter: () => void;
  onPreview: (character: CastingCharacter) => void;
  onPreviewVoice: (voice: VoiceChoice) => void;
  /** Preview a candidate voice on this character's own line, before committing. */
  onPreviewVoiceFor?: (character: CastingCharacter, voice: VoiceChoice) => void;
  onVoiceChange: (name: string, voice: VoiceChoice) => void;
  isCasting: boolean;
  modelLabel: string;
  prompt: string;
  setPrompt: (value: string) => void;
  onFindSimilar: () => void;
  libraryPreviewUrls: Record<string, string>;
  analysis?: CastAnalysisState | null;
  onCancelAnalysis?: () => void;
  narrationStyle?: NarrationStyle;
  onNarrationStyleChange?: (style: NarrationStyle) => void;
  onAssignDefaults?: () => void;
  assigningDefaults?: boolean;
  onRemoveCharacter?: (character: CastingCharacter) => void;
}) {
  const running = analysis?.status === "running" || analysis?.status === "queued";
  const multiVoice = narrationStyle !== "single";
  const speakingCharacters = characters.filter(character => !character.isNarrator).length;

  // Which character's picker is open, and the picker's own filters. Kept apart
  // from the library search so browsing the catalog never changes which voices a
  // character's list contains.
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [traits, setTraits] = useState<{ gender: string | null; age: string | null; accent: string | null }>({ gender: null, age: null, accent: null });

  const openVoices = allVoices?.length ? allVoices : voices;
  const facets = useMemo(() => voiceFacets(pickable(openVoices)), [openVoices]);
  const candidates = useMemo(
    () => filterVoices(pickable(openVoices), { query: pickerQuery, ...traits }),
    [openVoices, pickerQuery, traits],
  );
  const traitButtons: Array<{ kind: TraitKind; value: string }> = [
    ...facets.genders.map(value => ({ kind: "gender" as const, value })),
    ...facets.ages.map(value => ({ kind: "age" as const, value })),
    ...facets.accents.map(value => ({ kind: "accent" as const, value })),
  ];
  const toggleTrait = (kind: TraitKind, value: string) =>
    setTraits(current => ({ ...current, [kind]: current[kind] === value ? null : value }));

  const openPicker = (key: string) => {
    setPickerFor(current => (current === key ? null : key));
    setPickerQuery("");
    setTraits({ gender: null, age: null, accent: null });
  };
  const assign = (character: CastingCharacter, voice: VoiceChoice) => {
    onVoiceChange(character.name, voice);
    setPickerFor(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-5 border-b border-stone-150 bg-paper px-6 py-7 md:flex-row md:items-end md:justify-between md:px-9">
        <div className="min-w-0">
          <span className="eyebrow text-brand-600">02 · MULTI-CAST</span>
          <h1 className="serif mt-2 text-[34px] leading-[1.1] tracking-[-.02em] text-ink-950">Cast every voice with intent.</h1>
          <p className="mt-2.5 max-w-2xl text-sm leading-6 text-ink-500">Prosecast reads the whole book, finds everyone who speaks, decides who says each line, and gives each character a distinct voice from your connected catalog. Change any voice — search the whole catalog, hear it on that character's own line, then use it. Your choices are never overwritten.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onAssignDefaults && (
            <button onClick={onAssignDefaults} disabled={assigningDefaults || running} className="btn-soft disabled:opacity-50" title="Pick fresh default voices for every character you have not cast yourself">
              {assigningDefaults ? <LoaderCircle className="mr-1 inline animate-spin" size={14} /> : <RefreshCw className="mr-1 inline" size={14} />}
              Default voices
            </button>
          )}
          <button onClick={onAutoCast} disabled={isCasting || running} className="btn-primary disabled:cursor-wait disabled:opacity-70">
            {isCasting || running ? <LoaderCircle className="mr-1.5 inline animate-spin" size={15} /> : <Wand2 className="mr-1.5 inline" size={15} />}
            {isCasting || running ? "Reading the book…" : characters.length ? "Re-analyze the book" : "Analyze the book"}
          </button>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0 overflow-auto p-6 md:p-9">
          {onNarrationStyleChange && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-stone-150 bg-paper px-5 py-4 shadow-hairline">
              <div>
                <strong className="text-sm font-semibold text-ink-900">Who speaks the dialogue</strong>
                <p className="mt-0.5 text-xs text-ink-500">{multiVoice ? "The narrator reads the story; each character speaks their own lines." : "One narrator reads everything, dialogue included."}</p>
              </div>
              <div role="radiogroup" aria-label="Narration style" className="flex rounded-xl bg-stone-100 p-1">
                {([["single", "Single narrator"], ["narrator-cast", "Narrator + cast"]] as const).map(([value, label]) => {
                  const active = value === "single" ? !multiVoice : multiVoice;
                  return (
                    <button key={value} role="radio" aria-checked={active} onClick={() => !active && onNarrationStyleChange(value)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${active ? "bg-white text-brand-800 shadow-soft ring-1 ring-stone-150" : "text-ink-500 hover:text-ink-800"}`}>{label}</button>
                  );
                })}
              </div>
            </div>
          )}

          {analysis && analysis.status !== "idle" && (
            <div role="status" className={`mb-4 rounded-2xl border px-4 py-3 ${analysis.status === "failed" ? "border-clay-200 bg-clay-50" : "border-brand-100 bg-brand-50"}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <strong className={`block text-sm ${analysis.status === "failed" ? "text-clay-700" : "text-brand-700"}`}>
                    {running ? "Reading the book" : analysis.status === "completed" ? "Cast ready" : analysis.status === "cancelled" ? "Analysis stopped" : "Analysis did not finish"}
                  </strong>
                  <span className="block text-xs text-ink-500">{analysis.message}</span>
                  {running && <StepTiming run={analysis} />}
                </div>
                {running && onCancelAnalysis && (
                  <button onClick={onCancelAnalysis} aria-label="Stop the analysis" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-500 hover:bg-brand-50"><X size={14} /></button>
                )}
              </div>
              {running && (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-brand-100">
                  <div className="h-full rounded-full bg-brand-400 transition-[width] duration-500" style={{ width: `${Math.max(4, analysis.percent)}%` }} />
                </div>
              )}
              {analysis.errors.length > 0 && !running && (
                <details className="mt-2 text-2xs text-gold-700">
                  <summary className="cursor-pointer font-semibold">{analysis.errors.length} note{analysis.errors.length === 1 ? "" : "s"}</summary>
                  <ul className="mt-1 space-y-1">{analysis.errors.slice(-6).map((error, index) => <li key={index}>{error}</li>)}</ul>
                </details>
              )}
            </div>
          )}

          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-100 bg-brand-50/70 px-5 py-4">
            <div className="flex min-w-0 items-start gap-3"><span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-brand-600 ring-1 ring-brand-100"><Sparkles aria-hidden="true" size={15} /></span><div className="min-w-0"><strong className="text-sm font-semibold text-brand-800">Model-assisted casting</strong><p className="mt-0.5 break-words text-xs text-ink-500">Using {modelLabel}. Voices are matched on gender, age, accent and manner as the book describes them.</p></div></div>
            <span className="eyebrow rounded-full bg-white px-3 py-1 text-brand-700 ring-1 ring-brand-100">{speakingCharacters} CHARACTER{speakingCharacters === 1 ? "" : "S"}</span>
          </div>

          {characters.length === 0 ? (
            <div className="rounded-card border border-dashed border-stone-300 bg-paper p-10 text-center">
              <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-brand-50 text-brand-600 ring-1 ring-brand-100"><BookOpenText aria-hidden="true" size={22} /></span>
              <h3 className="serif text-[24px] leading-tight text-ink-950">No cast yet</h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-500">Analyze the book and Prosecast will find every speaking character, attribute their lines and suggest a voice for each. You can also add speakers yourself.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {characters.map((character) => {
                const key = character.id || character.name;
                const pickerId = `voice-picker-${slug(key)}`;
                const open = pickerFor === key;
                const facts = [character.gender, character.ageGroup].filter(Boolean).join(" · ");
                const pending = character.pendingVoiceLines ?? 0;
                return (
                  <article key={key} className={`rounded-card border bg-paper p-5 shadow-soft transition hover:shadow-lift ${character.isNarrator ? "border-brand-200" : "border-stone-150"}`}>
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                      <span className="serif grid h-12 w-12 shrink-0 place-items-center rounded-full text-xl text-white shadow-[inset_0_1px_0_rgb(255_255_255/.25),0_4px_10px_-4px_rgb(18_33_37/.35)] ring-2 ring-white" style={{ background: character.color }}>{character.name.slice(0, 1)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-[15px] font-semibold text-ink-950">{character.name}</h3>
                          <span className={`rounded-full px-2 py-0.5 text-3xs font-medium ${character.isNarrator ? "bg-brand-50 text-brand-700 ring-1 ring-brand-100" : "bg-stone-50 text-ink-600 ring-1 ring-stone-150"}`}>{character.isNarrator ? "Narrator" : character.role}</span>
                          {facts && <span className="text-3xs capitalize text-ink-500">{facts}</span>}
                          {character.lineCount ? <span className="text-3xs text-ink-500">{character.lineCount.toLocaleString()} {character.isNarrator ? "passages" : `line${character.lineCount === 1 ? "" : "s"}`}</span> : null}
                          {character.assignmentSource === "manual" ? <span className="text-3xs font-semibold text-gold-700">Your choice</span> : character.confidence !== undefined ? <span className="text-3xs text-brand-600">{character.confidence}% match</span> : null}
                        </div>
                        {character.description && <p className="mt-1 text-xs text-ink-500">{character.description}</p>}
                        <p className="mt-1 text-xs text-ink-500">{character.rationale || (character.voiceId ? `${character.accent} delivery selected to keep this character distinct.` : "No voice yet. Pick one below or use Default voices.")}</p>
                        {character.sampleLine && <p className="serif mt-3 line-clamp-2 border-l-2 border-gold-300 pl-3 text-[15px] italic leading-6 text-ink-600">{character.sampleLine}</p>}
                        {character.previewUrl && <audio controls preload="none" src={character.previewUrl} className="mt-3 h-8 w-full max-w-sm" aria-label={`${character.name} generated voice preview`} />}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button onClick={() => onPreview(character)} disabled={!character.voiceId} aria-label={`Preview ${character.name}'s current voice`} title="Hear the voice this character speaks with now" className="grid h-9 w-9 place-items-center rounded-xl border border-brand-100 bg-brand-50 text-brand-700 transition hover:border-brand-200 hover:bg-brand-100 disabled:opacity-40"><Play size={15} /></button>
                        {onRemoveCharacter && !character.isNarrator && (
                          <button onClick={() => onRemoveCharacter(character)} aria-label={`Remove ${character.name}`} className="grid h-9 w-9 place-items-center rounded-xl text-ink-500 transition hover:bg-clay-50 hover:text-clay-600"><Trash2 size={14} /></button>
                        )}
                        <Volume2 aria-hidden="true" size={15} className="text-ink-400" />
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-stone-100 pt-3">
                      <button onClick={() => openPicker(key)} aria-expanded={open} aria-controls={pickerId} className="btn-soft inline-flex items-center gap-1.5">
                        <ChevronDown aria-hidden="true" size={13} className={`transition ${open ? "rotate-180" : ""}`} />
                        Change voice
                      </button>
                      <span className="text-xs text-ink-600">Now: <strong className="font-semibold text-ink-900">{character.voice || "no voice"}</strong>{character.accent ? ` · ${character.accent}` : ""}</span>
                      {pending > 0 && (
                        <span className="rounded-full bg-gold-50 px-2 py-0.5 text-3xs font-semibold text-gold-700 ring-1 ring-gold-200" title={`${pending.toLocaleString()} line(s) already have audio in another voice; the next run re-renders only those`}>
                          {pending.toLocaleString()} line{pending === 1 ? "" : "s"} will re-render in this voice
                        </span>
                      )}
                    </div>
                    {open && (
                      <div id={pickerId} className="mt-3 rounded-2xl border border-brand-100 bg-brand-50/40 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="relative min-w-[200px] flex-1">
                            <Search aria-hidden="true" className="absolute left-3 top-2.5 text-ink-400" size={14} />
                            <input type="search" autoFocus value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} aria-label={`Search voices for ${character.name}`} placeholder="Search the whole catalog: name, accent, age, or a voice ID" className="input py-2 pl-9 pr-3 text-xs" />
                          </span>
                          <button onClick={() => setPickerFor(null)} className="rounded-lg px-2 py-1.5 text-xs font-semibold text-ink-500 transition hover:bg-white hover:text-ink-800">Close</button>
                        </div>
                        {traitButtons.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {traitButtons.map(({ kind, value }) => {
                              const active = traits[kind] === value;
                              return (
                                <button key={`${kind}-${value}`} role="checkbox" aria-checked={active} onClick={() => toggleTrait(kind, value)} className={`rounded-full px-2.5 py-1 text-2xs font-semibold capitalize transition ${active ? "bg-brand-600 text-white" : "bg-white text-ink-600 ring-1 ring-stone-150 hover:ring-brand-200"}`}>{value}</button>
                              );
                            })}
                          </div>
                        )}
                        <ul className="mt-3 max-h-72 space-y-1.5 overflow-auto pr-0.5">
                          {candidates.slice(0, 60).map((candidate) => {
                            const voice = openVoices.find(item => item.id === candidate.id)!;
                            const current = voice.id === character.voiceId;
                            return (
                              <li key={voice.id} className={`flex flex-wrap items-center gap-2 rounded-xl border bg-white px-3 py-2 ${current ? "border-brand-300" : "border-stone-150"}`}>
                                <span className="min-w-[160px] flex-1">
                                  <strong className="flex items-center gap-1.5 truncate text-[13px] font-semibold text-ink-900">
                                    {voice.name}
                                    {current && <span className="inline-flex items-center gap-0.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-3xs font-semibold text-brand-700"><Check aria-hidden="true" size={10} /> current</span>}
                                  </strong>
                                  <span className="block truncate text-2xs text-ink-500">{voice.detail}</span>
                                  <code className="mono block truncate text-3xs text-ink-400">{voice.id}</code>
                                </span>
                                {onPreviewVoiceFor && <button onClick={() => onPreviewVoiceFor(character, voice)} disabled={!character.sampleLine} title={character.sampleLine ? CAN_PREVIEW_ON_LINE : "This character has no line from the book to read yet"} className="rounded-lg bg-brand-50 px-2.5 py-1.5 text-2xs font-semibold text-brand-700 ring-1 ring-brand-100 transition hover:bg-brand-100 disabled:opacity-40">Hear their line</button>}
                                <button onClick={() => assign(character, voice)} disabled={current} className="rounded-lg bg-brand-600 px-3 py-1.5 text-2xs font-semibold text-white transition hover:bg-brand-700 disabled:opacity-40">Use</button>
                              </li>
                            );
                          })}
                          {!candidates.length && <li className="rounded-xl border border-dashed border-stone-200 bg-white p-4 text-xs leading-5 text-ink-500">No voice matches those filters. Clear a filter or search for a different trait.</li>}
                        </ul>
                        <p className="mt-2 text-2xs leading-5 text-ink-500">Showing {Math.min(candidates.length, 60).toLocaleString()} of {openVoices.length.toLocaleString()} voices from the connected catalog{openVoices.length > 60 && candidates.length > 60 ? "; narrow the search to see the rest" : ""}.</p>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
        <aside className="min-w-0 border-t border-stone-150 bg-paper-50 p-5 lg:border-l lg:border-t-0 lg:overflow-auto">
          <div className="flex items-center justify-between"><span className="eyebrow text-ink-500">VOICE LIBRARY</span><button onClick={onAddCharacter} className="rounded-lg px-2 py-1 text-xs font-semibold text-brand-600 transition hover:bg-brand-50 hover:text-brand-800">+ Add speaker</button></div>
          <div className="relative mt-3"><Search aria-hidden="true" className="absolute left-3 top-3 text-ink-400" size={15} /><input id="voice-library-search" type="search" aria-label="Search voices by name, trait or voice ID" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search: female british calm, or a voice ID" className="input py-2.5 pl-9 pr-3" /></div>
          <div className="mt-3 rounded-xl border border-stone-150 bg-paper p-3"><label className="block text-2xs font-semibold text-ink-600">Describe the voice you need<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="e.g. calm, low-pitched male with a British accent" className="input mt-2 min-h-20 resize-y p-2.5 text-xs font-normal" /></label><button onClick={onFindSimilar} disabled={!prompt.trim()} className="btn-soft mt-2 w-full disabled:cursor-not-allowed disabled:opacity-50"><Sparkles className="mr-1 inline" size={13} /> Find similar voices</button></div>
          <div className="mt-4 space-y-2">{voicesLoading ? [0, 1, 2, 3].map((index) => <div key={index} aria-hidden="true" className="rounded-xl border border-stone-100 bg-white p-3"><div className="flex items-center gap-3"><span className="skeleton h-9 w-9 rounded-full" /><span className="min-w-0 flex-1"><span className="skeleton block h-3 w-24" /><span className="skeleton mt-2 block h-2.5 w-32" /></span></div></div>) : voices.length ? voices.slice(0, 60).map((voice) => <div key={voice.id} className="rounded-xl border border-stone-100 bg-white p-3 transition hover:border-brand-200 hover:shadow-soft"><div className="flex items-center gap-3"><span className="serif grid h-9 w-9 shrink-0 place-items-center rounded-full text-base text-white shadow-[inset_0_1px_0_rgb(255_255_255/.25)]" style={{ background: voice.color }}>{voice.name[0]}</span><span className="min-w-0 flex-1"><strong className="block truncate text-[13px] font-semibold text-ink-900">{voice.name}</strong><span className="block truncate text-2xs text-ink-500">{voice.detail}</span><code className="mono mt-1 block truncate text-3xs text-ink-500">{voice.id}</code></span><button onClick={() => onPreviewVoice(voice)} aria-label={`Test ${voice.name}`} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700 ring-1 ring-brand-100 transition hover:bg-brand-100"><Play size={14} /></button></div>{characters.length > 0 && <label className="mt-2 flex items-center gap-2 text-2xs font-semibold text-ink-600">Assign to
                            <select value="" onChange={(event) => { const name = event.target.value; const target = characters.find((character) => character.name === name); if (target) onVoiceChange(name, voice); }} aria-label={`Assign ${voice.name} to a character`} className="input select min-w-0 flex-1 py-1.5 text-2xs">
                              <option value="">Choose a character…</option>
                              {characters.map((character) => <option key={character.id || character.name} value={character.name}>{character.name}{character.voiceId === voice.id ? " (current)" : ""}</option>)}
                            </select>
                          </label>}{libraryPreviewUrls[voice.id] && <audio controls preload="none" src={libraryPreviewUrls[voice.id]} className="mt-3 h-8 w-full" aria-label={`${voice.name} voice test`} />}</div>) : <p className="rounded-xl border border-dashed border-stone-150 p-4 text-xs leading-5 text-ink-500">No voices matched that ID or description. Try fewer terms or a different provider voice ID.</p>}</div>
          <p className="mt-5 text-2xs leading-5 text-ink-500"><Sparkles className="mr-1 inline text-gold-500" size={13} /> Signed-in projects search the connected voice catalog. Before sign-in, Prosecast uses its starter library and clearly labels browser-only test playback.</p>
        </aside>
      </div>
    </div>
  );
}