import { waitFor } from "vitecompose/core";
import { expect } from "vitest";
import { test } from "../fixtures/swarm-test.ts";

test("worker claims task, runs fake claude in real Herdr tab, commits file, completes, and closes tab", async ({
  compose,
  swarm,
}) => {
  const { id } = await swarm.createTask(
    "projects/demo-app",
    "Create marker file [commit:hello-e2e.txt]",
    { labels: ["machine=worker-1"] },
  );

  const completed = await swarm.waitForTaskState(id, "completed", { timeoutMs: 60_000 });
  expect(completed.replies.some((r) => r.text.includes("fake-claude") && r.text.includes(id))).toBe(
    true,
  );

  // Verify the commit actually landed in worker-1's local git checkout.
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
  expect(gitLog.stdout).toContain("hello-e2e.txt");

  // Verify the dispatcher closed the worker's Herdr tab after completion.
  await waitFor(
    () => swarm.listWorkerTabs("worker-1"),
    (tabs) => !tabs.some((tab) => tab.label.includes(id.slice(-8)) || tab.label.includes("claude")),
    { timeoutMs: 20_000, intervalMs: 500, describe: "worker-1 Herdr tab cleanup" },
  );
});

test("blocked task parks [BLOCKED] Herdr tab instead of closing it", async ({ swarm }) => {
  const { id } = await swarm.createTask(
    "projects/demo-app",
    "Deploy production [block:Need approval for production key]",
    { labels: ["machine=worker-1"] },
  );

  await swarm.waitForTaskState(id, "blocked", { timeoutMs: 60_000 });

  const tabs = await waitFor(
    () => swarm.listWorkerTabs("worker-1"),
    (list) => list.some((tab) => tab.label.includes("[BLOCKED]")),
    { timeoutMs: 20_000, intervalMs: 500, describe: "worker-1 [BLOCKED] tab" },
  );
  expect(tabs.some((tab) => tab.label.includes("[BLOCKED]"))).toBe(true);
});

test("unexpected agent exit fails the task, posts terminal output, and parks [FAILED] tab", async ({
  swarm,
}) => {
  const { id } = await swarm.createTask("projects/demo-app", "Crash mid-flight [fail-exit]", {
    labels: ["machine=worker-1"],
  });

  const failed = await swarm.waitForTaskState(id, "failed", { timeoutMs: 60_000 });
  expect(
    failed.replies.some(
      (r) => r.text.includes("exited before") || r.text.includes("simulated fatal crash"),
    ),
  ).toBe(true);

  const tabs = await waitFor(
    () => swarm.listWorkerTabs("worker-1"),
    (list) => list.some((tab) => tab.label.includes("[FAILED]")),
    { timeoutMs: 20_000, intervalMs: 500, describe: "worker-1 [FAILED] tab" },
  );
  expect(tabs.some((tab) => tab.label.includes("[FAILED]"))).toBe(true);
});
