# Agent Adapters and Structured Signals

Plan C of three. Order: A (`2026-11-27-dispatcher-durability-plan.md`) → B (`2026-11-27-event-bus-reactors-plan.md`) → **C (this plan)**.

Status legend: `[ ]` not started · `[-]` in progress · `[x]` done (only when verified).

## Summary

Two places where the swarm's contracts are implicit and scattered:

1. **Agent support is hardcoded in about seven places.** Adding or changing an agent CLI means editing a 110-line `if/else`, two constant tables, the model catalog, doctor, host detection and three docs. Custom agent kinds silently get no permission flags, and the Lead is hardcoded to `claude`.
2. **Agents talk to the dispatcher through prose.** Review handoff and verdicts are regex matches on reply text, found by re-reading whole threads. The machine registry never heartbeats, so a dead worker advertises forever and Lead keeps routing to it.

Target state: one adapter file per agent kind plus a declarative form for custom kinds, the Lead resolved through the same mechanism, review signals carried as Board labels, and a registry with a heartbeat and a time-to-live.

## Decisions

- **`AgentAdapter` is the single source of truth per kind.** Defaults, argument building, supported efforts, model discovery and the doctor check all live in `src/agents/<kind>.ts`. Everything else asks the registry.
- **Argument output is a preserved contract.** The exact argument arrays asserted in `tests/dispatcher.test.ts` ("config & worker agent selection") and `tests/agent-catalog.test.ts` must not change in the extraction slices.
- **Custom kinds are declared in `swarm.json` as argument templates**, not as loadable code. No dynamic `import()` of user files.
- **Signals are labels on the reply message.** A reply labelled `swarm.signal=ready_for_review`, or `swarm.signal=verdict` with `swarm.verdict=approve|request_changes`, is the canonical signal. Reply labels are append-only, need no compare-and-set, and arrive on Plan B's tail feed inside `message.labels` so no thread read is needed.
- **The text markers stay as an accepted fallback for now.** `STATUS: READY_FOR_REVIEW` and `VERDICT: …` keep working; every fallback match is logged. The final slice decides, from those logs, whether to remove or keep the fallback.
- **Registry liveness is TTL-only.** Workers re-publish on a heartbeat; the Lead catalog treats entries older than three heartbeats as offline. No "going offline" message on shutdown, because routine restarts would flap.
- **The registry stays a readable card with an embedded JSON block.** Adopting Board schemas (`--schema`) is out of scope until their semantics are understood.

## Scope

In scope: adapter interface and registry, the four built-in adapters, declarative custom adapters, Lead through an adapter, label-based review signals with fallback, registry heartbeat and TTL, docs.

Out of scope:

- New review stages or changes to the review loop's semantics (rounds, escalation).
- Replacing polling (Plan B) or restart durability (Plan A).
- Per-machine agent profile overrides, packaging, service management.

## Prerequisites

Plans A and B should be complete. Read their Working Notes first. Two things in this plan depend on what B delivered:

- If B's bus landed, Slice 6 consumes signals from `board.message` events. If it did not, skip Slice 6; Slice 5 works on the existing thread-read path.
- If B's Slice 8 (pipeline stage seam) landed, the review signal detectors live behind that interface; apply Slice 5 there.

## Current State

Line numbers are as of commit `428ab4d`; trust symbol names over line numbers.

Agent touchpoints:

- `BUILTIN_AGENT_KINDS` and `BUILTIN_AGENT_PROFILES` (`src/lib/config.ts:95-126`).
- `buildAgentCliArgs` (`src/lib/config.ts:374-484`): one `if/else` branch per kind mapping `model`, `effort` and `permissionMode` to flags. The final `else` (custom kinds) emits only `--model` and `--effort` and ignores `permissionMode`.
- `resolveWorkerRuntime` and `resolveReviewerConfig` (`src/lib/config.ts`): label overrides, with the effort list duplicated inline and again as `VALID_EFFORT_LEVELS`; a third copy is `SWARM_EFFORT_LEVELS` in `src/lib/agent-catalog.ts`.
- `KIND_INFO` and the three model-list parsers (`src/lib/agent-catalog.ts`).
- Installed-binary detection in two places: `detectAvailableAgentKinds` (`src/dispatcher.ts`, run once at boot) and `detectInstalledAgentKinds` (`src/lib/host-env.ts`).
- `scripts/doctor.ts`: one hand-written `checkVersion` line per agent.
- Lead: `spawnSessionForThread` in `src/lead-watcher.ts` hardcodes `kind: "claude"` twice; `apply-main.ts` renders `prompts/lead-CLAUDE.md` to `<leadWorkspace>/CLAUDE.md`.
- Docs that enumerate agents and flags: `AGENTS.md` ("Worker agent label routing"), the README supported-agents table, `docs/worker-machine-setup.md`.

Signals:

- `src/lib/review.ts`: `findReadyForReviewReply` and `findReviewVerdictReply` match `STATUS: READY_FOR_REVIEW` and `VERDICT: APPROVE|REQUEST_CHANGES` by regex on reply text.
- `observeThreadSignal` (`src/dispatcher.ts`) reads the whole thread when the reply count grew or the agent went idle; `phaseSeenReplyIds` prevents re-matching old markers.
- The instructions agents follow are produced in `renderWorkerPrompt` (`src/lib/routing.ts`, `{{COMPLETION_WORKFLOW}}`), `prompts/reviewer-prompt.md`, `buildFixRoundPrompt` (`src/lib/review.ts`) and `buildIdleReminder` (`src/lib/task-fsm.ts`).
- `BoardMessageSchema` (`src/lib/schemas.ts`) is passthrough and does not declare `labels`, so reply labels are present at runtime but untyped.
- `BoardClient.reply` takes no labels.

Verified on 2026-11-27 (Vercel CLI 66.6.0):

- `vercel board reply <id> "text" --label k=v` labels the reply.
- `vercel board label <id> k=v [--if k=v] [--if-unset K] [--unset K]` edits labels with compare-and-set options.
- Label keys: up to 64 characters of lowercase letters, digits, `.`, `_`, `-`, starting with a letter or digit. Values: up to 256 characters.
- `tasks`, `tail` and `wait` accept `--label`, matching "a label on the message or its thread's root".
- Tail events carry `message.labels` (Plan B).

Registry:

- `publishMachineRegistry` (`src/lib/registry.ts`) returns `unchanged` when the fingerprint, which ignores `updatedAt`, matches. So `updatedAt` only moves when content changes.
- The dispatcher publishes once per process start and again only when `projects.json` changes (`registryPublishedOnce` in `src/dispatcher.ts`). Agent CLIs installed or removed after boot are never re-detected.
- `mergeRegistryIntoLeadCatalog` never expires an entry.
- `catalogFingerprint` strips only the top-level `updatedAt`; per-machine `updatedAt` values are part of the fingerprint.
- `prompts/lead-CLAUDE.md` tells Lead how to route using the synced `projects.json`.

## Implementation Shape

Adapter:

```ts
export interface AgentAdapter {
  kind: string; // binary name and `herdr agent start --kind`
  defaults: Omit<WorkerAgentProfile, "kind">;
  cliEfforts: readonly string[];
  buildArgs(profile: WorkerAgentProfile): string[];
  models: {
    discover?: { cmd: string; args: string[]; parse(stdout: string): CatalogModel[] };
    static: CatalogModel[];
    note?: string;
  };
  versionArgs: string[]; // for doctor and install detection
}
```

`src/agents/registry.ts` exposes `getAdapter(kind)`, `listAdapters()` and `registerDeclarativeAdapters(swarm)`. `buildAgentCliArgs` becomes a one-line delegate so existing callers and tests are untouched.

Declarative custom kind (illustrative; settle the exact shape in Slice 3):

```json
"agents": {
  "myagent": {
    "kind": "myagent",
    "argTemplate": {
      "model": ["--model", "{model}"],
      "effort": ["--reasoning", "{effort}"],
      "permissionMode": { "auto": ["--yes"], "plan": ["--read-only"] }
    }
  }
}
```

Signals:

| Signal                    | Reply labels                                            | Fallback text marker       |
| ------------------------- | ------------------------------------------------------- | -------------------------- |
| Implementer hands off     | `swarm.signal=ready_for_review`                         | `STATUS: READY_FOR_REVIEW` |
| Reviewer approves         | `swarm.signal=verdict`, `swarm.verdict=approve`         | `VERDICT: APPROVE`         |
| Reviewer requests changes | `swarm.signal=verdict`, `swarm.verdict=request_changes` | `VERDICT: REQUEST_CHANGES` |

Detection order per unseen reply from the expected profile: labels first, then text marker. A reply that has both must not be counted twice.

Registry: entry `version` goes to 2 and gains `heartbeatSeconds`. The catalog written for Lead gains a per-machine `online` boolean computed at read time; offline machines are removed from each project's `machines` list.

## Cross-Slice Rules

- Follow `AGENTS.md`: Node type-stripping compatible TypeScript; discriminated unions and `assertNever`; pure, deterministic tests.
- `npm run check` passes at the end of every slice.
- Slices 1 and 2 are pure refactors: no test expectation may change.
- Config schema changes: update Zod in `src/lib/schemas.ts`, run `mise run schemas:generate`, update `config/*.example.json`.
- Prompt changes are behavior changes for live agents. Keep old and new signal forms both accepted until Slice 8.
- Registry format changes must be readable by an older Lead Watcher and vice versa (workers and the main machine update at different times): parse version 1 and 2, and treat a missing `heartbeatSeconds` as "never expires".
- No personal hostnames, usernames, paths, or Board IDs in committed files or fixtures.
- One reviewable commit per slice; record findings under Working Notes.

## Slices

### Slice 1: Adapter seam (pure refactor)

Status: `[ ]` Not started

- Goal: the four built-in kinds live in `src/agents/`, and `buildAgentCliArgs` delegates to them.
- Why here: establishes the contract with zero behavior change, protected by existing tests.
- This slice should implement:
  - `src/agents/types.ts`, `src/agents/registry.ts`, `src/agents/{claude,agy,codex,pi}.ts`, and a `generic` adapter reproducing today's fallback branch exactly.
  - `BUILTIN_AGENT_KINDS` and `BUILTIN_AGENT_PROFILES` derived from the registry (keep the exports).
- Expected output: `config.ts` loses the `if/else`; no caller changes.
- Verification: `node --test tests/dispatcher.test.ts tests/agent-catalog.test.ts` with no expectation edits; `npm run check`.
- Dependencies: none.

### Slice 2: Fold catalog, detection, doctor and effort levels onto adapters

Status: `[ ]` Not started

- Goal: no per-kind knowledge outside `src/agents/`.
- Why here: completes the seam before anything new is built on it.
- This slice should implement:
  - Move `KIND_INFO` data and the three parsers into their adapters; `agent-catalog.ts` iterates the registry.
  - One installed-kinds detector used by the dispatcher, `init`, and doctor.
  - `scripts/doctor.ts` loops over adapters for version checks (preserve which are required versus optional: `claude` required, the rest optional).
  - One exported effort-level list used by `resolveWorkerRuntime`, `resolveReviewerConfig` and the catalog.
- Expected output: adding a built-in agent is one new file plus one registry line.
- Verification: existing tests unchanged; `mise run agents -- --static` and `mise run doctor` output compared before and after; `npm run check`.
- Dependencies: Slice 1.

### Slice 3: Declarative custom adapters

Status: `[ ]` Not started

- Goal: a custom agent kind gets correct model, effort and permission flags from config alone.
- Why here: needs the registry; unblocks the Lead slice for non-built-in kinds.
- This slice should implement:
  - First settle Open Question 1 (what Herdr does with an unknown `--kind`) and record the answer; it bounds what "custom kind" can mean.
  - `argTemplate` in the agent profile schema, with placeholder substitution that only ever produces whole argv elements (no shell, no splitting).
  - Validation: unknown placeholders rejected at config load; a custom kind without a template logs a warning that `permissionMode` is ignored.
  - `mise run agents` lists custom kinds; doctor checks their binary.
- Expected output: schema, example config entry, docs paragraph.
- Verification: schema tests; arg-building tests for a templated kind; `npm run check`.
- Dependencies: Slices 1 and 2.

### Slice 4: Lead through an adapter

Status: `[ ]` Not started

- Goal: the Lead agent kind is configuration, not a literal.
- Why here: small, and removes the last hardcoded kind.
- This slice should implement:
  - `lead.agent` (profile name, default `claude`) resolved through the registry; `model`, `effort` and `permissionMode` keep their current meaning and defaults.
  - `apply-main.ts` writes the rendered Lead playbook as both `CLAUDE.md` and `AGENTS.md` in the Lead workspace so non-Claude leads pick it up; the wake prompt in `buildLeadWakePrompt` stops naming `CLAUDE.md` specifically.
  - Doctor checks the configured Lead binary on main machines.
- Expected output: default behavior byte-identical for `claude`; other kinds possible.
- Verification: existing `tests/lead-watcher.test.ts` unchanged for the default; new test for a non-default Lead kind; `npm run check`.
- Dependencies: Slice 1.

### Slice 5: Label-based review signals with text fallback

Status: `[ ]` Not started

- Goal: review handoff and verdicts are detected from reply labels.
- Why here: independent of the adapter work; placed after it so prompt changes land once.
- This slice should implement:
  - `labels` declared on `BoardMessageSchema` (normalized with the existing `normalizeLabels`); `BoardClient.reply` accepts labels.
  - Pure detectors in `src/lib/review.ts` (or behind B's stage interface if it exists) that accept labels first, then the text marker, and report which path matched.
  - Prompts updated to instruct the labelled reply form: `renderWorkerPrompt` completion workflow, `prompts/reviewer-prompt.md`, `buildFixRoundPrompt`, `buildIdleReminder`. Keep the final marker line in the instructions as well during the transition.
  - A log line each time the fallback path is the one that matched.
- Expected output: both forms accepted; no change to rounds, escalation or completion behavior.
- Verification: `tests/reviewer.test.ts` extended with label-only, text-only and both-present replies (no double count); existing cases unchanged; a manual task with review enabled on one agent kind; `npm run check`.
- Dependencies: none strictly; coordinate with Plan B Slice 8 if it landed.

### Slice 6: Consume signals from the bus (conditional)

Status: `[ ]` Not started

- Condition: only if Plan B's bus is in place. Otherwise mark this slice as skipped with a note.
- Goal: no thread read is needed to notice a signal.
- This slice should implement:
  - On a `board.message` event in a tracked thread carrying a `swarm.signal` label from the expected profile, feed the signal to the task FSM directly.
  - Keep the thread-read path as the reconcile fallback (it is also what catches text-marker replies).
- Verification: lifecycle test that a labelled reply event advances the phase with zero `read` calls on the fake runner; `npm run check`.
- Dependencies: Slice 5, Plan B Slices 3 and 4.

### Slice 7: Registry heartbeat and TTL

Status: `[ ]` Not started

- Goal: Lead stops routing to machines that are gone, and notices newly installed agent CLIs.
- Why here: independent; grouped last among features because it touches both daemons and the Lead prompt.
- This slice should implement:
  - `board.registryHeartbeatSeconds` (default 300). The dispatcher re-publishes with a fresh `updatedAt` on that cadence even when content is unchanged, and re-detects installed agent kinds at the same time.
  - Registry entry version 2 with `heartbeatSeconds`; parser accepts versions 1 and 2.
  - `mergeRegistryIntoLeadCatalog` takes `nowMs`, marks machines `online`, and omits offline machines from each project's `machines`. A project whose every host is offline stays listed with an empty `machines` array so Lead can say so.
  - `catalogFingerprint` ignores per-machine `updatedAt` so the catalog file is not rewritten on every heartbeat, but does include `online`.
  - `prompts/lead-CLAUDE.md`: do not target offline machines; say so in the thread when no host is online for a project.
  - If Plan B landed, make sure heartbeat edits in the registry channel do not wake Lead.
- Expected output: schema and example updates, registry tests, prompt change.
- Verification: `tests/registry.test.ts` cases for fresh, stale, version 1 and mixed entries; manual check by stopping a worker for longer than three heartbeats (use a short heartbeat in a scratch config) and reading the synced catalog; `npm run check`.
- Dependencies: none strictly.

### Slice 8: Fallback decision, cleanup and docs

Status: `[ ]` Not started

- Goal: no undocumented dual implementation remains.
- This slice should implement:
  - Review the fallback log lines from real use. Record the counts per agent kind under Working Notes.
  - Decide: remove the text-marker fallback (and the marker line from prompts), or keep it permanently and document it as supported. Record the decision in the Decisions section.
  - Update `AGENTS.md` (agent routing section now points at adapters; signal protocol; registry TTL), the README supported-agents table and review section, `docs/worker-machine-setup.md`, `docs/architecture.md`.
- Verification: `npm run check`; docs read against behavior.
- Dependencies: Slices 1–7 as landed, plus enough real usage of Slice 5 to judge.

## Testing Plan

- Slices 1–2: existing tests are the contract; no expectation edits.
- Slices 3–7: pure unit tests per feature as listed, plus the fake-runner lifecycle harness in `tests/dispatcher.test.ts`, `tests/reviewer.test.ts` and `tests/lead-watcher.test.ts`.
- Final manual pass on a `both` machine: one task per installed agent kind with review enabled, confirming the labelled handoff and verdict are detected; one custom templated kind if a suitable CLI is available; registry TTL check.

## Files to Add

- `src/agents/types.ts`, `src/agents/registry.ts`, `src/agents/claude.ts`, `src/agents/agy.ts`, `src/agents/codex.ts`, `src/agents/pi.ts`, `src/agents/generic.ts`
- `tests/agents.test.ts`

## Files to Change

- `src/lib/config.ts`, `src/lib/agent-catalog.ts`, `src/lib/host-env.ts`, `src/lib/schemas.ts`
- `src/dispatcher.ts`, `src/lead-watcher.ts`, `src/lib/lead-events.ts`
- `src/lib/board.ts`, `src/lib/review.ts`, `src/lib/routing.ts`, `src/lib/task-fsm.ts`, `src/lib/registry.ts`
- `scripts/doctor.ts`, `scripts/apply-main.ts`, `scripts/agents.ts`, `scripts/init.ts`
- `prompts/worker-prompt.md`, `prompts/reviewer-prompt.md`, `prompts/lead-CLAUDE.md`
- `config/swarm.schema.json`, `config/swarm.example.json`
- `tests/dispatcher.test.ts`, `tests/agent-catalog.test.ts`, `tests/reviewer.test.ts`, `tests/registry.test.ts`, `tests/lead-watcher.test.ts`
- `AGENTS.md`, `README.md`, `docs/architecture.md`, `docs/worker-machine-setup.md`

## Open Questions

1. What does `herdr agent start --kind <unknown>` do? Its help says "a supported interactive agent", and the socket API has `server.agent_manifests` / `server.reload_agent_manifests`. If Herdr needs a manifest per kind, custom adapters must document or generate one.
2. Do all four agent CLIs reliably follow an instruction to add `--label` flags to a `vercel board reply` command, including when the body comes from a heredoc on stdin? Slice 5's fallback logging answers this.
3. Can a reply's labels be set by any profile, or only its author? If anyone can label, the detector must keep checking the reply's author profile (it does today for text markers).
4. Should a `swarm.round` label be required on verdicts to guard against a stale verdict from an earlier round, or is `phaseSeenReplyIds` sufficient? Default assumption: sufficient.
5. Is a 300-second heartbeat with a 3× TTL the right trade-off between Board write volume and how quickly Lead notices a dead worker?

## Working Notes

- 2026-11-27: Plan written from a code review. The `reply --label` and `label` CLI options and the label character limits were read from CLI help; tail events were observed to carry `message.labels`. No agent was asked to post a labelled reply, and no code has been changed.

## Next Slice

Start with **Slice 1**. First read the Working Notes of Plans A and B. Then read `buildAgentCliArgs`, `BUILTIN_AGENT_PROFILES`, `resolveWorkerRuntime` and `resolveReviewerConfig` in `src/lib/config.ts`, and the argument assertions in `tests/dispatcher.test.ts` ("config & worker agent selection"). Move each `if/else` branch into its adapter verbatim. Verification is those two test files passing with no expectation edits, then `npm run check`. No blockers.
