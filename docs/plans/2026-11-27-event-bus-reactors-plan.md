# Event Bus and Reactors: Push Instead of Poll, and "When X, Do Y" as Plugins

Plan B of three. Order: A (`2026-11-27-dispatcher-durability-plan.md`) → **B (this plan)** → C (`2026-11-27-agent-adapters-structured-signals-plan.md`).

Status legend: `[ ]` not started · `[-]` in progress · `[x]` done (only when verified).

## Summary

Both daemons poll: the Lead Watcher every 10 seconds, the Worker Dispatcher every 15. Each hop from "human posts" to "worker starts" waits up to a poll interval, every tick spawns several CLI processes, and polling thread summaries loses events. Both upstream systems already expose live streams.

Target state:

1. **Push transport.** Board and Herdr events arrive as they happen and wake the existing logic immediately. Polling stays only as a slow safety net.
2. **Reactor registry.** The hardcoded "when X, do Y" rules become named, individually testable reactors, with a small config-driven form for user-defined ones.
3. **Pipeline stage seam.** The review step stops being welded into the task FSM so the next stage (tests, PR) is a new module rather than a change across four files.

## Decisions

- **Events are hints; state stays level-triggered.** The pure FSMs keep their `(state, observation) → outcome` contract. An event triggers an immediate, debounced reconcile; it is never the only source of truth. A missed event costs latency, not correctness, because the periodic reconcile remains.
- **Lead events are the exception: they are edges.** A mention or a new inbox message must not be lost, so the Board tail cursor is persisted and the stream resumes with `--after`. The existing poll-based `collectLeadEvents` remains as the catch-up path when the cursor is missing or rejected.
- **One unfiltered `vercel board tail --json` per daemon, filtered in-process.** `tail` takes a single channel or prefix, and the Lead Watcher needs inbox, `projects/` and the registry channel. Revisit if the board is noisy.
- **Herdr events come from the socket API, with CLI polling as the fallback.** The protocol is reported as `private_protocol: 22`, so treat it as unstable: validate with Zod, and on any connect or parse failure fall back to today's polling and log once. A non-local `herdrTarget` always uses the fallback.
- **The bus is a library under `src/bus/`** used by both daemons. Do not merge the daemons in this plan, but do not make a later merge harder.
- **Reactors follow the house style:** a pure `react(event, state) → effects` function plus a thin executor.
- **Config-driven reactors run local commands only from local, gitignored config.** Never derive a command, path or argument from Board message content. Event data is passed as JSON on stdin.
- **Polling intervals stay configurable.** When sources are healthy, the full reconcile runs every `reconcileIntervalSeconds` (new, default 60). When a source is down, the daemon uses the existing `pollIntervalSeconds`.

## Scope

In scope: Board tail source, Herdr event source, bus core, moving both daemons onto the bus, reactor registry, config-driven reactors, a behavior-preserving stage seam for review, docs.

Out of scope:

- Changing how review handoff is signalled (labels instead of text markers) — Plan C.
- Agent adapters — Plan C.
- Merging the daemons, packaging, or service management changes.
- New stages (tests, PR). This plan only creates the seam.

## Prerequisites

Plan A should be complete. Read its Working Notes first: this plan assumes the dispatcher persists its state (the bus must persist through the same store, not a second file) and that `BoardClient.listTasks` paginates.

## Current State

Line numbers are as of commit `428ab4d`; trust symbol names over line numbers.

Polling today:

- Dispatcher `runLoop` (`src/dispatcher.ts`) sleeps `workerDefaults.pollIntervalSeconds` (default 15). A tick: hot-reload `projects.json` by mtime and publish the registry → list tasks → `reconcileRunningWorkers` (`herdr tab list` + `herdr agent list`, plus a thread read per reviewed task) → claim.
- Lead Watcher `tick` (`src/lead-watcher.ts`) every `lead.pollIntervalSeconds` (default 10): read registry channel, read inbox, list channels, list blocked tasks, then read every project channel **sequentially** → `collectLeadEvents` → 👀 acknowledgements → `reconcileSessions` → `dispatchQueuedThreads`.
- Every Board or Herdr call is a process spawn (`execFile`) with JSON parsing.

Known defects caused by polling summaries:

- **Missed mentions.** `collectLeadEvents` (`src/lib/lead-events.ts`, project-channel loop) looks only at the latest message per thread. It advances the seen marker to `latest.id` and then checks whether _that_ message mentions Lead. A mention followed by any other reply within one poll window is dropped.
- `seenThreadLatestMsgId` grows without bound.

Hardcoded reactions:

- Lead Watcher: three event kinds (`inbox`, `mention`, `blocked_task`), one reaction (queue a per-thread Lead session), and the 👀 acknowledgement inlined in `tick()` (`acknowledgeInboxEvent`).
- Dispatcher: implement → optional review → complete. Review logic is spread across `TaskPhase` (`reviewing`, `fixing`), `ThreadSignal`, `spawn_reviewer` / `resume_implementer_for_fix` effects (`src/lib/task-fsm.ts`, `src/lib/dispatcher-effects.ts`), `observeThreadSignal` (`src/dispatcher.ts`), and `src/lib/review.ts`.

Verified on 2026-11-27 (Vercel CLI 66.6.0, Herdr 0.9.5):

- `vercel board tail [channel|prefix/] --json` emits one JSON object per line and runs until killed. Flags: `--after <ID|cursor>`, `--last <N>` (1–100), `--label`, `--mentions`, `--re`, `-a` (delivery receipts).
- Each event has the shape `{ cursor, type, createdAt, payload, message, actor }`.
  - Types seen in a 100-event sample: `message.posted`, `message.edited`, `reaction.added`, `task.created`, `task.ready`, `task.claimed`, `task.completed`, `task.blocked`, `task.unblocked`. Others (failed, canceled, released, renewed, lease expiry) are expected but unseen.
  - `message` is the full message: `id`, `channel`, `text`, `re`, `thread`, `labels`, `reactions`, `by.profile`, `author.kind`, `deleted`, and for task roots `task { state, owner, claim, blocked, result, ... }`.
- `vercel` runs the stream in a child process. Signalling only the parent did not stop it; spawn with `detached: true` and kill the process group.
- `vercel` writes a hint line to stderr; ignore stderr for parsing.
- Herdr: `herdr status server` prints the socket path (default `~/.config/herdr/herdr.sock`). The socket speaks newline-delimited JSON. Sending `{"id":"x","method":"events.subscribe","params":{"subscriptions":[{"type":"tab.closed"}]}}` returned `{"id":"x","result":{"type":"subscription_started"}}`. Events then arrive as `{ event, data }` lines.
- Subscription types relevant here: `tab.closed`, `pane.closed`, `pane.exited`, `pane.agent_detected` (global, no parameters) and `pane.agent_status_changed` (**requires `pane_id`**, optional `agent_status` filter; payload has `pane_id`, `workspace_id`, `agent_status`, `agent`). Full schema: `herdr api schema --json`.
- There is also `herdr agent wait <target> --until <status>` on the CLI, usable as a per-agent fallback.

## Implementation Shape

```
sources                         bus                      consumers
───────                         ───                      ─────────
BoardTailSource  ─┐
HerdrEventSource ─┼─► SwarmEvent ─► Bus.publish ─┬─► wake scheduler ─► existing tick/reconcile
TimerSource      ─┤   (discriminated            │                     (level-triggered FSMs)
FsWatchSource    ─┘    union)                   └─► reactors ─► effects ─► executor
```

`SwarmEvent` is a discriminated union, for example:

```ts
type SwarmEvent =
  | { kind: "board.message"; op: "posted" | "edited"; message: BoardMessage; cursor: string }
  | {
      kind: "board.task";
      op: "created" | "ready" | "claimed" | "completed" | "blocked" | "unblocked" | "other";
      task: BoardTask;
      cursor: string;
    }
  | { kind: "board.reaction"; messageId: string; cursor: string }
  | { kind: "herdr.agent_status"; paneId: string; status: HerdrAgentStatus }
  | { kind: "herdr.pane_exited"; paneId: string }
  | { kind: "herdr.tab_closed"; tabId: string }
  | { kind: "timer.reconcile" }
  | { kind: "fs.changed"; path: string }
  | { kind: "source.health"; source: "board" | "herdr"; healthy: boolean };
```

Unknown Board event types must map to a tolerated `other` variant or be dropped with a debug log; never throw on an unrecognized type.

Sources own their lifecycle: start, stop, restart with backoff, and a `source.health` event on every transition. The wake scheduler coalesces bursts (for example, a 250 ms debounce) and guarantees ticks never overlap.

Reactor interface:

```ts
interface Reactor {
  name: string;
  matches(event: SwarmEvent): boolean; // pure
  react(event: SwarmEvent, ctx: ReactorContext): ReactorEffect[]; // pure
}
```

## Cross-Slice Rules

- Follow `AGENTS.md`: Node type-stripping compatible TypeScript; pure FSMs with discriminated unions and `assertNever`; pure tests with no sleeps or I/O. Inject clocks and process spawners.
- `npm run check` passes at the end of every slice.
- Until a slice explicitly removes it, the polling path keeps working. Every slice must leave both daemons functional with all sources disabled.
- No personal hostnames, usernames, paths, or Board IDs in committed files or fixtures. Sanitize any sampled event used as a fixture.
- Config schema changes: update Zod in `src/lib/schemas.ts`, run `mise run schemas:generate`, and update `config/*.example.json`.
- Never leave a child `vercel board tail` running after the daemon exits. Every test that spawns a fake source must assert teardown.
- One reviewable commit per slice; record findings under Working Notes.

## Slices

### Slice 1: Board tail source

Status: `[x]` Done

- Goal: a supervised, resumable stream of typed Board events.
- Why here: it proves the riskiest external assumption and nothing else depends on Herdr.
- This slice should implement:
  - Zod schema for the tail event envelope (loose/passthrough; reuse `BoardMessageSchema` and `normalizeBoardTask`).
  - Pure NDJSON line parser → `SwarmEvent` (handles partial chunks, blank lines, non-JSON noise).
  - `BoardTailSource`: spawns `vercel board tail --json [--after <cursor>]` with the same `--name`/`--scope` handling as `BoardClient.buildArgs`; process-group kill on stop; restart with capped exponential backoff; emits `source.health`.
  - Resolve Open Questions 1–3 empirically and record the answers.
- Expected output: `src/bus/board-tail-source.ts`, `src/bus/events.ts`, tests with an injected fake spawner.
- Verification: parser unit tests (including sanitized real samples of each observed type); supervisor tests for restart, backoff and teardown; a manual run of a small script that prints parsed events while you post a message; `npm run check`.
- Dependencies: none.

### Slice 2: Herdr event source

Status: `[x]` Done

- Goal: live tab, pane and agent-status events from the local Herdr server.
- Why here: independent of Slice 1; isolates the unstable private protocol behind one module.
- This slice should implement:
  - Minimal NDJSON socket client (`node:net`): request/response by `id`, plus event lines.
  - Socket path discovery from `herdr status server`, with the default path as fallback.
  - Global subscriptions (`tab.closed`, `pane.exited`, `pane.closed`) at connect; dynamic per-pane `pane.agent_status_changed` subscriptions added when a session starts and dropped when it ends. Determine how unsubscribe works (Open Question 4).
  - Reconnect with backoff and re-subscribe; `source.health` events; automatic disable when `herdrTarget` is not `local`.
- Expected output: `src/bus/herdr-event-source.ts` and tests against an in-process fake socket server.
- Verification: unit tests for framing, re-subscribe after reconnect, and fallback; manual check that closing a tab produces an event; `npm run check`.
- Dependencies: none.

### Slice 3: Bus core and wake scheduler

Status: `[x]` Done

- Goal: one place where events are published, fanned out, and turned into debounced wake-ups.
- Why here: both daemons need it before either can move.
- This slice should implement:
  - `Bus` (subscribe, publish, error isolation per subscriber).
  - Wake scheduler: debounce, no overlapping ticks, a pending-wake flag so an event during a tick triggers exactly one follow-up tick, and interval selection (`reconcileIntervalSeconds` when all sources are healthy, `pollIntervalSeconds` otherwise).
  - `TimerSource` and `FsWatchSource` (for `config/projects.json` and `prompts/`), replacing the mtime check only when Slice 4 wires it in.
  - New config keys `workerDefaults.reconcileIntervalSeconds` and `lead.reconcileIntervalSeconds` (default 60); regenerate schemas.
- Expected output: `src/bus/bus.ts`, `src/bus/scheduler.ts`, pure tests with an injected clock.
- Verification: scheduler tests (burst coalescing, no overlap, degraded-interval switch); `npm run check`.
- Dependencies: Slices 1 and 2 for the event types only.

### Slice 4: Dispatcher on the bus

Status: `[x]` Done

- Goal: a ready task is claimed, and an agent status change is acted on, within about a second.
- Why here: the dispatcher's logic is already level-triggered, so it is the low-risk first consumer.
- This slice should implement:
  - `runLoop` driven by the scheduler instead of `sleep`.
  - Wake on `board.task` events under the project prefix, on `board.message` events in tracked task threads, and on Herdr events for tracked panes or tabs.
  - Per-pane status subscriptions registered at spawn and adoption (including sessions restored from Plan A's state file).
  - `FsWatchSource` replaces the per-tick mtime check for `projects.json`.
  - Persist nothing new unless needed; if a cursor is persisted, it goes into Plan A's state file under a new versioned field.
- Expected output: event-driven dispatcher with the same FSMs and effects.
- Verification: existing lifecycle tests pass unchanged; new test that a `task.ready` event triggers a claim without waiting for the interval; test that with both sources unhealthy the dispatcher behaves exactly as before; manual latency check (post a task, measure time to tab creation); `npm run check`.
- Dependencies: Slices 1–3, Plan A.

### Slice 5: Lead Watcher on the bus

Status: `[x]` Done

- Goal: no lost mentions, sub-second acknowledgement, and no per-channel polling.
- Why here: it changes edge-triggered behavior, so it follows the lower-risk dispatcher move.
- This slice should implement:
  - Derive Lead events from each `board.message` event individually (inbox posts and replies, mentions in project channels) and from `board.task` blocked events, instead of from thread summaries.
  - Persist the tail cursor in `LeadWatcherState`; resume with `--after`. On a missing or rejected cursor, run the existing `collectLeadEvents` catch-up once, then follow live.
  - Keep `collectLeadEvents` as the periodic reconcile, and fix the missed-mention defect there too (inspect all messages newer than the seen marker, which needs a thread read when the reply count advanced by more than one).
  - Registry sync triggered by events in the registry channel plus the periodic reconcile.
  - Prune `seenThreadLatestMsgId` (for example, drop entries not seen in the channel reads for N days).
  - De-duplication between the live path and the catch-up path keyed on message id.
- Expected output: event-driven Lead Watcher; state schema gains a cursor field with a tolerant loader.
- Verification: regression test for mention-then-reply inside one window (fails before, passes after); test for cursor resume and for the rejected-cursor fallback; existing `tests/lead-watcher.test.ts` passes; manual check of 👀 latency; `npm run check`.
- Dependencies: Slices 1 and 3.

### Slice 6: Reactor registry for built-in reactions

Status: `[x]` Done

- Goal: every built-in "when X, do Y" is a named reactor with its own tests.
- Why here: the bus exists and both daemons use it, so this is a refactor with a stable target.
- This slice should implement:
  - `src/bus/reactor.ts` (interface, registry, executor with per-reactor error isolation and logging).
  - Built-in reactors, behavior unchanged: `inbox-ack` (👀), `lead-wake` (inbox, mention, blocked task → per-thread queue), `registry-sync`, `projects-reload`, `dispatcher-wake`.
  - Startup log listing registered reactors.
- Expected output: `tick()` bodies shrink to scheduling and reconcile; reactions live in `src/reactors/`.
- Verification: pure tests per reactor (`matches` and `react`); existing daemon tests unchanged; `npm run check`.
- Dependencies: Slices 4 and 5.

### Slice 7: Config-driven reactors

Status: `[x]` Done

- Goal: a user can add "when a task blocks, notify me" without touching the code.
- Why here: needs the registry.
- This slice should implement:
  - `swarm.json` `reactors[]`: `{ name, on, match?, run }` where `on` is an event selector such as `task.blocked` or `message.posted`, `match` filters by channel prefix and labels, and `run` is one of `{ command: string[] }` (event JSON on stdin, timeout, no shell) or `{ post: { channel, text } }` with a small set of placeholders.
  - Zod schema with `.describe()`, regenerated JSON schema, an example in `config/swarm.example.json`.
  - `mise run doctor` validates reactors (the command exists, selectors are known).
  - Rate limiting or a per-reactor cooldown so a `post` reactor cannot trigger itself in a loop; reactors never fire on messages authored by their own profile.
- Expected output: documented user-extensible reactions.
- Verification: schema tests; reactor tests with a fake command runner; a loop-prevention test; manual check with a `command` reactor that appends to a file; `npm run check`.
- Dependencies: Slice 6.

### Slice 8: Pipeline stage seam (behavior-preserving)

Status: `[ ]` Deferred to a follow-up plan (see the design note below and Working Notes)

- Goal: review is one implementation of a `Stage` interface; the task FSM composes stages.
- Why here: last, because it is the largest refactor and nothing else depends on it.
- This slice should implement:
  - A short design note appended to this plan before coding: the `Stage` interface (entry condition, session spawn, signal detection, outcomes `pass | retry | escalate`), and how `TaskPhase` composes it without boolean flags.
  - Extraction of review-specific logic from `task-fsm.ts`, `dispatcher-effects.ts` and `observeThreadSignal` behind that interface.
- Scope guard: `tests/fsm.test.ts`, `tests/reviewer.test.ts` and `tests/dispatcher.test.ts` must pass **without modification**. If the extraction cannot be done within that constraint or the diff is too large to review as one commit, stop, record what was learned, and move this slice to a follow-up plan. Plan C changes review signal detection; note any conflict under Working Notes.
- Verification: unchanged tests pass; `npm run check`.
- Dependencies: Slices 4 and 6.

#### Design note (written before coding, 2026-11-27)

Proposed interface:

```ts
type StageOutcome =
  | { kind: "continue"; next: StageState; effects: TaskEffect[] } // still running
  | { kind: "pass"; summary: string; effects: TaskEffect[] } // next stage, or complete
  | { kind: "retry"; round: number; effects: TaskEffect[] } // back to the implementer
  | { kind: "escalate"; reason: string; effects: TaskEffect[] }; // block + park for a human

interface Stage<S extends { kind: string }> {
  name: string; // "review"; later "tests", "pr"
  /** Entry condition, checked while implementing (e.g. a READY_FOR_REVIEW handoff with a diff). */
  enter(task: ActiveTask, signal: ThreadSignal): { effects: TaskEffect[]; state: S } | null;
  step(state: S, task: ActiveTask, obs: TaskObservation): StageOutcome;
  sessions(state: S): SessionHandle[]; // for reconcile, pane subscriptions, orphan sweep
}

type TaskPhase =
  | { kind: "implementing"; impl: ManagedSession }
  | { kind: "stage"; impl: SessionHandle; stage: StageState }; // StageState = union of stage states
```

`TaskPhase` composes stages by holding exactly one stage state; `fixing` becomes the review stage's `retry` outcome, which returns to `implementing` with a round counter carried in the stage's own state. No boolean flags are involved.

What was learned (why it was not implemented here):

1. The `reviewing` and `fixing` variants of `TaskPhase` are constructed directly by `tests/fsm.test.ts` and `tests/reviewer.test.ts`, and persisted 1:1 by `PersistedDispatcherStateSchema` (`version: 1`, Plan A). Any seam that changes `TaskPhase` must change those tests and needs a v2 state migration. The scope guard forbids the first, and the second is a durability change that deserves its own review.
2. A seam that keeps `TaskPhase` unchanged can only move code (the review branches of `stepTask`, the `spawn_reviewer` and `resume_implementer_for_fix` executors, and `observeThreadSignal`) behind function boundaries. Every phase switch still names `reviewing`/`fixing`, so adding a stage would still touch the same four files. That is churn without the benefit.
3. Plan C replaces review handoff detection (text markers to labels), which is exactly the `enter`/signal half of this interface. Doing the seam first would be rewritten by Plan C.

Recommendation: a follow-up plan after Plan C that introduces `{ kind: "stage" }` together with a `version: 2` dispatcher state (and a v1 → v2 loader), updates the FSM and reviewer tests deliberately, and lands review as the first `Stage`.

### Slice 9: Docs

Status: `[x]` Done

- Update `docs/architecture.md` (diagrams and the polling language), README (latency and "what it feels like" claims, reactor configuration), `AGENTS.md` (bus, reactor and source conventions), and the setup guides if any command changed.
- Verification: `npm run check`; read the docs against the running system.
- Dependencies: all prior slices that landed.

## Testing Plan

- Pure tests for parsers, scheduler, reactors and FSMs; injected spawner, socket and clock everywhere.
- Daemon lifecycle tests continue to use the fake `ExecRunner` harness in `tests/dispatcher.test.ts` and `tests/lead-watcher.test.ts`.
- Degraded-mode test in both daemons: all sources unhealthy → behavior identical to today.
- Final manual check on a `both` machine:
  1. Post in `#inbox`; 👀 appears within about a second.
  2. Time from Lead creating a task to the worker tab appearing is about a second, not up to 15.
  3. Kill the `vercel board tail` child; the daemon logs degraded mode, keeps working by polling, then recovers.
  4. Stop the Herdr server; same expectation.
  5. Post a mention and immediately another reply in a project thread; Lead still wakes.

## Files to Add

- `src/bus/events.ts`, `src/bus/bus.ts`, `src/bus/scheduler.ts`, `src/bus/board-tail-source.ts`, `src/bus/herdr-event-source.ts`, `src/bus/reactor.ts`
- `src/reactors/*.ts`
- `tests/bus-*.test.ts`, `tests/reactors.test.ts`

## Files to Change

- `src/dispatcher.ts`, `src/lead-watcher.ts`, `src/lib/lead-events.ts`
- `src/lib/schemas.ts`, `config/swarm.schema.json`, `config/swarm.example.json`
- `src/lib/task-fsm.ts`, `src/lib/dispatcher-effects.ts`, `src/lib/review.ts` (Slice 8 only)
- `scripts/doctor.ts`
- `docs/architecture.md`, `README.md`, `AGENTS.md`

## Open Questions

1. Does `vercel board tail` reconnect on network loss, exit, or stall silently? If it can stall, add a watchdog (for example, restart when no event and no successful poll difference for N minutes).
2. How long is a tail cursor valid for `--after`, and what does a rejected cursor look like (exit code, stderr)?
3. What are the remaining task event type names (failed, canceled, released, lease expired, renewed)?
4. How does a client drop a single Herdr subscription: is there an unsubscribe method, or is it per-connection only? If per-connection, use one connection per tracked pane or re-establish the subscription set.
5. Does `pane.agent_status_changed` fire for agents started through `herdr agent start` in panes created with `--no-focus`? (Expected yes; verify.)
6. Should config-driven reactors be allowed on worker-only machines, main only, or both? Default assumption: both, each daemon runs the reactors whose selectors it can observe.

## Working Notes

- 2026-11-27: Plan written from a code review. The tail event envelope, the sampled event types, the process-group kill requirement, the Herdr socket framing and the `events.subscribe` response were checked by hand on one machine (Vercel CLI 66.6.0, Herdr 0.9.5). Nothing was run end to end and no code has been changed.

- 2026-11-27 (Slice 1): `src/bus/events.ts` (`SwarmEvent`, `parseBoardTailLine`, `LineSplitter`, `parseHerdrEventLine`), `src/bus/board-tail-source.ts` (`BoardTailSource`), `src/bus/timers.ts` (injectable `Timers`). `BoardClient.buildTailCommand` builds the args with the same `--url`/`--name`/`--scope` handling as every other call (so `vb tail` works in the e2e stack). `BoardMessageSchema` gained optional `re`, `thread`, and `labels`. Fixture: `tests/fixtures/board-tail-sample.ndjson` (one sanitized live event per observed type).
  - **OQ3:** a live 100-event sample contained `message.posted`, `message.edited`, `reaction.added`, and `task.{created,ready,claimed,completed,failed,blocked,expired,released,canceled}`. A lapsed lease is `task.expired` (the message snapshot then says `ready`). `task.unblocked` and `task.renewed` were not in the sample; both are typed ops, and any other `task.*` maps to `op: "other"`. Each task event carries the root message snapshot (with `task { state, claim, blocked, ... }`) as of the event, so `normalizeBoardTask({ message })` works unchanged.
  - **OQ2:** a rejected `--after` (a bogus string or a malformed `x1.` cursor) makes the CLI exit with code 2 and print a _pretty-printed_ (multi-line) JSON error on stdout with `"reason": "invalid_cursor"` (`after: <value> isn't a cursor here or a message's ID`). A message ID is accepted as `--after` too. An old message ID from many hours earlier was still accepted and replayed what followed it; how long a cursor stays valid was not determined beyond that. The supervisor detects the error line, calls `onCursorRejected`, and restarts without `--after`.
  - **OQ1:** not verified (no way to cut the network safely on this host). The supervisor restarts the child with capped exponential backoff (1s doubling to 60s, reset once the stream has been up for 3s or delivers an event) and has a stall watchdog (default 10 min without output): it restarts the stream quietly, without a health transition, resuming from the last cursor.
  - Stop sends `SIGTERM` to the process group (spawned `detached: true`), escalates to `SIGKILL` after 3s, and never restarts afterwards. A manual run against the live board printed the reply posted from another shell about 2s after posting, and `pgrep` found no `board tail` process after stop.
- 2026-11-27 (Slice 2): `src/bus/herdr-event-source.ts` (`HerdrEventSource`). Socket path from `herdr status server` (`socket: <path>`), falling back to `~/.config/herdr/herdr.sock`; re-discovered on every reconnect of the main connection.
  - Event lines on Herdr 0.9.5 are `{ "event": "tab_closed", "data": { "type": "tab_closed", "tab_id", "workspace_id" } }`: names use **underscores**, not the dotted subscription names. The parser accepts both. Closing a tab whose shell is alive emitted `tab_closed` but no `pane_closed`; a shell that exits emitted `pane_exited`.
  - **OQ4:** `herdr api schema --json` lists only `events.subscribe` and `events.wait`; there is no unsubscribe. Subscriptions are per connection, so each watched pane gets its own connection (`setWatchedPanes`), and dropping a pane closes it. The main connection holds `tab.closed`, `pane.exited`, `pane.closed`.
  - Health follows the main connection: healthy on `subscription_started`, unhealthy (logged once until it recovers) on connect failure, a rejected or unanswered subscribe (10s), an unparseable line, or a close. Every connection reconnects with capped backoff and re-subscribes. A non-local `herdrTarget` disables the source.
  - **OQ5:** not verified (needs a live agent in a `--no-focus` pane). The CLI reconcile still covers it.
  - Manual check: the source against the local server printed `herdr.tab_closed` for a scratch tab closed from another shell.
- 2026-11-27 (Slice 3): `src/bus/bus.ts` (`Bus`, `SourceHealth`, `selectReconcileIntervalMs`), `src/bus/scheduler.ts` (`WakeScheduler`), `src/bus/fs-watch-source.ts` (`FsWatchSource`). Config: `lead.reconcileIntervalSeconds`, `workerDefaults.reconcileIntervalSeconds` (optional, default 60 via `DEFAULT_RECONCILE_INTERVAL_SECONDS`), and a top-level `events: { boardTail, herdr }` kill switch (both on when omitted). The keys are optional in the resolved `SwarmConfig` type so existing test fixtures compile unchanged.
  - Deviation: there is no separate `TimerSource`. The scheduler owns the periodic timer and passes `periodic: true` to the tick it starts, so the event union keeps `timer.reconcile` only for reactors. The periodic deadline is measured from the previous periodic run, so a steady stream of events cannot postpone the full reconcile forever.
  - Deviation: `selectReconcileIntervalMs` keeps the poll cadence while time-based work is in flight (dispatcher with tracked tasks, Lead with open sessions). Idle reminders, lead idle-close, and startup grace are clock-driven transitions with no event behind them; stretching ticks to 60s would delay them. The slow interval applies when the machine is idle, which is where the polling cost was.
  - `FsWatchSource` watches the parent directory (atomic `rename` replaces the inode). `prompts/` is not watched: both prompt templates are already read from disk at every spawn.
- 2026-11-27 (Slice 4): `runLoop` runs ticks through `WakeScheduler` (the first tick is immediate; `--once` still runs a single tick without the scheduler). Sources are built by `createDaemonEventSources` (`src/bus/daemon-events.ts`, shared with Lead): the dispatcher tails only `board.projectChannelPrefix`, watches `projects.json`, and subscribes to Herdr. `SwarmDispatcher` takes the wiring as an optional `events` parameter; without it there is no enabled source and the scheduler period is `pollIntervalSeconds`, so the old loop is reproduced exactly (all 29 existing `tests/dispatcher.test.ts` tests pass unmodified).
  - Wake rules are the pure `shouldWakeDispatcher` (`src/reactors/dispatcher-wake.ts`): any event on a tracked task; `created`/`ready`/`unblocked`/`released`/`expired`/`other` on an untracked task under the prefix; a reply in a tracked thread (review handoff and verdicts); Herdr events for tracked panes or tabs; a `projects.json` change.
  - Per-pane status subscriptions are re-synced at the end of every tick from active and parked tasks, which covers spawns, orphan adoption, and sessions restored from Plan A's state file.
  - Deviation: the `projects.json` mtime comparison stays as the reload decision; `FsWatchSource` only wakes the tick. A missed or spurious watch event then costs latency at most. Nothing new is persisted: the dispatcher is level-triggered and does not need a cursor.
  - A source that goes down or recovers logs one line (`Live events degraded (polling) [board=down, herdr=live]; periodic reconcile every 15s.`) and re-arms the periodic timer.
  - Manual check (dry run against the live board on a scratch prefix, intervals set to 120s): the tick for a newly created task ran about 4.5s after invoking `vercel board tasks create`, CLI round trip included, instead of up to 120s. `SIGTERM` stopped it at once and `pgrep` found no `board tail` child afterwards.
- 2026-11-27 (Slice 5): Lead Watcher tails the whole board (unfiltered), resuming from `LeadWatcherState.tailCursor`. Board events are **queued** by the bus subscriber and drained, in order, at the start of the next tick, so live handling and the catch-up reads never interleave. An event-woken tick does no channel reads: it drains live events (👀 directly on the message ID, wake events, registry sync when the registry channel changed), then reconciles sessions and dispatches. A periodic tick (first tick, interval, `tick()` with no argument, any tick while the Board stream is down, or after a rejected cursor via `requestReconcile`) also runs the old full poll (`collectCatchUpEvents`). The existing `tests/lead-watcher.test.ts` passes unmodified.
  - Missed-mention fix: state keeps `seenThreadReplyCount`. `selectThreadsNeedingRead` picks project threads whose reply count advanced by more than one and whose latest message does not already wake Lead; those threads are read in full and every message after the seen marker is checked. Regression tests in `tests/lead-bus.test.ts` show the old latest-only check returns 0 events for mention-then-reply, and the new path returns the mention.
  - De-duplication: `handledMessageIds` (last 1000) plus the seen markers. A live message is skipped if it is already handled or is its thread's seen marker (a replay after `--after`). The catch-up path skips handled IDs and advances markers so it does not report what the live path handled.
  - Pruning: `seenThreadLastSeenMs` is refreshed by channel reads and live events; markers not refreshed for 14 days are dropped (legacy entries start their clock on first load). The loader is tolerant: a pre-bus state file loads unchanged.
  - Lead keeps the 10s poll cadence while sessions are open or events are queued (idle-close, startup grace); idle with a healthy stream it reconciles every `reconcileIntervalSeconds`. Herdr events for Lead's own panes or tabs wake it, and Lead session panes are watched for agent-status changes.
  - Manual check (dry run against the live board, inbox pointed at a scratch channel, intervals 120s): the post was detected less than a second after `vercel board post` returned, with no channel read; `SIGTERM` stopped it cleanly with no `board tail` child left.
- 2026-11-27 (Slice 6): `src/bus/reactor.ts` holds the `Reactor` interface, `ReactorRegistry` (per-reactor isolation for both `matches` and `react`, duplicate names rejected), the `ReactorEffect` union, and `executeEffects` (one handler per effect type; failures and unsupported effect types are logged, never fatal). Built-ins: `src/reactors/dispatcher-wake.ts` (`dispatcher-wake`, `projects-reload`) and `src/reactors/lead.ts` (`inbox-ack`, `lead-wake`, `registry-sync`, `lead-session-wake`). Each daemon logs its reactor list at startup.
  - Deviation from the interface sketch: configuration (channels, profile, paths) is bound when a reactor is created, and `ctx` carries only the daemon's live read-only view (tracked task, pane, and tab IDs; Lead session panes). That keeps `matches(event)` pure and usable at receipt time.
  - Lead runs Board-event reactors when the tick drains its queue, after the replay/duplicate check, so a reactor never sees an already-handled message. At receipt it only asks `matchesAny` to decide whether to wake. Lead's own effects (`lead_event`, `react`, `registry_sync`) feed triage directly; other effects are deferred until after triage.
- 2026-11-27 (Slice 7): `swarm.json` `reactors[]` (`ConfiguredReactorSchema`: `name`, `enabled`, `on` (selector or list, including `task.*` / `message.*`), `runOn`, `match { channel, labels }`, `run { command, timeoutSeconds } | { post { channel, text, profile? } }`, `cooldownSeconds` default 30; duplicate names rejected). Implementation: `src/reactors/configured.ts`. Commands run with `spawn(..., { shell: false })`, the argv comes from config only, and the event JSON goes to stdin. `post` text placeholders are `{type} {channel} {id} {thread} {author} {state} {text}`; the channel always comes from config. `mise run doctor` reports a missing command (fail), a dispatcher reactor whose channel is outside the dispatcher's prefix (warn), and a `post` reactor without a cooldown (warn).
  - **OQ6 (answered differently from the default assumption):** reactors run in **one** daemon, chosen per reactor with `runOn`, default `"lead"`. "Both" would run every reactor once per worker machine, plus once more on a `both` machine. Lead sees the whole board, and there is one Lead per swarm. `runOn: "dispatcher"` runs on every worker and only sees the project prefix; it is for per-machine local commands.
  - Loop prevention: a reactor never matches a message authored by its own posting profile (`reactor-<name>` unless set), and the executor's `CooldownGate` allows one run per `cooldownSeconds`. A test drives an "echo every #ops post into #ops" rule through both guards.
  - Lead runs configured effects after triage in the same tick (`runDeferredEffects`), so 👀 and Lead prompts are never delayed by a slow command. Dry-run logs instead of running.
  - Manual check: a non-dry-run Lead Watcher on scratch channels with `{ on: "message.posted", match: { channel: "scratch/..." }, run: { command: ["append.sh", "<file>"] } }` appended the event JSON about 5s after the post (behind that tick's triage). Process note: its startup catch-up also picked up an earlier probe post in the scratch inbox and spawned a real Lead tab. I closed it before it was prompted; use a fresh inbox channel for probes like this.
- 2026-11-27 (Slice 8): not implemented; deferred to a follow-up plan per the scope guard. The design note under Slice 8 records the proposed `Stage` interface and the reasons: `TaskPhase`'s review variants are fixed by the FSM and reviewer tests and by the v1 persisted state, and Plan C rewrites review signal detection. No code changed for this slice.
- 2026-11-27 (Slice 9): `docs/architecture.md` gains "Live Events, Wake-ups, and Reactors" (with a diagram) and drops the polling language from the overview diagram, the lifecycle sequence, and the component descriptions. The README's "What It Feels Like" now describes the event-driven latency, and a new "Live Events and Reactors" section shows reactor configuration. `AGENTS.md` records the bus, source, and reactor conventions. No command changed, so the setup guides are untouched.
- 2026-11-27 (local review and e2e): a `/code-review` pass over the branch found seven issues, all fixed in `ea561fc` with regression tests.
  - Timers were `unref()`'d, so a daemon with no healthy source could exit after its first tick. They are now ref'd; every component clears its timers on stop.
  - Lead queues drained wake events before the catch-up read, so a failing read cannot drop them.
  - A live event older than the last catch-up start (with a 30s skew margin, using the envelope `createdAt`) or already handled now only advances the cursor: no stale wake, no seen-marker regression, no reply-count drift.
  - Configured Lead reactors run for every live event, including ones Lead's own dedup skips.
  - Herdr pane subscriptions reopen after `stop()`/`start()`.
  - Doctor ignores disabled reactors' commands.
  - e2e: `tests/e2e/src/tests/event-bus.test.ts` adds two tests against the real `vb tail` and Herdr in the compose stack. (1) With `pollIntervalSeconds`/`reconcileIntervalSeconds` set to 120, a new task is claimed by event within the 20s bound, and its tab closes on the `task.completed` event. (2) Killing the `vb tail` child logs degraded mode, a task still completes, health recovers, and a graceful stop leaves no `tail` process. The full suite (15 tests) passes. Lead Watcher has no e2e harness in the stack (workers only), so its live path is covered by `tests/lead-bus.test.ts` and the manual runs above.

## Next Slice

Slices 1–7 and 9 are implemented; Slice 8 is deferred (see its design note). Remaining: the Testing Plan's final manual check on a `both` machine after merge (inbox 👀 latency, task-to-tab latency, killing the tail child, stopping the Herdr server, mention-then-reply), and a follow-up plan for the Stage seam after Plan C.
