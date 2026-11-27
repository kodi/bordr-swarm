# Dispatcher Durability: Survive Restarts and Paginate Task Discovery

Plan A of three. Order: **A (this plan)** → B (`2026-11-27-event-bus-reactors-plan.md`) → C (`2026-11-27-agent-adapters-structured-signals-plan.md`).

Status legend: `[ ]` not started · `[-]` in progress · `[x]` done (only when verified).

## Summary

Two live reliability problems in the Worker Dispatcher, both small in code and high in impact:

1. **The dispatcher forgets every in-flight task when it restarts.** Tracking lives only in memory, and `mise run update` restarts the dispatcher every time. Orphaned tasks stop getting lease renewals, lose the per-repo lock and the review loop, and their tabs are never auto-closed.
2. **Task discovery silently stops after about 200 lifetime tasks.** The dispatcher lists `--state all --limit 200`, the Board returns oldest first including completed tasks, and the cursor is ignored.

Target state: the dispatcher can be killed and restarted at any point with tasks in any phase and carry on as if nothing happened, and task discovery is correct regardless of how much history the board holds.

## Decisions

- **Persist, then reconcile.** The dispatcher writes its tracked state to a versioned JSON file and reloads it on boot. The existing pure FSMs already handle "tab is gone" and "Board state is terminal", so most of adoption is simply: load state, run the normal reconcile.
- **State file location:** `~/.local/state/bordr-swarm/dispatcher-<machine>.json`, overridable with `DISPATCHER_STATE_PATH`. This mirrors Lead Watcher (`~/.local/state/bordr-swarm/lead-watcher-state.json`, `LEAD_WATCHER_STATE_PATH`).
- **State is validated with Zod on load** (schema lives in `src/lib/schemas.ts`, is _not_ exported to `config/*.schema.json`). A file that fails validation is renamed to `*.corrupt-<timestamp>` and the dispatcher starts empty, then relies on the orphan sweep (Slice 5).
- **Writes are atomic** (write temp file, `rename`) and happen only when the serialized state changed, at the end of each tick and on graceful stop.
- **A graceful stop never closes tabs or releases tasks.** Agents keep running across a dispatcher restart; that is the whole point.
- **Lease lapse is modelled in the pure FSM**, not patched in the I/O shell (see Slice 4). Follow the repo rule: discriminated unions, exhaustive `switch` + `assertNever`, no flags.
- **Pagination ends on a short or empty page, not on a null cursor.** Observed on a live board: a 14-task response to `--limit 200` still carried a non-null cursor.
- **The dispatcher lists only open tasks** and resolves tracked tasks that dropped out of the open list with a point lookup.

## Scope

In scope:

- `BoardClient.listTasks` pagination and a single-task state lookup.
- Dispatcher state persistence, load, and reconciliation after restart.
- FSM handling for "we were tracking it but the Board no longer says we hold the claim".
- Orphan sweep for the no-state-file case.
- Tests, and the docs that describe restart behavior.

Out of scope:

- Replacing polling with event streams (Plan B).
- Changing how review handoff is detected (Plan C).
- Merging the dispatcher and Lead Watcher into one daemon.
- Lead Watcher persistence; it already persists and adopts.

## Current State

Line numbers are as of commit `428ab4d`; trust symbol names over line numbers.

Restart behavior:

- `SwarmDispatcher.activeWorkers: Map<string, ActiveTask>` and `parkedTabs: Map<string, ParkedTab>` are in-memory only (`src/dispatcher.ts:126-127`).
- `ActiveTask` (`src/lib/task-fsm.ts:39`) is plain data except `phaseSeenReplyIds: ReadonlySet<string>`. `ParkedTab` embeds a full `ActiveTask`. `ManagedSession` in the `awaiting_prompt` lifecycle carries the full prompt text.
- On `SIGTERM`/`SIGINT`, `requestStop()` lets the loop exit after the current tick. Nothing is flushed.
- `scripts/apply-worker.ts` restarts the service on every apply: on macOS it runs `launchctl kickstart -k` even when the plist is unchanged (around line 198). `scripts/update.ts` always runs `apply-worker` on worker hosts.
- After a restart, a task that is still `claimed` on the Board is invisible to the new process: `tick()` only considers `ready` tasks for claiming, and nothing renews the lease.
- Deterministic names that make adoption possible: Board profile `worker-<machine>-<shortId>`, Herdr agent name `sanitizeHerdrAgentName("w", shortId)`, reviewer profile `reviewer-<machine>-<shortId>`, reviewer agent `r<round>-<shortId>`, tab label `task-<shortId> (<profile>)`.
- Precedent to copy: `loadState`/`saveState` and the adopt-by-agent-name branch of `spawnSessionForThread` in `src/lead-watcher.ts`.

Task listing:

- `src/dispatcher.ts:273`: `this.board.listTasks(prefix, { state: "all", limit: 200 })`. The result feeds both claiming (`ready` tasks) and reconciliation (`tasksById` lookups for tracked tasks).
- Verified against a live board on 2026-11-27: `vercel board tasks projects/ --state all --limit 200 --json` returns `{ tasks, cursor }`, ordered **oldest first**, **including completed** tasks.
- `BoardTaskListEnvelopeSchema` already parses `cursor`; `listTasks` discards it. The CLI accepts `--after <CURSOR>`.
- A tracked task missing from the list yields `boardState: "unknown"`. `stepTask` treats `unknown` as neither terminal nor claimed, so the task sits forever with no lease renewal and no log line.
- `src/lead-watcher.ts` `tick()` also calls `listTasks(prefix, { state: "blocked", limit: 100 })` with no pagination. Lower risk (bounded by concurrently blocked tasks) but the same defect.
- CLI states: `waiting, ready, claimed, blocked, completed, failed, canceled, open, all` (default `open`).

Tests:

- `tests/dispatcher.test.ts` has a `SwarmDispatcher mocked lifecycle` suite that builds a dispatcher with fake `ExecRunner`s for Board and Herdr. Extend it; do not add a second harness.
- `tests/fsm.test.ts` covers the pure FSMs.

## Implementation Shape

```
boot
  load state file ──(invalid)──► quarantine file, start empty
  │
  ▼
tick
  listOpenTasks (paginated)
  point-lookup tracked ids missing from the open list
  reconcile (existing FSMs + new "claim lost / lease lapsed" handling)
  orphan sweep (claimed-by-us on the Board but untracked)
  claim new work
  persist if changed
stop
  persist, exit; tabs and claims untouched
```

Serialization: introduce a `PersistedDispatcherState` type (`version: 1`, `machine`, `activeWorkers`, `parkedTabs`, `savedAtMs`) with `phaseSeenReplyIds` stored as an array. Keep `toPersisted`/`fromPersisted` pure and round-trip tested. If the persisted `machine` differs from the current machine name, ignore the file.

## Cross-Slice Rules

- Follow `AGENTS.md`: TypeScript must stay compatible with Node type stripping (no `enum`, `namespace`, or parameter properties); FSMs stay pure and synchronous; FSM tests have no sleeps or I/O.
- `npm run check` (format check, oxlint, typecheck, tests) must pass at the end of every slice.
- No personal hostnames, usernames, paths, or Board IDs in committed files or test fixtures.
- Never close a tab, release a task, or fail a task as part of _loading_ state. Those decisions come only from FSM outcomes during reconcile.
- Each slice is one reviewable commit. Record findings under Working Notes before moving on.

## Slices

### Slice 1: Paginated, open-only task discovery

Status: `[x]` Done

- Goal: task discovery is correct at any board size.
- Why here: smallest change, independent of everything else, and it is a live time bomb.
- This slice should implement:
  - `BoardClient.listTasks` follows the cursor with `--after` until a page is shorter than the page size or empty. Add a hard page cap (for example 20 pages) that logs a warning when hit.
  - `BoardClient.getTaskState(id)` (or `getTask`) for a single task. First check whether `vercel board read <id> --json` exposes `message.task.state` (the tail feed shows `message.task` on thread roots); if so, reuse `normalizeBoardTask`.
  - Dispatcher lists `--state open` instead of `all`. Confirm empirically which states `open` includes and record it under Working Notes.
  - For tracked task ids absent from the open list, do a point lookup so terminal states (`completed`, `canceled`, `failed`) are still observed.
  - Paginate the Lead Watcher's blocked-task listing through the same code path.
  - Log a `WARN` when a tracked task resolves to `unknown`.
- Expected output: changes in `src/lib/board.ts`, `src/dispatcher.ts`, `src/lead-watcher.ts`; new tests.
- Verification:
  - Unit test: a fake runner serving three pages returns all tasks; a short page stops the loop; the page cap is honored.
  - Unit test: a tracked task that is `completed` and absent from the open list is cleaned up.
  - `npm run check`.
- Dependencies: none.

### Slice 2: Persisted state schema and store (pure)

Status: `[x]` Done

- Goal: a tested, versioned, serializable representation of dispatcher state.
- Why here: establishes the contract before any behavior depends on it.
- This slice should implement:
  - Zod schema for `PersistedDispatcherState` in `src/lib/schemas.ts`.
  - `src/lib/dispatcher-state.ts`: `toPersisted`, `fromPersisted`, `loadDispatcherState(path)`, `saveDispatcherState(path, state)` (atomic write, quarantine on invalid).
  - Round-trip tests covering every `TaskPhase` variant and every `SessionLifecycle` variant, plus a parked tab.
- Expected output: new module and tests; no behavior change.
- Verification: `node --test tests/dispatcher-state.test.ts`, then `npm run check`.
- Dependencies: none (can be done in parallel with Slice 1).

### Slice 3: Wire persistence into the dispatcher

Status: `[ ]` Not started

- Goal: a restarted dispatcher resumes tracking the same tasks and tabs.
- Why here: needs the store from Slice 2 and correct Board lookups from Slice 1.
- This slice should implement:
  - `SwarmDispatcher` takes an optional `statePath`; loads at construction; persists at end of `tick()` when changed and in the stop path. Skip persistence in `--dry-run`.
  - Startup log line: how many active and parked tasks were restored.
  - `main()` resolves the default path and the env override.
  - `scripts/stop.ts --reset` removes the dispatcher state file alongside the Lead Watcher state (check what `--reset` wipes today).
- Expected output: restart-safe dispatcher for the common case where the lease is still held.
- Verification:
  - Lifecycle test: dispatcher A claims a task and ticks; construct dispatcher B on the same state path and fakes; B does not re-claim, renews the lease when due, and closes the tab when the Board reports `completed`.
  - Lifecycle test: restart while a task is parked `[BLOCKED]`; the repo lock still blocks a second claim for that project.
  - Lifecycle test: restart during `reviewing`; the verdict is still processed.
  - `npm run check`.
- Dependencies: Slices 1 and 2.

### Slice 4: Model lost claims and lapsed leases in the FSM

Status: `[ ]` Not started

- Goal: defined behavior when the dispatcher was down longer than the lease.
- Why here: Slice 3 makes this state reachable in a controlled way; before it, the state was reachable only as silent corruption.
- This slice should implement:
  - First, resolve Open Questions 1 and 2 empirically on a scratch channel with a short lease, and record the results.
  - Add `boardAssignee` to `TaskObservation` (it already exists on `ParkedTabObservation`).
  - Pure FSM transitions for a tracked task whose tab and agent are alive:
    - Board `ready` (lease lapsed, nobody else took it): emit a new `reclaim_task` effect under the same Board profile and stay active. If the reclaim fails, treat as claimed-by-other.
    - Board `claimed` by a different profile: stop tracking, rename the tab with a clear prefix (for example `[ORPHANED]`), post one explanatory reply, and do not touch the task's state.
  - Executor support for `reclaim_task` in `src/lib/dispatcher-effects.ts`.
- Expected output: FSM and effect changes with pure tests.
- Verification: new cases in `tests/fsm.test.ts`; lifecycle test that simulates downtime longer than the lease; `npm run check`.
- Dependencies: Slice 3.

### Slice 5: Orphan sweep for the no-state case

Status: `[ ]` Not started

- Goal: recover sensibly when there is no usable state file (first deploy of this change, corrupted file, manual wipe).
- Why here: a fallback for the path Slices 3 and 4 make primary; lowest value, so last among code slices.
- This slice should implement:
  - Each tick (cheap: it reuses the open-task list), find tasks `claimed` by `worker-<thisMachine>-*` that are not tracked.
  - If a live Herdr agent with the matching `w-<shortId>` name exists: rebuild an `ActiveTask` from the Board task, project config, and the agent's `tab_id`/`pane_id`/`workspace_id`; adopt as `implementing` / `running` with `phaseSeenReplyIds` set to all current reply ids and `startHeadSha: null`. If a reviewer agent `r<N>-<shortId>` is also live, adopt conservatively: park the implementer tab as `[BLOCKED]` with an explanatory reply rather than guessing the review round.
  - If no live agent exists: post a reply and release the task so it becomes `ready` again.
- Expected output: sweep logic kept in a pure decision function plus a thin I/O wrapper.
- Verification: pure tests for the decision function; lifecycle test starting with an empty state file and a pre-claimed task; `npm run check`.
- Dependencies: Slices 1, 3, 4.

### Slice 6: Docs and operational polish

Status: `[ ]` Not started

- Goal: docs match behavior.
- This slice should implement:
  - `docs/architecture.md`: a short "Restart and recovery" section (state file, what survives, lease-lapse behavior, orphan sweep).
  - `docs/worker-machine-setup.md` and README command table: note that `mise run update` is safe with tasks in flight.
  - `AGENTS.md`: add the durable-state decision under Architectural Decisions.
  - Optional: make `scripts/update.ts` skip the dispatcher restart when no code changed, mirroring the existing `codeChanged` → `--restart-watcher` logic for main.
- Verification: manual end-to-end check below; `npm run check`.
- Dependencies: Slices 1 to 5.

## Testing Plan

- Per slice: the unit and lifecycle tests named above, then `npm run check`.
- Final manual check on a machine with role `both`:
  1. Post a task that takes several minutes.
  2. While the agent is working, run `mise run apply:worker`.
  3. `mise run logs -- dispatcher` shows the restore line and continued lease renewals.
  4. The tab auto-closes when the task completes.
  5. Repeat with review enabled, restarting during the review phase.
  6. Repeat after stopping the dispatcher for longer than `board.leaseDuration` (use a short lease in a scratch config).

## Files to Add

- `src/lib/dispatcher-state.ts`
- `tests/dispatcher-state.test.ts`

## Files to Change

- `src/lib/board.ts` (pagination, single-task lookup)
- `src/lib/schemas.ts` (persisted state schema)
- `src/dispatcher.ts` (open-only listing, load/persist, orphan sweep)
- `src/lib/task-fsm.ts`, `src/lib/dispatcher-effects.ts` (lost-claim handling, `reclaim_task`)
- `src/lead-watcher.ts` (paginated blocked-task listing)
- `scripts/stop.ts`, optionally `scripts/update.ts`
- `tests/dispatcher.test.ts`, `tests/fsm.test.ts`
- `docs/architecture.md`, `docs/worker-machine-setup.md`, `README.md`, `AGENTS.md`

## Open Questions

1. What does the Board do when a lease expires: does the task return to `ready`, and is there a distinct event or state? Assumed `ready`; unverified.
2. After a lease expires, can the same profile `renew`, or must it `claim` again?
3. Exactly which states does `--state open` include (is `failed` open)?
4. Does `vercel board read <id> --json` return `message.task.state` for a task root? If not, what is the cheapest single-task lookup?
5. What does `herdr agent start` do when an agent with the same name already exists? Relevant if a task is re-claimed while the old tab is alive.

## Working Notes

- 2026-11-27: Plan written from a code review. Listing order, completed-task inclusion, and the non-null cursor on a short page were checked against a live board. Lease-expiry behavior was _not_ checked. No code has been changed.
- 2026-11-27 (Slice 1, empirical, scratch channel with a 30s lease, probe tasks canceled afterwards):
  - **OQ3:** `--state open` returns `ready`, `claimed`, and `blocked` tasks (and, per the CLI help, `waiting`). `failed`, `completed`, and `canceled` are **not** open. So a tracked task that fails also needs the point lookup.
  - **OQ4:** `vercel board read <id> --json` returns `{ message: { …, task: { state, claim: { actor, until }, blocked, epoch } }, replies: [...], cursor }`. `normalizeBoardTask` handles it as-is; `BoardClient.getTask` reuses it. Empty task lists come back with `cursor: "0"`, and our fakes use `cursor: null`, so the envelope schema now accepts a nullable cursor.
  - **OQ1:** when a lease runs out, the task-list view reports it `ready` with no distinct event. The single-thread `read` view can lag: it kept reporting `claimed` with the stale `claim.until` until the next write touched the task (the failed `renew`), after which it reported `ready`, `claim: null`. Do not rely on `read` alone to detect a lapse.
  - **OQ2:** `renew` after expiry fails with `{"status":"error","reason":"claim_lost"}`. The same profile can then `claim` again (the task's `epoch` increments). A different profile cannot `claim` while the task is held, and cannot `renew` someone else's claim.
  - Claim actors are `vercel:user:<id>+<profile>`. `normalizeBoardTask` now strips that to the profile (`claimProfileFromActor`) so `assignee` compares equal to our `--as` names. Before this, `stepParkedTab`'s "owned by someone else" check could never match our own profile and a resumed `[BLOCKED]` tab never unparked against a real board.
  - Implemented: `listTasks` follows `--after` until a short or empty page (it uses the raw page length, so entries that fail to normalize do not end paging early), dedupes by id, and stops at 20 pages with a `WARN` through `BoardClientOptions.onWarn`. The dispatcher lists `--state open` 100 per page and point-looks-up tracked ids missing from that list, logging `WARN` when a task still resolves to `unknown`. Lead Watcher's blocked listing paginates through the same `listTasks`.
  - **OQ5** (`herdr agent start` with a duplicate name) is not exercised by this plan: reclaiming in Slice 4 keeps the existing agent, so nothing starts a second agent under the same name. Left unverified.
- 2026-11-27 (Slice 2): `PersistedDispatcherStateSchema` (strict, `version: 1`) lives in `src/lib/schemas.ts` and is not wired into `scripts/generate-schemas.ts`. `src/lib/dispatcher-state.ts` holds pure `toPersisted`/`fromPersisted` (ids and `phaseSeenReplyIds` sorted, so the output is deterministic), `dispatcherStateFingerprint` (everything except `savedAtMs`, used to skip unchanged writes), `resolveDispatcherStatePath`, `loadDispatcherState` (returns `missing` / `loaded` / `other_machine` / `quarantined`; a file for another machine is left in place, not quarantined), and `saveDispatcherState` (temp file + `rename`, mode `0600`). The types are checked both ways at compile time: `fromPersisted` must produce `ActiveTask` and `toPersisted` must accept it.

## Next Slice

**Slice 3**: wire `loadDispatcherState`/`saveDispatcherState` into `SwarmDispatcher` (load at construction, persist at the end of each tick when the fingerprint changed and on stop; skip in `--dry-run`), then `scripts/stop.ts --reset`.
