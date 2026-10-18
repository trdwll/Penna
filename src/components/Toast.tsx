import { useEffect } from "react";
import { CloseIcon } from "./icons";

export interface ToastMessage {
  id: number;
  text: string;
  tone: "info" | "error";
}

/** One message at a time, bottom center. Info fades after a few seconds; errors stay until closed. */
export default function Toast({ message, onDismiss }: { message: ToastMessage | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!message || message.tone === "error") return;
    const id = setTimeout(onDismiss, 4500);
    return () => clearTimeout(id);
  }, [message, onDismiss]);

  if (!message) return null;
  const error = message.tone === "error";
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
      <div
        role={error ? "alert" : "status"}
        className="pointer-events-auto flex max-w-[560px] items-start gap-3 rounded-xl bg-tooltip py-2.5 pr-2 pl-4 text-[13px] leading-snug text-on-tooltip shadow-lg"
      >
        {error && <span className="mt-1 size-2 shrink-0 rounded-full bg-danger" aria-hidden="true" />}
        <span className="min-w-0 py-0.5 break-words">{message.text}</span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="grid size-6 shrink-0 place-items-center rounded-md opacity-70 hover:opacity-100"
        >
          <CloseIcon className="size-3" />
        </button>
      </div>
    </div>
  );
}
