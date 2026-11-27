import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { messageLabels, threadRootId, type SwarmEvent } from "../bus/events.ts";
import type { EffectHandlers, Reactor, ReactorEffect } from "../bus/reactor.ts";
import type { LogFn } from "../bus/timers.ts";
import type { BoardClient } from "../lib/board.ts";
import { getMessageAuthorLabel, isAuthoredByProfile } from "../lib/lead-events.ts";
import type { ConfiguredReactor, ReactorEventSelector } from "../lib/schemas.ts";

/** The Board event type of an event (`message.posted`, `task.blocked`, ...), or null. */
export function eventSelectorOf(event: SwarmEvent): string | null {
  switch (event.kind) {
    case "board.message":
      return `message.${event.op}`;
    case "board.task":
      return event.type;
    case "board.reaction":
      return `reaction.${event.op}`;
    default:
      return null;
  }
}

export function selectorMatches(selector: ReactorEventSelector, eventType: string): boolean {
  if (selector.endsWith(".*")) return eventType.startsWith(selector.slice(0, -1));
  return selector === eventType;
}

function eventChannel(event: SwarmEvent): string {
  switch (event.kind) {
    case "board.message":
      return (event.message.channel ?? "").replace(/^#/, "");
    case "board.task":
      return event.task.channel.replace(/^#/, "");
    case "board.reaction":
      return event.channel.replace(/^#/, "");
    default:
      return "";
  }
}

function eventLabels(event: SwarmEvent): Record<string, string> {
  if (event.kind === "board.message") return messageLabels(event.message);
  if (event.kind === "board.task") return event.task.labels;
  return {};
}

export function channelMatches(filter: string, channel: string): boolean {
  const clean = filter.replace(/^#/, "");
  return clean.endsWith("/") ? channel.startsWith(clean) : channel === clean;
}

/** Board profile a `post` reactor writes as (also the profile it never reacts to). */
export function reactorProfile(cfg: ConfiguredReactor): string {
  return "post" in cfg.run && cfg.run.post.profile ? cfg.run.post.profile : `reactor-${cfg.name}`;
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

/** Values available to `{placeholder}`s in a `post` reactor's text. */
export function eventPlaceholders(event: SwarmEvent): Record<string, string> {
  const base = { type: eventSelectorOf(event) ?? event.kind, channel: eventChannel(event) };
  switch (event.kind) {
    case "board.message":
      return {
        ...base,
        id: event.message.id,
        thread: threadRootId(event.message),
        author: getMessageAuthorLabel(event.message),
        state: "",
        text: truncate(event.message.text, 300),
      };
    case "board.task":
      return {
        ...base,
        id: event.task.id,
        thread: event.task.id,
        author: event.task.assignee ?? "",
        state: event.task.state,
        text: truncate(event.task.text, 300),
      };
    case "board.reaction":
      return { ...base, id: event.messageId, thread: "", author: "", state: "", text: event.emoji };
    default:
      return { ...base, id: "", thread: "", author: "", state: "", text: "" };
  }
}

/** Replaces known `{name}` placeholders; unknown ones are left as written. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, key: string) =>
    Object.hasOwn(values, key) ? (values[key] ?? "") : whole,
  );
}

/**
 * Pure reactor for one configured rule. Loop prevention: it never fires on a message authored
 * by its own posting profile (the cooldown in the executor covers anything else).
 */
export function createConfiguredReactor(cfg: ConfiguredReactor): Reactor<unknown> {
  const selectors = Array.isArray(cfg.on) ? cfg.on : [cfg.on];
  const ownProfile = reactorProfile(cfg);
  const cooldownMs = cfg.cooldownSeconds * 1000;
  return {
    name: `config:${cfg.name}`,
    matches: (event) => {
      const type = eventSelectorOf(event);
      if (!cfg.enabled || !type || !selectors.some((sel) => selectorMatches(sel, type))) {
        return false;
      }
      if (cfg.match?.channel && !channelMatches(cfg.match.channel, eventChannel(event))) {
        return false;
      }
      if (cfg.match?.labels) {
        const labels = eventLabels(event);
        for (const [k, v] of Object.entries(cfg.match.labels)) {
          if (labels[k] !== v) return false;
        }
      }
      if (event.kind === "board.message" && isAuthoredByProfile(event.message, ownProfile)) {
        return false;
      }
      return true;
    },
    react: (event): ReactorEffect[] => {
      if ("command" in cfg.run) {
        return [
          {
            type: "run_command",
            command: [...cfg.run.command],
            timeoutMs: cfg.run.timeoutSeconds * 1000,
            stdin: `${JSON.stringify(event)}\n`,
            cooldownMs,
          },
        ];
      }
      return [
        {
          type: "post",
          channel: cfg.run.post.channel.replace(/^#/, ""),
          text: renderTemplate(cfg.run.post.text, eventPlaceholders(event)),
          asProfile: ownProfile,
          cooldownMs,
        },
      ];
    },
  };
}

/** Configured reactors for one daemon (`runOn`), skipping disabled ones. */
export function createConfiguredReactors(
  configs: readonly ConfiguredReactor[] | undefined,
  runOn: ConfiguredReactor["runOn"],
): Array<Reactor<unknown>> {
  return (configs ?? [])
    .filter((c) => c.enabled && c.runOn === runOn)
    .map((c) => createConfiguredReactor(c));
}

/** Per-reactor cooldown: at most one run per `cooldownMs`. */
export class CooldownGate {
  private readonly lastRunMs = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** True (and records the run) if the reactor may run now. */
  tryAcquire(reactor: string, cooldownMs: number): boolean {
    const nowMs = this.now();
    const last = this.lastRunMs.get(reactor);
    if (last !== undefined && nowMs - last < cooldownMs) return false;
    this.lastRunMs.set(reactor, nowMs);
    return true;
  }
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CommandRunner = (
  argv: readonly string[],
  opts: { stdin: string; timeoutMs: number },
) => Promise<CommandResult>;

/** Runs argv without a shell, writing `stdin` and killing the process after `timeoutMs`. */
export const defaultCommandRunner: CommandRunner = (argv, opts) =>
  new Promise((resolveRun, rejectRun) => {
    const [cmd, ...args] = argv;
    if (!cmd) {
      rejectRun(new Error("empty command"));
      return;
    }
    const child = spawn(cmd, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout = `${stdout}${d}`.slice(-4_000)));
    child.stderr.on("data", (d: Buffer) => (stderr = `${stderr}${d}`.slice(-4_000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin);
  });

/**
 * Handlers for configured-reactor effects (`run_command`, `post`), shared by both daemons. Each
 * run first passes the reactor's cooldown; in dry-run mode nothing is executed.
 */
export function createConfiguredEffectHandlers(deps: {
  board: Pick<BoardClient, "postMessage">;
  log: LogFn;
  dryRun?: boolean;
  runner?: CommandRunner;
  cooldown?: CooldownGate;
}): EffectHandlers {
  const runner = deps.runner ?? defaultCommandRunner;
  const cooldown = deps.cooldown ?? new CooldownGate();
  const skipCooldown = (reactor: string, cooldownMs: number): boolean => {
    if (cooldown.tryAcquire(reactor, cooldownMs)) return false;
    deps.log(
      "INFO",
      `Reactor "${reactor}" skipped: still in its ${Math.round(cooldownMs / 1000)}s cooldown.`,
    );
    return true;
  };
  return {
    run_command: async (effect, reactor) => {
      if (skipCooldown(reactor, effect.cooldownMs)) return;
      if (deps.dryRun) {
        deps.log(
          "INFO",
          `[dry-run] Reactor "${reactor}" would run ${JSON.stringify(effect.command)}.`,
        );
        return;
      }
      const res = await runner(effect.command, {
        stdin: effect.stdin,
        timeoutMs: effect.timeoutMs,
      });
      const tail = (res.stderr || res.stdout).trim().split("\n").slice(-1)[0] ?? "";
      if (res.timedOut || res.code !== 0) {
        deps.log(
          "WARN",
          `Reactor "${reactor}" command ${JSON.stringify(effect.command[0])} ${res.timedOut ? `timed out after ${Math.round(effect.timeoutMs / 1000)}s` : `exited ${res.code}`}${tail ? `: ${tail.slice(0, 200)}` : ""}`,
        );
      } else {
        deps.log("INFO", `Reactor "${reactor}" ran ${JSON.stringify(effect.command[0])}.`);
      }
    },
    post: async (effect, reactor) => {
      if (skipCooldown(reactor, effect.cooldownMs)) return;
      if (deps.dryRun) {
        deps.log(
          "INFO",
          `[dry-run] Reactor "${reactor}" would post to #${effect.channel}: ${effect.text}`,
        );
        return;
      }
      await deps.board.postMessage(effect.channel, effect.text, { asProfile: effect.asProfile });
      deps.log("INFO", `Reactor "${reactor}" posted to #${effect.channel} as ${effect.asProfile}.`);
    },
  };
}

/** Finds an executable on PATH (or checks an absolute/relative path). */
function commandExists(cmd: string, env: NodeJS.ProcessEnv): boolean {
  if (isAbsolute(cmd) || cmd.includes("/")) return existsSync(cmd);
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, cmd))) return true;
  }
  return false;
}

/** Doctor checks for configured reactors: command availability and per-daemon caveats. */
export function validateConfiguredReactors(
  configs: readonly ConfiguredReactor[] | undefined,
  opts: { projectChannelPrefix: string; env?: NodeJS.ProcessEnv },
): { errors: string[]; warnings: string[]; summary: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];
  const env = opts.env ?? process.env;
  for (const cfg of configs ?? []) {
    const on = (Array.isArray(cfg.on) ? cfg.on : [cfg.on]).join("|");
    const action =
      "command" in cfg.run ? `command ${cfg.run.command[0]}` : `post #${cfg.run.post.channel}`;
    summary.push(
      `${cfg.name}${cfg.enabled ? "" : " (disabled)"}: on ${on} → ${action} [${cfg.runOn}]`,
    );
    if ("command" in cfg.run && !commandExists(cfg.run.command[0]!, env)) {
      errors.push(`reactor "${cfg.name}": command "${cfg.run.command[0]}" not found on PATH`);
    }
    if (
      cfg.runOn === "dispatcher" &&
      cfg.match?.channel &&
      !cfg.match.channel.replace(/^#/, "").startsWith(opts.projectChannelPrefix)
    ) {
      warnings.push(
        `reactor "${cfg.name}": runOn "dispatcher" only sees ${opts.projectChannelPrefix}* events, so channel "${cfg.match.channel}" never matches`,
      );
    }
    if ("post" in cfg.run && cfg.cooldownSeconds === 0) {
      warnings.push(`reactor "${cfg.name}": a post reactor without a cooldown can flood a channel`);
    }
  }
  return { errors, warnings, summary };
}
