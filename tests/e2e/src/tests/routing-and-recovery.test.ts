import { waitFor } from "vitecompose/core";
import { expect } from "vitest";
import { test } from "../fixtures/swarm-test.ts";

test("routes labeled tasks to worker-1 and worker-2 independently", async ({ swarm }) => {
  const [t1, t2] = await Promise.all([
    swarm.createTask("projects/demo-app", "Work for worker 1", { labels: ["machine=worker-1"] }),
    swarm.createTask("projects/demo-app", "Work for worker 2", { labels: ["machine=worker-2"] }),
  ]);

  const [done1, done2] = await Promise.all([
    swarm.waitForTaskState(t1.id, "completed", { timeoutMs: 60_000 }),
    swarm.waitForTaskState(t2.id, "completed", { timeoutMs: 60_000 }),
  ]);

  expect(done1.replies.some((r) => r.text.includes("worker-worker-1"))).toBe(true);
  expect(done2.replies.some((r) => r.text.includes("worker-worker-2"))).toBe(true);
});

test("hard container kill persists dispatcher state and cleanly settles dead worker claim on restart", async ({
  compose,
  swarm,
}) => {
  const { id } = await swarm.createTask(
    "projects/demo-app",
    "Long task interrupted by hard crash [sleep:15000]",
    { labels: ["machine=worker-1"] },
  );

  // Wait until worker-1 claims the task AND writes it into its durable state file.
  await swarm.waitForTaskState(id, "claimed", { timeoutMs: 30_000 });
  const persisted = await waitFor(
    () => swarm.readDispatcherState("worker-1"),
    (state) => {
      const active = state?.activeWorkers;
      return Boolean(active && typeof active === "object" && id in active);
    },
    {
      timeoutMs: 20_000,
      intervalMs: 500,
      describe: "dispatcher state file recording claimed task",
    },
  );
  expect(persisted).not.toBeNull();

  // Simulate an abrupt machine crash via SIGKILL (`await using` guarantees restoration).
  await using crashed = await compose.stopTemporarily("worker-1", { kill: true });
  expect(await compose.inspect("worker-1")).toHaveContainerState("exited");
  await crashed.restore();
  expect(await compose.inspect("worker-1")).toBeContainerHealthy();

  // Because the entire container (including Herdr) died, the restored dispatcher should read its
  // durable state file, detect that the Herdr tab/agent is gone, and fail the task cleanly rather
  // than leaving a zombie claim stuck forever.
  const settled = await swarm.waitForTaskState(id, "failed", { timeoutMs: 45_000 });
  expect(settled.replies.some((r) => r.text.includes("exited before"))).toBe(true);
});
