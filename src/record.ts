// The shadow's recorder on GitHub Actions (.github/workflows/shadow.yml, docs/design.md). The workflow runs Ludion's
// recorder (tools/shadow/src/recorder.ts of Ludion-ai/ludion) at the commit it pins, the one the shadow started with,
// for a bounded time, so that the next job can commit what it wrote to the data branch. drive() is the loop of the
// recorder's own run() with an end: a poll every minute, OSV once a day, a status line per poll, and no poll started
// once the next one would begin after the deadline. The recorder itself is not changed.
// The data directory holds only state.json and known/: the earlier runs' files stay on the data branch, and their size
// is added to the recorder's count, so its storage limit covers the whole branch.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The frozen watched list's sha256 (Ludion's docs/bench/2026-10-29-shadow-recorder/README.md). A different list is a different shadow. */
export const WATCHED_SHA256 = "02d3e6de2cc5e4d05af15d60bb6f9ca7ac17ebd261b652c77a9ce23281674f6a";

/** The part of the recorder's Recorder that drive() uses. */
export type RecorderLike = {
  state: { stopped: string | null; pending: string[] };
  bytes: number;
  poll(): Promise<object>;
  osv(): Promise<number>;
  append(kind: "status", record: object): boolean;
};
export type Outcome = { ended: "deadline" | "stopped"; polls: number; failed_polls: number };
type Options = { until: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> };

const iso = (ms: number) => new Date(ms).toISOString();
const message = (e: unknown) => String((e as Error).message).slice(0, 300);

/** Polls until the next poll would start after `until`, or until the recorder stops at its limit. */
export async function drive(rec: RecorderLike, start: object, opts: Options): Promise<Outcome> {
  const now = opts.now ?? Date.now, interval = opts.intervalMs ?? 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  rec.append("status", { type: "start", at: iso(now()), ...start, bytes: rec.bytes, until: iso(opts.until) });
  let polls = 0, failed = 0;
  while (true) {
    if (rec.state.stopped) return { ended: "stopped", polls, failed_polls: failed };
    const started = now();
    try {
      const s = await rec.poll();
      rec.append("status", { type: "poll", at: iso(now()), ...s, pending: rec.state.pending.length, bytes: rec.bytes, ms: now() - started });
      polls++;
    } catch (e) { rec.append("status", { type: "error", at: iso(now()), error: message(e) }); failed++; }
    try { await rec.osv(); } catch (e) { rec.append("status", { type: "error", at: iso(now()), error: `osv: ${message(e)}` }); }
    const wait = Math.max(1_000, interval - (now() - started));
    if (now() + wait >= opts.until) return { ended: rec.state.stopped ? "stopped" : "deadline", polls, failed_polls: failed };
    await sleep(wait);
  }
}

/** The watched list next to the recorder, refused unless it is the frozen one. */
export function watchedList(recorderPath: string, expected = WATCHED_SHA256): { names: Record<string, string[]>; sha256: string } {
  const text = readFileSync(join(dirname(recorderPath), "..", "watched.json"), "utf8");
  const sha256 = createHash("sha256").update(text).digest("hex");
  if (sha256 !== expected) throw new Error(`The watched list's sha256 is ${sha256}, not the frozen ${expected}.`);
  return { names: JSON.parse(text).names, sha256 };
}

/** Exit codes: 0 at the deadline, 3 stopped at the storage limit, 4 no poll succeeded in this run. */
export const exitCode = (o: Outcome) => (o.ended === "stopped" ? 3 : o.polls === 0 ? 4 : 0);

/** record.ts <recorder.ts> <data dir> <max bytes> <bytes stored elsewhere> <seconds> <commit> <run> */
export async function main(args: string[]): Promise<Outcome> {
  const [recorderPath, dir, max, stored, seconds, commit, run] = args;
  // Digits only: Number("") is 0, and a missing size must not count as nothing stored.
  const numbers = [max, stored, seconds].map(s => (s !== undefined && /^\d+$/.test(s) ? Number(s) : NaN));
  if (!recorderPath || !dir || !commit || !run || numbers.some(n => !Number.isSafeInteger(n))) {
    throw new Error("usage: record.ts <recorder.ts> <data dir> <max bytes> <bytes stored elsewhere> <seconds> <commit> <run>");
  }
  const [maxBytes, storedBytes, secs] = numbers as [number, number, number];
  const watched = watchedList(recorderPath);
  const { Recorder } = await import(pathToFileURL(recorderPath).href);
  const rec: RecorderLike = new Recorder({ dir, maxBytes, watched: watched.names, commit, watchedSha256: watched.sha256 });
  rec.bytes += storedBytes;
  const start = { commit, watched_sha256: watched.sha256, watched_names: Object.keys(watched.names).length, max_bytes: maxBytes, stored_bytes: storedBytes, node: process.version, runner: "github-actions", run };
  return drive(rec, start, { until: Date.now() + secs * 1000 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outcome = await main(process.argv.slice(2));
  console.log(JSON.stringify(outcome));
  // Open keep-alive sockets must not hold the job after the deadline.
  process.exit(exitCode(outcome));
}
