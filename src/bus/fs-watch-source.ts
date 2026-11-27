import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { SwarmEvent } from "./events.ts";
import { errorMessage, realTimers, type LogFn, type TimerHandle, type Timers } from "./timers.ts";

export type DirWatcher = (
  dir: string,
  listener: (eventType: string, filename: string | null) => void,
) => Pick<FSWatcher, "close" | "on">;

const defaultDirWatcher: DirWatcher = (dir, listener) =>
  watch(dir, { persistent: false }, (eventType, filename) =>
    listener(eventType, filename === null ? null : String(filename)),
  );

/**
 * Emits `fs.changed` for a set of files. It watches each file's directory, not the file, so an
 * atomic replace (write temp + rename) is still seen. Events are debounced per file. A watch
 * failure is logged and ignored: callers keep their own change check (for example an mtime
 * comparison), so a missed event only costs latency.
 */
export class FsWatchSource {
  private readonly files: string[];
  private readonly onEvent: (event: SwarmEvent) => void;
  private readonly watchDir: DirWatcher;
  private readonly timers: Timers;
  private readonly log: LogFn;
  private readonly debounceMs: number;
  private watchers: Array<Pick<FSWatcher, "close">> = [];
  private readonly debounce = new Map<string, TimerHandle>();

  constructor(opts: {
    files: string[];
    onEvent: (event: SwarmEvent) => void;
    watchDir?: DirWatcher;
    timers?: Timers;
    log?: LogFn;
    debounceMs?: number;
  }) {
    this.files = [...new Set(opts.files.map((f) => resolve(f)))];
    this.onEvent = opts.onEvent;
    this.watchDir = opts.watchDir ?? defaultDirWatcher;
    this.timers = opts.timers ?? realTimers;
    this.log = opts.log ?? (() => {});
    this.debounceMs = opts.debounceMs ?? 200;
  }

  start(): void {
    const byDir = new Map<string, string[]>();
    for (const file of this.files) {
      const dir = dirname(file);
      byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
    }
    for (const [dir, files] of byDir) {
      const names = new Map(files.map((f) => [basename(f), f]));
      try {
        const watcher = this.watchDir(dir, (_type, filename) => {
          const file = filename ? names.get(basename(filename)) : undefined;
          if (file) this.bump(file);
        });
        watcher.on("error", (err: Error) => {
          this.log(
            "WARN",
            `File watch on ${dir} failed (${errorMessage(err)}); relying on polling.`,
          );
        });
        this.watchers.push(watcher);
      } catch (err) {
        this.log("WARN", `Could not watch ${dir} (${errorMessage(err)}); relying on polling.`);
      }
    }
  }

  stop(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // Already closed
      }
    }
    this.watchers = [];
    for (const t of this.debounce.values()) this.timers.clearTimeout(t);
    this.debounce.clear();
  }

  private bump(file: string): void {
    const existing = this.debounce.get(file);
    if (existing !== undefined) this.timers.clearTimeout(existing);
    this.debounce.set(
      file,
      this.timers.setTimeout(() => {
        this.debounce.delete(file);
        this.onEvent({ kind: "fs.changed", path: file });
      }, this.debounceMs),
    );
  }
}
