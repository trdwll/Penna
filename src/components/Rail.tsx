import type { ComponentType, SVGProps } from "react";
import { CalendarIcon, HistoryIcon, NoteIcon, SearchIcon, SettingsIcon, TagIcon } from "./icons";

export type View = "notes" | "search" | "tags" | "today" | "history" | "settings";

interface RailItem {
  view: View;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const TOP: RailItem[] = [
  { view: "notes", label: "Notes", Icon: NoteIcon },
  { view: "search", label: "Search (Ctrl+Shift+F)", Icon: SearchIcon },
  { view: "tags", label: "Tags (Ctrl+Shift+T)", Icon: TagIcon },
  { view: "today", label: "Today's note (Ctrl+D)", Icon: CalendarIcon },
  { view: "history", label: "History", Icon: HistoryIcon },
];

const SETTINGS: RailItem = { view: "settings", label: "Settings (Ctrl+,)", Icon: SettingsIcon };

/** Views not built yet show in the rail, disabled, so the layout is final from day one. */
const AVAILABLE: ReadonlySet<View> = new Set(["notes", "search", "tags", "today", "history", "settings"]);

export default function Rail({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const button = ({ view: v, label, Icon }: RailItem) => {
    const available = AVAILABLE.has(v);
    const current = v === view;
    return (
      <button
        key={v}
        type="button"
        aria-label={label}
        aria-current={current ? "page" : undefined}
        disabled={!available}
        title={available ? label : `${label} (coming soon)`}
        onClick={() => onChange(v)}
        className={`grid size-10 place-items-center rounded-lg disabled:opacity-35 ${
          current ? "bg-hover text-ink" : "text-ink-3 enabled:hover:bg-hover enabled:hover:text-ink"
        }`}
      >
        <Icon className="size-[18px]" strokeWidth={1.4} />
      </button>
    );
  };

  return (
    <nav aria-label="Views" className="flex w-14 shrink-0 flex-col items-center gap-1 pt-2 pb-3">
      {TOP.map(button)}
      <div className="flex-1" />
      {button(SETTINGS)}
    </nav>
  );
}
