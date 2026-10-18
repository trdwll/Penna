/**
 * Update check: asks GitHub for Penna's newest release and compares it with this build.
 * Nothing is downloaded or installed; Penna only says a new version is out and links to it.
 *
 * The automatic check runs at most once a day (Settings → General turns it off).
 * What it found is remembered on this PC, so the notice survives a restart without asking again.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

export const REPO = "trdwll/Penna";
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

/** How often the automatic check asks GitHub. */
export const CHECK_EVERY = 24 * 60 * 60_000;
/** Wait this long after Penna starts, so the check never competes with opening the vault. */
const FIRST_CHECK_DELAY = 5_000;
/** How often to see whether a day has passed while Penna stays open. */
const TICK = 60 * 60_000;
const STORAGE_KEY = "penna.updates";

export interface Release {
  /** Without the leading "v": "0.9.1". */
  version: string;
  /** The release page on GitHub. */
  url: string;
  /** ISO date, when GitHub says. */
  publishedAt: string | null;
}

interface Version {
  core: [number, number, number];
  pre: string[];
}

/** "v1.2.3", "1.2.3-beta.1+build" → its parts, or null when it isn't a version number. */
export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Above zero when `a` is newer than `b` (semver order: 1.0.0-beta comes before 1.0.0). Unreadable versions are never newer. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

/**
 * The newest published release, or null when the repository has none that anyone can see
 * (GitHub answers 404 for both, including while the repository is private).
 */
export async function fetchLatestRelease(signal?: AbortSignal): Promise<Release | null> {
  let res: Response;
  try {
    res = await fetch(LATEST_API, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store", signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error("Couldn't reach GitHub. Check your connection.");
  }
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) throw new Error("GitHub is limiting checks right now. Try again later.");
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown; published_at?: unknown };
  const tag = typeof data.tag_name === "string" ? data.tag_name : "";
  if (!parseVersion(tag)) throw new Error("The newest release on GitHub has no version number.");
  // Only ever open GitHub pages from what the API sent.
  const url = typeof data.html_url === "string" && data.html_url.startsWith(`https://github.com/${REPO}/`) ? data.html_url : RELEASES_PAGE;
  return {
    version: tag.trim().replace(/^v/, ""),
    url,
    publishedAt: typeof data.published_at === "string" ? data.published_at : null,
  };
}

/** What the last check found, kept on this PC. */
interface Remembered {
  checkedAt: number | null;
  latest: Release | null;
  /** "Skip this version": no title bar notice for it (Settings still says it's out). */
  skipped: string;
}

function remembered(): Remembered {
  const empty: Remembered = { checkedAt: null, latest: null, skipped: "" };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Remembered> | null;
    if (!raw) return empty;
    const latest = raw.latest && typeof raw.latest.version === "string" && typeof raw.latest.url === "string" ? raw.latest : null;
    return {
      checkedAt: typeof raw.checkedAt === "number" ? raw.checkedAt : null,
      latest,
      skipped: typeof raw.skipped === "string" ? raw.skipped : "",
    };
  } catch {
    return empty;
  }
}

function remember(state: Remembered) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable: the next start checks again.
  }
}

/** What one check found. */
export interface CheckResult {
  latest: Release | null;
  /** `latest`, when it's newer than this build. */
  available: Release | null;
  error: string | null;
}

/** The release, if it's newer than `current`. */
const newer = (release: Release | null, current: string) =>
  current && release && compareVersions(release.version, current) > 0 ? release : null;

export interface Updates {
  /** This build's version ("" until known). */
  current: string;
  /** The newest release GitHub showed, or null (none yet, or never checked). */
  latest: Release | null;
  checkedAt: number | null;
  checking: boolean;
  /** Why the last check failed. */
  error: string | null;
  /** A release newer than this build. */
  available: Release | null;
  /** What the title bar shows: `available`, unless checks are off or the user skipped it. */
  notice: Release | null;
  /** Ask GitHub now. */
  check: () => Promise<CheckResult>;
  /** No title bar notice for this version. */
  skip: (version: string) => void;
}

/** The update check, as React state. `auto` is the "Check for updates" setting. */
export function useUpdates(auto: boolean): Updates {
  const [current, setCurrent] = useState("");
  const [saved, setSaved] = useState<Remembered>(remembered);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef<Promise<CheckResult> | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;

  useEffect(() => {
    getVersion()
      .then(setCurrent)
      .catch(() => setCurrent(""));
  }, []);

  const check = useCallback(() => {
    // One request at a time: a click on "Check now" during the automatic check waits for it.
    if (running.current) return running.current;
    setChecking(true);
    const run = (async (): Promise<CheckResult> => {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 15_000);
      try {
        const latest = await fetchLatestRelease(timeout.signal);
        setSaved((s) => {
          const next = { ...s, latest, checkedAt: Date.now() };
          remember(next);
          return next;
        });
        setError(null);
        return { latest, available: newer(latest, currentRef.current), error: null };
      } catch (err) {
        // A failed check doesn't count, so the automatic one tries again within the hour.
        const error = timeout.signal.aborted ? "GitHub didn't answer in time." : err instanceof Error ? err.message : String(err);
        setError(error);
        return { latest: null, available: null, error };
      } finally {
        clearTimeout(timer);
        setChecking(false);
        running.current = null;
      }
    })();
    running.current = run;
    return run;
  }, []);

  // Automatic check: shortly after start, then whenever a day has passed since the last one.
  const lastChecked = useRef(saved.checkedAt);
  lastChecked.current = saved.checkedAt;
  useEffect(() => {
    if (!auto || !current) return;
    const due = () => {
      const at = lastChecked.current;
      if (at === null || Date.now() - at >= CHECK_EVERY || at > Date.now()) void check();
    };
    const first = setTimeout(due, FIRST_CHECK_DELAY);
    const tick = setInterval(due, TICK);
    return () => {
      clearTimeout(first);
      clearInterval(tick);
    };
  }, [auto, current, check]);

  const skip = useCallback((version: string) => {
    setSaved((s) => {
      const next = { ...s, skipped: version };
      remember(next);
      return next;
    });
  }, []);

  const available = newer(saved.latest, current);
  const notice = auto && available && available.version !== saved.skipped ? available : null;
  return { current, latest: saved.latest, checkedAt: saved.checkedAt, checking, error, available, notice, check, skip };
}
