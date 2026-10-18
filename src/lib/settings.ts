/**
 * Settings, in two places:
 *
 * - **App settings** stay on this PC (localStorage): theme, writing font,
 *   editor behavior, device name.
 * - **Vault settings** live in the vault as `.penna/settings.json`, so they
 *   travel with the notes to every device: sync behavior, daily notes, attachments.
 *
 * Both are read with defaults filled in, so older or partial files just work.
 */
import type { DiffLayout, ViewMode } from "../editor/Editor";

export interface AppSettings {
  reopenLastVault: boolean;
  newNotesIn: "root" | "inbox" | "current";
  defaultView: ViewMode;
  /** How Changes shows in Source. */
  diffLayout: DiffLayout;
  writingFont: "serif" | "sans" | "mono";
  textSize: number;
  lineWidth: "narrow" | "medium" | "wide";
  spellcheck: boolean;
  keepCrlf: boolean;
  theme: "system" | "light" | "dark";
  marginMarks: boolean;
  /** Shown in History so machines can be told apart. Empty = the computer's name. */
  deviceName: string;
}

export interface VaultSettings {
  sync: {
    auto: boolean;
    /** "typing" = a couple of minutes after you stop editing; otherwise minutes. */
    interval: "typing" | "5" | "15" | "60";
    pullOnOpen: boolean;
    syncOnClose: boolean;
    /** Message for automatic versions; {date} and {time} are filled in. */
    message: string;
  };
  daily: {
    folder: string;
    template: string;
    /** dddd, ddd, MMMM, MMM, MM, M, DD, D, YYYY */
    titleFormat: string;
    carryOver: boolean;
  };
  attachments: {
    /** Where pasted and dropped files go. Empty = next to the note. */
    folder: string;
  };
  templates: {
    /** Notes in this folder are templates. Empty = no templates. */
    folder: string;
  };
}

/** A change to some vault settings, section by section. */
export interface VaultPatch {
  sync?: Partial<VaultSettings["sync"]>;
  daily?: Partial<VaultSettings["daily"]>;
  attachments?: Partial<VaultSettings["attachments"]>;
  templates?: Partial<VaultSettings["templates"]>;
}

export const DEFAULT_APP: AppSettings = {
  reopenLastVault: true,
  newNotesIn: "root",
  defaultView: "preview",
  diffLayout: "unified",
  writingFont: "serif",
  textSize: 19,
  lineWidth: "medium",
  spellcheck: true,
  keepCrlf: true,
  theme: "system",
  marginMarks: true,
  deviceName: "",
};

export const DEFAULT_VAULT: VaultSettings = {
  sync: { auto: true, interval: "15", pullOnOpen: true, syncOnClose: true, message: "Vault backup {date} {time}" },
  daily: { folder: "Journal", template: "Templates/Daily.md", titleFormat: "dddd, MMMM D", carryOver: true },
  attachments: { folder: "Attachments" },
  templates: { folder: "Templates" },
};

const APP_KEY = "penna.settings";

export function loadAppSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(APP_KEY);
    return raw ? { ...DEFAULT_APP, ...(JSON.parse(raw) as Partial<AppSettings>) } : DEFAULT_APP;
  } catch {
    return DEFAULT_APP;
  }
}

export function saveAppSettings(settings: AppSettings) {
  try {
    localStorage.setItem(APP_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: settings last until the app closes.
  }
}

export function parseVaultSettings(json: string | null): VaultSettings {
  if (!json) return DEFAULT_VAULT;
  try {
    const raw = JSON.parse(json) as Partial<VaultSettings>;
    return {
      sync: { ...DEFAULT_VAULT.sync, ...(raw.sync ?? {}) },
      daily: { ...DEFAULT_VAULT.daily, ...(raw.daily ?? {}) },
      attachments: { ...DEFAULT_VAULT.attachments, ...(raw.attachments ?? {}) },
      templates: { ...DEFAULT_VAULT.templates, ...(raw.templates ?? {}) },
    };
  } catch {
    return DEFAULT_VAULT;
  }
}

const FONT: Record<AppSettings["writingFont"], string> = {
  serif: "var(--font-serif)",
  sans: "var(--font-sans)",
  mono: "var(--font-mono)",
};
const WIDTH: Record<AppSettings["lineWidth"], string> = { narrow: "600px", medium: "680px", wide: "820px" };

/** Put app settings into effect: theme, writing font/size, column width, margin marks. */
export function applyAppSettings(settings: AppSettings) {
  const root = document.documentElement;
  if (settings.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", settings.theme);
  root.style.setProperty("--writing-font", FONT[settings.writingFont]);
  root.style.setProperty("--writing-size", `${settings.textSize}px`);
  root.style.setProperty("--column-width", WIDTH[settings.lineWidth]);
  root.classList.toggle("hide-margin-marks", !settings.marginMarks);
}

/** Message for an automatic version, with the device recorded as a trailer History can show. */
export function syncMessage(template: string, device: string, date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const summary = (template.trim() || DEFAULT_VAULT.sync.message)
    .replaceAll("{date}", `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`)
    .replaceAll("{time}", `${pad(date.getHours())}:${pad(date.getMinutes())}`);
  return device ? `${summary}\n\nDevice: ${device}` : summary;
}

/** Format a date with dddd/ddd/MMMM/MMM/MM/M/DD/D/YYYY tokens; anything else is kept as written. */
export function formatDate(date: Date, format: string): string {
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, options).format(date);
  const tokens: Record<string, () => string> = {
    YYYY: () => String(date.getFullYear()),
    MMMM: () => part({ month: "long" }),
    MMM: () => part({ month: "short" }),
    MM: () => String(date.getMonth() + 1).padStart(2, "0"),
    M: () => String(date.getMonth() + 1),
    dddd: () => part({ weekday: "long" }),
    ddd: () => part({ weekday: "short" }),
    DD: () => String(date.getDate()).padStart(2, "0"),
    D: () => String(date.getDate()),
  };
  return format.replace(/YYYY|MMMM|MMM|MM|M|dddd|ddd|DD|D/g, (token) => tokens[token]());
}
