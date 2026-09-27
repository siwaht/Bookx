import { BookOpenText, LoaderCircle, Play, RefreshCw, Search, Sparkles, Trash2, Volume2, Wand2, X } from "lucide-react";

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
};

export type VoiceChoice = { id: string; name: string; detail: string; color: string };

export type CastAnalysisState = {
  status: "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";
  percent: number;
  message: string | null;
  errors: string[];
  jobId: string | null;
};

type NarrationStyle = "single" | "cast" | "narrator-cast";

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "character";

/**
 * The option list for one character's assignment, guaranteed to contain the value
 * the `<select>` is controlled by. `voices` is the filtered search result, so the
 * assigned voice is frequently missing from it.
 */
function withAssignedVoice(character: CastingCharacter, voices: VoiceChoice[]): VoiceChoice[] {
  const assignedId = character.voiceId;
  if (!assignedId || voices.some((voice) => voice.id === assignedId)) return voices;
  const current: VoiceChoice = {
    id: assignedId,
    name: character.voice || assignedId,
    detail: "Current assignment",
    color: character.color,
  };
  return [current, ...voices];
}

export function CastingReview({
  characters,
  voices,
  voicesLoading,
  query,
  setQuery,
  onAutoCast,
  onAddCharacter,
  onPreview,
  onPreviewVoice,
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
  query: string;
  setQuery: (value: string) => void;
  onAutoCast: () => void;
  onAddCharacter: () => void;
  onPreview: (character: CastingCharacter) => void;
  onPreviewVoice: (voice: VoiceChoice) => void;
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-5 border-b border-[#e1e6de] bg-[#fffefa] px-6 py-6 md:flex-row md:items-end md:justify-between md:px-9">
        <div>
          <span className="mono text-[10px] tracking-[.14em] text-[#668c87]">02 · MULTI-CAST</span>
          <h1 className="serif mt-2 text-3xl text-[#294043]">Cast every voice with intent.</h1>
          <p className="mt-2 max-w-2xl text-sm text-[#728084]">Prosecast reads the whole book, finds everyone who speaks, decides who says each line, and gives each character a distinct voice from your connected catalog. Change any voice; your choices are never overwritten.</p>
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
      <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_330px]">
        <section className="overflow-auto p-6 md:p-9">
          {onNarrationStyleChange && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#e0e6dd] bg-[#fffefa] px-4 py-3">
              <div>
                <strong className="text-sm text-[#35494b]">Who speaks the dialogue</strong>
                <p className="mt-0.5 text-xs text-[#748285]">{multiVoice ? "The narrator reads the story; each character speaks their own lines." : "One narrator reads everything, dialogue included."}</p>
              </div>
              <div role="radiogroup" aria-label="Narration style" className="flex rounded-xl bg-[#eef2ed] p-1">
                {([["single", "Single narrator"], ["narrator-cast", "Narrator + cast"]] as const).map(([value, label]) => {
                  const active = value === "single" ? !multiVoice : multiVoice;
                  return (
                    <button key={value} role="radio" aria-checked={active} onClick={() => !active && onNarrationStyleChange(value)} className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${active ? "bg-white text-[#2f6d68] shadow-sm" : "text-[#6f7f81] hover:text-[#3c5052]"}`}>{label}</button>
                  );
                })}
              </div>
            </div>
          )}

          {analysis && analysis.status !== "idle" && (
            <div role="status" className={`mb-4 rounded-2xl border px-4 py-3 ${analysis.status === "failed" ? "border-[#edd3c8] bg-[#fff7f3]" : "border-[#dce9e2] bg-[#f1f8f4]"}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <strong className={`block text-sm ${analysis.status === "failed" ? "text-[#8a4f3a]" : "text-[#315a56]"}`}>
                    {running ? "Reading the book" : analysis.status === "completed" ? "Cast ready" : analysis.status === "cancelled" ? "Analysis stopped" : "Analysis did not finish"}
                  </strong>
                  <span className="block text-xs text-[#66807b]">{analysis.message}</span>
                </div>
                {running && onCancelAnalysis && (
                  <button onClick={onCancelAnalysis} aria-label="Stop the analysis" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[#66807b] hover:bg-[#e3efe9]"><X size={14} /></button>
                )}
              </div>
              {running && (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#dfe9e3]">
                  <div className="h-full rounded-full bg-[#5c9688] transition-[width] duration-500" style={{ width: `${Math.max(4, analysis.percent)}%` }} />
                </div>
              )}
              {analysis.errors.length > 0 && !running && (
                <details className="mt-2 text-[11px] text-[#8a6b5f]">
                  <summary className="cursor-pointer font-semibold">{analysis.errors.length} note{analysis.errors.length === 1 ? "" : "s"}</summary>
                  <ul className="mt-1 space-y-1">{analysis.errors.slice(-6).map((error, index) => <li key={index}>{error}</li>)}</ul>
                </details>
              )}
            </div>
          )}

          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#dce9e2] bg-[#f1f8f4] px-4 py-3">
            <div><strong className="text-sm text-[#315a56]">Model-assisted casting</strong><p className="mt-0.5 text-xs text-[#66807b]">Using {modelLabel}. Voices are matched on gender, age, accent and manner as the book describes them.</p></div>
            <span className="rounded-full bg-white px-3 py-1 mono text-[10px] tracking-[.08em] text-[#477971]">{speakingCharacters} CHARACTER{speakingCharacters === 1 ? "" : "S"}</span>
          </div>

          {characters.length === 0 ? (
            <div className="rounded-[22px] border border-dashed border-[#c9d9d2] bg-[#fbfcf9] p-8 text-center">
              <BookOpenText aria-hidden="true" className="mx-auto mb-3 text-[#8fb0a8]" size={26} />
              <h3 className="font-bold text-[#35494b]">No cast yet</h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#748285]">Analyze the book and Prosecast will find every speaking character, attribute their lines and suggest a voice for each. You can also add speakers yourself.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {characters.map((character) => {
                const voiceOptions = withAssignedVoice(character, voices);
                const selectId = `voice-assignment-${slug(character.id || character.name)}`;
                const facts = [character.gender, character.ageGroup].filter(Boolean).join(" · ");
                return (
                  <article key={character.id || character.name} className={`panel-shadow rounded-2xl border bg-[#fffefa] p-4 ${character.isNarrator ? "border-[#cfe0d8]" : "border-[#e0e6dd]"}`}>
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-sm font-bold text-white" style={{ background: character.color }}>{character.name.slice(0, 1)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-bold text-[#304548]">{character.name}</h3>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] ${character.isNarrator ? "bg-[#e3f0eb] text-[#3c776f]" : "bg-[#eef2ed] text-[#708083]"}`}>{character.isNarrator ? "Narrator" : character.role}</span>
                          {facts && <span className="text-[10px] capitalize text-[#8a9899]">{facts}</span>}
                          {character.lineCount ? <span className="text-[10px] text-[#8a9899]">{character.lineCount.toLocaleString()} {character.isNarrator ? "passages" : `line${character.lineCount === 1 ? "" : "s"}`}</span> : null}
                          {character.assignmentSource === "manual" ? <span className="text-[10px] font-semibold text-[#9e722c]">Your choice</span> : character.confidence !== undefined ? <span className="text-[10px] text-[#699287]">{character.confidence}% match</span> : null}
                        </div>
                        {character.description && <p className="mt-1 text-xs text-[#5f7174]">{character.description}</p>}
                        <p className="mt-1 text-xs text-[#728084]">{character.rationale || (character.voiceId ? `${character.accent} delivery selected to keep this character distinct.` : "No voice yet. Pick one below or use Default voices.")}</p>
                        {character.sampleLine && <p className="mt-3 line-clamp-2 border-l-2 border-[#d8c47a] pl-3 text-sm italic text-[#69787a]">{character.sampleLine}</p>}
                        {character.previewUrl && <audio controls preload="none" src={character.previewUrl} className="mt-3 h-8 w-full max-w-sm" aria-label={`${character.name} generated voice preview`} />}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button onClick={() => onPreview(character)} disabled={!character.voiceId} aria-label={`Preview ${character.name}`} className="grid h-9 w-9 place-items-center rounded-xl border border-[#d8e4dd] bg-[#f4faf6] text-[#37746d] hover:bg-[#e5f2eb] disabled:opacity-40"><Play size={15} /></button>
                        {onRemoveCharacter && !character.isNarrator && (
                          <button onClick={() => onRemoveCharacter(character)} aria-label={`Remove ${character.name}`} className="grid h-9 w-9 place-items-center rounded-xl text-[#9aa2a3] hover:bg-[#fbeeea] hover:text-[#af5d5d]"><Trash2 size={14} /></button>
                        )}
                        <Volume2 aria-hidden="true" size={15} className="text-[#8aa09b]" />
                      </div>
                    </div>
                    <div className="mt-4 grid gap-2 border-t border-[#edf0ea] pt-3 sm:grid-cols-[1fr_auto] sm:items-center">
                      {/*
                        A controlled `<select>` whose value matches no option renders
                        the first option as selected, so filtering the voice list made
                        every row read as the top match. `withAssignedVoice` keeps the
                        current assignment in the list even when the search excludes it.
                      */}
                      <label htmlFor={selectId} className="text-xs font-semibold text-[#607477]">Voice
                        <select id={selectId} value={character.voiceId || ""} onChange={(event) => { const voice = voiceOptions.find((item) => item.id === event.target.value); if (voice) onVoiceChange(character.name, voice); }} className="input select ml-3 max-w-[340px] text-xs">
                          {!character.voiceId && <option value="">Choose a voice…</option>}
                          {voiceOptions.map((voice) => <option key={voice.id} value={voice.id}>{voice.name} · {voice.detail}</option>)}
                        </select>
                      </label>
                      <span className="text-xs text-[#7d8c8d]">{character.accent}</span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
        <aside className="border-t border-[#e0e5de] bg-[#fafbf7] p-5 lg:border-l lg:border-t-0 lg:overflow-auto">
          <div className="flex items-center justify-between"><span className="mono text-[10px] tracking-[.14em] text-[#899494]">VOICE LIBRARY</span><button onClick={onAddCharacter} className="text-xs font-bold text-[#3d796f]">+ Add speaker</button></div>
          <div className="relative mt-3"><Search aria-hidden="true" className="absolute left-3 top-3 text-[#8c9999]" size={15} /><input id="voice-library-search" type="search" aria-label="Search voices by name, trait or voice ID" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search: female british calm, or a voice ID" className="w-full rounded-xl border border-[#dee4de] bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:border-[#7ba9a1]" /></div>
          <div className="mt-3 rounded-xl border border-[#dfe7e1] bg-[#f4f8f5] p-3"><label className="block text-[11px] font-bold text-[#58736f]">Describe the voice you need<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="e.g. calm, low-pitched male with a British accent" className="mt-2 min-h-20 w-full resize-y rounded-lg border border-[#d9e3dc] bg-white p-2 text-xs outline-none focus:border-[#7ba9a1]" /></label><button onClick={onFindSimilar} disabled={!prompt.trim()} className="btn-soft mt-2 w-full disabled:cursor-not-allowed disabled:opacity-50"><Sparkles className="mr-1 inline" size={13} /> Find similar voices</button></div>
          <div className="mt-4 space-y-2">{voicesLoading ? [0, 1, 2, 3].map((index) => <div key={index} aria-hidden="true" className="rounded-xl border border-transparent bg-white p-3"><div className="flex items-center gap-3"><span className="skeleton h-9 w-9 rounded-full" /><span className="min-w-0 flex-1"><span className="skeleton block h-3 w-24" /><span className="skeleton mt-2 block h-2.5 w-32" /></span></div></div>) : voices.length ? voices.slice(0, 60).map((voice) => <div key={voice.id} className="rounded-xl border border-transparent bg-white p-3 hover:border-[#b8d5cf]"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-full text-xs font-bold text-white" style={{ background: voice.color }}>{voice.name[0]}</span><span className="min-w-0 flex-1"><strong className="block text-sm">{voice.name}</strong><span className="block truncate text-[11px] text-[#7d898b]">{voice.detail}</span><code className="mt-1 block truncate text-[10px] text-[#82908f]">{voice.id}</code></span><button onClick={() => onPreviewVoice(voice)} aria-label={`Test ${voice.name}`} className="grid h-8 w-8 place-items-center rounded-lg bg-[#e9f4ef] text-[#3d796f] hover:bg-[#dcece5]"><Play size={14} /></button></div>{libraryPreviewUrls[voice.id] && <audio controls preload="none" src={libraryPreviewUrls[voice.id]} className="mt-3 h-8 w-full" aria-label={`${voice.name} voice test`} />}</div>) : <p className="rounded-xl border border-dashed border-[#d8e1dc] p-4 text-xs leading-5 text-[#778689]">No voices matched that ID or description. Try fewer terms or a different provider voice ID.</p>}</div>
          <p className="mt-5 text-[11px] leading-5 text-[#849092]"><Sparkles className="mr-1 inline text-[#ad8d37]" size={13} /> Signed-in projects search the connected voice catalog. Before sign-in, Prosecast uses its starter library and clearly labels browser-only test playback.</p>
        </aside>
      </div>
    </div>
  );
}
