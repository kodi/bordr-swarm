import { resolve } from "node:path";
import { threadRootId, type SwarmEvent } from "../bus/events.ts";
import type { Reactor } from "../bus/reactor.ts";
import { assertNever } from "../lib/session-fsm.ts";

export interface DispatcherWakeContext {
  trackedTaskIds: ReadonlySet<string>;
  trackedPaneIds: ReadonlySet<string>;
  trackedTabIds: ReadonlySet<string>;
}

/** Task ops on untracked tasks that can make new work claimable. */
const CLAIMABLE_OPS = new Set(["created", "ready", "unblocked", "released", "expired", "other"]);

/**
 * Pure: does this event warrant an immediate dispatcher reconcile? The reconcile itself stays
 * level-triggered (it re-lists tasks and agents), so a false positive costs one tick and a miss
 * costs latency until the next periodic reconcile.
 */
export function shouldWakeDispatcher(
  event: SwarmEvent,
  ctx: DispatcherWakeContext & { projectChannelPrefix: string },
): boolean {
  switch (event.kind) {
    case "board.task": {
      if (ctx.trackedTaskIds.has(event.task.id)) return true;
      const inScope =
        !ctx.projectChannelPrefix || event.task.channel.startsWith(ctx.projectChannelPrefix);
      return inScope && CLAIMABLE_OPS.has(event.op);
    }
    case "board.message":
      // Replies on tracked task threads (review handoff, verdicts).
      return ctx.trackedTaskIds.has(threadRootId(event.message));
    case "herdr.agent_status":
    case "herdr.pane_exited":
    case "herdr.pane_closed":
      return ctx.trackedPaneIds.has(event.paneId);
    case "herdr.tab_closed":
      return ctx.trackedTabIds.has(event.tabId);
    case "fs.changed":
    case "board.reaction":
    case "board.other":
    case "timer.reconcile":
    case "source.health":
      return false;
    default:
      return assertNever(event);
  }
}

/** `dispatcher-wake`: Board and Herdr activity that concerns this dispatcher wakes it. */
export function createDispatcherWakeReactor(config: {
  projectChannelPrefix: string;
}): Reactor<DispatcherWakeContext> {
  return {
    name: "dispatcher-wake",
    matches: (event) =>
      event.kind === "board.task" ||
      event.kind === "board.message" ||
      event.kind === "herdr.agent_status" ||
      event.kind === "herdr.pane_exited" ||
      event.kind === "herdr.pane_closed" ||
      event.kind === "herdr.tab_closed",
    react: (event, ctx) =>
      shouldWakeDispatcher(event, { ...ctx, projectChannelPrefix: config.projectChannelPrefix })
        ? [{ type: "wake", reason: event.kind }]
        : [],
  };
}

/** `projects-reload`: a change to `projects.json` is re-checked on the next tick. */
export function createProjectsReloadReactor(config: {
  projectsConfigPath: string | null;
}): Reactor<unknown> {
  const target = config.projectsConfigPath ? resolve(config.projectsConfigPath) : null;
  return {
    name: "projects-reload",
    matches: (event) =>
      event.kind === "fs.changed" && target !== null && resolve(event.path) === target,
    react: () => [{ type: "projects_reload" }],
  };
}
