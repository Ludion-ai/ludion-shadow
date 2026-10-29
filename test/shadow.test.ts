// The shadow workflow (.github/workflows/shadow.yml) and its driver (src/record.ts):
// - the recording job can only read and has no secret, the writing job runs no Node, npm or Docker, and every action
//   is pinned by commit SHA;
// - the workflow's own shell steps, cut out of the file and run by bash against a local bare repository, commit only
//   the recorder's files for their own run and refuse everything else;
// - the driver ends at its deadline or at the recorder's limit, against the recorder at the pinned commit.
// Run: SHADOW_APP=<checkout of the pinned recorder commit, with node_modules/semver> node --test test/shadow.test.ts
// The script tests need bash, git, jq, tar and unzip; with CI set, a missing one fails them instead of skipping.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32 } from "node:zlib";
import { drive, exitCode, main, watchedList, WATCHED_SHA256, type RecorderLike } from "../src/record.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const SHADOW = readFileSync(join(root, ".github/workflows/shadow.yml"), "utf8").replace(/\r\n/g, "\n");
const TEST = readFileSync(join(root, ".github/workflows/test.yml"), "utf8").replace(/\r\n/g, "\n");
const APP = process.env.SHADOW_APP ? resolve(root, process.env.SHADOW_APP) : undefined;
const RECORDER = APP ? join(APP, "tools/shadow/src/recorder.ts") : "";
const code = (yaml: string) => yaml.split("\n").filter(l => !l.trim().startsWith("#")).join("\n");
/** One job's text, from its key to the next job. */
function job(name: string): string {
  const text = code(SHADOW), from = text.indexOf(`\n  ${name}:\n`);
  assert.ok(from > 0, name);
  const rest = text.slice(from + 1), next = rest.slice(1).search(/\n  [a-z]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
const permissionsOf = (text: string) => { const m = /\n    permissions:\n((?:      .*\n|\s*#.*\n)+)/.exec(text); return m ? m[1]!.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")) : []; };
const uses = (yaml: string) => code(yaml).split("\n").filter(l => /^\s*(-\s+)?uses:/.test(l)).map(l => l.replace(/^\s*(-\s+)?uses:\s*/, ""));
/** A step's run: script, without its indentation. */
function step(name: string, yaml = SHADOW): string {
  const lines = yaml.split("\n"), from = lines.indexOf(`      - name: ${name}`);
  assert.ok(from > 0, name);
  const at = lines.findIndex((l, i) => i > from && /^ +run: \|$/.test(l)), indent = lines[at]!.search(/\S/), body: string[] = [];
  for (const line of lines.slice(at + 1)) { if (line.trim() && line.search(/\S/) <= indent) break; body.push(line.slice(indent + 2)); }
  return body.join("\n") + "\n";
}

describe("shadow.yml", () => {
  it("runs on its hourly schedule or by hand, one run at a time, with no permission at the top", () => {
    assert.match(SHADOW, /\non:\n  schedule:\n(?:    #.*\n)*    - cron: "17 \* \* \* \*"\n(?:  #.*\n)*  workflow_dispatch:\n\npermissions: \{\}\n/);
    assert.doesNotMatch(code(SHADOW), /pull_request|workflow_run|push:|repository_dispatch|inputs:/);
    assert.match(SHADOW, /\nconcurrency:\n  group: shadow\n  cancel-in-progress: false\n/);
  });
  it("uses no secret, and pins every action by commit SHA", () => {
    for (const yaml of [SHADOW, TEST]) {
      assert.doesNotMatch(code(yaml), /secrets\./);
      const all = uses(yaml);
      assert.ok(all.length > 0);
      for (const u of all) assert.match(u, /^actions\/(checkout|upload-artifact|setup-node)@[0-9a-f]{40} # v[\d.]+$/);
    }
  });
  it("pins the recorder's repository and commit, the image and the storage limit", () => {
    assert.ok(SHADOW.includes("  RECORDER_REPOSITORY: Ludion-ai/ludion\n  RECORDER_COMMIT: 8a78b55940def8463a2401e7bdd38d7e6c7b604d\n"));
    assert.ok(SHADOW.includes("IMAGE: node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205\n"));
    assert.ok(SHADOW.includes('MAX_BYTES: "3800000000"\n'));
  });
  it("gives the recording job read access to contents only, and never persists a credential there", () => {
    const record = job("record");
    assert.deepEqual(permissionsOf(record), ["contents: read"]);
    const checkouts = record.split("- uses: actions/checkout@").slice(1);
    assert.equal(checkouts.length, 3);
    for (const c of checkouts) assert.match(c, /\n          persist-credentials: false\n/);
    assert.match(record, /repository: \$\{\{ env\.RECORDER_REPOSITORY \}\}\n          ref: \$\{\{ env\.RECORDER_COMMIT \}\}/);
    assert.match(record, /ref: \$\{\{ env\.DATA_BRANCH \}\}/);
    assert.ok(record.includes('docker run -d --name ludion-shadow --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" \\\n            --memory 2g --cpus 1 --cap-drop ALL --security-opt no-new-privileges -e HOME=/tmp \\\n'));
    assert.ok(record.includes('-v "$GITHUB_WORKSPACE/app:/app:ro" -v "$GITHUB_WORKSPACE/shadow/src:/driver:ro"'));
    assert.doesNotMatch(record, /--env-file|-e GH_TOKEN|--privileged|docker\.sock/);
    assert.doesNotMatch(record, /\bnpm\b|\bnpx\b/);
  });
  it("names each attempt's artifact apart, so a re-run commits its own", () => {
    assert.ok(job("record").includes('echo "artifact=shadow-run-${RUN_ATTEMPT}" >> "$GITHUB_OUTPUT"'));
    assert.ok(job("record").includes("name: ${{ steps.pack.outputs.artifact }}"));
  });
  it("gives the writing job only the artifact read and the push, and runs no Node, npm or Docker there", () => {
    const write = job("write");
    assert.deepEqual(permissionsOf(write), ["actions: read", "contents: write"]);
    assert.doesNotMatch(write, /\bnode\b|\bnpm\b|\bnpx\b|\bdocker\b|setup-node|src\/record/);
    assert.deepEqual(uses(write), ["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1"]);
    assert.deepEqual(write.match(/git push.*$/gm), ['git push --quiet origin "HEAD:refs/heads/${DATA_BRANCH}"']);
    assert.doesNotMatch(write, /--force|\+HEAD|\+refs/);
  });
  it("has no step that makes a branch; the checkouts and the guard below refuse a missing or foreign one", () => {
    assert.doesNotMatch(code(SHADOW), /--orphan|checkout -b|switch -c|git init|git branch/);
  });
  it("adds semver to the recorder the same way in the test workflow as in the shadow workflow", () => {
    const name = "Add semver from the pinned commit's lockfile, checked against its integrity";
    assert.equal(step(name, TEST), step(name));
  });
});

const has = (program: string, arg = "--version") => spawnSync(program, [arg]).status === 0;
const sh = (script: string, cwd: string, env: Record<string, string> = {}) => {
  const r = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const ok = (script: string, cwd: string, env: Record<string, string> = {}) => { const r = sh(`set -euo pipefail\n${script}`, cwd, env); assert.equal(r.status, 0, r.out); return r.out.trim(); };
/** A zip with one stored file, as upload-artifact makes it (compression aside). */
function zip(name: string, data: Buffer): Buffer {
  const n = Buffer.from(name), crc = crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
  const offset = local.length + n.length + data.length, size = central.length + n.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([local, n, data, central, n, end]);
}
// A stand-in for gh: the tree listing from the local repository (or a truncated one), and an artifact by its name,
// served from $FAKE/<name>.zip with the name as its id. "$[" stands for a shell "${", which a template literal would
// take for its own.
const GH = String.raw`#!/bin/bash
set -euo pipefail
case "$*" in
  api\ */git/trees/*)
    if [ -n "$[TRUNCATED:-}" ]; then echo '{"truncated": true, "tree": []}'; exit 0; fi
    sha=$[2#*/git/trees/}; sha=$[sha%%\?*}
    git -C "$FAKE/remote.git" ls-tree -r -l "$sha" | jq -R -s '{truncated: false, tree: [split("\n")[] | select(length > 0)
      | capture("^(?<mode>[0-9]+) (?<type>[a-z]+) (?<sha>[0-9a-f]+) +(?<size>[0-9]+)\t(?<path>.*)$") | .size |= tonumber]}' ;;
  api\ *"/artifacts?name="*)
    name=$[2#*artifacts?name=}
    if [ -f "$FAKE/$name.zip" ]; then echo "$name $(wc -c < "$FAKE/$name.zip")"; fi ;;
  api\ */actions/artifacts/*/zip)
    id=$[2#*/actions/artifacts/}; cat "$FAKE/$[id%/zip}.zip" ;;
  *) echo "gh stand-in: unexpected call: $*" >&2; exit 1 ;;
esac
`.replaceAll("$[", "${");
const KNOWN = `known/aa/${"a".repeat(64)}.json`, STATE = '{"seq":"5","feed_started_at":"2026-10-28T15:51:48.394Z","pending":[]}';
const STAMP = "2026-10-30/101500Z-777-1";
const tools = ["bash", "git", "jq", "tar"].every(p => has(p)) && has("unzip", "-v");

describe("shadow.yml's scripts, against a local data branch", { skip: !tools && !process.env.CI ? "needs bash, git, jq, tar and unzip" : false }, () => {
  /** A data branch as the seed script leaves it, plus `extra` files at their paths. */
  function branch(extra: Record<string, string> = {}, state = STATE) {
    const fake = mkdtempSync(join(tmpdir(), "shadow-branch-")), seed = join(fake, "seed");
    const files: Record<string, string> = { "state.json": state, [KNOWN]: "{}", "runs/pc-8a78b55/status/2026-10-28.jsonl": '{"type":"poll"}\n', ...extra };
    for (const [path, text] of Object.entries(files)) { mkdirSync(join(seed, path, ".."), { recursive: true }); writeFileSync(join(seed, path), text); }
    mkdirSync(join(fake, "bin")); writeFileSync(join(fake, "bin", "gh"), GH); chmodSync(join(fake, "bin", "gh"), 0o755);
    ok(`git init -q --bare remote.git && git -C remote.git config uploadpack.allowFilter true
      git -C seed init -q -b shadow-data && git -C seed add -A
      git -C seed -c user.name=t -c user.email=t@example.invalid commit -q -m seed && git -C seed push -q "file://${fake}/remote.git" shadow-data`, fake);
    return {
      fake, url: `file://${fake}/remote.git`,
      head: () => ok("git -C remote.git rev-parse shadow-data", fake),
      tree: () => ok("git -C remote.git ls-tree -r --name-only shadow-data", fake).split("\n"),
      env: { PATH: `${join(fake, "bin")}:${process.env.PATH}`, FAKE: fake, GH_TOKEN: "x", REPO: "Ludion-ai/ludion-shadow" },
    };
  }
  type Branch = ReturnType<typeof branch>;
  /** The record job's checkout of the data branch (sparse known/, blobless), then its check step. */
  function check(b: Branch, env: Record<string, string> = {}) {
    const w = mkdtempSync(join(b.fake, "r-"));
    ok(`git clone -q --depth 1 --filter=blob:none --sparse --branch shadow-data ${b.url} data && git -C data sparse-checkout set known`, w);
    writeFileSync(join(w, "out"), "");
    const r = sh(step("Check the data branch and read the size of its runs"), w, { ...b.env, GITHUB_OUTPUT: join(w, "out"), ...env });
    const output = readFileSync(join(w, "out"), "utf8");
    return { ...r, output, w, value: (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(output)?.[1] ?? "" };
  }
  /** The writer's checkout (sparse /state.json, blobless), then its step, with `zipFile` served as `artifact`. */
  function writeStep(b: Branch, tarFile: string, opts: { stamp?: string; runId?: string; artifact?: string; dataSha?: string; beforeStep?: () => void } = {}) {
    const artifact = opts.artifact ?? "shadow-run-1";
    writeFileSync(join(b.fake, `${artifact}.zip`), zip("shadow.tar", readFileSync(tarFile)));
    const w = mkdtempSync(join(b.fake, "w-"));
    ok(`git clone -q --depth 1 --filter=blob:none --no-checkout --branch shadow-data ${b.url} data
      git -C data sparse-checkout set --no-cone /state.json && git -C data checkout -q shadow-data`, w);
    const dataSha = opts.dataSha ?? b.head();
    opts.beforeStep?.();
    return sh(step("Check the run's files and commit them"), w, { ...b.env, RUN_ID: opts.runId ?? "777", STAMP: opts.stamp ?? STAMP, ARTIFACT: artifact, DATA_SHA: dataSha, DATA_BRANCH: "shadow-data" });
  }
  type Entry = string | { link: string } | { hardlink: string };
  /** Packs `files` (text, { link } for a symbolic link, { hardlink } for a hard link) as tar and runs the writer on it. */
  function write(b: Branch, files: Record<string, Entry>, opts: Parameters<typeof writeStep>[2] = {}) {
    const src = mkdtempSync(join(b.fake, "src-"));
    for (const [path, v] of Object.entries(files)) {
      mkdirSync(join(src, path, ".."), { recursive: true });
      if (typeof v === "string") writeFileSync(join(src, path), v);
      else if ("link" in v) symlinkSync(v.link, join(src, path));
      else linkSync(join(src, v.hardlink), join(src, path));
    }
    const tar = join(b.fake, `${src.split(/[\\/]/).pop()}.tar`);
    ok(`tar -C '${src}' -cf '${tar}' ${Object.keys(files).map(f => `'${f}'`).join(" ")}`, b.fake);
    return writeStep(b, tar, opts);
  }

  describe("the write job's step", () => {
    it("commits the recorder's own files for this run on top of the branch, keeping what was there", () => {
      const b = branch();
      const r = write(b, { "state.json": '{"seq":"9","feed_started_at":"2026-10-28T15:51:48.394Z"}', [KNOWN]: '{"time":{}}', [`runs/${STAMP}/captures/2026-10-30.jsonl`]: "{}\n", [`runs/${STAMP}/status/2026-10-30.jsonl`]: "{}\n" });
      assert.equal(r.status, 0, r.out);
      assert.deepEqual(b.tree(), [KNOWN, `runs/${STAMP}/captures/2026-10-30.jsonl`, `runs/${STAMP}/status/2026-10-30.jsonl`, "runs/pc-8a78b55/status/2026-10-28.jsonl", "state.json"]);
      assert.equal(ok(`git -C remote.git show shadow-data:${KNOWN}; echo; git -C remote.git log -1 --format=%s shadow-data`, b.fake), `{"time":{}}\nshadow: run ${STAMP}`);
    });
    it("commits an hour's lines when state.json did not change", () => {
      const b = branch();
      const r = write(b, { "state.json": STATE, [`runs/${STAMP}/status/2026-10-30.jsonl`]: '{"type":"error"}\n' });
      assert.equal(r.status, 0, r.out);
      assert.ok(b.tree().includes(`runs/${STAMP}/status/2026-10-30.jsonl`));
    });
    const refused: [string, Record<string, Entry>, RegExp][] = [
      ["a path the recorder never writes", { "state.json": STATE, ".github/workflows/x.yml": "on: push" }, /::error::The artifact holds a path the recorder does not write:\n\.github\/workflows\/x\.yml/],
      ["another run's directory", { "state.json": STATE, "runs/2026-10-30/101500Z-778-1/status/2026-10-30.jsonl": "{}\n" }, /::error::The artifact holds a path the recorder does not write/],
      ["a .tmp leftover", { "state.json": STATE, "state.json.tmp": "{}" }, /::error::The artifact holds a path the recorder does not write/],
      ["a symbolic link at a known/ path", { "state.json": STATE, [KNOWN]: { link: "/etc/passwd" } }, /::error::The artifact holds something other than regular files/],
      ["a hard link", { "state.json": STATE, [KNOWN]: { hardlink: "state.json" } }, /::error::The artifact holds something other than regular files/],
      ["no state.json", { [`runs/${STAMP}/status/2026-10-30.jsonl`]: "{}\n" }, /::error::The artifact holds no state\.json/],
      ["a state.json that is not an object", { "state.json": "[]" }, /::error::The artifact's state\.json has no feed position and feed start/],
      ["a state.json without a feed start", { "state.json": '{"seq":"9","feed_started_at":null}' }, /::error::The artifact's state\.json has no feed position and feed start/],
    ];
    for (const [what, files, message] of refused) {
      it(`refuses an artifact holding ${what}, and leaves the branch as it was`, () => {
        const b = branch(), before = b.head();
        const r = write(b, files);
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out, message);
        assert.equal(b.head(), before);
      });
    }
    it("refuses another run's id, an artifact of another attempt, and a branch that moved after the record job read it", () => {
      const b = branch(), before = b.head(), files = { "state.json": STATE };
      assert.match(write(b, files, { runId: "778" }).out, /::error::Unexpected run directory or artifact/);
      assert.match(write(b, files, { artifact: "shadow-run-2" }).out, /::error::Unexpected run directory or artifact/);
      assert.match(write(b, files, { artifact: "shadow-run-1; x" }).out, /::error::Unexpected run directory or artifact/);
      assert.match(write(b, files, { dataSha: "0".repeat(40) }).out, /::error::The data branch moved from 0{40}/);
      assert.equal(b.head(), before);
    });
    it("refuses a run directory that is already on the branch", () => {
      const b = branch({ [`runs/${STAMP}/status/2026-10-30.jsonl`]: "{}\n" }), before = b.head();
      assert.match(write(b, { "state.json": STATE }).out, /::error::runs\/2026-10-30\/101500Z-777-1 is already on the data branch/);
      assert.equal(b.head(), before);
    });
    it("does not re-create a branch deleted while the write job ran", () => {
      const b = branch();
      const r = write(b, { "state.json": STATE, [`runs/${STAMP}/status/2026-10-30.jsonl`]: "{}\n" }, { beforeStep: () => ok("git -C remote.git branch -D shadow-data", b.fake) });
      assert.notEqual(r.status, 0, r.out);
      assert.match(r.out, /::error::The data branch is at '', not [0-9a-f]{40}\. Nothing pushed\./);
      assert.equal(ok("git -C remote.git branch --list shadow-data", b.fake), "");
    });
    it("commits a re-run's own artifact: attempt 2 with shadow-run-2", () => {
      const b = branch(), stamp = "2026-10-30/111500Z-777-2";
      const r = write(b, { "state.json": STATE, [`runs/${stamp}/status/2026-10-30.jsonl`]: "{}\n" }, { stamp, artifact: "shadow-run-2" });
      assert.equal(r.status, 0, r.out);
      assert.ok(b.tree().includes(`runs/${stamp}/status/2026-10-30.jsonl`));
    });
  });

  describe("the record job's check of the data branch", () => {
    it("counts the bytes under runs/ and moves the repository out of the data directory", () => {
      const b = branch({ "runs/2026-10-30/000000Z-1-1/captures/2026-10-30.jsonl": "x".repeat(1000) });
      const r = check(b);
      assert.equal(r.status, 0, r.out);
      assert.equal(r.output, `data_sha=${b.head()}\nbytes=${1000 + '{"type":"poll"}\n'.length}\n`);
      assert.equal(existsSync(join(r.w, "data", ".git")), false);
      assert.equal(existsSync(join(r.w, "data.git")), true);
    });
    const refused: [string, Record<string, string>, string, Record<string, string>, RegExp][] = [
      ["a branch with anything else at its root", { "README.md": "x" }, STATE, {}, /root holds 'README\.md known runs state\.json '/],
      ["a state.json without a feed start", {}, '{"seq":"5","feed_started_at":null}', {}, /no feed position and feed start/],
      ["a truncated listing of runs/", {}, STATE, { TRUNCATED: "1" }, /truncated/],
    ];
    for (const [what, extra, state, env, message] of refused) {
      it(`refuses ${what}`, () => {
        const r = check(branch(extra, state), env);
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out, message);
        assert.equal(r.output, "");
      });
    }
  });

  describe("from the record job's pack step to the writer", () => {
    it("commits what a run wrote, under its own run directory, without .tmp leftovers", () => {
      const b = branch(), c = check(b);
      assert.equal(c.status, 0, c.out);
      const data = join(c.w, "data"), other = `known/bb/${"b".repeat(64)}.json`;
      // What the recorder leaves: state.json and a known/ file rewritten, a new known/ file, a crash's .tmp, and lines.
      writeFileSync(join(data, "state.json"), '{"seq":"6","feed_started_at":"2026-10-28T15:51:48.394Z","pending":[]}');
      writeFileSync(join(data, KNOWN), '{"time":{"1.0.0":"x"}}');
      mkdirSync(join(data, "known/bb")); writeFileSync(join(data, other), "{}"); writeFileSync(join(data, `${other}.tmp`), "{");
      for (const kind of ["captures", "status"]) { mkdirSync(join(data, kind)); writeFileSync(join(data, kind, "2026-10-30.jsonl"), `{"kind":"${kind}"}\n`); }
      writeFileSync(join(c.w, "pack.out"), "");
      ok(step("Pack what the recorder wrote"), c.w, { RUN_ID: "777", RUN_ATTEMPT: "1", GITHUB_OUTPUT: join(c.w, "pack.out") });
      const out = readFileSync(join(c.w, "pack.out"), "utf8"), stamp = /^stamp=(.*)$/m.exec(out)![1]!;
      assert.match(out, /^artifact=shadow-run-1$/m);
      assert.match(stamp, /^\d{4}-\d{2}-\d{2}\/\d{6}Z-777-1$/);
      const r = writeStep(b, join(c.w, "shadow.tar"), { stamp, dataSha: c.value("data_sha") });
      assert.equal(r.status, 0, r.out);
      assert.deepEqual(b.tree(), [KNOWN, other, `runs/${stamp}/captures/2026-10-30.jsonl`, `runs/${stamp}/status/2026-10-30.jsonl`, "runs/pc-8a78b55/status/2026-10-28.jsonl", "state.json"]);
      assert.equal(JSON.parse(ok("git -C remote.git show shadow-data:state.json", b.fake)).seq, "6");
    });
  });
});

/** A recorder stand-in: each poll takes `pollMs` of a fake clock; `fail` polls throw. */
function fake(opts: { pollMs?: number; fail?: boolean; stopAfter?: number } = {}) {
  let t = Date.parse("2026-10-30T00:00:00Z"), polls = 0;
  const lines: any[] = [];
  const rec: RecorderLike = {
    state: { stopped: null, pending: [] },
    bytes: 10,
    async poll() {
      t += opts.pollMs ?? 500; polls++;
      if (opts.fail) throw new Error("network down");
      if (opts.stopAfter !== undefined && polls >= opts.stopAfter) rec.state.stopped = "the data directory would pass 1 bytes";
      return { entries: 1, watched: 0, seq: String(polls) };
    },
    async osv() { return 0; },
    append(_kind, record) { lines.push(record); return true; },
  };
  return { rec, lines, now: () => t, sleep: async (ms: number) => { t += ms; }, start: t };
}
const statusLines = (dir: string) => readdirSync(join(dir, "status")).flatMap(f => readFileSync(join(dir, "status", f), "utf8").trim().split("\n").map(l => JSON.parse(l)));

describe("drive (src/record.ts)", () => {
  it("polls every minute and starts no poll that would begin after the deadline", async () => {
    const f = fake();
    const out = await drive(f.rec, { run: "1-1" }, { until: f.start + 5 * 60_000, now: f.now, sleep: f.sleep });
    assert.deepEqual(out, { ended: "deadline", polls: 5, failed_polls: 0 });
    assert.equal(exitCode(out), 0);
    assert.deepEqual({ type: f.lines[0].type, run: f.lines[0].run, bytes: f.lines[0].bytes, until: f.lines[0].until }, { type: "start", run: "1-1", bytes: 10, until: "2026-10-30T00:05:00.000Z" });
    assert.deepEqual(f.lines.filter(l => l.type === "poll").map(l => l.at), ["2026-10-30T00:00:00.500Z", "2026-10-30T00:01:00.500Z", "2026-10-30T00:02:00.500Z", "2026-10-30T00:03:00.500Z", "2026-10-30T00:04:00.500Z"]);
  });
  it("lets a poll running at the deadline finish, then ends", async () => {
    const f = fake({ pollMs: 90_000 });
    assert.deepEqual(await drive(f.rec, {}, { until: f.start + 60_000, now: f.now, sleep: f.sleep }), { ended: "deadline", polls: 1, failed_polls: 0 });
  });
  it("ends at once when the recorder stops at its limit, with exit code 3", async () => {
    const f = fake({ stopAfter: 2 });
    const out = await drive(f.rec, {}, { until: f.start + 60 * 60_000, now: f.now, sleep: f.sleep });
    assert.deepEqual(out, { ended: "stopped", polls: 2, failed_polls: 0 });
    assert.equal(exitCode(out), 3);
  });
  it("records each failed poll as an error line and exits 4 when none succeeded", async () => {
    const f = fake({ fail: true });
    const out = await drive(f.rec, {}, { until: f.start + 3 * 60_000, now: f.now, sleep: f.sleep });
    assert.deepEqual(out, { ended: "deadline", polls: 0, failed_polls: 3 });
    assert.deepEqual(f.lines.filter(l => l.type === "error").map(l => l.error), ["network down", "network down", "network down"]);
    assert.equal(exitCode(out), 4);
  });
});

describe("the driver against the pinned recorder", { skip: !APP && !process.env.CI ? "set SHADOW_APP to a checkout of the pinned recorder commit" : false }, () => {
  it("is given the recorder in CI", () => assert.ok(APP && existsSync(RECORDER), "SHADOW_APP must name a checkout of the pinned recorder commit"));
  it("counts the bytes stored on the data branch against the recorder's limit, before reading anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shadow-actions-"));
    // 900 bytes stored elsewhere and a 1,000-byte limit: the start line does not fit, so nothing is fetched.
    const out = await main([RECORDER, dir, "1000", "900", "60", "8a78b55940def8463a2401e7bdd38d7e6c7b604d", "1-1"]);
    assert.deepEqual(out, { ended: "stopped", polls: 0, failed_polls: 0 });
    assert.equal(exitCode(out), 3);
    const status = statusLines(dir);
    assert.equal(status.length, 1);
    assert.deepEqual({ type: status[0].type, reason: status[0].reason, bytes: status[0].bytes }, { type: "stopped", reason: "the data directory would pass 1000 bytes", bytes: 900 });
    assert.match(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).stopped, /would pass 1000 bytes/);
  });
  it("records a start line naming the run and the stored bytes when they fit", async () => {
    const { Recorder } = await import(pathToFileURL(RECORDER).href);
    const dir = mkdtempSync(join(tmpdir(), "shadow-actions-"));
    const rec = new Recorder({ dir, maxBytes: 100_000, watched: {}, fetchFn: (async () => new Response(JSON.stringify({ update_seq: 5 }))) as typeof fetch });
    rec.bytes += 50_000;
    const t = Date.parse("2026-10-30T00:00:00Z");
    await drive(rec, { run: "7-2", stored_bytes: 50_000 }, { until: t + 1, now: () => t, sleep: async () => {} });
    const first = statusLines(dir)[0];
    assert.deepEqual({ type: first.type, run: first.run, stored_bytes: first.stored_bytes, bytes: first.bytes }, { type: "start", run: "7-2", stored_bytes: 50_000, bytes: 50_000 });
  });
  it("refuses arguments that are not whole numbers, including an empty or missing size", async () => {
    for (const args of [["1.5", "0", "60"], ["1000", "-1", "60"], ["1000", "", "60"], ["1000", " 7", "60"]]) {
      await assert.rejects(main([RECORDER, "/tmp/x", ...args, "c", "r"]), /usage/, args.join(","));
    }
    await assert.rejects(main([RECORDER, "/tmp/x", "1000"]), /usage/);
  });
  it("accepts the frozen watched list and refuses any other", () => {
    assert.equal(watchedList(RECORDER).sha256, WATCHED_SHA256);
    assert.equal(Object.keys(watchedList(RECORDER).names).length, 7660);
    assert.throws(() => watchedList(RECORDER, "0".repeat(64)), /not the frozen/);
  });
});
