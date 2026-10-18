import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import * as api from "../services/tauri";
import type { GitStatus, Identity } from "../services/tauri";
import { formatDate, type AppSettings, type VaultPatch, type VaultSettings } from "../lib/settings";
import { UnusedFilesDialog, fileSize, type UnusedFile } from "./NoteDialogs";
import { Segmented } from "./TitleBar";
import { ChevronDown, SyncIcon } from "./icons";

interface SettingsViewProps {
  app: AppSettings;
  onApp: (patch: Partial<AppSettings>) => void;
  vault: VaultSettings;
  onVault: (patch: VaultPatch) => void;
  vaultPath: string;
  onSwitchVault: () => void;
  git: GitStatus | null;
  onInitRepo: () => void;
  onGitChanged: () => void;
  /** The computer's name, used when no device name is set. */
  defaultDevice: string;
  notify: (text: string, tone?: "info" | "error") => void;
  /** Move attachments to the Recycle Bin (Attachments → Files no note links to). */
  onDeleteFiles: (paths: string[]) => Promise<void>;
}

const SECTIONS = [
  { id: "general", label: "General", group: "Penna" },
  { id: "editor", label: "Editor", group: "Penna" },
  { id: "appearance", label: "Appearance", group: "Penna" },
  { id: "shortcuts", label: "Shortcuts", group: "Penna" },
  { id: "sync", label: "Sync", group: "This vault" },
  { id: "daily", label: "Daily notes", group: "This vault" },
  { id: "templates", label: "Templates", group: "This vault" },
  { id: "attachments", label: "Attachments", group: "This vault" },
] as const;

const SHORTCUTS: [string, string][] = [
  ["Go to anything", "Ctrl P"],
  ["Tags", "Ctrl Shift T"],
  ["New note from a template", "Ctrl Shift N"],
  ["Open a note beside, or close it", "Ctrl \\"],
  ["Open a note or link beside", "Ctrl click"],
  ["Commands", "Ctrl Shift P"],
  ["Find a note", "Ctrl K"],
  ["New note", "Ctrl N"],
  ["Today's note", "Ctrl D"],
  ["Switch Preview / Source", "Ctrl E"],
  ["Show changes", "Ctrl Shift E"],
  ["Search everything", "Ctrl Shift F"],
  ["Sync now", "Ctrl Shift S"],
  ["Bold / italic", "Ctrl B / Ctrl I"],
  ["Highlight", "Ctrl Shift H"],
  ["Move a block up / down", "Ctrl Shift ↑ / ↓"],
  ["Rename the note", "F2"],
  ["Insert menu", "/"],
  ["Link to a note", "[["],
];

/** The whole Settings view: section list, the settings page, and a note on where settings live. */
export default function SettingsView(props: SettingsViewProps) {
  const [active, setActive] = useState<string>("general");
  const jump = (id: string) => {
    setActive(id);
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      <aside aria-label="Settings sections" className="flex w-64 shrink-0 flex-col gap-5 overflow-y-auto pt-3 pr-5 pb-6 pl-2 select-none">
        {(["Penna", "This vault"] as const).map((group) => (
          <div key={group} className="flex flex-col gap-0.5">
            <div className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">{group}</div>
            {SECTIONS.filter((s) => s.group === group).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => jump(s.id)}
                aria-current={active === s.id ? "true" : undefined}
                className={`flex h-[30px] items-center rounded-md px-2.5 text-left ${
                  active === s.id ? "bg-hover font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        ))}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col border-l border-rule">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SettingsPage {...props} />
        </div>
      </main>

      <aside
        aria-label="About settings"
        className="hidden w-60 shrink-0 flex-col gap-2.5 pt-[112px] pr-7 pl-2 text-[13px] text-ink-2 select-none xl:flex"
      >
        <div className="text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">Where these live</div>
        <p className="leading-relaxed">
          Penna settings stay on this PC. Vault settings are saved in the vault (
          <span className="font-mono text-xs">.penna/settings.json</span>), so they sync to your other devices with your notes.
        </p>
        <p className="text-ink-3">Changes save as you make them.</p>
      </aside>
    </>
  );
}

function SettingsPage({
  app,
  onApp,
  vault,
  onVault,
  vaultPath,
  onSwitchVault,
  git,
  onInitRepo,
  onGitChanged,
  defaultDevice,
  notify,
  onDeleteFiles,
}: SettingsViewProps) {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);
  const today = new Date();

  return (
    <div className="mx-auto w-full pt-10 pr-10 pb-[30vh] pl-[80px]" style={{ maxWidth: "calc(var(--column-width, 680px) + 120px)" }}>
      <div className="flex items-baseline justify-between gap-4 text-xs tracking-[0.1em] text-ink-3 uppercase select-none">
        <span>Settings</span>
        <span className="tracking-normal normal-case">Changes save as you make them</span>
      </div>
      <h1 className="mt-3.5 font-serif text-[44px] leading-[1.12] font-medium tracking-[-0.015em]">Settings</h1>

      <Section id="general" number="01" title="General" scope="This PC">
        <Row title="Open vault" description={<span className="font-mono text-xs break-all">{vaultPath}</span>}>
          <button type="button" onClick={onSwitchVault} className="h-[34px] rounded-lg border border-rule px-3.5 hover:bg-hover">
            Switch vault…
          </button>
        </Row>
        <Row title="Reopen the last vault" description="Skip the folder picker when Penna starts.">
          <Switch label="Reopen the last vault" checked={app.reopenLastVault} onChange={(v) => onApp({ reopenLastVault: v })} />
        </Row>
        <Row title="New notes go in" description="Where Ctrl+N puts a note when you don't type a folder.">
          <Select
            label="New notes go in"
            value={app.newNotesIn}
            onChange={(v) => onApp({ newNotesIn: v as AppSettings["newNotesIn"] })}
            options={[
              ["root", "Vault root"],
              ["inbox", "Inbox"],
              ["current", "Folder of the current note"],
            ]}
          />
        </Row>
      </Section>

      <Section id="editor" number="02" title="Editor" scope="This PC">
        <Row title="Open notes in" description="Ctrl+E switches while you write.">
          <Segmented
            label="Open notes in"
            value={app.defaultView}
            onChange={(v) => onApp({ defaultView: v })}
            options={[
              { value: "preview", label: "Preview" },
              { value: "source", label: "Source" },
            ]}
          />
        </Row>
        <Row title="Changes in Source" description="One column, or the old text beside the new.">
          <Segmented
            label="Changes in Source"
            value={app.diffLayout}
            onChange={(v) => onApp({ diffLayout: v })}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Side by side" },
            ]}
          />
        </Row>
        <div className="flex flex-col gap-3.5 border-t border-rule py-[18px]">
          <RowText title="Writing font" description="Used in Preview. Source always uses DM Mono." />
          <div
            role="radiogroup"
            aria-label="Writing font"
            className="grid grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))] gap-2.5"
          >
            {(
              [
                ["serif", "Newsreader", "Serif, for long reading", "font-serif text-[34px]"],
                ["sans", "Hanken Grotesk", "Sans, plain and crisp", "font-sans text-[32px]"],
                ["mono", "DM Mono", "Mono, like a typewriter", "font-mono text-[28px]"],
              ] as const
            ).map(([value, name, hint, sample]) => (
              <label
                key={value}
                className={`flex flex-col gap-2 rounded-[10px] border p-3.5 ${app.writingFont === value ? "border-ink" : "border-rule hover:border-ink-3/50"}`}
              >
                <span className="flex items-start justify-between">
                  <span className={`${sample} leading-none`}>Aa</span>
                  <input
                    type="radio"
                    name="writing-font"
                    checked={app.writingFont === value}
                    onChange={() => onApp({ writingFont: value })}
                    className="m-0 accent-accent"
                  />
                </span>
                <span className="text-[13px] font-medium">{name}</span>
                <span className="text-xs text-ink-3">{hint}</span>
              </label>
            ))}
          </div>
        </div>
        <Row title="Text size" description="Headings scale with it.">
          <span className="flex items-center gap-3">
            <input
              type="range"
              min={15}
              max={24}
              value={app.textSize}
              onChange={(e) => onApp({ textSize: Number(e.target.value) })}
              aria-label="Text size"
              className="w-44 accent-accent"
            />
            <span className="w-11 font-mono text-xs text-ink-2">{app.textSize} px</span>
          </span>
        </Row>
        <Row title="Line width" description="How wide the page column gets on a big screen.">
          <Segmented
            label="Line width"
            value={app.lineWidth}
            onChange={(v) => onApp({ lineWidth: v })}
            options={[
              { value: "narrow", label: "Narrow" },
              { value: "medium", label: "Medium" },
              { value: "wide", label: "Wide" },
            ]}
          />
        </Row>
        <Row title="Check spelling" description="Uses the Windows dictionary for your language.">
          <Switch label="Check spelling" checked={app.spellcheck} onChange={(v) => onApp({ spellcheck: v })} />
        </Row>
        <Row title="Keep Windows line endings" description="Notes saved with CRLF stay that way, so Git only sees the edits you made.">
          <Switch label="Keep Windows line endings" checked={app.keepCrlf} onChange={(v) => onApp({ keepCrlf: v })} />
        </Row>
      </Section>

      <Section id="appearance" number="03" title="Appearance" scope="This PC">
        <Row title="Theme" description="Match Windows follows your light or dark mode setting.">
          <Segmented
            label="Theme"
            value={app.theme}
            onChange={(v) => onApp({ theme: v })}
            options={[
              { value: "system", label: "Match Windows" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </Row>
        <Row title="Show Markdown marks in the margin" description="The faint ## beside headings in Preview.">
          <Switch label="Show Markdown marks in the margin" checked={app.marginMarks} onChange={(v) => onApp({ marginMarks: v })} />
        </Row>
      </Section>

      <Section id="shortcuts" number="04" title="Shortcuts" scope="This PC">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-x-10 border-t border-rule pt-1.5">
          {SHORTCUTS.map(([label, keys]) => (
            <span key={label} className="flex h-[42px] items-center justify-between border-b border-rule">
              {label}
              <span className="rounded-[5px] border border-rule px-[7px] py-0.5 font-mono text-xs text-ink-2">{keys}</span>
            </span>
          ))}
        </div>
      </Section>

      <Section id="sync" number="05" title="Sync" scope="This vault">
        <SyncCard git={git} onInitRepo={onInitRepo} onGitChanged={onGitChanged} notify={notify} />
        <Row title="Sync automatically" description="Saves a version, gets changes, then sends yours.">
          <span className="flex items-center gap-3">
            <Select
              label="How often to sync"
              value={vault.sync.interval}
              onChange={(v) =>
                onVault({
                  sync: { interval: v as VaultSettings["sync"]["interval"] },
                })
              }
              disabled={!vault.sync.auto}
              options={[
                ["typing", "After I stop typing"],
                ["5", "Every 5 minutes"],
                ["15", "Every 15 minutes"],
                ["60", "Every hour"],
              ]}
            />
            <Switch label="Sync automatically" checked={vault.sync.auto} onChange={(v) => onVault({ sync: { auto: v } })} />
          </span>
        </Row>
        <Row title="Get changes when Penna opens" description="Pull first, so you start from the newest notes.">
          <Switch
            label="Get changes when Penna opens"
            checked={vault.sync.pullOnOpen}
            onChange={(v) => onVault({ sync: { pullOnOpen: v } })}
          />
        </Row>
        <Row title="Sync when Penna closes" description="So your other devices get your last edits.">
          <Switch label="Sync when Penna closes" checked={vault.sync.syncOnClose} onChange={(v) => onVault({ sync: { syncOnClose: v } })} />
        </Row>
        <Row title="This device's name" description="Shown in History so you can tell machines apart. Stays on this PC.">
          <TextInput
            label="This device's name"
            value={app.deviceName}
            placeholder={defaultDevice}
            onCommit={(v) => onApp({ deviceName: v })}
          />
        </Row>
        {git?.isRepo && <IdentityRow notify={notify} />}
        <Row title="Message for automatic versions" description="{date} and {time} are filled in.">
          <TextInput
            label="Message for automatic versions"
            value={vault.sync.message}
            mono
            width="w-60"
            onCommit={(v) => onVault({ sync: { message: v } })}
          />
        </Row>
      </Section>

      <Section id="daily" number="06" title="Daily notes" scope="This vault">
        <Row title="Folder" description="Where each day's note is created.">
          <TextInput label="Daily notes folder" value={vault.daily.folder} onCommit={(v) => onVault({ daily: { folder: v } })} />
        </Row>
        <Row
          title="Template"
          description="A note whose text starts each new day. {{title}}, {{date}}, {{time}} and {{carryover}} are filled in."
        >
          <TextInput label="Daily note template" value={vault.daily.template} onCommit={(v) => onVault({ daily: { template: v } })} />
        </Row>
        <Row title="Title" description={`Today's would be “${formatDate(today, vault.daily.titleFormat)}”.`}>
          <TextInput
            label="Daily note title format"
            value={vault.daily.titleFormat}
            mono
            onCommit={(v) => onVault({ daily: { titleFormat: v } })}
          />
        </Row>
        <Row title="Carry over unfinished tasks" description="Open checkboxes from the last daily note are copied into the new one." last>
          <Switch
            label="Carry over unfinished tasks"
            checked={vault.daily.carryOver}
            onChange={(v) => onVault({ daily: { carryOver: v } })}
          />
        </Row>
      </Section>

      <Section id="templates" number="07" title="Templates" scope="This vault">
        <Row
          title="Folder"
          description="Notes in this folder are templates: start a note from one with Ctrl+Shift+N, or put one into a note from the + menu."
        >
          <TextInput
            label="Templates folder"
            placeholder="No templates"
            value={vault.templates.folder}
            onCommit={(v) => onVault({ templates: { folder: v.trim().replace(/^[\\/]+|[\\/]+$/g, "") } })}
          />
        </Row>
        <Row
          title="Filled in"
          description="{{title}} the note's name · {{date}} today, or {{date:dddd, MMMM D}} in your own format · {{weekday}} · {{time}} · {{cursor}} where typing starts."
        >
          <span />
        </Row>
      </Section>

      <Section id="attachments" number="08" title="Attachments" scope="This vault">
        <Row
          title="Folder"
          description="Where pasted images and dropped or added files are copied. Leave it empty to keep them next to the note."
        >
          <TextInput
            label="Attachments folder"
            placeholder="Next to each note"
            value={vault.attachments.folder}
            onCommit={(v) => onVault({ attachments: { folder: v.trim().replace(/^[\\/]+|[\\/]+$/g, "") } })}
          />
        </Row>
        <UnusedFilesRow onDelete={onDeleteFiles} />
      </Section>

      <div className="mt-14 flex flex-wrap items-center justify-between gap-3 text-[13px] text-ink-3 select-none">
        <span>
          <span className="font-serif text-[19px] text-ink">Penna</span>
          {version && ` · version ${version}`}
        </span>
        <span>Plain Markdown, kept by Git.</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sync card and identity (talk to Git directly)
// ---------------------------------------------------------------------------

function SyncCard({ git, onInitRepo, onGitChanged, notify }: Pick<SettingsViewProps, "git" | "onInitRepo" | "onGitChanged" | "notify">) {
  const [url, setUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [tested, setTested] = useState<"ok" | string | null>(null);

  useEffect(() => {
    if (!git?.isRepo) return;
    api.gitRemoteUrl().then((u) => {
      setUrl(u);
      setDraft(u ?? "");
    });
  }, [git?.isRepo, git?.hasRemote]);

  if (!git) return null;
  if (!git.isRepo) {
    return (
      <Card>
        <span className="font-medium">History isn't set up for this vault</span>
        <span className="text-[13px] text-ink-3">Setting it up starts keeping versions. You can connect a remote afterwards.</span>
        <button
          type="button"
          onClick={onInitRepo}
          className="mt-1 h-8 w-fit rounded-full bg-ink px-4 text-[13px] font-medium text-bg hover:opacity-90"
        >
          Set up history
        </button>
      </Card>
    );
  }

  async function save() {
    setBusy("save");
    try {
      await api.gitSetRemote(draft);
      setUrl(draft.trim() || null);
      setEditing(false);
      setTested(null);
      onGitChanged();
      notify(draft.trim() ? "Remote saved. Sync to send your notes there." : "Disconnected from the remote.");
    } catch (err) {
      notify(`Couldn't save the remote: ${api.errorMessage(err)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setTested(null);
    try {
      await api.gitTestConnection();
      setTested("ok");
    } catch (err) {
      setTested(api.errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const connected = !!url && !editing;
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-2 text-[15px] font-medium">
          <span className={`size-2 rounded-full ${connected ? (tested && tested !== "ok" ? "bg-danger" : "bg-ok") : "bg-faint"}`} />
          {connected ? "Connected to origin" : "Not connected to a remote"}
        </span>
        {connected && (
          <button
            type="button"
            onClick={() => void test()}
            disabled={busy !== null}
            className="flex h-[30px] items-center gap-2 rounded-lg border border-rule px-3 text-[13px] hover:bg-hover disabled:opacity-50"
          >
            <SyncIcon className={`size-3.5 ${busy === "test" ? "animate-spin" : ""}`} />
            Test connection
          </button>
        )}
      </div>
      {connected ? (
        <>
          <span className="font-mono text-[13px] break-all text-ink-2">{url}</span>
          <span className="flex flex-wrap justify-between gap-2 text-[13px] text-ink-3">
            <span className={tested && tested !== "ok" ? "text-danger" : ""}>
              {tested === "ok"
                ? "Connection works."
                : tested
                  ? tested
                  : git.hasUpstream
                    ? "Synced before on this device."
                    : "Not synced from this device yet."}
            </span>
            <button type="button" onClick={() => setEditing(true)} className="text-accent hover:text-ink">
              Change remote…
            </button>
          </span>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <span className="text-[13px] text-ink-3">
            Paste the address of an empty repository (GitHub, GitLab, your own server). HTTPS sign-in uses Git Credential Manager; SSH uses
            your SSH agent.
          </span>
          <span className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="https://github.com/[you]/notes.git"
              aria-label="Remote address"
              className="h-[34px] min-w-0 flex-1 rounded-lg border border-rule bg-bg px-3 font-mono text-[13px] outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy !== null}
              className="h-[34px] rounded-lg bg-ink px-3.5 text-[13px] font-medium text-bg hover:opacity-90 disabled:opacity-50"
            >
              {url ? "Save" : "Connect"}
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="h-[34px] rounded-lg px-3 text-[13px] text-ink-2 hover:bg-hover"
              >
                Cancel
              </button>
            )}
          </span>
        </div>
      )}
    </Card>
  );
}

function IdentityRow({ notify }: { notify: SettingsViewProps["notify"] }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    api
      .gitIdentity()
      .then((who) => {
        setIdentity(who);
        setName(who.vaultOnly ? (who.name ?? "") : "");
        setEmail(who.vaultOnly ? (who.email ?? "") : "");
      })
      .catch(() => setIdentity(null));
  }, []);

  async function commit() {
    if (!identity) return;
    if (name === (identity.vaultOnly ? (identity.name ?? "") : "") && email === (identity.vaultOnly ? (identity.email ?? "") : "")) return;
    try {
      await api.gitSetIdentity(name, email);
      setIdentity(await api.gitIdentity());
      notify(name || email ? "Saved the name for this vault's versions." : "Using your global Git name again.");
    } catch (err) {
      notify(`Couldn't save the name: ${api.errorMessage(err)}`, "error");
    }
  }

  const inherited = identity && !identity.vaultOnly;
  return (
    <Row
      title="Name on saved versions"
      description={
        inherited && identity?.name
          ? `Leave empty to use your Git name, ${identity.name}${identity.email ? ` <${identity.email}>` : ""}.`
          : "Set a name for this vault only. Empty uses your Git settings."
      }
      align="start"
    >
      <span className="flex flex-col gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void commit()}
          placeholder={identity?.name ?? "[Your name]"}
          aria-label="Name"
          className="h-[34px] w-52 rounded-lg border border-rule bg-bg px-3 outline-none focus:border-accent"
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => void commit()}
          placeholder={identity?.email ?? "[you@example.com]"}
          aria-label="Email"
          className="h-[34px] w-52 rounded-lg border border-rule bg-bg px-3 outline-none focus:border-accent"
        />
      </span>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Section({
  id,
  number,
  title,
  scope,
  children,
}: {
  id: string;
  number: string;
  title: string;
  scope: string;
  children: ReactNode;
}) {
  return (
    <section id={`settings-${id}`} aria-labelledby={`settings-${id}-title`} className="scroll-mt-6">
      <div className="mt-14 mb-3 flex items-baseline justify-between">
        <h2 id={`settings-${id}-title`} className="relative font-serif text-[30px] leading-tight font-medium">
          <span aria-hidden="true" className="absolute top-[0.55em] right-full pr-4 font-mono text-xs font-normal text-faint">
            {number}
          </span>
          {title}
        </h2>
        <span className="text-xs text-ink-3">{scope}</span>
      </div>
      {children}
    </section>
  );
}

function RowText({ title, description }: { title: string; description: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[15px] font-medium">{title}</span>
      <span className="text-[13px] leading-snug text-ink-3">{description}</span>
    </div>
  );
}

/** Attachments → Files no note links to: how many, and a dialog to clear them out. */
function UnusedFilesRow({ onDelete }: { onDelete: (paths: string[]) => Promise<void> }) {
  const [unused, setUnused] = useState<UnusedFile[] | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const load = () =>
    api
      .attachmentUsage()
      .then((all) => setUnused(all.filter((u) => u.notes.length === 0).map(({ path, size }) => ({ path, size }))))
      .catch(() => setUnused([]));
  useEffect(() => {
    void load();
  }, []);
  const total = unused?.reduce((sum, f) => sum + f.size, 0) ?? 0;
  return (
    <Row
      title="Files no note links to"
      description={
        unused === null
          ? "Looking…"
          : unused.length
            ? `${unused.length} ${unused.length === 1 ? "file" : "files"} · ${fileSize(total)}. Images and files no note shows or links to.`
            : "Every image and file is used by a note."
      }
      last
    >
      <button
        type="button"
        disabled={!unused?.length}
        onClick={() => setReviewing(true)}
        className="h-8 rounded-full border border-rule px-3.5 text-[13px] text-ink hover:bg-hover disabled:opacity-40"
      >
        Review…
      </button>
      {reviewing && unused && (
        <UnusedFilesDialog
          files={unused}
          onCancel={() => setReviewing(false)}
          onReveal={(path) => void api.revealAttachment(path)}
          onDelete={async (paths) => {
            await onDelete(paths);
            setReviewing(false);
            await load();
          }}
        />
      )}
    </Row>
  );
}

function Row({
  title,
  description,
  children,
  last,
  align = "center",
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
  last?: boolean;
  align?: "center" | "start";
}) {
  return (
    <div
      className={`flex justify-between gap-8 border-t border-rule py-[18px] ${last ? "border-b" : ""} ${align === "start" ? "items-start" : "items-center"}`}
    >
      <RowText title={title} description={description} />
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="mb-[18px] flex flex-col gap-2.5 rounded-[10px] border border-rule px-[18px] py-4">{children}</div>;
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="relative inline-flex">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
        className="peer absolute inset-0 m-0 size-full opacity-0"
      />
      <span
        aria-hidden="true"
        className={`relative block h-[22px] w-[38px] rounded-full transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-accent ${
          checked ? "bg-accent" : "bg-rule"
        }`}
      >
        <span
          className={`absolute top-[3px] size-4 rounded-full bg-bg shadow-sm transition-[left] ${checked ? "left-[19px]" : "left-[3px]"}`}
        />
      </span>
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <span className="relative inline-flex">
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-[34px] appearance-none rounded-lg border border-rule bg-bg pr-9 pl-3 text-ink outline-none focus-visible:border-accent disabled:opacity-50"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute top-[11px] right-3 size-3 text-ink-3" />
    </span>
  );
}

/** A text field that saves when you leave it (or press Enter). */
function TextInput({
  label,
  value,
  onCommit,
  placeholder,
  mono,
  width = "w-52",
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  width?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft.trim());
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      placeholder={placeholder}
      aria-label={label}
      className={`h-[34px] ${width} rounded-lg border border-rule bg-bg px-3 outline-none focus:border-accent ${mono ? "font-mono text-xs" : ""}`}
    />
  );
}
