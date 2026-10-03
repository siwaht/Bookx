import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Download, FileArchive, LoaderCircle, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import {
  AUDIOBOOK_STANDARD,
  EXPORT_PRESETS,
  MP3_BITRATES,
  describeOutput,
  isPassthrough,
  meetsAudiobookStandard,
  noiseFloorPasses,
  presetById,
  type ExportOutput,
  type ExportPresetId,
} from "@shared/exportOptions";

/**
 * Export screen.
 *
 * Every export is one file per chapter (what Spotify for Authors and ACX ask
 * for) plus an optional whole-book file. The creator picks the chapters: any
 * chapter that is fully narrated can go in, and the ones still being worked on
 * are shown with the reason they are not ready instead of blocking the book.
 */

function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const fileHref = (storageKey: string, fileName: string) =>
  `/manus-storage/${storageKey.split("/").map(encodeURIComponent).join("/")}?download=1&name=${encodeURIComponent(fileName)}`;

const STATE_BADGE: Record<string, { label: string; className: string }> = {
  ready: { label: "Ready", className: "bg-[#e4f2eb] text-[#397868]" },
  outdated: { label: "Older audio", className: "bg-[#fff0da] text-[#9a6a22]" },
  partial: { label: "In progress", className: "bg-[#eef1ec] text-[#6f7f81]" },
  unrendered: { label: "Not narrated", className: "bg-[#eef1ec] text-[#6f7f81]" },
  empty: { label: "No text", className: "bg-[#eef1ec] text-[#8b9697]" },
};

export function ExportPackage({ projectId, canExport, disabledReason }: { projectId: string; canExport: boolean; disabledReason: string }) {
  const utils = trpc.useUtils();
  const [presetId, setPresetId] = useState<ExportPresetId>("spotify");
  const [output, setOutput] = useState<ExportOutput>(presetById("spotify").output);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);

  const overview = trpc.bookx.exportReadiness.useQuery({ projectId }, { enabled: canExport });
  const exports = trpc.bookx.listExports.useQuery(
    { projectId },
    {
      enabled: canExport,
      // Assembly is a background job, so poll while one is in flight.
      refetchInterval: query => (query.state.data?.some(row => row.status === "queued" || row.status === "assembling") ? 2000 : false),
    },
  );

  const chapters = overview.data?.chapters ?? [];
  // Until the creator changes it, the selection is every chapter that is done
  // (or, when none is fully current, every chapter that has all its audio).
  const defaultSelection = useMemo(() => {
    const ready = chapters.filter(chapter => chapter.state === "ready");
    return new Set((ready.length ? ready : chapters.filter(chapter => chapter.exportable)).map(chapter => chapter.chapterId));
  }, [chapters]);
  const chosen = selected ?? defaultSelection;
  const chosenChapters = chapters.filter(chapter => chapter.exportable && chosen.has(chapter.chapterId));
  const chosenDuration = chosenChapters.reduce((total, chapter) => total + chapter.durationMs, 0);

  // Drop chapters from a manual selection once they stop being exportable.
  useEffect(() => {
    if (!selected) return;
    const exportable = new Set(chapters.filter(chapter => chapter.exportable).map(chapter => chapter.chapterId));
    if ([...selected].some(id => !exportable.has(id))) setSelected(new Set([...selected].filter(id => exportable.has(id))));
  }, [chapters, selected]);

  const request = trpc.bookx.requestExport.useMutation({
    onSuccess: (result, submitted) => {
      void utils.bookx.listExports.invalidate({ projectId });
      // Describe what was submitted, not whatever the form shows by now.
      toast.success(`Assembling ${result.chapters} chapter${result.chapters === 1 ? "" : "s"}.`, { description: describeOutput(submitted.output ?? output) });
    },
    onError: error => toast.error(error.message || "Prosecast could not start the export."),
  });
  const remove = trpc.bookx.deleteExport.useMutation({
    onSuccess: () => void utils.bookx.listExports.invalidate({ projectId }),
    onError: error => toast.error(error.message || "Prosecast could not delete that package."),
  });

  if (!canExport) {
    return (
      <Shell>
        <div className="flex flex-1 items-center justify-center p-9">
          <div className="max-w-md rounded-[22px] border border-dashed border-[#d4ded7] bg-[#fbfcf9] p-7 text-center">
            <Download aria-hidden="true" className="mx-auto mb-4 text-[#a3b3ac]" size={26} />
            <h3 className="font-bold text-[#35494b]">Export needs a saved project</h3>
            <p className="mt-2 text-sm leading-6 text-[#748285]">{disabledReason}</p>
          </div>
        </div>
      </Shell>
    );
  }

  const choosePreset = (id: ExportPresetId) => {
    setPresetId(id);
    setOutput(presetById(id).output);
  };
  const tweak = (patch: Partial<ExportOutput>) => {
    const next = { ...output, ...patch };
    setOutput(next);
    // A Spotify preset that no longer matches its spec becomes a custom MP3.
    if (presetId === "spotify" && JSON.stringify(next) !== JSON.stringify(presetById("spotify").output)) setPresetId(next.container === "mp3" ? "mp3" : presetId);
  };
  const toggleChapter = (chapterId: string) => {
    const next = new Set(chosen);
    if (next.has(chapterId)) next.delete(chapterId);
    else next.add(chapterId);
    setSelected(next);
  };

  const rows = exports.data ?? [];
  const assembling = rows.some(row => row.status === "queued" || row.status === "assembling");
  const passthrough = isPassthrough(output);
  const soundOn = Boolean(overview.data?.soundDesign.effects || overview.data?.soundDesign.music);
  const blockReason = overview.data && !overview.data.ready ? overview.data.reason : null;
  const canCreate = chosenChapters.length > 0 && !request.isPending && !assembling && (passthrough || overview.data?.ffmpeg !== false);

  return (
    <Shell>
      <div className="grid flex-1 gap-6 overflow-auto p-6 lg:grid-cols-[minmax(0,1fr)_340px] md:p-9">
        <section className="min-w-0 space-y-5">
          <Card title="Format" eyebrow="1 · HOW">
            <div role="radiogroup" aria-label="Export format" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {EXPORT_PRESETS.map(preset => (
                <button
                  key={preset.id}
                  role="radio"
                  aria-checked={presetId === preset.id}
                  onClick={() => choosePreset(preset.id)}
                  className={`rounded-2xl border p-3.5 text-left transition ${presetId === preset.id ? "border-[#8eb8ae] bg-[#edf7f3]" : "border-[#e3e8e2] bg-white hover:border-[#c5d8cf]"}`}
                >
                  <strong className="block text-sm text-[#2f4346]">{preset.label}</strong>
                  <span className="mt-1 block text-[11px] leading-4 text-[#788688]">{preset.detail}</span>
                </button>
              ))}
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {output.container === "mp3" && !passthrough && (
                <Select label="Bitrate" value={String(output.mp3Bitrate)} onChange={value => tweak({ mp3Bitrate: Number(value) as ExportOutput["mp3Bitrate"] })}>
                  {MP3_BITRATES.map(rate => <option key={rate} value={rate}>{rate} kbps{rate === 192 ? " (ACX minimum)" : ""}</option>)}
                </Select>
              )}
              {output.container !== "mp3" && (
                <Select label="Bit depth" value={String(output.bitDepth)} onChange={value => tweak({ bitDepth: Number(value) as 16 | 24 })}>
                  <option value="16">16-bit</option>
                  <option value="24">24-bit</option>
                </Select>
              )}
              {!passthrough && (
                <>
                  <Select label="Sample rate" value={String(output.sampleRate)} onChange={value => tweak({ sampleRate: Number(value) as 44100 | 48000 })}>
                    <option value="44100">44.1 kHz</option>
                    <option value="48000">48 kHz</option>
                  </Select>
                  <Select label="Channels" value={output.channels} onChange={value => tweak({ channels: value as "mono" | "stereo" })}>
                    <option value="stereo">Stereo</option>
                    <option value="mono">Mono</option>
                  </Select>
                </>
              )}
            </div>

            <div className="mt-4 space-y-2">
              <Toggle
                checked={output.master && !passthrough}
                disabled={passthrough}
                onChange={value => tweak({ master: value })}
                label="Level to the audiobook standard"
                detail={`Each chapter at about ${AUDIOBOOK_STANDARD.targetRmsDb} dB RMS with peaks under ${AUDIOBOOK_STANDARD.maxPeakDb} dB, plus a moment of room tone at each end. Recommended for Spotify and ACX.`}
              />
              <Toggle
                checked={output.fullBook}
                onChange={value => tweak({ fullBook: value })}
                label="Also make one file for the whole book"
                detail={output.container === "mp3" ? "With chapter markers, for players and podcasts. Distributors want the chapter files." : "Handy for listening; distributors want the chapter files."}
              />
              <Toggle
                checked={output.credits}
                disabled={passthrough}
                onChange={value => tweak({ credits: value })}
                label="Narrate opening and closing credits"
                detail="ACX requires them: the title, author and narrator at the start, and a closing that says the book has ended."
              />
              <Toggle
                checked={output.chapterHeaders}
                disabled={passthrough}
                onChange={value => tweak({ chapterHeaders: value })}
                label="Speak each chapter's title at the start of its file"
                detail="ACX requires each file to open with its section header, so a listener landing on any file knows where they are."
              />
              <Toggle
                checked={output.retailSample}
                onChange={value => tweak({ retailSample: value })}
                label="Cut a retail sample (first 5 minutes)"
                detail="What Apple Books and Spotify play to a shopper. Taken from the opening of the first chapter."
              />
            </div>
          </Card>

          <Card
            title="Chapters"
            eyebrow="2 · WHAT"
            action={chapters.length > 0 && (
              <div className="flex gap-3 text-xs font-bold text-[#34736d]">
                <button onClick={() => setSelected(new Set(chapters.filter(chapter => chapter.exportable).map(chapter => chapter.chapterId)))}>All available</button>
                <button onClick={() => setSelected(new Set())}>None</button>
              </div>
            )}
          >
            {overview.isLoading ? (
              <p className="text-sm text-[#748285]"><LoaderCircle aria-hidden="true" className="mr-1 inline animate-spin" size={14} /> Checking the chapters…</p>
            ) : !chapters.length ? (
              <p className="text-sm text-[#748285]">No chapters are selected for the audiobook yet.</p>
            ) : (
              <ul className="divide-y divide-[#edf0eb]">
                {chapters.map(chapter => {
                  const badge = STATE_BADGE[chapter.state] ?? STATE_BADGE.unrendered!;
                  return (
                    <li key={chapter.chapterId}>
                      <label className={`flex items-start gap-3 py-3 ${chapter.exportable ? "cursor-pointer" : "cursor-not-allowed opacity-70"}`}>
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-[#3f827a]"
                          checked={chapter.exportable && chosen.has(chapter.chapterId)}
                          disabled={!chapter.exportable}
                          onChange={() => toggleChapter(chapter.chapterId)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <strong className="truncate text-sm text-[#34484b]">{chapter.position}. {chapter.title}</strong>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${badge.className}`}>{chapter.state === "partial" ? `${chapter.segmentsWithAudio}/${chapter.totalSegments} lines` : badge.label}</span>
                            {chapter.soundPlanned === false && chapter.exportable && <span className="text-[10px] text-[#8b9697]">no sound plan</span>}
                          </span>
                          {chapter.reason && <span className="mt-0.5 block text-[11px] leading-4 text-[#7b888a]">{chapter.reason}</span>}
                        </span>
                        <span className="shrink-0 text-xs text-[#7e8b8d]">{formatDuration(chapter.durationMs)}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {rows.length > 0 && (
            <Card title="Packages" eyebrow="3 · DOWNLOAD">
              <ul className="divide-y divide-[#edf0eb]">
                {rows.map(row => {
                  const detail = row.detail ?? {};
                  const files = detail.chapters ?? [];
                  const busy = row.status === "queued" || row.status === "assembling";
                  const open = openRow === row.id;
                  const label = EXPORT_PRESETS.find(preset => preset.id === detail.preset)?.label ?? row.format;
                  return (
                    <li key={row.id} className="py-3.5">
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <strong className="block text-sm">{label} <span className="font-normal text-[#7e8b8d]">· {new Date(row.createdAt).toLocaleString()}</span></strong>
                          <span className="text-xs text-[#7e8b8d]">
                            {row.status === "ready"
                              ? `${files.length} chapter file${files.length === 1 ? "" : "s"}${detail.credits?.opening || detail.credits?.closing ? " · credits" : ""}${detail.retailSample ? " · sample" : ""} · ${formatDuration(row.durationMs || 0)} · ${formatBytes(Number(row.bytes || 0) + (detail.fullBook?.bytes ?? 0))}${detail.output ? ` · ${describeOutput(detail.output)}` : ""}${detail.soundDesign ? ` · ${detail.soundDesign.cues} sound cues` : ""}`
                              : row.status === "failed"
                                ? row.error || "Assembly failed"
                                : detail.progress?.stage ?? "Assembling…"}
                          </span>
                        </div>
                        <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${row.status === "ready" ? "bg-[#e4f2eb] text-[#397868]" : row.status === "failed" ? "bg-[#fbe9e4] text-[#a35a44]" : "bg-[#e9f0f5] text-[#4a6f85]"}`}>{row.status.toUpperCase()}</span>
                        {row.status === "ready" && files.length > 0 && (
                          <a href={`/api/exports/${encodeURIComponent(row.id)}/zip?projectId=${encodeURIComponent(projectId)}`} className="btn-primary" download>
                            <FileArchive aria-hidden="true" className="mr-1 inline" size={13} /> All chapters (.zip)
                          </a>
                        )}
                        {row.status === "ready" && detail.fullBook && (
                          <a href={fileHref(detail.fullBook.storageKey, detail.fullBook.fileName)} className="btn-soft" download={detail.fullBook.fileName}>
                            <Download aria-hidden="true" className="mr-1 inline" size={13} /> Whole book
                          </a>
                        )}
                        {row.status === "ready" && files.length > 0 && (
                          <button onClick={() => setOpenRow(open ? null : row.id)} aria-expanded={open} className="btn-soft">
                            <ChevronDown aria-hidden="true" className={`mr-1 inline transition ${open ? "rotate-180" : ""}`} size={13} /> Files
                          </button>
                        )}
                        {!busy && (
                          <button
                            onClick={() => window.confirm("Delete this package and its files? Your narration is not affected.") && remove.mutate({ projectId, exportId: row.id })}
                            aria-label="Delete this package"
                            className="grid h-8 w-8 place-items-center rounded-lg text-[#9aa2a3] hover:bg-[#fbeeea] hover:text-[#af5d5d]"
                          >
                            <Trash2 aria-hidden="true" size={14} />
                          </button>
                        )}
                      </div>
                      {busy && detail.progress && (
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#dfe9e3]" role="progressbar" aria-valuemin={0} aria-valuemax={detail.progress.total} aria-valuenow={detail.progress.done}>
                          <div className="h-full rounded-full bg-[#5c9688] transition-[width] duration-500" style={{ width: `${Math.max(4, Math.round((detail.progress.done / Math.max(1, detail.progress.total)) * 100))}%` }} />
                        </div>
                      )}
                      {row.status === "ready" && detail.warnings && detail.warnings.length > 0 && (
                        <ul className="mt-2 space-y-1 text-[11px] text-[#8a6b35]">{detail.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
                      )}
                      {open && (
                        <ul className="mt-3 space-y-1.5 rounded-xl bg-[#f7f9f5] p-3">
                          {[
                            ...(detail.credits?.opening ? [{ key: "opening", name: detail.credits.opening.fileName ?? "Opening Credits", storageKey: detail.credits.opening.storageKey, bytes: detail.credits.opening.bytes ?? 0, durationMs: detail.credits.opening.durationMs, rmsDb: null as number | null, peakDb: null as number | null }] : []),
                            ...files.map(file => ({ key: file.chapterId, name: file.fileName ?? `${file.title}.${detail.container ?? "mp3"}`, storageKey: file.storageKey, bytes: file.bytes ?? 0, durationMs: file.durationMs, rmsDb: file.rmsDb ?? null, peakDb: file.peakDb ?? null })),
                            ...(detail.credits?.closing ? [{ key: "closing", name: detail.credits.closing.fileName ?? "Closing Credits", storageKey: detail.credits.closing.storageKey, bytes: detail.credits.closing.bytes ?? 0, durationMs: detail.credits.closing.durationMs, rmsDb: null as number | null, peakDb: null as number | null }] : []),
                            ...(detail.retailSample ? [{ key: "sample", name: detail.retailSample.fileName ?? "Retail Sample", storageKey: detail.retailSample.storageKey, bytes: detail.retailSample.bytes ?? 0, durationMs: detail.retailSample.durationMs, rmsDb: null as number | null, peakDb: null as number | null }] : []),
                          ].map(file => {
                            const levelled = detail.output?.master;
                            const meets = meetsAudiobookStandard(file.rmsDb, file.peakDb);
                            return (
                              <li key={file.key} className="flex flex-wrap items-center gap-2 text-xs">
                                <span className="min-w-0 flex-1 truncate text-[#34484b]">{file.name}</span>
                                <span className="text-[#7e8b8d]">{formatDuration(file.durationMs)} · {formatBytes(file.bytes)}</span>
                                {file.rmsDb != null && file.peakDb != null && (
                                  <span className={meets ? "text-[#397868]" : "text-[#8b9697]"} title="Whole-file RMS and peak level">
                                    {levelled && meets && <CheckCircle2 aria-hidden="true" className="mr-0.5 inline" size={12} />}
                                    {file.rmsDb} dB RMS · peak {file.peakDb} dB
                                  </span>
                                )}
                                <a href={fileHref(file.storageKey, file.name)} download={file.name} className="font-bold text-[#34736d]" aria-label={`Download ${file.name}`}>Download</a>
                              </li>
                            );
                          })}
                          {detail.quality?.noiseFloorDb != null && (
                            <li className="flex flex-wrap items-center gap-2 border-t border-[#e5eae2] pt-2 text-xs">
                              <span className="min-w-0 flex-1 text-[#5d6f71]">Noise floor (checked {detail.quality.checkedFiles ?? 0} file{detail.quality.checkedFiles === 1 ? "" : "s"})</span>
                              <span className={noiseFloorPasses(detail.quality.noiseFloorDb) ? "text-[#397868]" : "text-[#a35a44]"} title={`ACX requires the noise floor under ${AUDIOBOOK_STANDARD.maxNoiseFloorDb} dB`}>
                                {noiseFloorPasses(detail.quality.noiseFloorDb) && <CheckCircle2 aria-hidden="true" className="mr-0.5 inline" size={12} />}
                                {detail.quality.noiseFloorDb} dB
                              </span>
                            </li>
                          )}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </section>

        <aside className="space-y-4">
          <div className={`rounded-[24px] border p-6 ${chosenChapters.length ? "border-[#c9dfd5] bg-[#f4fbf7]" : "border-[#eddabf] bg-[#fff9ee]"}`}>
            <span className="mono text-[10px] tracking-[.13em] text-[#688f8a]">DELIVERY</span>
            <div className="mt-4 flex items-center gap-3">
              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${chosenChapters.length ? "bg-[#e2f1eb] text-[#3d806f]" : "bg-[#fff0da] text-[#ae7b2d]"}`}>
                {chosenChapters.length ? <ShieldCheck aria-hidden="true" size={19} /> : <AlertCircle aria-hidden="true" size={19} />}
              </span>
              <div className="min-w-0">
                <strong className="block text-sm">
                  {chosenChapters.length ? `${chosenChapters.length} chapter${chosenChapters.length === 1 ? "" : "s"} · ${formatDuration(chosenDuration)}` : "Nothing selected"}
                </strong>
                <span className="block text-xs text-[#7c898a]">
                  {overview.isLoading ? "Checking…" : `${overview.data?.exportableChapters ?? 0} of ${chapters.length} chapters can be exported`}
                </span>
              </div>
            </div>

            <p className="mt-4 text-xs leading-5 text-[#5d6f71]">{describeOutput(output)}{output.fullBook ? ", plus a whole-book file" : ""}.</p>
            {soundOn && <p className="mt-2 text-xs leading-5 text-[#5d6f71]">Background {[overview.data?.soundDesign.effects && "sounds", overview.data?.soundDesign.music && "music"].filter(Boolean).join(" and ")} will be mixed in where planned.</p>}
            {!passthrough && overview.data?.ffmpeg === false && <p className="mt-3 rounded-xl bg-white/70 px-3 py-2.5 text-xs leading-5 text-[#8a6b35]">Re-encoding needs ffmpeg on the server. Choose Original, or install ffmpeg.</p>}
            {!chosenChapters.length && blockReason && <p className="mt-3 rounded-xl bg-white/70 px-3 py-2.5 text-xs leading-5 text-[#8a6b35]">{blockReason}</p>}
            {chosenChapters.length > 0 && (overview.data?.warnings ?? []).filter(warning => !/older|later edits/.test(warning) || chosenChapters.some(chapter => chapter.state === "outdated")).map((warning, index) => (
              <p key={index} className="mt-2 text-[11px] leading-4 text-[#8a6b35]">{warning}</p>
            ))}

            <button
              onClick={() => request.mutate({ projectId, chapterIds: chosenChapters.map(chapter => chapter.chapterId), preset: presetId, output })}
              disabled={!canCreate}
              className="btn-primary btn-lg mt-6 w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {request.isPending || assembling
                ? <><LoaderCircle aria-hidden="true" className="animate-spin" size={15} /> Assembling…</>
                : <><Download aria-hidden="true" size={15} /> Create {presetById(presetId).label} package</>}
            </button>
            <p className="mt-4 text-[11px] leading-5 text-[#7c898a]">
              Chapters you have not narrated are left out rather than blocking the book. Each chapter becomes its own file, named and numbered in order.
            </p>
          </div>

          <div className="rounded-[22px] border border-[#dfe5de] bg-[#fffefa] p-5 text-xs leading-5 text-[#5d6f71]">
            <span className="mono text-[10px] tracking-[.13em] text-[#678e89]">SPOTIFY FOR AUTHORS</span>
            <ul className="mt-3 list-disc space-y-1 pl-4">
              <li>Upload the chapter files (MP3, WAV or FLAC), one per chapter, in order.</li>
              <li>Chapter titles come from your manuscript; keep them clear so listeners can navigate.</li>
              <li>Cover art: square PNG or JPEG, 3000 × 3000 px recommended.</li>
            </ul>
            <a className="mt-3 inline-block font-bold text-[#34736d]" href="https://support.spotify.com/us/authors/article/uploading-audiobooks/" target="_blank" rel="noreferrer noopener">Spotify's upload guide</a>
          </div>
        </aside>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-5 border-b border-[#e1e5de] bg-[#fffefa] px-6 py-6 md:flex-row md:items-end md:justify-between md:px-9">
        <div>
          <p className="mono text-[10px] tracking-[.15em] text-[#5a918b]">06 · PUBLISH</p>
          <h2 className="serif mt-2 text-3xl tracking-[-.04em] text-[#25393c]">Publish &amp; export.</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#738084]">
            One file per chapter in MP3, WAV or FLAC, ready for Spotify for Authors and other distributors. Export the chapters you have finished; the rest can follow later.
          </p>
        </div>
      </div>
      {children}
    </div>
  );
}

function Card({ title, eyebrow, action, children }: { title: string; eyebrow: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-[22px] border border-[#dfe5de] bg-[#fffefa] p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <span className="mono text-[10px] tracking-[.13em] text-[#7e8d8e]">{eyebrow}</span>
          <h3 className="font-bold text-[#2f4346]">{title}</h3>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <label className="block text-xs font-bold text-[#526468]">
      {label}
      <select value={value} onChange={event => onChange(event.target.value)} className="input select mt-1.5 text-sm font-normal">
        {children}
      </select>
    </label>
  );
}

function Toggle({ checked, disabled, onChange, label, detail }: { checked: boolean; disabled?: boolean; onChange: (value: boolean) => void; label: string; detail: string }) {
  return (
    <label className={`flex items-start gap-3 rounded-xl bg-[#f3f7f2] p-3 ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#3f817a]" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span>
        <strong className="block text-xs text-[#34484b]">{label}</strong>
        <span className="block text-[11px] leading-4 text-[#7b888a]">{detail}</span>
      </span>
    </label>
  );
}
