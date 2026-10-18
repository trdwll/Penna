import { FolderIcon } from "./icons";

/** First run, or the last vault couldn't be opened. */
export default function Welcome({ booting, onOpen }: { booting: boolean; onOpen: () => void }) {
  // While the last vault reopens, render nothing instead of flashing this screen.
  if (booting) return <main className="flex-1" />;

  return (
    <main className="grid flex-1 place-items-center p-8">
      <div className="flex max-w-sm flex-col items-center text-center">
        <h1 className="font-serif text-[56px] leading-none font-medium tracking-[-0.02em] text-ink">Penna</h1>
        <p className="mt-4 font-serif text-[19px] leading-relaxed text-ink-2">
          Plain Markdown in a folder you own, with every version kept by Git.
        </p>
        <button
          type="button"
          onClick={onOpen}
          className="mt-8 flex h-10 items-center gap-2 rounded-full bg-ink px-5 font-medium text-bg hover:opacity-90"
        >
          <FolderIcon className="size-4" />
          Open a vault folder
        </button>
        <p className="mt-3 text-xs text-ink-3">Any folder works. Existing .md files show up right away.</p>
      </div>
    </main>
  );
}
