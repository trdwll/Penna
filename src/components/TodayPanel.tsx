import { useEffect, useMemo, useState } from "react";
import type { TreeNode } from "../services/tauri";
import { addDays, dailyNotes, isoDate, sameDay, shortTitle, startOfDay } from "../lib/daily";
import { ChevronRight } from "./icons";

interface TodayPanelProps {
  tree: TreeNode[];
  /** The day being shown. */
  selected: Date;
  onPick: (date: Date) => void;
}

const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Intl.DateTimeFormat(undefined, { weekday: "narrow" }).format(new Date(2026, 1, 1 + i)), // Feb 1 2026 is a Sunday
);
const monthTitle = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const fullDate = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

/** Today view's left panel: a month calendar (dots on days with notes) and the latest daily notes. */
export default function TodayPanel({ tree, selected, onPick }: TodayPanelProps) {
  const [month, setMonth] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));
  useEffect(() => setMonth(new Date(selected.getFullYear(), selected.getMonth(), 1)), [selected]);

  const notes = useMemo(() => dailyNotes(tree), [tree]);
  const withNotes = useMemo(() => new Set(notes.map((n) => isoDate(n.date))), [notes]);
  const today = startOfDay(new Date());

  // Six rows, Sunday first, starting on the Sunday on or before the 1st.
  const first = addDays(month, -month.getDay());
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const weeks = days[35].getMonth() === month.getMonth() ? 6 : 5;

  return (
    <aside aria-label="Journal" className="flex w-64 shrink-0 flex-col gap-7 overflow-y-auto pt-4 pr-5 pb-6 pl-3.5 select-none">
      <section aria-label={monthTitle.format(month)} className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between pl-1">
          <span className="font-serif text-[19px] font-medium">{monthTitle.format(month)}</span>
          <div className="flex gap-0.5">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
              className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-hover"
            >
              <ChevronRight className="size-3 rotate-180" />
            </button>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
              className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-hover"
            >
              <ChevronRight className="size-3" />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center text-[13px]">
          {WEEKDAYS.map((d, i) => (
            <span key={i} aria-hidden="true" className="pb-1.5 text-[11px] font-semibold text-ink-3">
              {d}
            </span>
          ))}
          {days.slice(0, weeks * 7).map((day) => {
            const inMonth = day.getMonth() === month.getMonth();
            const isToday = sameDay(day, today);
            const isSelected = sameDay(day, selected);
            const hasNote = withNotes.has(isoDate(day));
            return (
              <button
                key={isoDate(day)}
                type="button"
                onClick={() => onPick(day)}
                aria-label={`${fullDate.format(day)}${hasNote ? ", has a note" : ""}`}
                aria-current={isToday ? "date" : undefined}
                aria-pressed={isSelected}
                className={`flex h-[34px] flex-col items-center justify-center gap-[3px] rounded-md ${
                  isToday
                    ? "bg-ink font-semibold text-bg"
                    : isSelected
                      ? "bg-hover font-medium text-ink ring-1 ring-ink-3/40"
                      : inMonth
                        ? hasNote
                          ? "text-ink hover:bg-hover"
                          : "text-ink-2 hover:bg-hover"
                        : "text-faint hover:bg-hover"
                }`}
              >
                {day.getDate()}
                <span className={`size-1 rounded-full ${hasNote ? (isToday ? "bg-bg" : "bg-accent") : ""}`} />
              </button>
            );
          })}
        </div>
      </section>

      <div className="flex flex-col gap-0.5">
        <div className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">Recent days</div>
        {notes.slice(0, 8).map(({ path, date }) => {
          const current = sameDay(date, selected);
          return (
            <button
              key={path}
              type="button"
              onClick={() => onPick(date)}
              aria-current={current ? "page" : undefined}
              className={`flex min-h-[30px] items-center justify-between rounded-md px-2.5 text-left ${
                current ? "bg-hover font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
              }`}
            >
              <span className="truncate">{shortTitle(date)}</span>
              {sameDay(date, today) && <span className="text-xs font-normal text-ink-3">today</span>}
            </button>
          );
        })}
        {notes.length === 0 && <p className="px-2.5 text-[13px] text-ink-3">No daily notes yet. Today's starts when you open it.</p>}
      </div>
    </aside>
  );
}
