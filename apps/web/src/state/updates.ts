/**
 * New versions for the desktop app: once a day (and on request) it asks the project's release page for the
 * latest version and offers to open its download page. Servers and the web app update where they are hosted.
 * Turned off with the "Check for new versions" setting; nothing but that one request is sent.
 */
import { APP_VERSION } from "@whittle/core";
import { invoke } from "./platform";
import { toast, useApp } from "./store";

const LATEST = "https://api.github.com/repos/anand34577/whittle/releases/latest";
const LAST_CHECK = "whittle.updateCheck";
const DAY = 24 * 60 * 60 * 1000;

/** Whether release `tag` (v1.2.3 or 1.2.3) is newer than version `have`. Pre-releases and odd tags never are. */
export function isNewer(tag: string, have: string): boolean {
  const parse = (v: string) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim()) ?? []).slice(1).map(Number);
  const [a, b] = [parse(tag), parse(have)];
  if (a.length !== 3 || b.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** Look for a newer release. `manual` checks now and says so when there is none. */
export async function checkForUpdate(manual = false) {
  const s = useApp.getState();
  if (s.platform.kind !== "desktop" || (!manual && !s.prefs.updateCheck)) return;
  try {
    if (!manual && Date.now() - Number(localStorage.getItem(LAST_CHECK) ?? 0) < DAY) return;
    localStorage.setItem(LAST_CHECK, String(Date.now()));
  } catch {
    /* storage unavailable: check anyway */
  }
  try {
    const res = await fetch(LATEST, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`The release page answered ${res.status}.`);
    const tag = String(((await res.json()) as { tag_name?: string }).tag_name ?? "");
    if (isNewer(tag, APP_VERSION)) {
      const version = tag.replace(/^v/, "");
      toast("info", `Whittle ${version} is available (you have ${APP_VERSION}).`, { label: "Download", run: () => void invoke("open_release", { version }) });
    } else if (manual) toast("ok", `Whittle ${APP_VERSION} is the latest version.`);
  } catch (e) {
    if (manual) toast("warn", `Couldn't check for a new version: ${e instanceof Error ? e.message : String(e)}`);
  }
}
