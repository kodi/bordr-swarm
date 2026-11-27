import type { LeadWakeEvent } from "../lib/lead-events.ts";
import type { SwarmEvent } from "./events.ts";
import { errorMessage, type LogFn } from "./timers.ts";

/** Declarative side effects a reactor asks its daemon to perform. */
export type ReactorEffect =
  /** Run a reconcile tick soon (debounced). */
  | { type: "wake"; reason: string }
  /** Queue a wake event for an ephemeral per-thread Lead session. */
  | { type: "lead_event"; event: LeadWakeEvent }
  /** Add a reaction as the daemon's profile (Lead's 👀). */
  | { type: "react"; messageId: string; emoji: string; threadId: string }
  /** Re-merge `#swarm/registry` into Lead's projects catalog. */
  | { type: "registry_sync" }
  /** `projects.json` may have changed: re-check it on the next tick. */
  | { type: "projects_reload" }
  /** Run a configured local command (argv from local config only) with the event JSON on stdin. */
  | {
      type: "run_command";
      command: string[];
      timeoutMs: number;
      stdin: string;
      /** Minimum gap between two runs of the same reactor. */
      cooldownMs: number;
    }
  /** Post a configured message. */
  | { type: "post"; channel: string; text: string; asProfile: string; cooldownMs: number };

export type ReactorEffectType = ReactorEffect["type"];

/**
 * A named "when X, do Y" rule. Both functions are pure; configuration is bound when the reactor
 * is created, and `ctx` carries only the daemon's current, read-only view (tracked IDs, ...).
 */
export interface Reactor<Ctx = unknown> {
  readonly name: string;
  matches(event: SwarmEvent): boolean;
  react(event: SwarmEvent, ctx: Ctx): ReactorEffect[];
}

export interface CollectedEffect {
  reactor: string;
  effect: ReactorEffect;
}

/** Runs every matching reactor for an event, isolating a throwing reactor from the others. */
export class ReactorRegistry<Ctx> {
  private readonly reactors: Reactor<Ctx>[];
  private readonly log: LogFn;

  constructor(reactors: Reactor<Ctx>[], log: LogFn = () => {}) {
    const names = new Set<string>();
    for (const r of reactors) {
      if (names.has(r.name)) throw new Error(`Duplicate reactor name "${r.name}"`);
      names.add(r.name);
    }
    this.reactors = reactors;
    this.log = log;
  }

  get names(): string[] {
    return this.reactors.map((r) => r.name);
  }

  /** True if at least one reactor is interested in the event (no effects computed). */
  matchesAny(event: SwarmEvent): boolean {
    return this.reactors.some((r) => this.safeMatches(r, event));
  }

  /** Effects of every matching reactor; `only` restricts which reactors run (by name). */
  collect(event: SwarmEvent, ctx: Ctx, only?: (name: string) => boolean): CollectedEffect[] {
    const out: CollectedEffect[] = [];
    for (const reactor of this.reactors) {
      if (only && !only(reactor.name)) continue;
      if (!this.safeMatches(reactor, event)) continue;
      try {
        for (const effect of reactor.react(event, ctx)) out.push({ reactor: reactor.name, effect });
      } catch (err) {
        this.log("WARN", `Reactor "${reactor.name}" failed on ${event.kind}: ${errorMessage(err)}`);
      }
    }
    return out;
  }

  private safeMatches(reactor: Reactor<Ctx>, event: SwarmEvent): boolean {
    try {
      return reactor.matches(event);
    } catch (err) {
      this.log(
        "WARN",
        `Reactor "${reactor.name}" matches() failed on ${event.kind}: ${errorMessage(err)}`,
      );
      return false;
    }
  }
}

export type EffectHandlers = {
  [K in ReactorEffectType]?: (
    effect: Extract<ReactorEffect, { type: K }>,
    reactor: string,
  ) => unknown;
};

/**
 * Thin executor: runs each effect through the daemon's handler for its type. A failing effect is
 * logged and never stops the rest; an effect type the daemon does not handle is logged once.
 */
export async function executeEffects(
  effects: readonly CollectedEffect[],
  handlers: EffectHandlers,
  log: LogFn,
): Promise<void> {
  for (const { reactor, effect } of effects) {
    const handler = handlers[effect.type] as
      | ((effect: ReactorEffect, reactor: string) => unknown)
      | undefined;
    if (!handler) {
      log(
        "WARN",
        `Reactor "${reactor}" produced a "${effect.type}" effect this daemon does not run.`,
      );
      continue;
    }
    try {
      await handler(effect, reactor);
    } catch (err) {
      log("WARN", `Reactor "${reactor}" effect "${effect.type}" failed: ${errorMessage(err)}`);
    }
  }
}

/** Startup log line listing registered reactors. */
export function describeReactors(daemon: string, names: readonly string[]): string {
  return `${daemon} reactors: ${names.length > 0 ? names.join(", ") : "(none)"}.`;
}
