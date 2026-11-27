import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { TailChild } from "../../src/bus/board-tail-source.ts";
import type { TimerHandle, Timers } from "../../src/bus/timers.ts";

interface PendingTimer {
  id: number;
  at: number;
  fn: () => void;
}

/** Deterministic timers: nothing runs until `advance()` moves the clock past a deadline. */
export class ManualTimers implements Timers {
  private nowMs: number;
  private nextId = 1;
  private pending: PendingTimer[] = [];

  constructor(startMs = 1_000_000) {
    this.nowMs = startMs;
  }

  now(): number {
    return this.nowMs;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const timer = { id: this.nextId++, at: this.nowMs + Math.max(0, ms), fn };
    this.pending.push(timer);
    return timer.id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.pending = this.pending.filter((t) => t.id !== handle);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Delays of pending timers relative to now, sorted ascending. */
  pendingDelays(): number[] {
    return this.pending.map((t) => t.at - this.nowMs).toSorted((a, b) => a - b);
  }

  /** Moves the clock forward, firing due timers in deadline order (including ones they schedule). */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const due = this.pending
        .filter((t) => t.at <= target)
        .toSorted((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.pending = this.pending.filter((t) => t.id !== due.id);
      this.nowMs = Math.max(this.nowMs, due.at);
      due.fn();
    }
    this.nowMs = target;
  }
}

/** Lets pending promise callbacks run (no timers involved). */
export async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

let fakePid = 40_000;

/** A fake `vercel board tail` child: write NDJSON with `emit()`, end it with `exit()`. */
export class FakeTailChild extends EventEmitter implements TailChild {
  readonly pid = fakePid++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exited = false;

  emitLine(obj: unknown): void {
    this.stdout.write(`${typeof obj === "string" ? obj : JSON.stringify(obj)}\n`);
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }
}

export interface FakeSpawnerRecord {
  cmd: string;
  args: string[];
  child: FakeTailChild;
}

/** Spawner + group killer pair that records calls; killing a live child makes it exit. */
export function createFakeTailProcesses(opts: { exitOnKill?: boolean } = {}): {
  spawns: FakeSpawnerRecord[];
  kills: Array<{ pid: number; signal: NodeJS.Signals }>;
  spawner: (cmd: string, args: string[]) => FakeTailChild;
  killGroup: (pid: number, signal: NodeJS.Signals) => void;
  live: () => FakeTailChild[];
} {
  const spawns: FakeSpawnerRecord[] = [];
  const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  return {
    spawns,
    kills,
    spawner: (cmd, args) => {
      const child = new FakeTailChild();
      spawns.push({ cmd, args, child });
      return child;
    },
    killGroup: (pid, signal) => {
      kills.push({ pid, signal });
      if (opts.exitOnKill === false) return;
      const rec = spawns.find((s) => s.child.pid === pid);
      if (rec && !rec.child.exited) {
        setImmediate(() => rec.child.exit(null, signal));
      }
    },
    live: () => spawns.map((s) => s.child).filter((c) => !c.exited),
  };
}
