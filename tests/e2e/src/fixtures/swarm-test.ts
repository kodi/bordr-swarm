import { resolve } from "node:path";
import { test as composeTest } from "vitecompose";
import { runChecked, waitFor, type ComposeClient } from "vitecompose/core";
import { inject } from "vitest";
import type { SwarmE2eConfig } from "../../compose.setup.ts";

export type E2eTaskSnapshot = {
  id: string;
  channel: string;
  state: string;
  text: string;
  assignee?: string;
  replies: Array<{ id: string; text: string; profile?: string | null }>;
};

export type SwarmFixture = {
  config: SwarmE2eConfig;
  vb: (
    args: readonly string[],
    opts?: { asProfile?: string; timeoutMs?: number },
  ) => Promise<string>;
  vbJson: <T = Record<string, unknown>>(
    args: readonly string[],
    opts?: { asProfile?: string; timeoutMs?: number },
  ) => Promise<T>;
  createTask: (
    channel: string,
    text: string,
    opts?: { labels?: readonly string[]; asProfile?: string },
  ) => Promise<{ id: string }>;
  readTask: (taskId: string) => Promise<E2eTaskSnapshot>;
  waitForTaskState: (
    taskId: string,
    expected: string | readonly string[],
    opts?: { timeoutMs?: number },
  ) => Promise<E2eTaskSnapshot>;
  listWorkerTabs: (
    worker: "worker-1" | "worker-2",
  ) => Promise<Array<{ tab_id: string; label: string }>>;
  listWorkerAgents: (
    worker: "worker-1" | "worker-2",
  ) => Promise<Array<{ name?: string; agent_status: string; tab_id?: string }>>;
  readDispatcherState: (worker: "worker-1" | "worker-2") => Promise<Record<string, unknown> | null>;
};

const VB_BIN = resolve(import.meta.dirname, "../../node_modules/.bin/vb");

function parseTaskSnapshot(raw: Record<string, unknown>): E2eTaskSnapshot {
  const msg = (raw.message ?? raw) as Record<string, unknown>;
  const taskMeta = (msg.task ?? {}) as Record<string, unknown>;
  const claim = (taskMeta.claim ?? {}) as Record<string, unknown>;
  const rawReplies = Array.isArray(raw.replies)
    ? (raw.replies as Array<Record<string, unknown>>)
    : [];

  const assignee =
    typeof claim.profile === "string"
      ? claim.profile
      : typeof claim.actor === "string"
        ? claim.actor
        : typeof claim.by === "string"
          ? claim.by
          : undefined;

  return {
    id: String(msg.id ?? ""),
    channel: String(msg.channel ?? ""),
    state: String(taskMeta.state ?? "unknown").toLowerCase(),
    text: String(msg.text ?? ""),
    assignee,
    replies: rawReplies.map((r) => {
      const by = (r.by ?? {}) as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        text: String(r.text ?? ""),
        profile: typeof by.profile === "string" ? by.profile : null,
      };
    }),
  };
}

async function resetSwarmEnvironment(
  compose: ComposeClient,
  config: SwarmE2eConfig,
): Promise<void> {
  // Wipe in-memory Board state.
  const res = await fetch(`${config.boardOrigin}/__test/reset`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to reset board server: HTTP ${res.status}`);
  }

  // Clear persisted dispatcher state and reset scratch repos on both workers, then restart them cleanly.
  for (const worker of ["worker-1", "worker-2"] as const) {
    await compose.exec(worker, [
      "sh",
      "-c",
      [
        `rm -f /var/lib/swarm/dispatcher-${worker}.json /var/lib/swarm/dispatcher-${worker}.json.*`,
        "rm -rf /root/.config/herdr/session.json /root/.config/herdr/session-snapshots",
        "cd /var/lib/swarm/repos/demo-app && git checkout --force main >/dev/null 2>&1 || true",
        'cd /var/lib/swarm/repos/demo-app && git reset --hard "$(git rev-list --max-parents=0 HEAD | tail -n 1)" >/dev/null 2>&1 || true',
        "cd /var/lib/swarm/repos/demo-app && git clean -fd >/dev/null 2>&1 || true",
      ].join(" && "),
    ]);
  }
  await compose.restart(["worker-1", "worker-2"]);
  await Promise.all([
    compose.waitForHealthy("worker-1", { timeoutMs: 30_000 }),
    compose.waitForHealthy("worker-2", { timeoutMs: 30_000 }),
  ]);
}

export const test = composeTest.extend(
  "swarm",
  async ({ compose, fileCompose, evidence, signal }) => {
    const config = inject("swarmE2e");
    evidence.markSensitive(config.boardToken);
    evidence.watchServices({ services: ["board", "worker-1", "worker-2"], tailLines: 120 });

    await resetSwarmEnvironment(fileCompose, config);

    const runVb = async (
      args: readonly string[],
      opts?: { asProfile?: string; timeoutMs?: number; unsignaled?: boolean },
    ): Promise<string> => {
      const fullArgs = [...args, "--url", config.boardUrl];
      if (opts?.asProfile) {
        fullArgs.push("--as", opts.asProfile);
      }
      const result = await runChecked(VB_BIN, fullArgs, {
        env: { ...process.env, BOARD_URL: config.boardUrl, BOARD_TOKEN: config.boardToken },
        timeoutMs: opts?.timeoutMs ?? 30_000,
        signal: opts?.unsignaled ? undefined : signal,
      });
      return result.stdout;
    };

    const vbJson = async <T = Record<string, unknown>>(
      args: readonly string[],
      opts?: { asProfile?: string; timeoutMs?: number; unsignaled?: boolean },
    ): Promise<T> => {
      const stdout = await runVb([...args, "--json"], opts);
      return JSON.parse(stdout.trim()) as T;
    };

    evidence.add("board tasks snapshot", async () => {
      try {
        return await runVb(["tasks", "projects/", "--state", "all", "--json"], {
          unsignaled: true,
        });
      } catch (error) {
        return `could not list tasks: ${String(error)}`;
      }
    });

    const readTask = async (taskId: string): Promise<E2eTaskSnapshot> => {
      const raw = await vbJson<Record<string, unknown>>(["read", taskId]);
      return parseTaskSnapshot(raw);
    };

    const swarm: SwarmFixture = {
      config,
      vb: (args, opts) => runVb(args, opts),
      vbJson: (args, opts) => vbJson(args, opts),
      createTask: async (channel, text, opts) => {
        const args = ["tasks", "create", channel, text];
        for (const label of opts?.labels ?? []) {
          args.push("--label", label);
        }
        const raw = await vbJson<Record<string, unknown>>(args, { asProfile: opts?.asProfile });
        const msg = (raw.task ?? raw.message ?? raw) as Record<string, unknown>;
        const id = String(msg.id ?? "");
        if (!id) {
          throw new Error(`Unexpected tasks create response: ${JSON.stringify(raw)}`);
        }
        return { id };
      },
      readTask,
      waitForTaskState: async (taskId, expected, opts) => {
        const allowed = new Set(Array.isArray(expected) ? expected : [expected]);
        const terminal = new Set(["completed", "failed", "canceled"]);
        return waitFor(
          () => readTask(taskId),
          (task) => {
            if (allowed.has(task.state)) return true;
            if (terminal.has(task.state)) {
              throw new Error(
                `Task ${taskId} reached unexpected terminal state "${task.state}" while waiting for [${[...allowed].join(", ")}]`,
              );
            }
            return false;
          },
          {
            timeoutMs: opts?.timeoutMs ?? 60_000,
            intervalMs: 750,
            signal,
            describe: `task ${taskId} to reach state [${[...allowed].join(", ")}]`,
            summarize: (task) => ({
              id: task.id,
              state: task.state,
              assignee: task.assignee,
              replies: task.replies.length,
            }),
          },
        );
      },
      listWorkerTabs: async (worker) => {
        const res = await compose.exec(worker, ["herdr", "tab", "list"]);
        if (res.status !== 0) {
          throw new Error(`herdr tab list failed on ${worker}: ${res.stderr}`);
        }
        const parsed = JSON.parse(res.stdout) as {
          result?: { tabs?: Array<{ tab_id: string; label: string }> };
        };
        return parsed.result?.tabs ?? [];
      },
      listWorkerAgents: async (worker) => {
        const res = await compose.exec(worker, ["herdr", "agent", "list"]);
        if (res.status !== 0) {
          throw new Error(`herdr agent list failed on ${worker}: ${res.stderr}`);
        }
        const parsed = JSON.parse(res.stdout) as {
          result?: { agents?: Array<{ name?: string; agent_status: string; tab_id?: string }> };
        };
        return parsed.result?.agents ?? [];
      },
      readDispatcherState: async (worker) => {
        const res = await compose.exec(worker, [
          "sh",
          "-c",
          `cat /var/lib/swarm/dispatcher-${worker}.json 2>/dev/null || true`,
        ]);
        const trimmed = res.stdout.trim();
        return trimmed ? (JSON.parse(trimmed) as Record<string, unknown>) : null;
      },
    };

    return swarm;
  },
);
