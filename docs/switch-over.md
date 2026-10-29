# Switching the shadow to this workflow, and back

The shadow's recorder first ran as a Docker container on a machine. Moving it here must not lose a UTC day: a UTC day with no successful poll restarts the counted four weeks. So every step below that stops one recorder and starts the other falls on the same UTC day as the container's last poll. A morning in UTC leaves the most room.

## Before

- This workflow is on `main`, and Actions are enabled for the repository.
- The branch `shadow-data` does not exist. The seed script refuses to run if it does.
- You have a clone of this repository whose `origin` is Ludion-ai/ludion-shadow, and git credentials that can push to it.
- Optional, in the repository's settings: a branch ruleset on `shadow-data` with **Restrict deletions** and **Block force pushes**. It must not require pull requests or status checks, since the workflow pushes to the branch directly.

## The switch

1. **Stop the container recorder:** `docker stop <container>`. Note the time.
2. **Seed the branch** from the container's data directory, in Git Bash, from the clone:

   ```text
   bash scripts/seed-data-branch.sh <data directory> origin 8a78b55940def8463a2401e7bdd38d7e6c7b604d
   ```

   It pushes `shadow-data` once and prints its commit. Note that commit: it is the **seed commit**. It never force-pushes.
3. **Run the workflow by hand:** Actions → shadow → Run workflow, on `main`, or `gh workflow run shadow.yml -R Ludion-ai/ludion-shadow --ref main`.
4. **Check the run.**
   - Both jobs pass.
   - `shadow-data` has a new commit `shadow: run …` on top of the seed commit.
   - Its `runs/…/status/*.jsonl` begins with a `start` line naming the pinned commit, `watched_names` 7660 and `stored_bytes`, followed by `poll` lines.
   - The new `state.json` has a larger `seq` than the seeded one, and the same `feed_started_at`.

From then on, the hourly schedule keeps it going.

## If the first run fails

1. **Disable the workflow first,** so that no scheduled run starts while you decide: Actions → shadow → ··· → Disable workflow, or `gh workflow disable shadow.yml -R Ludion-ai/ludion-shadow`.
2. **Look at the branch:** `git fetch origin && git log --oneline origin/shadow-data`.
   - **If it still holds only the seed commit,** no run has recorded anything here.
     - **Go back:** start the container again with `docker start <container>`, on the same UTC day as its last poll. Its data directory is as it was when it stopped, and it resumes from its own feed position. Only versions removed while both were stopped are lost; each is a capture gap.
     - **The branch is now stale.** To try the switch again later, it must be deleted (by someone allowed to delete branches) and seeded again from the container's newer data. The seed script refuses an existing branch.
   - **If it already holds a `shadow: run …` commit,** this workflow has recorded from the branch's state.
     - **Do not start the container again:** two recorders would follow the feed from different states.
     - **Fix forward:** correct the cause (a change to this workflow goes through a pull request), enable the workflow, and run it by hand. It resumes from the branch's `state.json`.
     - **Keep it on one UTC day.** The lost time counts only if a whole UTC day passes with no successful poll.
3. **Later failures need nothing special.** A failed hourly run is followed by the next one, which resumes from the committed state. Re-running a failed job commits that attempt's own files.
