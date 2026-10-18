import { useEffect, useRef, useState } from "react";
import type { Release } from "../lib/updates";
import { UpdateIcon } from "./icons";

/** "October 18", or "October 18, 2025" for an earlier year. */
function releasedOn(date: Date): string {
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year }).format(date);
}

/**
 * The title bar's "Update" pill, shown when GitHub has a newer Penna. It opens a
 * small card: the new version, a link to its release page, and "Skip this version".
 */
export default function UpdateNotice({
  release,
  current,
  onDownload,
  onSkip,
}: {
  release: Release;
  current: string;
  onDownload: () => void;
  onSkip: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);

  // Esc or a click elsewhere closes it, like a menu.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!card.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    card.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const date = release.publishedAt ? new Date(release.publishedAt) : null;
  return (
    <div className="relative shrink-0">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        title={`Penna ${release.version} is out${current ? ` (you have ${current})` : ""}`}
        aria-label="Update"
        className={`flex h-[30px] shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] whitespace-nowrap max-[1100px]:px-2 ${
          open ? "border-ink-3/40 bg-hover text-ink" : "border-rule text-ink-2 hover:border-ink-3/40 hover:text-ink"
        }`}
      >
        <UpdateIcon className="size-3.5 text-accent" />
        <span className="max-[1100px]:sr-only">Update</span>
      </button>
      {open && (
        <div
          ref={card}
          role="dialog"
          aria-label="Update available"
          className="absolute top-[calc(100%+6px)] right-0 z-50 flex w-[300px] flex-col gap-1 rounded-[10px] border border-rule bg-bg p-4 shadow-lg"
        >
          <div className="font-serif text-[19px] leading-tight font-medium text-ink">Penna {release.version} is out</div>
          <p className="text-[13px] leading-snug text-ink-3">
            {current ? `You have ${current}.` : ""}
            {date && !Number.isNaN(date.getTime()) ? ` Released ${releasedOn(date)}.` : ""}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDownload();
              }}
              className="h-8 rounded-full bg-ink px-4 text-[13px] font-medium text-bg hover:opacity-90"
            >
              Download
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onSkip();
              }}
              className="h-8 rounded-full px-3 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
            >
              Skip this version
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
