import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  PersistedDispatcherStateSchema,
  type PersistedActiveTask,
  type PersistedDispatcherState,
  type PersistedParkedTab,
} from "./schemas.ts";
import type { ActiveTask, ParkedTab } from "./task-fsm.ts";

export type { PersistedDispatcherState };

export const DISPATCHER_STATE_VERSION = 1;

/** In-memory dispatcher tracking, as held by `SwarmDispatcher`. */
export interface DispatcherTrackedState {
  activeWorkers: ReadonlyMap<string, ActiveTask>;
  parkedTabs: ReadonlyMap<string, ParkedTab>;
}

export interface RestoredDispatcherState {
  activeWorkers: Map<string, ActiveTask>;
  parkedTabs: Map<string, ParkedTab>;
}

export type DispatcherStateLoadResult =
  | { kind: "missing" }
  | { kind: "loaded"; state: RestoredDispatcherState; savedAtMs: number }
  | { kind: "other_machine"; machine: string }
  | { kind: "quarantined"; quarantinePath: string; error: string };

/**
 * Default location: `~/.local/state/bordr-swarm/dispatcher-<machine>.json`, overridable with
 * `DISPATCHER_STATE_PATH` (mirrors Lead Watcher's `LEAD_WATCHER_STATE_PATH`).
 */
export function resolveDispatcherStatePath(
  machineName: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const override = env.DISPATCHER_STATE_PATH?.trim();
  if (override) return resolve(override);
  return resolve(home, ".local/state/bordr-swarm", `dispatcher-${machineName}.json`);
}

function activeToPersisted(task: ActiveTask): PersistedActiveTask {
  return {
    ctx: task.ctx,
    phase: task.phase,
    lastLeaseRenewMs: task.lastLeaseRenewMs,
    phaseSeenReplyIds: [...task.phaseSeenReplyIds].sort(),
    lastImplSummary: task.lastImplSummary,
  };
}

function activeFromPersisted(task: PersistedActiveTask): ActiveTask {
  return {
    ctx: task.ctx,
    phase: task.phase,
    lastLeaseRenewMs: task.lastLeaseRenewMs,
    phaseSeenReplyIds: new Set(task.phaseSeenReplyIds),
    lastImplSummary: task.lastImplSummary,
  };
}

function parkedToPersisted(parked: ParkedTab): PersistedParkedTab {
  return { ...parked, task: activeToPersisted(parked.task) };
}

function parkedFromPersisted(parked: PersistedParkedTab): ParkedTab {
  return { ...parked, task: activeFromPersisted(parked.task) };
}

/** Pure: in-memory tracking -> versioned, JSON-safe snapshot. */
export function toPersisted(
  tracked: DispatcherTrackedState,
  machine: string,
  savedAtMs: number,
): PersistedDispatcherState {
  const activeWorkers: Record<string, PersistedActiveTask> = {};
  for (const id of [...tracked.activeWorkers.keys()].sort()) {
    activeWorkers[id] = activeToPersisted(tracked.activeWorkers.get(id)!);
  }
  const parkedTabs: Record<string, PersistedParkedTab> = {};
  for (const id of [...tracked.parkedTabs.keys()].sort()) {
    parkedTabs[id] = parkedToPersisted(tracked.parkedTabs.get(id)!);
  }
  return { version: DISPATCHER_STATE_VERSION, machine, savedAtMs, activeWorkers, parkedTabs };
}

/** Pure: versioned snapshot -> in-memory tracking maps. */
export function fromPersisted(state: PersistedDispatcherState): RestoredDispatcherState {
  const activeWorkers = new Map<string, ActiveTask>();
  for (const [id, task] of Object.entries(state.activeWorkers)) {
    activeWorkers.set(id, activeFromPersisted(task));
  }
  const parkedTabs = new Map<string, ParkedTab>();
  for (const [id, parked] of Object.entries(state.parkedTabs)) {
    parkedTabs.set(id, parkedFromPersisted(parked));
  }
  return { activeWorkers, parkedTabs };
}

/**
 * Stable string of everything except `savedAtMs`, so callers can skip writes when nothing changed.
 */
export function dispatcherStateFingerprint(
  tracked: DispatcherTrackedState,
  machine: string,
): string {
  const { savedAtMs: _savedAtMs, ...rest } = toPersisted(tracked, machine, 0);
  return JSON.stringify(rest);
}

function quarantine(path: string, nowMs: number, error: string): DispatcherStateLoadResult {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  const quarantinePath = `${path}.corrupt-${stamp}`;
  renameSync(path, quarantinePath);
  return { kind: "quarantined", quarantinePath, error };
}

/**
 * Loads and validates the state file. Never closes tabs or touches tasks: an invalid file is
 * renamed to `*.corrupt-<timestamp>` and the caller starts empty (the orphan sweep recovers).
 */
export function loadDispatcherState(
  path: string,
  opts: { machine: string; nowMs?: number },
): DispatcherStateLoadResult {
  if (!existsSync(path)) return { kind: "missing" };
  const nowMs = opts.nowMs ?? Date.now();

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return quarantine(
      path,
      nowMs,
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = PersistedDispatcherStateSchema.safeParse(raw);
  if (!parsed.success) {
    return quarantine(path, nowMs, z.prettifyError(parsed.error));
  }
  if (parsed.data.machine !== opts.machine) {
    return { kind: "other_machine", machine: parsed.data.machine };
  }
  return { kind: "loaded", state: fromPersisted(parsed.data), savedAtMs: parsed.data.savedAtMs };
}

/** Atomic write: temp file in the same directory, then `rename` over the target. */
export function saveDispatcherState(path: string, state: PersistedDispatcherState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmpPath, path);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}
