# Rex Worker Runtime: Run Worker Agents in Rex Next to Herdr

Standalone plan. It touches the same seams as Plan C (`2026-11-27-agent-adapters-structured-signals-plan.md`) and Plan B (`2026-11-27-event-bus-reactors-plan.md`), but doesn't depend on them. See **Relationship to other plans**.

Status legend: `[ ]` not started · `[-]` in progress · `[x]` done (only when verified).

## Summary

Today every worker machine runs its agents in Herdr. The Dispatcher reads each agent's state (`idle`/`working`/`blocked`/`done`) from `herdr agent list`, and Sheprd shows the tabs.

Hands-on tests on 2026-11-27 (Board thread `msg_22f3bebb-d7db-4462-b9ce-941b53fc3056_1`, replies `_3` and `_4`) showed that Rex `0.1.0-preview.25` gets the same states **natively** from claude, codex, pi and agy. The agents send OSC 7501 themselves, and Rex exposes it through the `program_status` block method and `program_status_changed` events. That removes the main blocker in `docs/research/rex-vs-herdr.md` (no agent status in Rex).

Target state: a machine can be set up as a **Rex worker** instead of a **Herdr worker**. Both kinds claim from the same Board queue, run the same task/session FSMs, and post the same Board replies. Only the terminal runtime differs. On each machine, `mise run init` asks which one to use.

## Decisions

- **One runtime per machine.** A machine's Dispatcher uses Herdr or Rex, never both. Mixed fleets come from mixing machines. Per-task runtime selection on one host stays out of scope (it is the research note's "later" option).
- **A `WorkerRuntime` interface is the seam.** The FSMs stay as they are and consume a runtime-neutral `AgentStatus`. Only the effect shells (`src/dispatcher.ts`, `src/lib/dispatcher-effects.ts`) talk to the runtime. The interface follows the sketch in `docs/research/rex-vs-herdr.md` §4.
- **Herdr behavior is a preserved contract.** Extracting `HerdrRuntime` must not change any argv sent to `herdr` or any FSM transition. Existing tests are the contract.
- **The Lead stays on Herdr.** `LeadWatcher` keeps using `HerdrClient` directly. A `role: "both"` machine that picks Rex for workers still needs Herdr for the Lead, and doctor checks both.
- **Rex status comes from `program_status`, read by polling first.** Each reconcile tick calls `block.method program_status` for each live worker block. With `maxWorkers` ≈ 2 that is a handful of calls per tick. An event-stream source is an optional later slice (Slice 10).
- **Rex mapping**, from the 2026-11-27 findings:
  - Rex container mapping: project slug → Rex **session**, task → **window** (tab), agent → its root **block**.
  - Herdr's `workspace_id`/`tab_id`/`pane_id` map to Rex's `session_id`/`window_id`/`block_id`.
- **Env goes through an argv wrapper.** Rex has no per-pane `--env`, so the command runs as `env BOARD_PROFILE=… VERCEL_SCOPE=… <agent> <args>` after `--`, with `--shell` left at its default so the login environment loads.
- **Prompts are sent only after the first `idle`.** The tests showed input sent during startup gets dropped (codex). The existing `awaiting_prompt` lifecycle in `src/lib/session-fsm.ts` already delivers on the first idle/done, so Rex sessions always start in `awaiting_prompt`.
- **Worktrees for Rex use plain `git worktree`.** Rex has no worktree command. The default plain-tab + per-repo-lock path works unchanged. `useWorktree: true` on a Rex machine is handled by the Dispatcher with `git worktree add/remove` (Slice 7). Herdr keeps `herdr worktree create`.
- **Init wording.** For `worker` and `both` roles, init asks: "Where should worker agents run?" with "1) Herdr — tabs you watch in Sheprd" and "2) Rex — tabs you watch in the Rex app". There's a matching `--runtime herdr|rex` flag. The default is whichever binary is installed, and Herdr if both or neither are.

## Scope

In scope:

- the runtime seam
- `HerdrRuntime` (refactor) and `RexRuntime` (new)
- a startup guard in the session FSM
- the config schema and routing label
- registry advertising
- `git worktree` support for Rex
- init/apply/doctor/status/stop support
- a macOS launchd and Linux `systemd --user` worker on Rex
- docs

Out of scope:

- The Lead on Rex.
- Both runtimes in one Dispatcher process.
- Remote Rex targets (`-S ssh://…`). Rex stays local per machine, the same as `herdrTarget: "local"`.
- Rex GUI client actions (`rex do` against a client, e.g. selecting a session in the app).
- Changing agent CLI flags (Plan C).

## Relationship to Other Plans

- **Plan C Slice 1 (adapter seam)** and this plan's Slice 2 both edit the spawn path in `src/dispatcher.ts`. Whichever lands second rebases. They don't conflict in design: C is about _which agent CLI_ runs, this plan is about _which terminal runtime_ hosts it.
- **Plan B Slice 2 (Herdr event source)**: if it landed, Slice 10 adds a sibling `RexEventSource`. If it didn't, polling is enough and Slice 10 is skipped.
- **Plan A (durability)**: persisted state stores `paneId`/`tabId`/`workspaceId`. Slice 2 renames them to runtime-neutral fields in `SessionRef`. If Plan A has already landed, Slice 2 must migrate or alias the persisted field names.

## Current State

Line numbers are as of commit `428ab4d`; trust symbol names over line numbers.

Herdr touchpoints:

- `src/lib/herdr.ts`: `HerdrClient` with `createWorkspace`, `createTab`, `findOrCreateProjectTab`, `createWorktree`, `removeWorktree`, `renameTab`, `closeTab`, `paneRun`, `paneRead`, `listTabs`, `listAgents`, `getAgent`, `startAgent` (which waits for readiness and reports `agent_not_ready` as `blockedOnStartup`), `promptAgent`, and `sanitizeHerdrAgentName`.
- `src/dispatcher.ts`:
  - spawn path (around lines 378–490): `createWorktree`/`findOrCreateProjectTab` → `startAgent` → `promptAgent`, or `[BLOCKED]` rename on a startup block
  - `reconcileRunningWorkers` (around line 598): `listTabs` + `listAgents`, keyed by `tab_id`/`pane_id`
  - the `HerdrClient` built from `machineCfg.herdrTarget` (around line 725)
- `src/lib/dispatcher-effects.ts`:
  - reviewer spawn (`createTab` + `startAgent`)
  - fix-round restart, `promptAgent`, `renameTab`, `closeTab`, `removeWorktree`
  - `paneRead` for `[BLOCKED]` excerpts
- `src/lib/session-fsm.ts`, `src/lib/task-fsm.ts`: import only the `HerdrAgentStatus` type. `stepSession` treats `agentStatus === null` past the startup grace as `exited_unexpectedly`. `awaiting_prompt` delivers the prompt on idle/done and notifies `ui_blocked` once on blocked. It has **no timeout**.
- `src/lib/schemas.ts`: `HerdrAgentStatusSchema` = `idle|working|blocked|done|unknown`. `MachineConfigSchema.herdrTarget` defaults to `"local"`.
- `src/lib/routing.ts`: `matchesMachineLabels` adds `machine=<key>` and `os=<os>` host labels.
- Scripts:
  - `scripts/init.ts`: role prompt at lines 149–165, no runtime prompt
  - `scripts/doctor.ts`: `herdr --version` and `herdr status server` checks
  - `scripts/status.ts` and `scripts/stop.ts`: use `HerdrClient` directly
  - `scripts/apply-worker.ts`: renders the dispatcher service

Rex facts verified on 2026-11-27 (Rex `0.1.0-preview.25`, api rev 24):

- Spawn: `rex new <label> -c <cwd> --window <name> --json -- <cmd…>` returns `.session_id` and `.initial_windows[0].block_ids[0]`.
- New tab: `rex window new <label> -s <session> -c <cwd> --focus=false --json -- <cmd…>` returns `.block_ids[0]` (and `.window_id`).
- Status:
  - `rex do com.superlogical.terminal.program_status -b <block>` returns `{"records":[{state, kind?, msg?, app, effective_app, updated_at, owner:{pid,name}}]}`.
  - `state` is one of `idle|working|done|blocked|error`.
  - `kind` (when blocked) is one of `permission|question|auth`.
  - Equivalent: `rex api call -s <session> block.method '{"block_id":…,"method":"program_status"}'`.
- Process: `rex do com.superlogical.terminal.process -b <block>` returns `child`/`foreground` `{pid,name,argv0,cwd}` and `last_exit`.
- Listing: `rex block ls --json` returns `{blocks:[{block_id,label,window_id,flavor,…}]}` with **no status**, so status needs one call per block.
- Events: `rex events -s <session> --json` emits `block_event` with `name: "program_status_changed"` (`reason:"report"`), plus `child_exited {exit_code}`, `window_closed` and `block_closed`. `program_status_removed` was never observed.
- After a closed block, `program_status` fails with `block target "…" not found`.
- Input: `rex send -b <block> '<text>'` then `rex send-key -b <block> enter`. Single-line prompts were verified. **Multi-line paste has not been verified** (Slice 1).
- `rex wait` only waits for exit. There is no `--until idle`.
- Per-agent observations:

  | agent          | `app`         | blocked kinds seen                                                                                 | caveats                                                                     |
  | -------------- | ------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
  | claude 2.1.332 | `claude-code` | question, permission (`--permission-mode default`)                                                 | none                                                                        |
  | codex 0.171.0  | `codex`       | permission (only with `approvals_reviewer="user"`)                                                 | update menu at startup gives `records: []`; input during startup is dropped |
  | pi             | `pi`          | none (no prompts)                                                                                  | none                                                                        |
  | agy 1.5.18     | `antigravity` | permission (`--mode accept-edits`), question, **auth at startup (transient, ~0 ms before `idle`)** | `--mode auto` never blocked on permission                                   |

## Implementation Shape

```ts
// src/lib/runtime.ts
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown"; // was HerdrAgentStatus
export type RuntimeKind = "herdr" | "rex";

export interface SessionRef {
  runtime: RuntimeKind;
  groupId: string; // herdr workspace_id | rex session_id
  tabId: string; // herdr tab_id       | rex window_id
  paneId: string; // herdr pane_id      | rex block_id
  agentName: string; // herdr agent name   | rex window label
}

export interface LiveAgent {
  paneId: string;
  status: AgentStatus; // "unknown" = process alive, no status yet
  blockedKind?: "permission" | "question" | "auth" | string;
}

export interface RuntimeSnapshot {
  tabIds: Set<string>;
  agentsByPane: Map<string, LiveAgent>; // absent = no live agent (exited / closed)
}

export interface WorkerRuntime {
  readonly kind: RuntimeKind;
  health(): Promise<{ ok: boolean; detail: string }>;
  spawn(opts: {
    group: string; // project slug
    cwd: string;
    label: string;
    env: Record<string, string>;
    agent: { name: string; kind: string; args: string[] };
    worktree?: { branch: string; base?: string }; // herdr: native; rex: rejected (dispatcher does git)
    timeoutMs: number;
  }): Promise<{ ref: SessionRef; blockedOnStartup: boolean; promptNow: boolean }>;
  prompt(ref: SessionRef, text: string): Promise<void>;
  snapshot(refs: SessionRef[]): Promise<RuntimeSnapshot>;
  rename(ref: SessionRef, label: string): Promise<void>;
  close(ref: SessionRef): Promise<void>;
  removeWorktree?(ref: SessionRef): Promise<void>;
  readTail(ref: SessionRef, lines: number): Promise<string>;
}
```

- `HerdrRuntime.spawn` = today's `createWorktree|findOrCreateProjectTab` + `startAgent`, with `promptNow: !blockedOnStartup`. The FSM handle is created exactly as today.
- `RexRuntime.spawn`:
  - Find the session labelled `<group>` (`rex ls --json`) or `rex new` it.
  - Then `rex window new <label> -s S -c <cwd> --focus=false --json -- env K=V… <agent> <args>`.
  - Return `promptNow: false`, so the FSM starts in `awaiting_prompt` and delivers on the first idle.
- `RexRuntime.snapshot(refs)`: run `rex window ls --json` per session for tab existence, and `program_status` per ref's block in parallel. A `not found` error removes the block from the map. `[]` records with a live foreground process give `unknown`.
- Pure normalizer `normalizeRexStatus(records, foreground, startedAtMs, nowMs)`:
  - Pick the root record (`id === ""`) or else the newest `updated_at`.
  - Drop a record whose `owner.pid` isn't the foreground pid (stale).
  - `done` → `done`, `idle` → `idle`, `working` → `working`, `error` → `blocked`. The `[FAILED]` path already exists via blocked parking.
  - `blocked` with `kind:"auth"` within `authGraceMs` (default 5 s) of start → `unknown`. Any other blocked → `blocked`.

Init flow, with the runtime question added after the role prompt for `worker`/`both`:

```
Where should worker agents run?
  1) Herdr — tabs you watch in Sheprd (default)
  2) Rex   — tabs you watch in the Rex app
Runtime [1]:
```

Config is a discriminated union, with the legacy `herdrTarget` kept as a back-compat alias:

```jsonc
"machines": {
  "mac-worker":   { "role": "worker", "maxWorkers": 2, "runtime": { "kind": "herdr", "target": "local" } },
  "linux-worker": { "role": "worker", "maxWorkers": 2, "runtime": { "kind": "rex" } }
}
```

## Cross-Slice Rules

- Follow `AGENTS.md`:
  - Node type-stripping compatible TS (no `enum`/`namespace`/parameter properties).
  - Pure FSMs with discriminated unions and `assertNever`.
  - FSM tests are pure (no sleeps or I/O).
  - Parse every Rex ID from JSON output, never guess one.
- `npm run check` passes at the end of every slice.
- Herdr workers keep working unchanged after every slice. Until Slice 6, no machine can select Rex.
- Rex JSON is parsed with Zod schemas in `src/lib/schemas.ts`, marked "verified against rex 0.1.0-preview.25". Unknown `state`/`kind` values are caught as `unknown`, never thrown.
- Never kill, close or rename Rex sessions/windows the Dispatcher didn't create. Only touch windows whose label matches `formatTabLabel` output and whose block ID is in our own state.
- Config schema changes: update Zod, run `mise run schemas:generate`, and update `config/*.example.json`.
- No personal hostnames, users, paths or Board/Rex IDs in committed files or fixtures. Sanitize the sampled Rex JSON.
- One reviewable commit per slice; record findings under Working Notes.

## Slices

### Slice 1: Rex contract spike and fixtures

Status: `[-]` In progress (Linux Rex `0.1.0-preview.25` CLI contracts & fixtures verified in Docker; real-agent TUI multi-line paste, codex update menu, claude folder-trust, and macOS Rex app host remain for manual Mac verification)

- Goal: close the last unverified Rex behaviors before writing adapter code, and capture fixtures.
- Why here: everything after this relies on these answers; it's cheap and has no code risk.
- This slice should implement (scratch scripts only, in your own Rex session):
  - **Multi-line prompt delivery:** send a real rendered worker prompt (`renderWorkerPrompt` output, ~60 lines) with `rex send` + `send-key enter` to claude, codex, pi and agy. Check it arrives as **one** submitted message, not one submit per line. If it doesn't, try bracketed paste (`\e[200~…\e[201~`) via `rex send` or `rex block call`, and record which works per agent.
  - **Env wrapper:** confirm `-- env BOARD_PROFILE=x VERCEL_SCOPE=y claude …` reaches the agent (`echo $BOARD_PROFILE` via the agent's shell tool).
  - **Codex startup menu:** find a per-process flag that suppresses the update prompt (e.g. `-c check_for_update_on_startup=false`), or confirm it needs the startup guard from Slice 3.
  - **Close semantics:** `rex window close <window>` on a running agent, and whether it emits `child_exited`/`block_closed`. Also `rex window rename`, and whether the label shows in the Rex app sidebar.
  - **Folder trust:** spawn claude in a fresh untrusted directory and record what `program_status` reports (blocked? which kind? or `[]`?).
  - Save sanitized JSON samples (program_status idle/working/done/blocked×kinds/empty, process, block ls, window ls, `rex new`/`window new` output, an events NDJSON excerpt) under `tests/fixtures/rex/`.
- Expected output: fixtures plus a dated Working Notes entry answering each item. Update the Decisions if any answer contradicts them.
- Verification: the findings are recorded in Working Notes with the exact commands. The fixtures parse with `jq`.
- Dependencies: Rex installed on a test machine.

### Slice 2: Runtime seam with `HerdrRuntime` (pure refactor)

Status: `[x]` Done (verified via `npm run check` + full Herdr E2E suite)

- Goal: the Dispatcher and its effects talk to `WorkerRuntime`, not `HerdrClient`.
- Why here: it decouples everything after it from Herdr without any behavior change. It is worth doing even if Rex stalls.
- This slice should implement:
  - `src/lib/runtime.ts` with the types from Implementation Shape. Rename `HerdrAgentStatus` → `AgentStatus` in the FSMs, keeping a type alias in `herdr.ts` for one release.
  - `src/lib/runtimes/herdr-runtime.ts` wrapping `HerdrClient`, using exactly the current call sequence.
  - The `src/dispatcher.ts` spawn + reconcile and `src/lib/dispatcher-effects.ts` (reviewer spawn, fix-round restart, prompt, rename, close, removeWorktree, readTail) go through the runtime. The `SessionHandle` fields become runtime-neutral (`groupId`, `tabId`, `paneId`).
  - `sanitizeHerdrAgentName` → a runtime-neutral `sanitizeAgentName`, keeping the old export as an alias.
  - Leave `LeadWatcher`, `scripts/status.ts` and `scripts/stop.ts` on `HerdrClient`.
- Expected output: no argv or log changes. A recording fake `WorkerRuntime` replaces the Herdr fakes in `tests/dispatcher.test.ts` where that simplifies them.
- Verification: `npm run check`. The existing dispatcher, fsm and reviewer tests pass unmodified, or with only import/type renames. Run a Herdr worker manually on one real task.
- Dependencies: none. Rebase over Plan C Slice 1 / Plan A if they landed first.

### Slice 3: Startup guard in the session FSM

Status: `[x]` Done (verified via `tests/fsm.test.ts` + `npm run check`)

- Goal: a session that never reaches `idle` after spawn gets surfaced instead of sitting forever, and "alive but no status yet" isn't treated as exited.
- Why here: Rex needs it (the codex update menu gives `[]`, and a stuck folder-trust prompt is possible). It is pure FSM work, testable before any Rex code exists. Herdr benefits too.
- This slice should implement:
  - Split the `agentStatus` observation into `null` (no live agent → existing `exited_unexpectedly` after grace) and `"unknown"` (alive, unclassified).
  - `awaiting_prompt` gains `sinceMs` (a field in that variant only). If not idle/done within `workerDefaults.startupTimeoutSeconds` (new, default 90), emit `ui_blocked` with reason `startup_timeout`. The existing `[BLOCKED]` path renames the tab and posts a Board reply with a `readTail` excerpt.
  - Keep `uiBlockedNotified` semantics so it fires once.
- Expected output: pure tests covering unknown → idle → deliver, unknown past timeout → ui_blocked once, null past grace → exited, and blocked → ui_blocked → idle → deliver.
- Verification: `npm run check`; the new cases in `tests/fsm.test.ts`.
- Dependencies: Slice 2 (`AgentStatus` type).

### Slice 4: Config, routing label and registry

Status: `[x]` Done (verified via `tests/rex.test.ts`, `npm run schemas:generate`, and E2E `#swarm/registry` + `runtime=rex` routing)

- Goal: a machine can declare `runtime: {kind:"herdr"|"rex"}`, and the swarm knows which machines run which runtime.
- Why here: it's the contract the later slices read. On its own it's inert (Slice 6 wires the Rex side).
- This slice should implement:
  - `MachineRuntimeSchema` discriminated union in `src/lib/schemas.ts`: `{kind:"herdr", target?: string}` | `{kind:"rex"}`, with `.describe()` text. Use a `z.preprocess` so a legacy `herdrTarget` maps to `{kind:"herdr", target}`, and a missing `runtime` means `herdr` / `local`. Reject a config that sets both `runtime` and `herdrTarget` with different values.
  - `matchesMachineLabels` adds a `runtime=<kind>` host label, so a task can pin with `runtime=rex`.
  - `publishMachineRegistry` includes `runtime` per machine. The `prompts/lead-CLAUDE.md` routing section gets one line about the `runtime=` label.
  - `mise run schemas:generate`, and update `config/swarm.example.json`.
- Expected output: schema, routing and registry tests. Existing configs parse unchanged.
- Verification: `npm run check`; `tests/registry.test.ts` plus new schema/routing cases; `mise run schemas:generate` leaves no diff after the commit.
- Dependencies: none (can run in parallel with Slices 2–3).

### Slice 5: `RexClient` and status normalizer

Status: `[x]` Done (verified via `tests/rex.test.ts` against sanitized `rex 0.1.0-preview.25` fixtures + real `worker-3` E2E)

- Goal: a typed, tested wrapper over the Rex CLI and a pure `records → AgentStatus` mapping.
- Why here: it isolates Rex's beta CLI surface behind one module, tested on the Slice 1 fixtures, before it touches the Dispatcher.
- This slice should implement:
  - `src/lib/rex.ts`: `RexClient` built on the injected `ExecRunner` (same pattern as `HerdrClient`). Methods: `listSessions`, `newSession`, `newWindow`, `listWindows`, `listBlocks`, `programStatus`, `process`, `send`, `sendKey`, `capture`, `renameWindow`, `closeWindow`, `whoami`. Every method parses with Zod.
  - Map exit code `3` and "not found" to a typed `RexNotFoundError`, and exit code `4` to `RexUnreachableError`.
  - Zod schemas for every Rex JSON shape used.
  - The pure `normalizeRexStatus(...)` from Implementation Shape: root-record selection, stale-pid drop, `auth` startup grace, unknown-state catch.
  - Prompt delivery via whichever method Slice 1 proved for multi-line text.
- Expected output: `src/lib/rex.ts`; `tests/rex.test.ts` (argv assertions with a fake runner, fixture parsing, normalizer table tests including agy `blocked/auth` → `unknown` inside grace and `blocked` after it).
- Verification: `npm run check`.
- Dependencies: Slice 1 (fixtures, prompt method), Slice 2 (`AgentStatus`).

### Slice 6: `RexRuntime` and Dispatcher wiring

Status: `[-]` In progress (implemented and verified end-to-end against real `rex 0.1.0-preview.25` in Docker `worker-3` E2E; real `claude`/`codex`/`pi`/`agy` Mac run pending manual confirmation)

- Goal: a machine with `runtime.kind: "rex"` claims, runs, reviews and settles tasks end to end in Rex.
- Why here: it needs the seam (2), the startup guard (3), config (4) and the client (5).
- This slice should implement:
  - `src/lib/runtimes/rex-runtime.ts` implementing `WorkerRuntime`:
    - spawn uses a session per project slug and a window per task, with the env wrapper and `promptNow: false`
    - `snapshot(refs)`: window existence + per-block `programStatus` + `process`, run in parallel and normalized
    - `prompt`, `rename` (window label, so `[BLOCKED]`/`[REVIEW]` labels keep working), `close` (`window close`), `readTail` (`capture --trim`, last N lines)
  - Reject `worktree` until Slice 7. In this slice, a project with `useWorktree: true` on a Rex machine logs a warning and falls back to the per-repo lock.
  - Factory `createWorkerRuntime(machineCfg)` in `src/dispatcher.ts` replacing `new HerdrClient(...)`. The startup log line names the runtime.
  - The reviewer session spawns through the same runtime (already true after Slice 2).
- Expected output: dispatcher tests using a fake `RexClient` for spawn → awaiting_prompt → idle → deliver → working → done → completion flow, a blocked-permission parking flow, and a window closed by hand → exited.
- Verification: `npm run check`. Manual: on a Rex test machine with `runtime.kind:"rex"` and `dryRun` off, create a trivial task (`agent=claude`, "reply OK and complete the task"). It gets claimed, the prompt is delivered after idle, and the task completes. Repeat with `agent=codex`, `agent=pi` and `agent=agy`. Record the results in Working Notes.
- Dependencies: Slices 2–5.

### Slice 7: `git worktree` support for Rex machines

Status: `[x]` Done (verified via `tests/rex.test.ts` + `worker-3` E2E `worktree-app` creation and cleanup)

- Goal: `useWorktree: true` works on Rex machines.
- Why here: it's optional; the default plain-tab path already works after Slice 6.
- This slice should implement:
  - `src/lib/worktree.ts`:
    - `git worktree add -b task/<short> <dir> <base>` before spawn, under a configured root (default `<repo>/../.swarm-worktrees/<slug>/<short>`)
    - `git worktree remove --force` plus branch cleanup in the existing cleanup effect, but only for worktrees this Dispatcher created
  - The Dispatcher passes the worktree path as `cwd` to `RexRuntime.spawn`. Herdr keeps `herdr worktree create`.
- Expected output: unit tests with a fake runner (argv assertions); a manual run on a test repo.
- Verification: `npm run check`. Manually run one task with `useWorktree: true` on the Rex machine, then confirm the worktree is gone after completion (`git worktree list`).
- Dependencies: Slice 6.

### Slice 8: Init, apply, doctor, status, stop

Status: `[-]` In progress (implemented and unit-tested; manual `mise run init --role worker --runtime rex` + `doctor`/`apply`/`status` on macOS/Linux host pending)

- Goal: a user sets up a Rex worker from `mise run init` with no hand-editing, and the ops scripts understand it.
- Why here: user-facing; only worth shipping once Slice 6 works.
- This slice should implement:
  - `scripts/init.ts`:
    - For `worker`/`both` roles, ask "Where should worker agents run?" (wording in Implementation Shape), plus a `--runtime herdr|rex` flag (validated like `--role`).
    - Default to the installed binary (`rex` vs `herdr` on PATH via `src/lib/host-env.ts`).
    - Write `runtime` into the machine entry.
    - For `both` + `rex`, print one line saying the Lead still runs in Herdr.
  - `scripts/doctor.ts`:
    - Rex machines check `rex version` and `rex whoami --json` (server reachable, `rex_version`), and warn when the version differs from the one verified in `schemas.ts`.
    - Herdr checks run only when the machine runtime is Herdr or the role includes main.
  - `scripts/status.ts`: list live swarm workers via the machine's runtime (`snapshot` over windows with swarm labels).
  - `scripts/stop.ts`: close only the Dispatcher's own Rex windows.
  - `scripts/apply-worker.ts`:
    - Linux Rex: ensure a `systemd --user` Rex server (`rex server install`, no sudo) is running before the Dispatcher unit. Add `After=` ordering, or a doctor hint if it's not installable non-interactively.
    - macOS Rex: the app hosts the server, so check reachability and print a hint.
- Expected output: init tests for flag parsing and the default choice; doctor output for both runtimes.
- Verification: `npm run check`. Manual: `mise run init --role worker --runtime rex` on a clean config, then `mise run doctor`, `mise run apply`, `mise run status`.
- Dependencies: Slices 4, 6.

### Slice 9: Docs and side-by-side validation

Status: `[-]` In progress (docs updated; mixed Herdr+Rex fleet verified in Docker E2E with `worker-1`/`worker-2` Herdr + `worker-3` Rex; real Board + Mac mixed-fleet pass pending)

- Goal: the docs reflect two runtimes, and a mixed fleet is proven on the real Board.
- This slice should implement:
  - Docs:
    - `docs/worker-machine-setup.md`: a "Herdr worker or Rex worker" section, with install steps per OS and what you see where (Sheprd vs Rex app).
    - `docs/architecture.md`: the runtime seam.
    - `AGENTS.md`: add the Rex runtime to "Generalized Machine Topology" and "Architectural Decisions", and add the conventions "parse Rex IDs from JSON" and "Lead stays on Herdr".
    - README: one table row.
  - `docs/research/rex-vs-herdr.md`: add a dated note at the top pointing to the 2026-11-27 Board findings and this plan, marking the "agent status missing" blocker as resolved.
  - Mixed-fleet run: one Herdr worker machine and one Rex worker machine against the same Board. Queue 4+ tasks with mixed `agent=` labels and one `runtime=rex` pin. Confirm the claims spread across both machines, the pin is respected, one reviewer round runs on Rex, and a `[BLOCKED]` question task (claude `AskUserQuestion`) parks and resumes after a Board answer.
- Verification: the mixed-fleet results are recorded in Working Notes with task IDs. `npm run check`.
- Dependencies: Slices 6, 8 (and 7 if worktrees are wanted).

### Slice 10 (optional): Rex event source

Status: `[x]` Done (implemented `RexEventSource`, verified via `tests/rex.test.ts` + `worker-3` E2E event-driven test with 120s poll interval and clean process-group teardown)

- Goal: Rex status changes wake the Dispatcher immediately instead of on the next poll.
- Only if Plan B's bus landed. It is a sibling of `HerdrEventSource`.
- This slice should implement:
  - `src/bus/rex-event-source.ts` reading `rex events -s <session> --json` per swarm session, with its own NDJSON reader and process-group kill on stop. Don't use a `head -1` pipeline, because SIGPIPE only arrives on the next event.
  - Map `program_status_changed` → `runtime.agent_status`, and `child_exited`/`block_closed`/`window_closed` → exit events.
  - Restart with backoff, and emit `source.health`.
- Verification: parser tests on the Slice 1 events fixture; a teardown test; a manual latency check (status → wake < 1 s).
- Dependencies: Slice 6, Plan B Slices 2–3.

## Testing Plan

- Pure:
  - FSM startup guard (`tests/fsm.test.ts`)
  - `normalizeRexStatus` table tests
  - schema back-compat (`herdrTarget` → `runtime`)
  - the routing `runtime=` label
- Adapter: `tests/rex.test.ts` (argv + fixture parsing via a fake `ExecRunner`). `HerdrRuntime` is covered by the existing dispatcher tests.
- Integration with fakes: dispatcher flows over a fake `RexClient` (Slice 6).
- Manual / real machines:
  - Slice 1 spike
  - Slice 6 per-agent task runs
  - Slice 8 init → apply on a clean config
  - Slice 9 mixed fleet
- Final: `npm run check`, plus the Slice 9 mixed-fleet record.

## Files to Add

- `src/lib/runtime.ts`
- `src/lib/runtimes/herdr-runtime.ts`
- `src/lib/runtimes/rex-runtime.ts`
- `src/lib/rex.ts`
- `src/lib/worktree.ts` (Slice 7)
- `src/bus/rex-event-source.ts` (Slice 10, optional)
- `tests/rex.test.ts`
- `tests/fixtures/rex/*.json` and `tests/fixtures/rex/*.ndjson`

## Files to Change

- `src/dispatcher.ts`, `src/lib/dispatcher-effects.ts`
- `src/lib/session-fsm.ts`, `src/lib/task-fsm.ts` (type rename, startup guard)
- `src/lib/herdr.ts` (type aliases)
- `src/lib/schemas.ts`, `config/swarm.schema.json`, `config/swarm.example.json`
- `src/lib/routing.ts`, `src/lib/registry.ts`, `src/lib/config.ts` (runtime resolution)
- `src/lib/host-env.ts` (detect `rex`)
- `scripts/init.ts`, `scripts/doctor.ts`, `scripts/status.ts`, `scripts/stop.ts`, `scripts/apply-worker.ts`
- `infra/systemd/swarm-dispatcher.service`, `infra/launchd/dev.swarm.dispatcher.plist` (ordering/hints only, if needed)
- `prompts/lead-CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/worker-machine-setup.md`, `docs/architecture.md`, `docs/research/rex-vs-herdr.md`

## Open Questions

1. **Multi-line prompt delivery** through `rex send`: does it submit once, or per line? (Slice 1.) If no CLI path works, `rex block call write` with bracketed paste is the fallback.
2. **Codex update menu:** is there a per-process flag that skips it, or do we rely on the Slice 3 startup guard?
3. **Folder-trust prompt (claude) in Rex:** is it reported as `blocked`, or as `[]`? This decides whether the startup guard or the normal blocked path handles it.
4. **Session layout:** one Rex session per project (proposed), or one `swarm` session with a window per task? Per project mirrors Herdr workspaces but uses more of Rex's 64-session limit.
5. **Headless macOS Rex worker:** the macOS server is hosted by the app. Does a launchd Dispatcher work when no one is logged in? If not, document that macOS Rex workers need a logged-in session, and Linux is the headless option.
6. **Version drift:** Rex is a preview with no CLI semver promise. Should `doctor` hard-fail or only warn on a version newer than the one verified? (Proposed: warn.)
7. **`error` state mapping:** map it to `blocked` (park it for a human, proposed) or straight to task `fail`?
8. **Init wording:** is "Where should worker agents run?" with Herdr/Rex + where-you-watch-it hints clear enough, or should it mention the trade-off (e.g. "Rex — beta")?

## Working Notes

- 2026-11-27: Plan written from the Board findings (`msg_22f3bebb-…_3` for codex/pi/claude, `_4` for agy) and `docs/research/rex-vs-herdr.md`. The research note's main blocker (no agent status in Rex) no longer applies: all four agents report through OSC 7501. Also checked live on Rex `0.1.0-preview.25`: `rex block ls --json` carries no status field (so status needs one `program_status` call per block), and `rex window new` takes `-s/-c/--focus/--json/--keep-open/--shell`.
- 2026-11-27 (Docker Linux probe & E2E on `rex 0.1.0-preview.25`, api rev 24):
  - Installed via `curl -fsSL https://pkgs.superlogical.com/rex/install.sh | sh -s -- --channel preview` in `node:24-bookworm-slim`; `rex server start` runs headless over Unix socket with no systemd.
  - CLI contract specifics confirmed directly on `0.1.0-preview.25`:
    - `rex block ls --json` requires `-s <session>` (`-A --json` fails); `rex window ls -s <session> --json` returns windows + nested block IDs.
    - `rex window rename` does NOT accept `--json`.
    - `rex send` reads stdin when `[TEXT]` is **omitted** (passing `-` sends literal `-`). `RexClient.send` pipes via stdin with bracketed paste (`\x1b[200~...\x1b[201~`) for multi-line prompts, followed by `rex send-key -s <sid> -b <bid> enter`.
    - Passing `--keep-open` to `rex new` and `rex window new` keeps the window/block alive after a crash so `rex capture` returns the tail and `[FAILED]` parking works; `rex do com.superlogical.terminal.process` reports `child: null, foreground: null, last_exit: {...}` once exited.
    - `rex events --json` streams server-level connectivity/session events; `rex events -s <sid> --json` streams `program_status_changed`, `child_exited`, `window_closed`, and `block_closed`.
  - Race caught & fixed in E2E: fast-starting Rex agents can emit initial OSC 7501 `idle` before `rex events -s <sid>` finishes attaching; `SwarmDispatcher.tick()` schedules a debounced `rex_awaiting_prompt` wake whenever a new Rex session enters `awaiting_prompt`.
  - Added `worker-3` (`SWARM_RUNTIME=rex`) to `tests/e2e/docker-compose.yaml` and verified mixed-fleet routing (`runtime=rex` / `runtime=herdr`), `RexEventSource` event-driven wakeups, `--keep-open` crash capture & `[FAILED]` parking, mid-review dispatcher restart durability, and Dispatcher-managed `git worktree` cleanup.
  - Remaining manual verification on macOS / real agents: real TUI multi-line paste on `claude`/`codex`/`pi`/`agy`, `codex` startup update menu flag, `claude` untrusted-folder prompt status, and macOS Rex app + `launchd` `init`/`doctor`/`apply`/`status`.

## Next Slice

**Slice 1: Rex contract spike and fixtures.**

1. On the Rex test machine, create your own session (`rex new rex-spike -c <repo> --json`).
2. Render a real worker prompt (call `renderWorkerPrompt` from a small `node` script, or copy one from a past task).
3. Deliver it to claude, codex, pi and agy with `rex send` + `rex send-key enter`, and record whether each submits once.
4. Answer Open Questions 1–3 (and 5 if a macOS box is in use). Save the sanitized JSON fixtures to `tests/fixtures/rex/`.
5. Clean up with `rex kill <your session>`.

Success means every question has a recorded answer and command in Working Notes. Nothing blocks starting.
