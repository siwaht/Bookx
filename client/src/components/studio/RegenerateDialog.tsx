import { Pause } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { isBuiltInProvider } from "@shared/providers";
import { formatBalance } from "@shared/usage";
import { ConfirmDialog } from "./ConfirmDialog";
import { Notice, count } from "./studioUi";

/**
 * Confirms a chapter regeneration with what it will cost: the lines, the
 * characters (direction tags included, as they are billed too) and, where
 * the provider reports it, what is left in the account.
 */
export function RegenerateDialog({
  projectId,
  chapter,
  open,
  onOpenChange,
  activeJobId,
}: {
  projectId: string;
  chapter: { id: string; title: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A run that is rendering right now, which has to pause first. */
  activeJobId: string | null;
}) {
  const utils = trpc.useUtils();
  const estimate = trpc.studio.estimate.useQuery(
    { projectId, chapterIds: chapter ? [chapter.id] : [], regenerate: true },
    { enabled: open && Boolean(chapter) },
  );
  const provider = estimate.data?.provider;
  const balances = trpc.providers.balances.useQuery(
    provider && isBuiltInProvider(provider) ? { provider } : undefined,
    { enabled: open && Boolean(provider && isBuiltInProvider(provider)) },
  );
  const balance = balances.data?.find(entry => entry.provider === provider);

  const pause = trpc.bookx.pauseNarration.useMutation({
    onSuccess: () => {
      toast("Pausing after the current line…");
      void utils.bookx.narrationStatus.invalidate({ projectId });
    },
    onError: error => toast.error(error.message || "Prosecast could not pause the run."),
  });
  const regenerate = trpc.studio.regenerateChapters.useMutation({
    onSuccess: () => {
      toast.success(`Regenerating ${chapter?.title ?? "the chapter"}. You can listen to finished lines as they arrive.`);
      void utils.bookx.narrationStatus.invalidate({ projectId });
      void utils.bookx.auditNarration.invalidate({ projectId });
      onOpenChange(false);
    },
    onError: error => toast.error(error.message || "Prosecast could not start the regeneration."),
  });

  const data = estimate.data;
  const short = balance?.status === "ok" && balance.unit === "credits" && balance.remaining !== undefined && data ? balance.remaining < data.characters : false;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Regenerate ${chapter?.title ?? "chapter"}?`}
      description="Every line in the chapter is narrated again with the current model, voices, pronunciation and direction, even lines whose audio is up to date. The new audio replaces the old line by line, and a paused regeneration resumes where it stopped."
      confirmLabel="Regenerate chapter"
      pending={regenerate.isPending}
      disabled={!data || Boolean(activeJobId) || data.segments === 0}
      onConfirm={() => chapter && regenerate.mutate({ projectId, chapterIds: [chapter.id] })}
      cost={data ? (
        <>
          Sends <strong>{count(data.segments)}</strong> line{data.segments === 1 ? "" : "s"} and about <strong>{count(data.characters)}</strong> characters
          {data.directionCharacters > 0 && <> (including {count(data.directionCharacters)} for direction tags)</>} to <strong>{data.provider}</strong> · {data.model}. This is a paid request.
          {balance?.status === "ok" && balance.remaining !== undefined && (
            <span className="mt-1 block">Your {data.provider} account has {formatBalance(balance.remaining, balance.unit)} left{balance.resetsAt ? `, resetting ${new Date(balance.resetsAt).toLocaleDateString()}` : ""}.</span>
          )}
        </>
      ) : estimate.isLoading ? "Working out the cost…" : estimate.error?.message}
    >
      {activeJobId && (
        <Notice
          tone="warn"
          title="Narration is running"
          action={
            <button type="button" className="btn-soft" onClick={() => pause.mutate({ projectId, jobId: activeJobId })} disabled={pause.isPending}>
              <Pause aria-hidden="true" size={13} /> Pause the run
            </button>
          }
        >
          Pause it first. The regeneration starts straight away, and Continue narration picks up the rest of the book afterwards.
        </Notice>
      )}
      {short && (
        <Notice tone="bad" title="Not enough credits">
          This needs about {count(data!.characters)} credits and the account has {formatBalance(balance!.remaining, balance!.unit)}. The run will stop when they run out; everything rendered until then is kept.
        </Notice>
      )}
    </ConfirmDialog>
  );
}
