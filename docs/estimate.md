# Storage, minutes and cost: the estimate

Every figure here is an estimate from one measurement, not a bound, unless it is labelled as a measurement or a published limit. Where something is unknown it says so.

## The measurement it rests on

The container recorder's first 9.35 hours, from 2026-10-28T15:51:48Z to 2026-10-29T01:13:00Z, read without changing anything. The script and its log are in Ludion-ai/ludion at commit `c4512cb99cb518973d2130c65a9a9991c9a5ce53` (reachable as `refs/pull/197/head`): `docs/bench/2026-10-29-shadow-actions/scripts/measure-pc.sh` and `logs/measure-pc.log`.

| | Measured |
| --- | --- |
| Data directory | 58,581,507 bytes |
| Polls | 561 (one a minute), 42,829 feed entries, 441 watched changes |
| Poll duration | median 301 ms, p90 3,392 ms, p99 27,835 ms, max 67,362 ms |
| First-seen names | 247 names, 8,796,338 bytes, plus 25,539,477 bytes of their versions |
| New versions | 14,678,373 bytes (`new` 328, `retry` 97); 36,451 bytes per `new` record, with its file list |
| Other captures | 199,076 bytes (`created` 481, `change` 194, `deprecation` 17) |
| Status lines | 73,007 bytes |
| `known/` | 9,245,477 bytes: 247 name files (mean 36,937) and 481 `created` files |
| gzip -6 ratio | captures 0.331, `known/` 0.290 |

This is one weekday night, so the rates below are low-confidence.

## Storage

The shadow needs captures for four weeks plus the longest wait, 336 h: about 42 days.

| Item | Per day | 28 days | 42 days | How |
| --- | --- | --- | --- | --- |
| New versions | 37.7 MB | 1,055 MB | 1,582 MB | 14,678,373 B / 9.35 h × 24 |
| First-seen names, central | — | 306 MB | 306 MB | 139,011 B per name × 2,198 names (28.7% of 7,660 published within 28 days in a sample) |
| First-seen names, if every name is seen | — | 1,065 MB | 1,065 MB | × 7,660 |
| `known/`, central / every name | — | 81 / 283 MB | 81 / 283 MB | 36,937 B × 2,198 / 7,660 |
| Status, `created` and the rest | 0.7 MB | 20 MB | 29 MB | 272,083 B / 9.35 h × 24 |
| **Branch files, uncompressed, central** | | **1.46 GB** | **2.00 GB** | |
| **Every name first seen** | | 2.42 GB | 2.96 GB | |

- **The "every name" rows** cover only the first-seen names, at the measured size per name. The new-version rate could be higher on other days.
- **The limit.** `MAX_BYTES` is 3,800,000,000. That is 28% over the "every name" case at 42 days; a higher new-version rate eats into the margin.
- **On disk.** At the gzip ratios (0.331 for captures, 0.290 for `known/`), the branch's files take about 0.66 GB (central) to 0.97 GB at 42 days.
  - **Rewrites.** Each hourly commit also rewrites `state.json` and the changed `known/` files: about 12 MB a day before git's deltas (441 changes / 9.35 h × 24 × 36,937 B × 0.290), so about 0.5 GB over 42 days. How much git's deltas save on GitHub is unknown.
  - **Total.** About 1.2 to 1.5 GB, against GitHub's recommended 10 GB per repository.
- **Per file.** A run's files stay far under GitHub's 100 MB per file: about 1.6 MB of new versions an hour. The seed script cuts larger day files at 50,000,000 bytes.
- **Listing.** `runs/` grows by about 7 entries an hour, about 7,100 over 42 days. GitHub's recursive listing allows 100,000 entries and 7 MB.
- **Artifacts.** One per run attempt, kept 1 day: about 3 to 4 MB an hour, so under 100 MB at a time.
- **Downloads each hour, not stored.** The record job checks out all of `known/`: about 81 MB (central) to 283 MB by the end, which is up to 1.9 to 6.8 GB a day. Whether GitHub counts or limits that for a public repository is unknown.

## Minutes and cost

| Item | Value |
| --- | --- |
| Public repository, standard runner | free: "Standard GitHub-hosted runners in public repositories" ([billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)) |
| Minutes per run | about 50 for `record` (3,000 s of polls, plus checkouts and the image pull) and about 1 for `write`. Not yet measured on GitHub |
| Per 30 days | about 24 × 30 × 51 ≈ 36,700 minutes |
| If the repository were private | $0.006 a minute (Linux 2-core): about $220 a month |
| Artifact storage | the billing page measures storage "For private repositories"; for public ones it gives no number, so unknown |
| Job limits | 6 hours per job, and 20 concurrent jobs on GitHub Free ([limits](https://docs.github.com/en/actions/reference/limits)). This workflow holds one of them most of each hour |
| API calls | 3 per run, against 1,000 an hour per repository for the workflow token |
| Docker Hub | each run pulls the image unauthenticated. Docker limits such pulls per IP ([Docker](https://docs.docker.com/docker-hub/usage/pulls/)), and whether GitHub-hosted runners are exempt is unknown. The workflow tries three times, a minute apart |
| npm registry and OSV | rate limits unknown |

**GitHub's terms for Actions.** They exclude, on GitHub-hosted runners, "any other activity unrelated to the production, testing, deployment, or publication of the software project", and activity whose burden "is disproportionate to the benefits provided to users" ([additional products](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)). The shadow tests Ludion's judge. Whether GitHub reads it the same way is unknown.

## Permissions

- **The jobs:** none at the top level. `record` has `contents: read`; `write` has `actions: read` and `contents: write`, and pushes only to `shadow-data`.
- **No secret** is used, and none needs to be created.

## Sources (read 2026-10-29)

- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows: the shortest schedule is every 5 minutes; scheduled runs "can be delayed during periods of high loads"; they run on the default branch only. In a public repository they are disabled after 60 days with no repository activity. Events made with the workflow's token, apart from `workflow_dispatch` and `repository_dispatch`, do not start workflows.
- https://docs.github.com/en/actions/reference/limits
- https://docs.github.com/en/rest/git/trees: "The limit for the tree array is 100,000 entries with a maximum size of 7 MB when using the recursive parameter."
- https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits: 10 GB recommended on disk, 100 MB per file enforced.
- https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features
- https://docs.docker.com/docker-hub/usage/pulls/
