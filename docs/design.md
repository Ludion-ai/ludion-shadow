# How the shadow workflow works

The recorder is Ludion's own (`tools/shadow/src/recorder.ts` in [Ludion-ai/ludion](https://github.com/Ludion-ai/ludion)). How its records are counted is fixed in that repository: `docs/decisions/2026-10-29-shadow-counting.md`. Nothing here changes it.

## What runs

- **The workflow.** `.github/workflows/shadow.yml` runs at minute 17 of every hour, or by hand (`workflow_dispatch`). One run at a time: concurrency group `shadow`, never cancelled in progress.
- **The recorder.** Ludion-ai/ludion at `8a78b55940def8463a2401e7bdd38d7e6c7b604d`, the commit the shadow started with. Before each run, its frozen watched list is checked (sha256 `02d3e6de…f6a`, 7,660 names). A later change to the recorder in Ludion does not change what is recorded here. Moving to a newer recorder is a change to this workflow.
- **The driver.** `src/record.ts` is the recorder's own loop with an end:
  - it polls every minute;
  - it reads OSV once a UTC day;
  - it writes a status line per poll;
  - it starts no poll after `RECORD_SECONDS` (3,000 s).

  Its exit code is 0 at the deadline, 3 when the recorder stopped at its storage limit, and 4 when no poll succeeded.
- **The runtime.** node:24-slim by digest, with a read-only root, `--cap-drop ALL`, no new privileges, 2 GB, one CPU and no host environment. The only package added to the pinned code is semver, from the pinned commit's lockfile, checked against its sha512 integrity.

## Where the data lives

- **The branch `shadow-data`** of this repository, with no code on it. This workflow never creates it; it is seeded once (docs/switch-over.md).
- **Its layout:**
  - `state.json` and `known/` at the root, as the recorder keeps them;
  - each run's lines under `runs/<UTC day>/<HHMMSS>Z-<run id>-<attempt>/{captures,osv,status}/<UTC day>.jsonl`;
  - the seeded lines under `runs/pc-8a78b55/`, cut into `<day>.partNN.jsonl` where a file passes 50,000,000 bytes.

  A reader takes every `*.jsonl` under every `runs/**/<kind>/` and orders the records by their own times (`fetched_at`, `at`).
  - **Not by name.** `runs/pc-8a78b55/`, the oldest data, sorts after every `runs/2026-…`.
  - **Within one seeded kind,** the `partNN` files are in name order.
  - **The time in a run's directory name** is when the run was packed.
- **What is rewritten.** Only `state.json` and the `known/` files of names that changed. A run's lines are new files, so no file grows from commit to commit.
- **The storage limit.** 3,800,000,000 bytes, counted over every file on the branch, uncompressed (docs/estimate.md).
  - **How it is counted.** The recorder counts `state.json` and `known/` on disk. The record job adds the size of everything under `runs/`, read from GitHub's recursive listing of that subtree alone. `known/` grows by about 50 files an hour, so a listing of the whole branch could pass GitHub's listing limits (100,000 entries, 7 MB); `runs/` grows by about 7 entries an hour.
  - **At the limit.** The recorder stops itself, and every later run fails visibly.

## Permissions

- **Top level:** `permissions: {}`.
- **record:** `contents: read`, no secret, and no credential kept by its checkouts. It is the only job that runs Node, and it runs it only in the container.
- **write:** `actions: read` (its own run's artifact) and `contents: write` (the push). It runs no Node, npm or Docker. It refuses:
  - a run directory or artifact name that is not this run's attempt;
  - a data branch that moved after the record job read it;
  - a run directory already on the branch;
  - a branch that was deleted or moved by the time it pushes (it reads the branch again just before the push);
  - an artifact over 1 GiB;
  - anything but regular files at the recorder's own paths (`state.json`, `known/…/<sha256>.json`, this run's `runs/…/<kind>/<day>.jsonl`);
  - an artifact without a `state.json` that has a feed position and a feed start.

  It pushes only `HEAD:refs/heads/shadow-data`, and never with force.
- **Pushes start nothing.** GitHub does not start workflows for events made with the workflow's own token, apart from `workflow_dispatch` and `repository_dispatch`.
- **No secret** and no other credential.

## Failures

- **No data branch.** The checkout fails, so no run can start a second shadow with a new feed start.
- **A branch that is not the seeded one.** The record job refuses a root holding anything but `known`, `runs` and `state.json`, and a `state.json` without a feed position and a feed start.
- **What fails a run:**
  - a stop at the storage limit (exit 3);
  - no successful poll (exit 4);
  - any other exit, or a recorder still running 25 minutes after its deadline;
  - an image that could not be pulled after three tries;
  - a refused artifact.

  What was recorded before the failure is still committed when the artifact passes the writer's checks.
- **Re-runs.** Each attempt uploads its own artifact (`shadow-run-<attempt>`), so re-running a failed job commits that attempt's own files.
- **Gaps.** A failed or dropped run loses no feed entry: the next run resumes from the committed `state.json`. A version removed within the gap cannot be captured.
- **Days.** A UTC day with no successful poll still restarts the counted four weeks (the counting decision, section 2).
- **Inactivity.** GitHub disables scheduled workflows in a public repository after 60 days with no repository activity. Whether this workflow's own commits count as activity is unknown. The shadow's 42 days are inside that, but only if the four weeks never restart. If the shadow runs longer, someone must act on the repository before day 60, for example by merging a pull request.

## What differs from a recorder that polls every minute

- **Capture lag.** Polls run for 50 minutes of each hour, and a scheduled run can start late. So a version can wait about 10 minutes, plus the job's setup and any delay in the schedule, before its first capture. A version removed in that time is a capture gap. That gap has a cost: under the counting decision (section 6), a capture gap on a confirmed malicious version, or on a record-omission candidate, counts as a miss for condition (b).
- **Clock.** `fetched_at` comes from the runner's clock.
- **Unchanged.** The recorder's code, the watched list, the hosts it may ask, what it stores, how it removes e-mail addresses, and its retries.
