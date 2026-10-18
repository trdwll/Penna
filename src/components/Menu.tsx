import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

export interface MenuItem {
  label: string;
  /** Shortcut shown on the right, e.g. "F2". */
  hint?: string;
  danger?: boolean;
  onSelect: () => void;
}

/** Where a menu opens: at the pointer, or under a button (`alignRight` lines up its right edge with `x`). */
export interface MenuAnchor {
  x: number;
  y: number;
  alignRight?: boolean;
}

/** The anchor under a button, right-aligned with it. */
export function anchorBelow(el: Element): MenuAnchor {
  const r = el.getBoundingClientRect();
  return { x: r.right, y: r.bottom + 4, alignRight: true };
}

const EDGE = 8;

/**
 * A small popup menu. Arrow keys move, Enter picks, Esc or a click outside
 * closes it, and focus goes back where it was.
 */
export default function Menu({
  anchor,
  items,
  label,
  onClose,
}: {
  anchor: MenuAnchor;
  items: MenuItem[];
  label: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [returnTo] = useState(() => document.activeElement as HTMLElement | null);

  // Keep it on screen: flip above the anchor when there's no room below.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(anchor.alignRight ? anchor.x - width : anchor.x, window.innerWidth - width - EDGE));
    const top = anchor.y + height > window.innerHeight - EDGE ? Math.max(EDGE, anchor.y - height) : anchor.y;
    setPos({ left, top });
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [anchor]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const dismiss = () => onClose();
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [onClose]);

  function onKeyDown(e: KeyboardEvent) {
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    const focus = (n: number) => buttons[(n + buttons.length) % buttons.length]?.focus();
    if (e.key === "ArrowDown") focus(i + 1);
    else if (e.key === "ArrowUp") focus(i - 1);
    else if (e.key === "Home") focus(0);
    else if (e.key === "End") focus(-1);
    else if (e.key === "Escape" || e.key === "Tab") {
      onClose();
      returnTo?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos?.left ?? anchor.x, top: pos?.top ?? anchor.y, visibility: pos ? "visible" : "hidden" }}
      className="fixed z-50 min-w-[188px] rounded-lg border border-rule bg-bg py-1 shadow-lg select-none"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          className={`flex h-8 w-full items-center justify-between gap-6 px-3 text-left text-[13px] outline-none hover:bg-hover focus:bg-hover ${
            item.danger ? "text-danger" : "text-ink-2 hover:text-ink focus:text-ink"
          }`}
        >
          <span>{item.label}</span>
          {item.hint && <span className="font-mono text-[11px] text-ink-3">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
