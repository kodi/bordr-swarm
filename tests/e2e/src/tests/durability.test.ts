import { setTimeout as delay } from "node:timers/promises";
import { waitFor } from "vitecompose/core";
import { expect } from "vitest";
import { shortTaskId, test } from "../fixtures/swarm-test.ts";

test("dispatcher-only restart mid-task restores persisted state, keeps live agent tab, and auto-closes on completion", async ({
  compose,
  swarm,
}) => {
  const { id } = await swarm.createTask(
    "projects/demo-app",
    "Survive dispatcher restart [sleep:10000] [commit:survived-restart.txt]",
    { labels: ["machine=worker-1"] },
  );

  await swarm.waitForTaskState(id, "claimed", { timeoutMs: 30_000 });
  await waitFor(
    () => swarm.readDispatcherState("worker-1"),
    (state) => Boolean(state?.activeWorkers && id in (state.activeWorkers as object)),
    { timeoutMs: 20_000, intervalMs: 400, describe: "dispatcher state persisting active task" },
  );

  const tabsBefore = await swarm.listWorkerTabs("worker-1");
  const sid = shortTaskId(id);
  const origTab = tabsBefore.find((t) => t.label.includes(sid));
  expect(origTab).toBeDefined();

  // Restart ONLY the dispatcher process while Herdr and the sleeping fake-claude agent stay alive.
  await swarm.restartDispatcher("worker-1");

  await waitFor(
    () => swarm.readDispatcherLog("worker-1"),
    (log) => log.includes("Restored 1 active and 0 parked task(s)"),
    { timeoutMs: 20_000, intervalMs: 300, describe: "dispatcher log showing restored active task" },
  );

  // Confirm no duplicate tab was spawned and the original tab is still alive.
  const tabsAfter = await swarm.listWorkerTabs("worker-1");
  expect(tabsAfter.filter((t) => t.label.includes(sid))).toHaveLength(1);
  expect(tabsAfter.some((t) => t.tab_id === origTab!.tab_id)).toBe(true);

  const completed = await swarm.waitForTaskState(id, "completed", { timeoutMs: 60_000 });
  expect(completed.replies.some((r) => r.text.includes("fake-claude"))).toBe(true);

  const gitLog = await compose.exec("worker-1", [
    "git",
    "-C",
    "/var/lib/swarm/repos/demo-app",
    "log",
    "-n",
    "1",
    "--oneline",
  ]);
  expect(gitLog.status).toBe(0);
  expect(gitLog.stdout).toContain("survived-restart.txt");

  // Restarted dispatcher must auto-close the original live tab once the task completes.
  await waitFor(
    () => swarm.listWorkerTabs("worker-1"),
    (tabs) => !tabs.some((t) => t.tab_id === origTab!.tab_id),
    { timeoutMs: 20_000, intervalMs: 500, describe: "original tab auto-closed after restart" },
  );
});

test("corrupt state file is quarantined and orphan sweep adopts live agent without duplicating tabs", async ({
  compose,
  swarm,
}) => {
  const { id } = await swarm.createTask(
    "projects/demo-app",
    "Adopt live agent after corrupt state [sleep:10000] [commit:adopted-orphan.txt]",
    { labels: ["machine=worker-1"] },
  );

  await swarm.waitForTaskState(id, "claimed", { timeoutMs: 30_000 });
  await waitFor(
    () => swarm.readDispatcherState("worker-1"),
    (state) => Boolean(state?.activeWorkers && id in (state.activeWorkers as object)),
    { timeoutMs: 20_000, intervalMs: 400, describe: "initial dispatcher state written" },
  );

  const sid = shortTaskId(id);
  const tabsBefore = await swarm.listWorkerTabs("worker-1");
  const origTab = tabsBefore.find((t) => t.label.includes(sid));
  expect(origTab).toBeDefined();

  // Stop only the dispatcher, corrupt its state file, and start it again.
  await swarm.stopDispatcher("worker-1");
  const corruptRes = await compose.exec("worker-1", [
    "sh",
    "-c",
    "printf '{not-valid-json' > /var/lib/swarm/dispatcher-worker-1.json",
  ]);
  expect(corruptRes.status).toBe(0);

  await swarm.startDispatcher("worker-1");

  // Confirm corrupt state file was quarantined and orphan sweep adopted the live Herdr agent.
  await waitFor(
    async () => {
      const ls = await compose.exec("worker-1", [
        "sh",
        "-c",
        "ls /var/lib/swarm/dispatcher-worker-1.json.corrupt-* 2>/dev/null || true",
      ]);
      return ls.stdout.trim();
    },
    (out) => out.includes(".corrupt-"),
    { timeoutMs: 15_000, intervalMs: 300, describe: "corrupt dispatcher state quarantine file" },
  );

  await waitFor(
    () => swarm.readDispatcherLog("worker-1"),
    (log) => log.includes(`Adopted orphaned task #${id}`),
    { timeoutMs: 20_000, intervalMs: 400, describe: "orphan sweep adoption log" },
  );

  // Original tab is still the only tab for this task.
  const tabsAfter = await swarm.listWorkerTabs("worker-1");
  expect(tabsAfter.filter((t) => t.label.includes(sid))).toHaveLength(1);
  expect(tabsAfter.some((t) => t.tab_id === origTab!.tab_id)).toBe(true);

  await swarm.waitForTaskState(id, "completed", { timeoutMs: 60_000 });

  const gitLog = await compose.exec("worker-1", [
    "git",
    "-C",
    "/var/lib/swarm/repos/demo-app",
    "log",
    "-n",
    "1",
    "--oneline",
  ]);
  expect(gitLog.status).toBe(0);
  expect(gitLog.stdout).toContain("adopted-orphan.txt");

  await waitFor(
    () => swarm.listWorkerTabs("worker-1"),
    (tabs) => !tabs.some((t) => t.tab_id === origTab!.tab_id),
    { timeoutMs: 20_000, intervalMs: 500, describe: "adopted tab auto-closed on completion" },
  );
});

test("orphan sweep releases dead claim back to ready when no state file and no live agent exist", async ({
  compose,
  swarm,
}) => {
  // Stop worker-1 so we can plant an untracked claim belonging to worker-1 without a live agent.
  await swarm.stopDispatcher("worker-1");

  // Label for an unmatched host so once worker-1 releases it to `ready`, neither worker immediately steals it.
  const { id } = await swarm.createTask("projects/demo-app", "Pre-claimed dead orphan task", {
    labels: ["machine=unmatched-host"],
  });

  // Claim from inside worker-1 so `vb` holds the local claim token on worker-1 (just as when
  // worker-1 originally claimed a task before losing its dispatcher state file and agent).
  const workerProfile = `worker-worker-1-${shortTaskId(id)}`;
  const claimRes = await compose.exec("worker-1", [
    "vb",
    "tasks",
    "claim",
    id,
    "--lease",
    "5m",
    "--as",
    workerProfile,
    "--url",
    "http://board:4100/api/board",
    "--json",
  ]);
  expect(claimRes.status, `stderr=${claimRes.stderr} stdout=${claimRes.stdout}`).toBe(0);
  expect((await swarm.readTask(id)).state).toBe("claimed");

  await swarm.startDispatcher("worker-1");

  const released = await swarm.waitForTaskState(id, "ready", { timeoutMs: 30_000 });
  expect(released.replies.some((r) => r.text.includes("released the task"))).toBe(true);
  expect(await swarm.listWorkerTabs("worker-1")).toHaveLength(0);
});

test("dispatcher restart during review phase processes reviewer verdict and closes both tabs", async ({
  compose,
  swarm,
}) => {
  const { id } = await swarm.createTask(
    "projects/reviewed-app",
    "Reviewed change [commit:reviewed.txt] [review-ready] [review-sleep:10000]",
    { labels: ["machine=worker-1"] },
  );

  const sid = shortTaskId(id);

  // Wait until implementer hands off and the dispatcher enters the `reviewing` phase with a live reviewer agent.
  await waitFor(
    () => swarm.readDispatcherState("worker-1"),
    (state) => {
      const active = state?.activeWorkers as
        | Record<string, { phase?: { kind?: string } }>
        | undefined;
      return active?.[id]?.phase?.kind === "reviewing";
    },
    { timeoutMs: 45_000, intervalMs: 500, describe: "dispatcher entering reviewing phase" },
  );

  const tabsInReview = await waitFor(
    () => swarm.listWorkerTabs("worker-1"),
    (tabs) =>
      tabs.some((t) => t.label.includes(`[IN-REVIEW r1]`) && t.label.includes(sid)) &&
      tabs.some((t) => t.label.includes(`review-${sid}`)),
    { timeoutMs: 20_000, intervalMs: 400, describe: "implementer and reviewer tabs both present" },
  );

  const implTab = tabsInReview.find((t) => t.label.includes("[IN-REVIEW r1]"))!;
  const reviewTab = tabsInReview.find((t) => t.label.includes(`review-${sid}`))!;

  // Wait for reviewer prompt delivery so the reviewer is actively working when we restart the dispatcher.
  await waitFor(
    () => swarm.listWorkerAgents("worker-1"),
    (agents) =>
      agents.some(
        (a) => a.tab_id === reviewTab.tab_id && a.agent_status.toLowerCase() === "working",
      ),
    { timeoutMs: 20_000, intervalMs: 400, describe: "reviewer agent working mid-review" },
  );

  // Restart ONLY the dispatcher mid-review.
  await swarm.restartDispatcher("worker-1");

  await waitFor(
    () => swarm.readDispatcherLog("worker-1"),
    (log) => log.includes("Restored 1 active and 0 parked task(s)"),
    { timeoutMs: 20_000, intervalMs: 300, describe: "dispatcher log restoring reviewing task" },
  );

  // Reviewer completes its sleep, posts VERDICT: APPROVE, and the restarted dispatcher completes the task.
  const completed = await swarm.waitForTaskState(id, "completed", { timeoutMs: 60_000 });
  expect(completed.replies.some((r) => r.text.includes("STATUS: READY_FOR_REVIEW"))).toBe(true);
  expect(completed.replies.some((r) => r.text.includes("VERDICT: APPROVE"))).toBe(true);

  const gitLog = await compose.exec("worker-1", [
    "git",
    "-C",
    "/var/lib/swarm/repos/reviewed-app",
    "log",
    "-n",
    "1",
    "--oneline",
  ]);
  expect(gitLog.status).toBe(0);
  expect(gitLog.stdout).toContain("reviewed.txt");

  // Both the implementer tab and reviewer tab must be closed automatically.
  await waitFor(
    () => swarm.listWorkerTabs("worker-1"),
    (tabs) => !tabs.some((t) => t.tab_id === implTab.tab_id || t.tab_id === reviewTab.tab_id),
    { timeoutMs: 20_000, intervalMs: 500, describe: "both implementer and reviewer tabs closed" },
  );
});

test("parked [BLOCKED] tab preserves per-repo lock across dispatcher restart until closed", async ({
  swarm,
}) => {
  const { id: blockedId } = await swarm.createTask(
    "projects/demo-app",
    "Block demo-app repo [block:Wait for manual decision]",
    { labels: ["machine=worker-1"] },
  );

  await swarm.waitForTaskState(blockedId, "blocked", { timeoutMs: 60_000 });
  const parkedTabs = await waitFor(
    () => swarm.listWorkerTabs("worker-1"),
    (tabs) => tabs.some((t) => t.label.includes("[BLOCKED]")),
    { timeoutMs: 20_000, intervalMs: 500, describe: "[BLOCKED] tab created" },
  );
  const blockedTab = parkedTabs.find((t) => t.label.includes("[BLOCKED]"))!;

  await waitFor(
    () => swarm.readDispatcherState("worker-1"),
    (state) => Boolean(state?.parkedTabs && blockedId in (state.parkedTabs as object)),
    { timeoutMs: 20_000, intervalMs: 400, describe: "parked tab persisted to dispatcher state" },
  );

  // Restart ONLY the dispatcher; the [BLOCKED] tab stays open in Herdr.
  await swarm.restartDispatcher("worker-1");

  await waitFor(
    () => swarm.readDispatcherLog("worker-1"),
    (log) => log.includes("Restored 0 active and 1 parked task(s)"),
    { timeoutMs: 20_000, intervalMs: 300, describe: "dispatcher restoring 1 parked tab" },
  );

  // Queue a second task for the same plain-tab repo on worker-1.
  const { id: secondId } = await swarm.createTask(
    "projects/demo-app",
    "Queued behind restored [BLOCKED] tab",
    { labels: ["machine=worker-1"] },
  );

  // Wait >2 poll intervals (3s each) and verify the restored parked tab still holds the repo lock.
  await delay(7_000);
  expect((await swarm.readTask(secondId)).state).toBe("ready");

  // Once the operator closes the [BLOCKED] tab, the lock releases and the queued task completes.
  await swarm.closeWorkerTab("worker-1", blockedTab.tab_id);

  const completed = await swarm.waitForTaskState(secondId, "completed", { timeoutMs: 60_000 });
  expect(completed.replies.some((r) => r.text.includes("fake-claude"))).toBe(true);
});
