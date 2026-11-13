import type { SettingsService } from "./settings";

/**
 * Where "latest" comes from: this fork is installed from its own repository, not from
 * npm, so the check reads the create-talorys package version on the fork's main branch.
 * A release is a version bump there; the fix is the usual git pull + update flow.
 */
export const LATEST_URL = "https://raw.githubusercontent.com/wrinfotel/talorys/main/packages/create-talorys/package.json";
const CACHE_KEY = "update.latest";
const TTL_MS = 24 * 60 * 60 * 1000;
/** Retry a failed lookup sooner than a successful one, but not on every page load. */
const FAILURE_TTL_MS = 60 * 60 * 1000;

interface CachedLatest {
  version: string | null;
  checked_at: number;
}

export interface UpdateStatus {
  enabled: boolean;
  current: string;
  latest: string | null;
  update_available: boolean;
  checked_at: string | null;
}

/** Latest published version, cached in tal_settings. Never throws; offline yields latest: null. */
export async function checkForUpdate(
  settings: SettingsService,
  current: string,
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<UpdateStatus> {
  if (!settings.get().updateCheck) {
    return { enabled: false, current, latest: null, update_available: false, checked_at: null };
  }
  let cached = settings.getJson<CachedLatest>(CACHE_KEY);
  const ttl = cached?.version ? TTL_MS : FAILURE_TTL_MS;
  if (!cached || nowMs - cached.checked_at >= ttl) {
    cached = { version: await fetchLatest(fetchFn), checked_at: nowMs };
    settings.setJson(CACHE_KEY, cached);
  }
  const latest = cached.version;
  return {
    enabled: true,
    current,
    latest,
    update_available: latest !== null && compareVersions(latest, current) > 0,
    checked_at: new Date(cached.checked_at).toISOString(),
  };
}

async function fetchLatest(fetchFn: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchFn(LATEST_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" && parseVersion(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Compares plain x.y.z versions; anything unparseable (e.g. prereleases) never counts as newer. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}
