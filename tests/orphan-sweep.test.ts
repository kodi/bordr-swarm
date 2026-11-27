import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoardTask } from "../src/lib/board.ts";
import type { HerdrAgent } from "../src/lib/herdr.ts";
import {
  buildAdoptedTask,
  buildParkedAdoption,
  decideOrphan,
  findUntrackedOwnClaims,
  workerBoardProfile,
} from "../src/lib/orphan-sweep.ts";
import type { CandidateTask, TaskRoutingResult } from "../src/lib/routing.ts";

function task(id: string, overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    channel: "projects/app",
    state: "claimed",
    text: "Task",
    labels: {},
    assignee: `worker-worker-machine-${id}`,
    raw: {},
    ...overrides,
  };
}

function agent(name: string, overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    name,
    agent_status: "working",
    pane_id: `p-${name}`,
    tab_id: `t-${name}`,
    workspace_id: "w1",
    ...overrides,
  };
}

const routing: CandidateTask = {
  task: task("1"),
  projectSlug: "app",
  project: { defaultMachine: "worker-machine", baseBranch: "main", paths: {} },
  repoPath: "/repos/app",
  useWorktree: false,
  runtime: {
    profileName: "claude",
    kind: "claude",
    model: "opus",
    effort: "medium",
    permissionMode: "auto",
    cliArgs: [],
  },
  reviewer: { enabled: false, required: false, maxRounds: 2, skipIfNoDiff: true, runtime: null },
};
const routed: TaskRoutingResult = { ok: true, candidate: routing };

describe("orphan sweep (pure)", () => {
  it("finds only untracked tasks claimed by this machine's exact worker profile", () => {
    const tasks = [
      task("1"),
      task("2"),
      task("3", { state: "ready", assignee: undefined }),
      task("4", { assignee: "worker-other-machine-4" }),
      // Machine name that merely shares a prefix with ours must not match
      task("5", { assignee: "worker-worker-machine-2-5" }),
      task("6", { assignee: "lead" }),
    ];
    const found = findUntrackedOwnClaims(tasks, new Set(["2"]), "worker-machine");
    assert.deepEqual(
      found.map((o) => [o.task.id, o.boardProfile, o.implAgentName]),
      [["1", "worker-worker-machine-1", "w-1"]],
    );
  });

  it("releases when no live implementer agent exists", () => {
    const [orphan] = findUntrackedOwnClaims([task("1")], new Set(), "worker-machine");
    const decision = decideOrphan(orphan!, [agent("w-2"), agent("lead-abc")], routed);
    assert.equal(decision.kind, "release");
  });

  it("adopts a live implementer and parks when a reviewer is also live", () => {
    const [orphan] = findUntrackedOwnClaims([task("1")], new Set(), "worker-machine");
    const adopt = decideOrphan(orphan!, [agent("w-1")], routed);
    assert.equal(adopt.kind, "adopt");
    if (adopt.kind === "adopt") assert.equal(adopt.impl.tabId, "t-w-1");

    const park = decideOrphan(orphan!, [agent("w-1"), agent("r2-1")], routed);
    assert.equal(park.kind, "park_in_review");
    if (park.kind === "park_in_review") assert.equal(park.reviewerAgentName, "r2-1");
  });

  it("skips (never releases) a live agent it cannot route or locate", () => {
    const [orphan] = findUntrackedOwnClaims([task("1")], new Set(), "worker-machine");
    const noRoute = decideOrphan(orphan!, [agent("w-1")], { ok: false, reason: "unknown project" });
    assert.equal(noRoute.kind, "skip");
    const noTab = decideOrphan(orphan!, [agent("w-1", { tab_id: undefined })], routed);
    assert.equal(noTab.kind, "skip");
  });

  it("rebuilds an implementing/running task with all replies seen and an immediate renew", () => {
    const [orphan] = findUntrackedOwnClaims([task("1")], new Set(), "worker-machine");
    const decision = decideOrphan(orphan!, [agent("w-1", { workspace_id: "w7" })], routed);
    assert.equal(decision.kind, "adopt");
    if (decision.kind !== "adopt") return;
    const adopted = buildAdoptedTask({
      orphan: decision.orphan,
      routing: decision.routing,
      impl: decision.impl,
      replyIds: ["r1", "r2"],
      machineName: "worker-machine",
      humanHandle: "@owner",
      nowMs: 50_000,
    });
    assert.equal(adopted.phase.kind, "implementing");
    if (adopted.phase.kind === "implementing") {
      assert.deepEqual(adopted.phase.impl.lifecycle, { kind: "running" });
      assert.equal(adopted.phase.impl.handle.paneId, "p-w-1");
      assert.equal(adopted.phase.impl.handle.agentName, "w-1");
    }
    assert.equal(adopted.ctx.workspaceId, "w7");
    assert.equal(adopted.ctx.startHeadSha, null);
    assert.equal(adopted.ctx.boardProfile, "worker-worker-machine-1");
    assert.equal(adopted.ctx.branch, "task/1");
    assert.equal(adopted.lastLeaseRenewMs, 0);
    assert.deepEqual([...adopted.phaseSeenReplyIds], ["r1", "r2"]);

    const parked = buildParkedAdoption(adopted, 60_000);
    assert.equal(parked.reason, "blocked");
    assert.equal(parked.tabId, "t-w-1");
    assert.equal(parked.projectSlug, "app");
  });

  it("matches long machine names via the same <=32-char deterministic profile without prefix collisions", () => {
    const taskId = "msg_0a3e4c6e-f4ed-4d2c-bef5-beed17baf5c8_1";
    const ownProfile = workerBoardProfile("example-macbook-pro-1", taskId);
    const otherProfile = workerBoardProfile("example-macbook-pro-2", taskId);
    assert.ok(ownProfile.length <= 32);
    assert.notEqual(ownProfile, otherProfile);

    const found = findUntrackedOwnClaims(
      [
        task(taskId, { assignee: ownProfile }),
        task("msg_11111111-f4ed-4d2c-bef5-beed17baf5c8_1", { assignee: otherProfile }),
      ],
      new Set(),
      "example-macbook-pro-1",
    );
    assert.equal(found.length, 1);
    assert.equal(found[0]?.boardProfile, ownProfile);
    assert.equal(found[0]?.implAgentName, "w-0a3e4c6e");
  });
});
