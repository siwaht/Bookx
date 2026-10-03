import { createElement, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AudioLines, Music2, Pause, Play, Plus, SlidersHorizontal, Users } from "lucide-react";

type Speaker = { name: string; role: "Host" | "Guest" | "Narrator" | "Character"; voice: string };

export function EnhancedProduction({ kind, playing, setPlaying }: { kind: "audiobook" | "podcast"; playing: boolean; setPlaying: (value: boolean) => void }) {
  const podcast = kind === "podcast";
  const [batch, setBatch] = useState("4 chapters");
  const [music, setMusic] = useState("Opening theme · Gentle rise");
  const [effect, setEffect] = useState("Soft rain at doorway");
  const [musicVolume, setMusicVolume] = useState(34);
  const [duck, setDuck] = useState(true);
  const [runningBatch, setRunningBatch] = useState(false);
  const initialSpeakers: Speaker[] = podcast
    ? [{ name: "Nadia", role: "Host", voice: "Iris" }, { name: "Mika", role: "Guest", voice: "Sage" }, { name: "Otto", role: "Guest", voice: "Theo" }]
    : [{ name: "Mara", role: "Narrator", voice: "Iris" }, { name: "Elias", role: "Character", voice: "Theo" }, { name: "June", role: "Character", voice: "Sage" }];
  const [cast, setCast] = useState<Speaker[]>(initialSpeakers);
  const batchTimer = useRef<number | undefined>(undefined);

  // `cast` is seeded from props, so switching an open project between audiobook
  // and podcast used to leave the previous kind's speakers on screen.
  useEffect(() => {
    setCast(podcast
      ? [{ name: "Nadia", role: "Host", voice: "Iris" }, { name: "Mika", role: "Guest", voice: "Sage" }, { name: "Otto", role: "Guest", voice: "Theo" }]
      : [{ name: "Mara", role: "Narrator", voice: "Iris" }, { name: "Elias", role: "Character", voice: "Theo" }, { name: "June", role: "Character", voice: "Sage" }]);
  }, [podcast]);

  useEffect(() => () => window.clearTimeout(batchTimer.current), []);

  const updateVoice = (index: number, voice: string) => setCast((current) => current.map((speaker, position) => position === index ? { ...speaker, voice } : speaker));
  const addGuest = () => setCast((current) => [...current, { name: `Guest ${current.length + 1}`, role: "Guest", voice: "Noor" }]);
  const announce = (message: string) => toast(message);
  const runBatch = () => {
    if (runningBatch) return;
    setRunningBatch(true);
    announce(`${batch} queued with the current cast and mix.`);
    // Cleared on unmount so leaving the studio mid-batch cannot pop a toast or
    // set state on a component that is gone.
    batchTimer.current = window.setTimeout(() => {
      setRunningBatch(false);
      announce(`${batch} production pass is ready for review.`);
    }, 700);
  };

  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex flex-col gap-5 border-b border-stone-150 bg-paper px-6 py-7 lg:flex-row lg:items-end lg:justify-between lg:px-9">
      <div className="min-w-0"><p className="eyebrow text-brand-600">{podcast ? "PODCAST PRODUCTION" : "LONG-FORM PRODUCTION"}</p><h2 className="serif mt-2 text-[34px] leading-[1.1] tracking-[-.02em] text-ink-950">{podcast ? "Make every person easy to follow." : "Keep the long listen effortless."}</h2><p className="mt-2.5 max-w-2xl text-sm leading-6 text-ink-500">{podcast ? "Set a host and guests, assign voices, and mix the episode without a complicated console." : "Produce a book in calm batches while keeping casting, pronunciation, and soundtrack decisions consistent."}</p></div><button onClick={() => announce(podcast ? "New episode draft added to the production plan." : "A new chapter batch is ready to configure.")} className="btn-primary"><Plus className="mr-1 inline" size={14} /> {podcast ? "Add episode" : "Add chapter batch"}</button>
    </header>
    <div className="grid flex-1 grid-cols-1 content-start gap-6 p-6 xl:grid-cols-[minmax(0,1.2fr)_360px] md:p-9">
      <section className="min-w-0 space-y-5">
        <div className="rounded-card border border-stone-150 bg-paper p-6 shadow-soft"><div className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-center gap-4"><button onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause the mix" : "Play the mix"} aria-pressed={playing} className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[linear-gradient(160deg,var(--color-brand-600),var(--color-brand-800))] text-paper shadow-[inset_0_1px_0_rgb(255_255_255/.16),0_8px_18px_-8px_rgb(11_41_44/.6)] transition hover:brightness-110">{playing ? <Pause aria-hidden="true" size={18} /> : <Play aria-hidden="true" className="ml-0.5" size={18} />}</button><div><strong className="serif block text-[20px] leading-tight text-ink-950">{podcast ? "Episode 04 · The shared horizon" : "Chapter 01 · Undertow"}</strong><span className="mt-1 block text-xs tabular-nums text-ink-500">{playing ? "Playing mix · 01:24 / 03:18" : "Ready for a quick listen · 03:18"}</span></div></div><span className="rounded-full bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 ring-1 ring-brand-100">Simple mix</span></div></div>
        <div className="overflow-x-auto rounded-card border border-stone-150 bg-paper shadow-hairline"><div className="min-w-[520px]"><div className="eyebrow flex h-11 items-center border-b border-stone-100 bg-paper-50 px-5 text-3xs text-ink-500"><span className="w-[170px]">MIX TRACKS</span><div className="flex flex-1 justify-between"><span>00:00</span><span>01:00</span><span>02:00</span><span>03:00</span></div></div>{[[podcast ? "Host + guests" : "Narration", "#70a49b", [25, 48, 74]], ["Sound effect", "#8a9fbc", [10, 67]], ["Background music", "#d4a260", [0, 58]]].map(([label, color, clips]) => <div key={label as string} className="flex min-h-16 items-center border-b border-stone-100 px-5 last:border-0"><div className="w-[170px] text-xs font-semibold text-ink-600">{label as string}</div><div className="relative h-9 flex-1 rounded-lg bg-stone-50">{(clips as number[]).map((left, index) => <div key={index} className="absolute top-1.5 h-6 rounded-md" style={{ left: `${left}%`, width: `${index === 1 ? 20 : 18}%`, background: color as string }} />)}</div></div>)}</div></div>
        <div className="grid gap-3 md:grid-cols-3">{[[Music2, "Background music", "Choose a gentle bed, then keep it below voices."], [AudioLines, "Sound effects", "Place atmosphere and story moments with intent."], [SlidersHorizontal, "Auto-level", "Maintain a clear, comfortable listening level."]].map(([Icon, title, detail]) => <button key={title as string} onClick={() => announce(`${title as string} controls are ready in the simple mix panel.`)} className="rounded-2xl border border-stone-150 bg-paper p-4 text-left shadow-hairline transition hover:border-brand-200 hover:shadow-soft">{createElement(Icon as typeof Music2, { size: 16, className: "mb-3 text-brand-600" })}<strong className="block text-sm font-semibold text-ink-900">{title as string}</strong><span className="mt-1 block text-xs leading-5 text-ink-500">{detail as string}</span></button>)}</div>
      </section>
      <aside className="space-y-5">
        <div className="rounded-card border border-stone-150 bg-paper p-6 shadow-hairline"><div className="flex items-start justify-between gap-3"><div><span className="eyebrow text-brand-600">{podcast ? "MULTI-CAST EPISODE" : "LONG-FORM BATCH"}</span><h3 className="serif mt-1.5 text-[21px] leading-tight text-ink-950">{podcast ? "People in this episode" : "Generate without losing your place"}</h3></div><Users size={17} className="text-brand-500" /></div>{podcast ? <><div className="mt-4 space-y-2">{cast.map((speaker, index) => <div key={`${speaker.name}-${index}`} className="rounded-xl border border-stone-150 bg-paper-50 p-3"><div className="flex items-center gap-3"><span className="serif grid h-8 w-8 place-items-center rounded-full bg-brand-100 text-sm text-brand-800">{speaker.name[0]}</span><span className="flex-1 text-xs font-semibold text-ink-800">{speaker.name} · {speaker.role}</span></div><select value={speaker.voice} onChange={(event) => updateVoice(index, event.target.value)} aria-label={`Voice for ${speaker.name}`} className="input select mt-2 text-xs"><option>Iris</option><option>Theo</option><option>Sage</option><option>Noor</option></select></div>)}</div><button onClick={addGuest} className="mt-3 w-full rounded-xl border border-dashed border-brand-300 py-2.5 text-xs font-semibold text-brand-600 transition hover:bg-brand-50"><Plus className="mr-1 inline" size={13} /> Add another guest</button></> : <><div className="mt-4 rounded-xl bg-brand-50 p-3"><strong className="block text-sm text-brand-600">Continue in groups</strong><span className="mt-1 block text-xs leading-5 text-ink-500">Keep the same cast and mix choices for every batch of chapters.</span></div><div className="mt-3 grid grid-cols-3 gap-2">{["4 chapters", "8 chapters", "Custom"].map((label) => <button key={label} onClick={() => setBatch(label)} className={`rounded-lg px-2 py-2 text-3xs font-semibold ${batch === label ? "bg-brand-700 text-white" : "bg-stone-50 text-ink-500"}`}>{label}</button>)}</div><button onClick={runBatch} disabled={runningBatch} className="btn-primary mt-3 w-full disabled:opacity-60">{runningBatch ? `Preparing ${batch}…` : `Generate ${batch}`}</button></>}</div>
        <div className="rounded-card border border-stone-150 bg-paper-50 p-6"><span className="eyebrow text-brand-600">SOUND SIMPLE</span><label className="mt-4 block text-xs font-semibold text-ink-700">Background music<select value={music} onChange={(event) => setMusic(event.target.value)} className="input select mt-2"><option>Opening theme · Gentle rise</option><option>Quiet underscore · Felt piano</option><option>No background music</option></select></label><label className="mt-4 block text-xs font-semibold text-ink-700">Sound effect<select value={effect} onChange={(event) => setEffect(event.target.value)} className="input select mt-2"><option>Soft rain at doorway</option><option>Footsteps in hallway</option><option>Cafe room tone</option><option>No sound effect</option></select></label><div className="mt-4"><div className="flex justify-between text-xs font-semibold text-ink-700"><span id="music-volume-label">Music volume</span><span className="tabular-nums text-ink-500">{musicVolume}%</span></div><input value={musicVolume} onChange={(event) => setMusicVolume(Number(event.target.value))} type="range" min="0" max="70" aria-labelledby="music-volume-label" aria-valuetext={`${musicVolume}%`} className="mt-2 w-full accent-brand-600" /></div><label className="mt-4 flex cursor-pointer items-center justify-between rounded-xl border border-brand-100 bg-brand-50 p-3"><span className="text-xs font-semibold text-ink-800">Lower music under voices</span><input checked={duck} onChange={(event) => setDuck(event.target.checked)} type="checkbox" className="h-4 w-4 accent-brand-600" /></label></div>
      </aside>
    </div>
  </div>;
}
