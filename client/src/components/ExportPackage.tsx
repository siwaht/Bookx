import { createElement, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Download,
  Headphones,
  LoaderCircle,
  Mic2,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

/**
 * Export screen.
 *
 * The button is gated on a server-side audit rather than on a progress bar: a book
 * with a missing, stale, or differently-voiced segment cannot be packaged at all.
 * That is the point of the gate — a partial export is only discovered by a listener.
 */

type ExportFormat = "ACX" | "Podcast" | "InAudio package";

const FORMATS: Array<[ExportFormat, string, typeof BookOpen]> = [
  ["ACX", "Audiobook delivery", BookOpen],
  ["Podcast", "Episode package", Mic2],
  ["InAudio package", "Chaptered distribution", Headphones],
];

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
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ExportPackage({
  projectId,
  canExport,
  disabledReason,
}: {
  projectId: string;
  canExport: boolean;
  disabledReason: string;
}) {
  const utils = trpc.useUtils();
  const [format, setFormat] = useState<ExportFormat>("ACX");
  const packageLabel = format === "InAudio package" ? format : `${format} package`;

  const readiness = trpc.bookx.exportReadiness.useQuery({ projectId }, { enabled: canExport });
  const exports = trpc.bookx.listExports.useQuery(
    { projectId },
    {
      enabled: canExport,
      // Assembly is a background job, so poll while one is in flight.
      refetchInterval: query =>
        query.state.data?.some(row => row.status === "queued" || row.status === "assembling") ? 2000 : false,
    },
  );

  const request = trpc.bookx.requestExport.useMutation({
    onSuccess: () => {
      utils.bookx.listExports.invalidate({ projectId });
      toast.success("Assembling your package.", { description: "Chapters are joined without re-encoding, so nothing is re-compressed." });
    },
    onError: error => toast.error(error.message || "Bookx could not start the export."),
  });

  const download = trpc.bookx.exportDownloadUrl.useMutation({
    onSuccess: result => window.open(result.url, "_blank", "noopener,noreferrer"),
    onError: error => toast.error(error.message || "Bookx could not produce a download link."),
  });

  if (!canExport) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Header />
        <div className="flex flex-1 items-center justify-center p-9">
          <div className="max-w-md rounded-[22px] border border-dashed border-[#d4ded7] bg-[#fbfcf9] p-7 text-center">
            <Download className="mx-auto mb-4 text-[#a3b3ac]" size={26} />
            <h3 className="font-bold text-[#35494b]">Export needs a saved project</h3>
            <p className="mt-2 text-sm leading-6 text-[#748285]">{disabledReason}</p>
          </div>
        </div>
      </div>
    );
  }

  const ready = readiness.data?.ready === true;
  const blockReason = readiness.data && !readiness.data.ready ? readiness.data.reason : null;
  const rows = exports.data ?? [];
  const assembling = rows.some(row => row.status === "queued" || row.status === "assembling");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header />
      <div className="grid flex-1 gap-6 overflow-auto p-6 lg:grid-cols-[minmax(0,1fr)_340px] md:p-9">
        <section>
          <div className="grid gap-3 md:grid-cols-3">
            {FORMATS.map(([name, detail, Icon]) => (
              <button
                key={name}
                onClick={() => setFormat(name)}
                aria-pressed={format === name}
                className={`rounded-[20px] border p-5 text-left ${format === name ? "border-[#8eb8ae] bg-[#edf7f3]" : "border-[#dfe5de] bg-[#fffefa]"}`}
              >
                {createElement(Icon, { size: 18, className: "mb-5 text-[#4d887f]", "aria-hidden": true })}
                <strong className="block text-sm">{name}</strong>
                <span className="mt-1 block text-xs text-[#788688]">{detail}</span>
              </button>
            ))}
          </div>

          <div className="mt-5 rounded-[22px] border border-[#dfe5de] bg-[#fffefa] p-5">
            <span className="mono text-[10px] tracking-[.13em] text-[#7e8d8e]">{packageLabel.toUpperCase()}</span>
            <h3 className="serif mt-2 text-2xl">Joined without re-encoding.</h3>
            <div className="mt-5 space-y-3 text-sm text-[#5d6f71]">
              {[
                "Chapter files plus one combined file with chapter marks",
                "Frame-level join, so the audio is bit-identical to what the model produced",
                "Format mismatches are refused rather than silently concatenated",
                "Silence between chapters is generated in the same encoding as the audio",
              ].map(line => (
                <div key={line} className="flex items-start gap-3">
                  <CheckCircle2 aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-[#5c9688]" />
                  {line}
                </div>
              ))}
            </div>
          </div>

          {rows.length > 0 && (
            <div className="mt-5 rounded-[22px] border border-[#dfe5de] bg-[#fffefa] p-5">
              <h3 className="font-bold">Packages</h3>
              {rows.map(row => (
                <div key={row.id} className="flex flex-wrap items-center gap-3 border-t border-[#edf0eb] py-3.5">
                  <div className="min-w-0 flex-1">
                    <strong className="block text-sm">{row.format}</strong>
                    <span className="text-xs text-[#7e8b8d]">
                      {row.status === "ready"
                        ? `${formatDuration(row.durationMs || 0)} · ${formatBytes(Number(row.bytes || 0))} · ${row.detail?.chapters?.length ?? 0} chapters`
                        : row.status === "failed"
                          ? row.error || "Assembly failed"
                          : "Assembling…"}
                    </span>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${row.status === "ready" ? "bg-[#e4f2eb] text-[#397868]" : row.status === "failed" ? "bg-[#fbe9e4] text-[#a35a44]" : "bg-[#e9f0f5] text-[#4a6f85]"}`}>
                    {row.status.toUpperCase()}
                  </span>
                  {row.status === "ready" && (
                    <button
                      onClick={() => download.mutate({ projectId, exportId: row.id })}
                      disabled={download.isPending}
                      className="btn-soft disabled:opacity-50"
                    >
                      <Download className="mr-1 inline" size={13} /> Download
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-4">
          <div className={`rounded-[24px] border p-6 ${ready ? "border-[#c9dfd5] bg-[#f4fbf7]" : "border-[#eddabf] bg-[#fff9ee]"}`}>
            <span className="mono text-[10px] tracking-[.13em] text-[#688f8a]">DELIVERY STATUS</span>
            <div className="mt-4 flex items-center gap-3">
              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${ready ? "bg-[#e2f1eb] text-[#3d806f]" : "bg-[#fff0da] text-[#ae7b2d]"}`}>
                {ready ? <ShieldCheck size={19} /> : <AlertCircle size={19} />}
              </span>
              <div className="min-w-0">
                <strong className="block text-sm">{ready ? "Ready to package" : "Not ready yet"}</strong>
                <span className="block text-xs text-[#7c898a]">
                  {readiness.isLoading
                    ? "Checking…"
                    : `${readiness.data?.segments ?? 0} segments · ${formatDuration(readiness.data?.durationMs ?? 0)}`}
                </span>
              </div>
            </div>

            {blockReason && <p className="mt-4 rounded-xl bg-white/70 px-3 py-2.5 text-xs leading-5 text-[#8a6b35]">{blockReason}</p>}

            <button
              onClick={() => request.mutate({ projectId, format })}
              disabled={!ready || request.isPending || assembling}
              className="btn-primary btn-lg mt-6 w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {request.isPending || assembling
                ? <><LoaderCircle className="animate-spin" size={15} /> Assembling…</>
                : <><Download size={15} /> Create {packageLabel}</>}
            </button>

            <p className="mt-4 text-[11px] leading-5 text-[#7c898a]">
              Bookx will not package a book with a missing, edited, or differently-voiced segment. The check runs against the stored audio, not a progress counter.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="flex flex-col gap-5 border-b border-[#e1e5de] bg-[#fffefa] px-6 py-6 md:flex-row md:items-end md:justify-between md:px-9">
      <div>
        <p className="mono text-[10px] tracking-[.15em] text-[#5a918b]">06 · PUBLISH</p>
        <h2 className="serif mt-2 text-3xl tracking-[-.04em] text-[#25393c]">Publish &amp; export.</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#738084]">
          Join the rendered segments into chapter files and one continuous file with chapter marks.
        </p>
      </div>
    </div>
  );
}
