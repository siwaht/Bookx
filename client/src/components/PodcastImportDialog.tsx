import { FileAudio, FileText, Upload, X } from "lucide-react";
import { useEffect, useState, type ChangeEvent } from "react";

export type PodcastImport = {
  text: string;
  file?: { name: string; mimeType: string; base64: string };
};

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Bookx could not read that audio file."));
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
    if (!selected) return;
    if (selected.size > 25 * 1024 * 1024) { setError("Choose an audio source smaller than 25 MB."); return; }
    const accepted = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a", "audio/flac", "audio/aac"];
    if (!accepted.includes(selected.type)) { setError("Choose an MP3, WAV, M4A, FLAC, or AAC file."); return; }
    setReading(true);
    setError(undefined);
    try {
      setFile({ name: selected.name, mimeType: selected.type, base64: await readFileAsBase64(selected) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Bookx could not read that audio file.");
    } finally {
      setReading(false);
    }
  };

  const canContinue = Boolean(text.trim() || file) && !reading;
  return <div role="dialog" aria-modal="true" aria-label="Import podcast source" className="fixed inset-0 z-50 overflow-y-auto bg-[#173034]/35 p-4 backdrop-blur-sm" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="soft-shadow mx-auto my-4 w-full max-w-2xl rounded-[28px] bg-[#fffefa] p-6 md:p-7"><div className="flex items-start justify-between"><div><p className="mono text-[10px] tracking-[.15em] text-[#5d918b]">PODCAST SOURCE</p><h2 className="serif mt-2 text-3xl">Start with audio or text.</h2><p className="mt-2 max-w-xl text-sm leading-6 text-[#728084]">Paste an episode script, attach a source recording, or bring both. Your script remains editable after setup.</p></div><button onClick={onClose} aria-label="Close import" className="grid h-9 w-9 place-items-center rounded-xl border border-[#dce5de] bg-white text-[#607477] transition hover:border-[#a9c9c4] hover:text-[#1d6a69]"><X size={17} /></button></div><div className="mt-6 grid gap-4 md:grid-cols-2"><label className="cursor-pointer rounded-[20px] border border-dashed border-[#8eafa6] bg-[#f2f8f5] p-5 text-center transition hover:border-[#4d8a80]"><FileAudio size={23} className="mx-auto mb-3 text-[#3c7b75]" /><strong className="block text-sm">Attach episode audio</strong><span className="mt-1 block text-xs leading-5 text-[#728084]">MP3, WAV, M4A, FLAC, or AAC · up to 25 MB</span><input type="file" accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/flac,audio/aac,.mp3,.wav,.m4a,.flac,.aac" onChange={(event) => void selectFile(event)} className="sr-only" />{file ? <span className="mt-3 block truncate rounded-lg bg-white px-3 py-2 text-xs font-bold text-[#3c776f]">Attached: {file.name}</span> : <span className="mt-3 inline-flex items-center gap-1 rounded-lg bg-white px-3 py-2 text-xs font-bold text-[#3c776f]"><Upload size={12} /> Choose file</span>}</label><div className="rounded-[20px] border border-[#dce5de] bg-[#fbfcf9] p-4"><label className="flex items-center gap-2 text-sm font-bold text-[#435c5e]"><FileText size={15} className="text-[#4a877e]" /> Paste episode script or transcript</label><textarea value={text} onChange={(event) => setText(event.target.value)} autoFocus placeholder="Paste your episode text here. You can edit it after project setup." className="mt-3 h-36 w-full resize-y rounded-xl border border-[#dbe4de] bg-white p-3 text-sm leading-6 outline-none focus:border-[#6fa196]" /></div></div>{error && <p role="alert" className="mt-4 rounded-xl bg-[#fff0e8] px-4 py-3 text-sm text-[#9a573f]">{error}</p>}<div className="mt-5 flex flex-col-reverse gap-3 border-t border-[#e4e8e1] pt-5 sm:flex-row sm:justify-end"><button onClick={onClose} className="rounded-xl px-4 py-3 text-sm font-semibold text-[#657578] transition hover:bg-[#eef2ef] hover:text-[#3c5052]">Cancel</button><button disabled={!canContinue} onClick={() => onFinish({ text, file })} className="btn-primary btn-lg disabled:cursor-not-allowed disabled:opacity-50">{reading ? "Preparing source…" : "Continue to project setup"}</button></div></div></div>;
}
