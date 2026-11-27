import { waitFor } from "vitecompose/core";
import { expect } from "vitest";
import { shortTaskId, test, type WorkerName } from "../fixtures/swarm-test.ts";

const SWARM_JSON = "/var/lib/swarm/config/swarm.json";

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

test("mixed fleet routes runtime=rex to worker-3 and runtime=herdr to Herdr workers, runs real Rex window, commits, and closes window", async ({
  compose,
  swarm,
}) => {
  const [rexTask, herdrTask] = await Promise.all([
    swarm.createTask("projects/demo-app", "Run on Rex [commit:hello-rex.txt]", {
      labels: ["runtime=rex"],
    }),
    swarm.createTask("projects/demo-app", "Run on Herdr [commit:hello-herdr.txt]", {
      labels: ["runtime=herdr", "machine=worker-1"],
    }),
  ]);

  const [rexDone, herdrDone] = await Promise.all([
    swarm.waitForTaskState(rexTask.id, "completed", { timeoutMs: 60_000 }),
    swarm.waitForTaskState(herdrTask.id, "completed", { timeoutMs: 60_000 }),
  ]);

  expect(rexDone.replies.some((r) => r.text.includes("worker-worker-3"))).toBe(true);
  expect(herdrDone.replies.some((r) => r.text.includes("worker-worker-1"))).toBe(true);

  const gitLog = await compose.exec("worker-3", [
    "git",
    "-C",
    "/var/lib/swarm/repos/demo-app",
    "log",
    "-n",
    "1",
    "--oneline",
  ]);
  expect(gitLog.status).toBe(0);
  expect(gitLog.stdout).toContain("hello-rex.txt");

  // Completed Rex window must be closed automatically.
  const sid = shortTaskId(rexTask.id);
  await waitFor(
    () => swarm.listWorkerTabs("worker-3"),
    (tabs) => !tabs.some((t) => t.label.includes(sid)),
    { timeoutMs: 20_000, intervalMs: 500, describe: "worker-3 Rex window cleanup" },
  );
});

test("Rex worker runs event-driven via RexEventSource with polling slowed to 120s and cleans up rex events children on stop", async ({
  compose,
  swarm,
}) => {
  const exec = (w: WorkerName, cmd: string[]) => compose.exec(w, cmd);
  await setIntervals(exec, "worker-3", 120, 120);
  await swarm.restartDispatcher("worker-3");

  await waitFor(
    () => swarm.readDispatcherLog("worker-3"),
    (log) => log.includes("Live events event-driven [board=live, rex=live]"),
    { timeoutMs: 30_000, intervalMs: 300, describe: "worker-3 reporting board=live and rex=live" },
  );

  const startedAt = Date.now();
  const { id } = await swarm.createTask(
    "projects/demo-app",
    "Event-driven Rex claim [commit:rex-event-bus.txt]",
    { labels: ["runtime=rex"] },
  );
  await swarm.waitForTaskState(id, "completed", { timeoutMs: 30_000 });
  expect(Date.now() - startedAt).toBeLessThan(30_000);

  const sid = shortTaskId(id);
  await waitFor(
    () => swarm.listWorkerTabs("worker-3"),
    (tabs) => !tabs.some((t) => t.label.includes(sid)),
    { timeoutMs: 20_000, intervalMs: 500, describe: "worker-3 event-driven window close" },
  );

  await swarm.stopDispatcher("worker-3");
  await waitFor(
    async () => {
      const res = await compose.exec("worker-3", ["sh", "-c", "pgrep -af '[r]ex events' || true"]);
      return res.stdout.trim();
    },
    (procs) => procs === "",
    { timeoutMs: 10_000, intervalMs: 300, describe: "no rex events child left after stop" },
  );
  await swarm.startDispatcher("worker-3");
});

test("Rex worker captures crash tail via --keep-open, fails task, and parks [FAILED] window", async ({
  swarm,
}) => {
  const { id } = await swarm.createTask("projects/demo-app", "Crash in Rex [fail-exit]", {
    labels: ["runtime=rex"],
  });

  const failed = await swarm.waitForTaskState(id, "failed", { timeoutMs: 60_000 });
  expect(
    failed.replies.some(
      (r) => r.text.includes("exited before") && r.text.includes("simulated fatal crash"),
    ),
  ).toBe(true);

  const sid = shortTaskId(id);
  const tabs = await waitFor(
    () => swarm.listWorkerTabs("worker-3"),
    (list) => list.some((t) => t.label.includes("[FAILED]") && t.label.includes(sid)),
    { timeoutMs: 20_000, intervalMs: 500, describe: "worker-3 [FAILED] Rex window" },
  );
  expect(tabs.some((t) => t.label.includes("[FAILED]") && t.label.includes(sid))).toBe(true);
});

test("Rex worker runs review round, survives dispatcher restart mid-review, and closes both windows", async ({
  compose,
  swarm,
}) => {
  const { id } = await swarm.createTask(
    "projects/reviewed-app",
    "Rex reviewed change [commit:rex-reviewed.txt] [review-ready] [review-sleep:7000]",
    { labels: ["runtime=rex"] },
  );

  const sid = shortTaskId(id);
  await waitFor(
    () => swarm.readDispatcherState("worker-3"),
    (state) => {
      const active = state?.activeWorkers as
        | Record<string, { phase?: { kind?: string } }>
        | undefined;
      return active?.[id]?.phase?.kind === "reviewing";
    },
    { timeoutMs: 45_000, intervalMs: 500, describe: "worker-3 entering reviewing phase" },
  );

  const tabsInReview = await waitFor(
    () => swarm.listWorkerTabs("worker-3"),
    (tabs) =>
      tabs.some((t) => t.label.includes("[IN-REVIEW r1]") && t.label.includes(sid)) &&
      tabs.some((t) => t.label.includes(`review-${sid}`)),
    { timeoutMs: 20_000, intervalMs: 400, describe: "Rex impl and reviewer windows open" },
  );
  const implWin = tabsInReview.find((t) => t.label.includes("[IN-REVIEW r1]"))!;
  const reviewWin = tabsInReview.find((t) => t.label.includes(`review-${sid}`))!;

  await swarm.restartDispatcher("worker-3");
  await waitFor(
    () => swarm.readDispatcherLog("worker-3"),
    (log) => log.includes("Restored 1 active and 0 parked task(s)"),
    { timeoutMs: 20_000, intervalMs: 300, describe: "worker-3 restoring active reviewing task" },
  );

  const completed = await swarm.waitForTaskState(id, "completed", { timeoutMs: 60_000 });
  expect(completed.replies.some((r) => r.text.includes("STATUS: READY_FOR_REVIEW"))).toBe(true);
  expect(completed.replies.some((r) => r.text.includes("VERDICT: APPROVE"))).toBe(true);

  const gitLog = await compose.exec("worker-3", [
    "git",
    "-C",
    "/var/lib/swarm/repos/reviewed-app",
    "log",
    "-n",
    "1",
    "--oneline",
  ]);
  expect(gitLog.status).toBe(0);
  expect(gitLog.stdout).toContain("rex-reviewed.txt");

  await waitFor(
    () => swarm.listWorkerTabs("worker-3"),
    (tabs) => !tabs.some((t) => t.tab_id === implWin.tab_id || t.tab_id === reviewWin.tab_id),
    {
      timeoutMs: 20_000,
      intervalMs: 500,
      describe: "both Rex windows closed after review approve",
    },
  );
});

test("Rex worker creates and removes Dispatcher-managed git worktree for useWorktree projects", async ({
  compose,
  swarm,
}) => {
  const { id } = await swarm.createTask(
    "projects/worktree-app",
    "Work in Rex git worktree [commit:rex-wt.txt]",
    { labels: ["runtime=rex"] },
  );

  const completed = await swarm.waitForTaskState(id, "completed", { timeoutMs: 60_000 });
  expect(completed.replies.some((r) => r.text.includes("worker-worker-3"))).toBe(true);

  // Confirm the temporary git worktree was cleaned up after task completion.
  await waitFor(
    async () => {
      const wtList = await compose.exec("worker-3", [
        "git",
        "-C",
        "/var/lib/swarm/repos/worktree-app",
        "worktree",
        "list",
        "--porcelain",
      ]);
      return wtList.stdout;
    },
    (out) => {
      const count = out.split("\n").filter((l) => l.startsWith("worktree ")).length;
      return count === 1;
    },
    {
      timeoutMs: 20_000,
      intervalMs: 500,
      describe: "temporary git worktree removed after completion",
    },
  );
});
