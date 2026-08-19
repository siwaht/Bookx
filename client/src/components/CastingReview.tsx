import { LoaderCircle, Play, Search, Sparkles, Volume2, Wand2 } from "lucide-react";

export type CastingCharacter = {
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
};

export type VoiceChoice = { id: string; name: string; detail: string; color: string };

export function CastingReview({
  characters,
  voices,
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
}: {
  characters: CastingCharacter[];
  voices: VoiceChoice[];
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
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-5 border-b border-[#e1e6de] bg-[#fffefa] px-6 py-6 md:flex-row md:items-end md:justify-between md:px-9">
        <div>
          <span className="mono text-[10px] tracking-[.14em] text-[#668c87]">02 · MULTI-CAST</span>
          <h1 className="serif mt-2 text-3xl text-[#294043]">Cast every voice with intent.</h1>
          <p className="mt-2 max-w-2xl text-sm text-[#728084]">Bookx finds recurring speakers, reads their dialogue context, and assigns distinct voices from your connected catalog. Every suggestion remains editable.</p>
        </div>
        <button onClick={onAutoCast} disabled={isCasting} className="rounded-xl bg-[#225f61] px-4 py-3 text-xs font-bold text-white shadow-sm transition hover:bg-[#174f51] disabled:cursor-wait disabled:opacity-70">
          {isCasting ? <LoaderCircle className="mr-1.5 inline animate-spin" size={15} /> : <Wand2 className="mr-1.5 inline" size={15} />}
          {isCasting ? "Reading manuscript…" : "Analyze & assign voices"}
        </button>
      </header>
      <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_330px]">
        <section className="overflow-auto p-6 md:p-9">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#dce9e2] bg-[#f1f8f4] px-4 py-3">
            <div><strong className="text-sm text-[#315a56]">Model-assisted casting</strong><p className="mt-0.5 text-xs text-[#66807b]">Using {modelLabel}. Recommendations consider role, delivery, and dialogue—not protected traits.</p></div>
            <span className="rounded-full bg-white px-3 py-1 mono text-[10px] tracking-[.08em] text-[#477971]">{characters.length} VOICES</span>
          </div>
          <div className="space-y-3">
            {characters.map((character) => (
              <article key={character.name} className="panel-shadow rounded-2xl border border-[#e0e6dd] bg-[#fffefa] p-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-sm font-bold text-white" style={{ background: character.color }}>{character.name.slice(0, 1)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="font-bold text-[#304548]">{character.name}</h3><span className="rounded-full bg-[#eef2ed] px-2 py-0.5 text-[10px] text-[#708083]">{character.role}</span>{character.confidence ? <span className="text-[10px] text-[#699287]">{character.confidence}% match</span> : null}</div>
                    <p className="mt-1 text-xs text-[#728084]">{character.rationale || `${character.accent} delivery selected to keep this character distinct.`}</p>
                    <p className="mt-3 line-clamp-2 border-l-2 border-[#d8c47a] pl-3 text-sm italic text-[#69787a]">“{character.sampleLine || "Add dialogue in the manuscript to generate a representative preview line."}”</p>
                    {character.previewUrl && <audio controls preload="none" src={character.previewUrl} className="mt-3 h-8 w-full max-w-sm" aria-label={`${character.name} generated voice preview`} />}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button onClick={() => onPreview(character)} aria-label={`Preview ${character.name}`} className="grid h-9 w-9 place-items-center rounded-xl border border-[#d8e4dd] bg-[#f4faf6] text-[#37746d] hover:bg-[#e5f2eb]"><Play size={15} /></button>
                    <Volume2 size={15} className="text-[#8aa09b]" />
                  </div>
                </div>
                <div className="mt-4 grid gap-2 border-t border-[#edf0ea] pt-3 sm:grid-cols-[1fr_auto] sm:items-center">
                  <label className="text-xs font-semibold text-[#607477]">Voice assignment
                    <select value={character.voiceId || character.voice} onChange={(event) => { const voice = voices.find((item) => item.id === event.target.value); if (voice) onVoiceChange(character.name, voice); }} className="ml-3 rounded-lg border border-[#dce5df] bg-white px-2 py-1.5 text-xs font-semibold text-[#3e6661] outline-none focus:border-[#7ba9a1]">
                      {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name} · {voice.detail}</option>)}
                    </select>
                  </label>
                  <span className="text-xs text-[#7d8c8d]">{character.accent}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
        <aside className="border-t border-[#e0e5de] bg-[#fafbf7] p-5 lg:border-l lg:border-t-0">
          <div className="flex items-center justify-between"><span className="mono text-[10px] tracking-[.14em] text-[#899494]">VOICE LIBRARY</span><button onClick={onAddCharacter} className="text-xs font-bold text-[#3d796f]">+ Add speaker</button></div>
          <div className="relative mt-3"><Search className="absolute left-3 top-3 text-[#8c9999]" size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by voice name or exact voice ID" className="w-full rounded-xl border border-[#dee4de] bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:border-[#7ba9a1]" /></div>
          <div className="mt-3 rounded-xl border border-[#dfe7e1] bg-[#f4f8f5] p-3"><label className="block text-[11px] font-bold text-[#58736f]">Describe the voice you need<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="e.g. calm, low-pitched host with a thoughtful delivery" className="mt-2 min-h-20 w-full resize-y rounded-lg border border-[#d9e3dc] bg-white p-2 text-xs outline-none focus:border-[#7ba9a1]" /></label><button onClick={onFindSimilar} disabled={!prompt.trim()} className="mt-2 w-full rounded-lg bg-[#e1efe9] px-3 py-2 text-xs font-bold text-[#39756e] disabled:cursor-not-allowed disabled:opacity-50"><Sparkles className="mr-1 inline" size={13} /> Find similar voices</button></div>
          <div className="mt-4 space-y-2">{voices.length ? voices.map((voice) => <div key={voice.id} className="rounded-xl border border-transparent bg-white p-3 hover:border-[#b8d5cf]"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-full text-xs font-bold text-white" style={{ background: voice.color }}>{voice.name[0]}</span><span className="min-w-0 flex-1"><strong className="block text-sm">{voice.name}</strong><span className="block truncate text-[11px] text-[#7d898b]">{voice.detail}</span><code className="mt-1 block truncate text-[10px] text-[#82908f]">{voice.id}</code></span><button onClick={() => onPreviewVoice(voice)} aria-label={`Test ${voice.name}`} className="grid h-8 w-8 place-items-center rounded-lg bg-[#e9f4ef] text-[#3d796f] hover:bg-[#dcece5]"><Play size={14} /></button></div>{libraryPreviewUrls[voice.id] && <audio controls preload="none" src={libraryPreviewUrls[voice.id]} className="mt-3 h-8 w-full" aria-label={`${voice.name} voice test`} />}</div>) : <p className="rounded-xl border border-dashed border-[#d8e1dc] p-4 text-xs leading-5 text-[#778689]">No voices matched that ID or description. Try fewer terms or a different provider voice ID.</p>}</div>
          <p className="mt-5 text-[11px] leading-5 text-[#849092]"><Sparkles className="mr-1 inline text-[#ad8d37]" size={13} /> Signed-in projects search the connected voice catalog. Before sign-in, Bookx uses its starter library and clearly labels browser-only test playback.</p>
        </aside>
      </div>
    </div>
  );
}
