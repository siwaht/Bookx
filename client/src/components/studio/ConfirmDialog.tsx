import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Asks before anything that costs money (a provider call) or cannot be undone.
 * The cost line says what will be sent, so a paid action is never a surprise.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  cost,
  confirmLabel,
  onConfirm,
  pending,
  disabled,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** "Sends about 4,200 characters to ElevenLabs (paid)". */
  cost?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg rounded-panel bg-paper">
        <DialogHeader>
          <DialogTitle className="serif text-xl tracking-[-.02em] text-ink-900">{title}</DialogTitle>
          {description && <DialogDescription className="text-sm leading-6 text-ink-500">{description}</DialogDescription>}
        </DialogHeader>
        {children}
        {cost && <div className="rounded-xl border border-gold-200 bg-gold-50 px-3.5 py-2.5 text-xs leading-5 text-gold-700">{cost}</div>}
        <DialogFooter className="gap-2 sm:gap-2">
          <button type="button" className="btn-soft" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</button>
          <button type="button" className="btn-primary" onClick={onConfirm} disabled={pending || disabled}>
            {pending && <LoaderCircle aria-hidden="true" className="animate-spin" size={14} />}
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
