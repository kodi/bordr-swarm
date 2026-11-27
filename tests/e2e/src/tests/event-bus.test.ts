import { waitFor } from "vitecompose/core";
import { expect } from "vitest";
import { shortTaskId, test, type WorkerName } from "../fixtures/swarm-test.ts";

const SWARM_JSON = "/var/lib/swarm/config/swarm.json";

/** Rewrites the worker's swarm.json intervals (the next dispatcher start picks them up). */
async function setIntervals(
  exec: (worker: WorkerName, cmd: string[]) => Promise<{ status: number | null; stderr: string }>,
  worker: WorkerName,
  pollSeconds: number,
  reconcileSeconds: number,
): Promise<void> {
  const script = [
    "const fs=require('fs');",
    `const p=${JSON.stringify(SWARM_JSON)};`,
    "const c=JSON.parse(fs.readFileSync(p,'utf8'));",
    `c.workerDefaults.pollIntervalSeconds=${pollSeconds};`,
    `c.workerDefaults.reconcileIntervalSeconds=${reconcileSeconds};`,
    "fs.writeFileSync(p,JSON.stringify(c,null,2));",
  ].join("");
  const res = await exec(worker, ["node", "-e", script]);
  if (res.status !== 0) throw new Error(`could not rewrite ${SWARM_JSON}: ${res.stderr}`);
}

async function tailProcesses(
  exec: (worker: WorkerName, cmd: string[]) => Promise<{ stdout: string }>,
  worker: WorkerName,
): Promise<string> {
  // `[t]ail` keeps pgrep from matching this shell's own command line.
  const res = await exec(worker, ["sh", "-c", "pgrep -af '[t]ail projects/' || true"]);
  return res.stdout.trim();
}

test("claims a new task from a live Board event and cleans up on its completion event, with polling slowed to 120s", async ({
  compose,
  swarm,
}) => {
  const exec = (w: WorkerName, cmd: string[]) => compose.exec(w, cmd);
  await setIntervals(exec, "worker-1", 120, 120);
  await swarm.restartDispatcher("worker-1");
  await waitFor(
    () => swarm.readDispatcherLog("worker-1"),
    (log) => log.includes("Live events event-driven [board=live, herdr=live]"),
    { timeoutMs: 30_000, intervalMs: 300, describe: "dispatcher reporting both live sources" },
  );
  // Let the startup tick finish so only an event can trigger the next one.
  await waitFor(
    () => swarm.readDispatcherLog("worker-1"),
    (log) => log.includes("periodic reconcile every 120s"),
    { timeoutMs: 10_000, intervalMs: 300, describe: "120s reconcile interval in effect" },
  );

  const startedAt = Date.now();
  const { id } = await swarm.createTask(
    "projects/demo-app",
    "Event-driven claim [commit:event-bus.txt]",
    {
      labels: ["machine=worker-1"],
    },
  );
  await swarm.waitForTaskState(id, ["claimed", "completed"], { timeoutMs: 20_000 });
  const claimLatencyMs = Date.now() - startedAt;
  // Polling alone would take up to 120s; the event path is a few seconds even on a slow CI box.
  expect(claimLatencyMs).toBeLessThan(20_000);

  await swarm.waitForTaskState(id, "completed", { timeoutMs: 60_000 });
  // The tab closes on the task.completed event, not on the (120s) periodic reconcile.
  const sid = shortTaskId(id);
  await waitFor(
    () => swarm.listWorkerTabs("worker-1"),
    (tabs) => !tabs.some((t) => t.label.includes(sid)),
    { timeoutMs: 30_000, intervalMs: 500, describe: `worker tab for ${sid} auto-closed` },
  );
});

test("falls back to polling when the tail child dies, recovers, and leaves no tail process after stop", async ({
  compose,
  swarm,
}) => {
  const exec = (w: WorkerName, cmd: string[]) => compose.exec(w, cmd);
  await waitFor(
    () => swarm.readDispatcherLog("worker-1"),
    (log) => log.includes("Live events event-driven"),
    { timeoutMs: 30_000, intervalMs: 300, describe: "dispatcher event-driven" },
  );
  expect(await tailProcesses(exec, "worker-1")).not.toBe("");

  // Kill the tail stream out from under the dispatcher.
  await compose.exec("worker-1", ["sh", "-c", "pkill -KILL -f '[t]ail projects/' || true"]);
  await waitFor(
    () => swarm.readDispatcherLog("worker-1"),
    (log) => log.includes("Board event stream down") && log.includes("degraded (polling)"),
    { timeoutMs: 20_000, intervalMs: 300, describe: "dispatcher logging degraded mode" },
  );

  // Work still flows (polling, or the restarted stream).
  const { id } = await swarm.createTask("projects/demo-app", "Degraded-mode claim", {
    labels: ["machine=worker-1"],
  });
  await swarm.waitForTaskState(id, "completed", { timeoutMs: 60_000 });

  // The supervisor restarted the stream and health recovered.
  await waitFor(
    async () =>
      (await swarm.readDispatcherLog("worker-1")).split("degraded (polling)").at(-1) ?? "",
    (afterDegraded) => afterDegraded.includes("Live events event-driven"),
    { timeoutMs: 30_000, intervalMs: 500, describe: "dispatcher recovering to event-driven" },
  );

  // A graceful stop must not leave the `vb tail` process group behind.
  await swarm.stopDispatcher("worker-1");
  await waitFor(
    () => tailProcesses(exec, "worker-1"),
    (procs) => procs === "",
    { timeoutMs: 10_000, intervalMs: 300, describe: "no tail process after dispatcher stop" },
  );
  await swarm.startDispatcher("worker-1");
});
