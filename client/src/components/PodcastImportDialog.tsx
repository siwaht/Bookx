import { FileAudio, FileText, Upload, X } from "lucide-react";
import { useEffect, useState, type ChangeEvent } from "react";

export type PodcastImport = {
  text: string;
  file?: { name: string; mimeType: string; base64: string };
};

/** The server's name for each accepted kind of audio. */
const AUDIO_BY_EXTENSION: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac" };
const AUDIO_BY_TYPE: Record<string, string> = {
  "audio/mpeg": "audio/mpeg", "audio/mp3": "audio/mpeg", "audio/x-mp3": "audio/mpeg", "audio/mpeg3": "audio/mpeg",
  "audio/wav": "audio/wav", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/vnd.wave": "audio/wav",
  "audio/mp4": "audio/mp4", "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4",
  "audio/flac": "audio/flac", "audio/x-flac": "audio/flac",
  "audio/aac": "audio/aac", "audio/x-aac": "audio/aac", "audio/aacp": "audio/aac", "audio/vnd.dlna.adts": "audio/aac",
};

function audioTypeFor(file: File): string | null {
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return AUDIO_BY_EXTENSION[extension] ?? AUDIO_BY_TYPE[file.type.toLowerCase()] ?? null;
}

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Prosecast could not read that audio file."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export function PodcastImportDialog({ onClose, onFinish }: { onClose: () => void; onFinish: (source: PodcastImport) => void }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<PodcastImport["file"]>();
  const [error, setError] = useState<string>();
  const [reading, setReading] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const selectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    // Cleared so choosing the same file again (after an error) still fires.
    event.target.value = "";
    if (!selected) return;
    if (selected.size > 25 * 1024 * 1024) { setError("Choose an audio source smaller than 25 MB."); return; }
    // Browsers report these differently (an empty type, audio/x-flac,
    // audio/mp3, audio/wave, audio/vnd.dlna.adts on Windows), so valid files
    // were refused. The extension decides first, then any known type.
    const mimeType = audioTypeFor(selected);
    if (!mimeType) { setError("Choose an MP3, WAV, M4A, FLAC, or AAC file."); return; }
    setReading(true);
    setError(undefined);
    try {
      setFile({ name: selected.name, mimeType, base64: await readFileAsBase64(selected) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Prosecast could not read that audio file.");
    } finally {
      setReading(false);
    }
  };

  const canContinue = Boolean(text.trim() || file) && !reading;
  return <div role="dialog" aria-modal="true" aria-label="Import podcast source" className="fixed inset-0 z-50 overflow-y-auto bg-ink-950/40 p-4 backdrop-blur-[6px]" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="soft-shadow fade-up mx-auto my-4 w-full max-w-2xl rounded-panel border border-white/70 bg-paper p-6 ring-1 ring-stone-150 md:p-8"><div className="flex items-start justify-between gap-4"><div><p className="eyebrow text-brand-600">PODCAST SOURCE</p><h2 className="serif mt-2 text-[34px] leading-[1.1] tracking-[-.02em] text-ink-950">Start with audio or text.</h2><p className="mt-2 max-w-xl text-sm leading-6 text-ink-500">Paste an episode script, attach a source recording, or bring both. Your script remains editable after setup.</p></div><button onClick={onClose} aria-label="Close import" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-stone-150 bg-white text-ink-500 transition hover:border-brand-200 hover:text-brand-700"><X size={17} /></button></div><div className="mt-6 grid gap-4 md:grid-cols-2"><label className="group flex cursor-pointer flex-col items-center justify-center rounded-card border border-dashed border-brand-300 bg-brand-50/50 p-6 text-center transition hover:border-brand-400 hover:bg-brand-50"><span className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-white text-brand-600 shadow-soft ring-1 ring-brand-100 transition group-hover:-translate-y-0.5"><FileAudio size={20} /></span><strong className="block text-[15px] font-semibold text-ink-900">Attach episode audio</strong><span className="mt-1 block text-xs leading-5 text-ink-500">MP3, WAV, M4A, FLAC, or AAC · up to 25 MB</span><input type="file" accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/flac,audio/aac,.mp3,.wav,.m4a,.flac,.aac" onChange={(event) => void selectFile(event)} className="sr-only" />{file ? <span className="mt-4 block max-w-full truncate rounded-lg bg-white px-3 py-2 text-xs font-semibold text-brand-700 ring-1 ring-brand-100">Attached: {file.name}</span> : <span className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-brand-700 ring-1 ring-brand-100"><Upload size={12} /> Choose file</span>}</label><div className="rounded-card border border-stone-150 bg-paper-50 p-4"><label className="flex items-center gap-2 text-sm font-semibold text-ink-800"><FileText size={15} className="text-brand-500" /> Paste episode script or transcript</label><textarea value={text} onChange={(event) => setText(event.target.value)} autoFocus placeholder="Paste your episode text here. You can edit it after project setup." className="input mt-3 h-36 resize-y p-3 leading-6" /></div></div>{error && <p role="alert" className="mt-4 rounded-xl border border-clay-200 bg-clay-50 px-4 py-3 text-sm text-clay-700">{error}</p>}<div className="mt-6 flex flex-col-reverse gap-3 border-t border-stone-150 pt-5 sm:flex-row sm:justify-end"><button onClick={onClose} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-ink-500 transition hover:bg-stone-50 hover:text-ink-900">Cancel</button><button disabled={!canContinue} onClick={() => onFinish({ text, file })} className="btn-primary btn-lg disabled:cursor-not-allowed disabled:opacity-50">{reading ? "Preparing source…" : "Continue to project setup"}</button></div></div></div>;
}
