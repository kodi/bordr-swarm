import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyProjectReviewerUpdate,
  applyWorkerReviewerUpdate,
  parseReviewerCliArgs,
} from "../scripts/reviewer.ts";
import { SwarmDispatcher } from "../src/dispatcher.ts";
import {
  BoardClient,
  type BoardMessage,
  type BoardTask,
  type ExecRunner,
} from "../src/lib/board.ts";
import {
  parseSwarmConfig,
  resolveReviewerConfig,
  type ProjectConfig,
  type ProjectsConfig,
  type SwarmConfig,
} from "../src/lib/config.ts";
import { HerdrClient } from "../src/lib/herdr.ts";
import {
  findReadyForReviewReply,
  findReviewVerdictReply,
  parseReadyForReviewSignal,
  parseReviewVerdict,
  type GitChangeDetector,
} from "../src/lib/review.ts";
import { selectEligibleTasks } from "../src/lib/routing.ts";

function makeSwarmWithReviewer(reviewerInput?: Record<string, unknown>): SwarmConfig {
  return parseSwarmConfig({
    board: { humanHandle: "@owner" },
    workerDefaults: {
      defaultAgent: "claude",
      agents: {
        claude: { model: "opus", effort: "medium", permissionMode: "auto" },
        codex: { model: "", effort: "medium", permissionMode: "auto" },
        pi: { model: "", effort: "medium", permissionMode: "auto" },
      },
      ...(reviewerInput ? { reviewer: reviewerInput } : {}),
    },
    machines: {
      "worker-machine": {
        role: "worker",
        os: "macos",
        maxWorkers: 2,
      },
    },
  });
}

describe("reviewer config resolution & inheritance", () => {
  it("defaults to disabled when reviewer block is omitted, and auto-enables when configured", () => {
    const disabledSwarm = makeSwarmWithReviewer();
    const disabled = resolveReviewerConfig(disabledSwarm.workerDefaults);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.runtime, null);

    const enabledSwarm = makeSwarmWithReviewer({ agent: "codex", effort: "high" });
    const enabled = resolveReviewerConfig(enabledSwarm.workerDefaults);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.maxRounds, 2);
    assert.equal(enabled.skipIfNoDiff, true);
    assert.equal(enabled.runtime?.profileName, "codex");
    assert.equal(enabled.runtime?.kind, "codex");
    assert.deepEqual(enabled.runtime?.cliArgs, [
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      "sandbox_workspace_write.network_access=true",
      "--approve-for-me",
    ]);
  });

  it("supports per-project reviewer agent + model override without leaking old model across agents", () => {
    const swarm = makeSwarmWithReviewer({
      agent: "claude",
      model: "opus",
      effort: "high",
      maxRounds: 3,
    });

    // Project overrides agent to codex without specifying model -> must NOT pass "opus" to codex!
    const codexProject: ProjectConfig = {
      defaultMachine: "worker-machine",
      baseBranch: "main",
      paths: { "worker-machine": "/tmp/codex-proj" },
      reviewer: { agent: "codex" },
    };
    const codexRev = resolveReviewerConfig(swarm.workerDefaults, codexProject);
    assert.equal(codexRev.enabled, true);
    assert.equal(codexRev.maxRounds, 3);
    assert.equal(codexRev.runtime?.profileName, "codex");
    assert.equal(codexRev.runtime?.model, "");
    assert.ok(!codexRev.runtime?.cliArgs.includes("opus"));

    // Project overrides agent to pi with explicit model
    const piProject: ProjectConfig = {
      defaultMachine: "worker-machine",
      baseBranch: "main",
      paths: { "worker-machine": "/tmp/pi-proj" },
      reviewer: { agent: "pi", model: "openai-codex/gpt-5.4", effort: "xhigh" },
    };
    const piRev = resolveReviewerConfig(swarm.workerDefaults, piProject);
    assert.equal(piRev.enabled, true);
    assert.equal(piRev.runtime?.profileName, "pi");
    assert.equal(piRev.runtime?.model, "openai-codex/gpt-5.4");
    assert.deepEqual(piRev.runtime?.cliArgs, [
      "--model",
      "openai-codex/gpt-5.4",
      "--thinking",
      "xhigh",
      "--approve",
    ]);

    // Project explicitly disables review
    const noRevProject: ProjectConfig = {
      defaultMachine: "worker-machine",
      baseBranch: "main",
      paths: { "worker-machine": "/tmp/notes" },
      reviewer: { enabled: false },
    };
    assert.equal(resolveReviewerConfig(swarm.workerDefaults, noRevProject).enabled, false);
  });

  it("enables review for a single project even when global reviewer is disabled, and respects task labels", () => {
    const swarm = makeSwarmWithReviewer(); // globally disabled
    const project: ProjectConfig = {
      defaultMachine: "worker-machine",
      baseBranch: "main",
      paths: { "worker-machine": "/tmp/app" },
      reviewer: { agent: "pi", model: "openai-codex/gpt-5.4" },
    };

    const fromProject = resolveReviewerConfig(swarm.workerDefaults, project);
    assert.equal(fromProject.enabled, true);
    assert.equal(fromProject.runtime?.profileName, "pi");

    // Task label review=skip overrides project reviewer
    const skipped = resolveReviewerConfig(swarm.workerDefaults, project, { review: "skip" });
    assert.equal(skipped.enabled, false);

    // Task label review=required sets required=true and allows one-off reviewer/model override
    const required = resolveReviewerConfig(swarm.workerDefaults, project, {
      review: "required",
      reviewer: "codex",
      reviewer_model: "gpt-5.4",
      reviewer_effort: "high",
    });
    assert.equal(required.enabled, true);
    assert.equal(required.required, true);
    assert.equal(required.runtime?.kind, "codex");
    assert.equal(required.runtime?.model, "gpt-5.4");
  });

  it("skips claiming a task when required reviewer binary is missing on this host", () => {
    const swarm = makeSwarmWithReviewer({ agent: "codex" });
    const projects: ProjectsConfig = {
      projects: {
        app: {
          defaultMachine: "worker-machine",
          baseBranch: "main",
          paths: { "worker-machine": "/tmp/app" },
        },
      },
    };
    const tasks: BoardTask[] = [
      { id: "1", channel: "projects/app", state: "ready", text: "Fix bug", labels: {}, raw: {} },
    ];

    const res = selectEligibleTasks({
      tasks,
      swarm,
      projects,
      machineName: "worker-machine",
      busyPlainTabProjects: new Set(),
      alreadyTrackedTaskIds: new Set(),
      availableAgentKinds: new Set(["claude"]), // codex missing!
    });

    assert.equal(res.candidates.length, 0);
    assert.equal(res.skips.length, 1);
    assert.match(res.skips[0]?.reason ?? "", /reviewer binary "codex" is not installed/i);
  });
});

describe("review signal & verdict parsing", () => {
  it("parses READY_FOR_REVIEW and VERDICT markers tolerating Markdown formatting", () => {
    assert.equal(parseReadyForReviewSignal("Done!\n\n**STATUS: READY_FOR_REVIEW**"), true);
    assert.equal(parseReadyForReviewSignal("Still working on tests"), false);

    assert.equal(parseReviewVerdict("Looks great.\n\n`VERDICT: APPROVE`"), "approve");
    assert.equal(
      parseReviewVerdict(
        "Remember VERDICT: APPROVE vs VERDICT: REQUEST_CHANGES.\n\nVERDICT: REQUEST_CHANGES",
      ),
      "request_changes",
    );
    assert.equal(parseReviewVerdict("No verdict posted yet"), null);
  });

  it("ignores already-seen replies and filters by reviewer profile", () => {
    const replies: BoardMessage[] = [
      {
        id: "r1",
        text: "Round 1 done\nSTATUS: READY_FOR_REVIEW",
        by: { profile: "worker-host-1" },
      },
      {
        id: "r2",
        text: "Found null deref\nVERDICT: REQUEST_CHANGES",
        by: { profile: "reviewer-host-1" },
      },
      {
        id: "r3",
        text: "Fixed null deref\nSTATUS: READY_FOR_REVIEW",
        by: { profile: "worker-host-1" },
      },
    ];

    const seen = new Set(["r1", "r2"]);
    const ready = findReadyForReviewReply(replies, seen, "reviewer-host-1");
    assert.equal(ready?.reply.id, "r3");
    assert.equal(ready?.summary, "Fixed null deref");

    const noVerdictYet = findReviewVerdictReply(replies, seen, "reviewer-host-1");
    assert.equal(noVerdictYet, null);
  });
});

function setupMockHarness(params: {
  swarm: SwarmConfig;
  projects: ProjectsConfig;
  task: BoardTask;
  gitDetector: GitChangeDetector;
}) {
  const boardTasks: Record<string, BoardTask> = { [params.task.id]: params.task };
  const threadReplies: BoardMessage[] = [];
  const boardCalls: string[][] = [];

  const boardRunner: ExecRunner = async (_cmd, args) => {
    boardCalls.push(args);
    const sub = args[1];
    if (sub === "tasks" && args[2] === "claim") {
      const task = boardTasks[args[3]!]!;
      task.state = "claimed";
      return { stdout: JSON.stringify(task), stderr: "" };
    }
    if (sub === "tasks" && args[2] === "complete") {
      const task = boardTasks[args[3]!]!;
      task.state = "completed";
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }
    if (sub === "tasks" && args[2] === "block") {
      const task = boardTasks[args[3]!]!;
      task.state = "blocked";
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }
    if (sub === "tasks" && args[2] === "projects/") {
      return {
        stdout: JSON.stringify({
          tasks: Object.values(boardTasks).map((t) => ({
            ...t,
            replies: threadReplies.length,
          })),
        }),
        stderr: "",
      };
    }
    if (sub === "read" && args[2] === params.task.id) {
      return {
        stdout: JSON.stringify({
          message: { id: params.task.id, text: params.task.text },
          replies: threadReplies,
          cursor: "c1",
        }),
        stderr: "",
      };
    }
    if (sub === "reply") {
      threadReplies.push({
        id: `disp_r_${threadReplies.length + 1}`,
        text: args[3] ?? "",
        by: { profile: args[args.indexOf("--as") + 1] ?? "dispatcher" },
      });
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }
    return { stdout: JSON.stringify({ ok: true }), stderr: "" };
  };

  let nextTabSeq = 1;
  const openTabs = new Map<string, { tab_id: string; workspace_id: string; label: string }>();
  const liveAgents = new Map<string, { pane_id: string; agent_status: string; name: string }>();
  const herdrCalls: string[][] = [];

  const herdrRunner: ExecRunner = async (_cmd, args) => {
    herdrCalls.push(args);
    const [group, sub] = args;
    if (group === "workspace" && sub === "list") {
      return {
        stdout: JSON.stringify({
          result: { workspaces: [{ workspace_id: "w1", label: "app" }] },
        }),
        stderr: "",
      };
    }
    if (group === "tab" && sub === "create") {
      const wsId = args[args.indexOf("--workspace") + 1]!;
      const label = args[args.indexOf("--label") + 1]!;
      const seq = nextTabSeq++;
      const tabId = `${wsId}:t${seq}`;
      const paneId = `${wsId}:p${seq}`;
      openTabs.set(tabId, { tab_id: tabId, workspace_id: wsId, label });
      return {
        stdout: JSON.stringify({
          result: { tab: { tab_id: tabId, workspace_id: wsId }, root_pane: { pane_id: paneId } },
        }),
        stderr: "",
      };
    }
    if (group === "tab" && sub === "list") {
      return {
        stdout: JSON.stringify({ result: { tabs: [...openTabs.values()] } }),
        stderr: "",
      };
    }
    if (group === "tab" && sub === "close") {
      const tabId = args[2]!;
      openTabs.delete(tabId);
      const paneId = tabId.replace(":t", ":p");
      liveAgents.delete(paneId);
      return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
    }
    if (group === "tab" && sub === "rename") {
      const tab = openTabs.get(args[2]!);
      if (tab) tab.label = args[3]!;
      return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
    }
    if (group === "agent" && sub === "start") {
      const name = args[2]!;
      const paneId = args[args.indexOf("--pane") + 1]!;
      liveAgents.set(paneId, { pane_id: paneId, agent_status: "idle", name });
      return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
    }
    if (group === "agent" && sub === "list") {
      return {
        stdout: JSON.stringify({ result: { agents: [...liveAgents.values()] } }),
        stderr: "",
      };
    }
    return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
  };

  const dispatcher = new SwarmDispatcher({
    repoRoot: "/nonexistent-test-root",
    swarm: params.swarm,
    projects: params.projects,
    machineName: "worker-machine",
    board: new BoardClient({}, boardRunner),
    herdr: new HerdrClient({ target: "local" }, herdrRunner),
    promptTemplate: "Task {{TASK_ID}}\n{{COMPLETION_WORKFLOW}}",
    reviewerPromptTemplate:
      "Review {{TASK_ID}} round {{ROUND}}/{{MAX_ROUNDS}} base={{BASE_REF}} profile={{REVIEWER_PROFILE}}",
    gitDetector: params.gitDetector,
    availableAgentKinds: new Set(["claude", "codex", "pi"]),
    dryRun: false,
  });

  return { dispatcher, boardTasks, threadReplies, boardCalls, openTabs, liveAgents, herdrCalls };
}

describe("SwarmDispatcher review & fix lifecycles", () => {
  it("runs implement -> review (REQUEST_CHANGES) -> original implementer fix -> re-review (APPROVE) -> complete", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "swarm-review-loop-"));
    const repoPath = join(tmpBase, "app");
    mkdirSync(repoPath);

    try {
      const swarm = makeSwarmWithReviewer({ agent: "codex", maxRounds: 2 });
      const projects: ProjectsConfig = {
        projects: {
          app: {
            defaultMachine: "worker-machine",
            baseBranch: "main",
            paths: { "worker-machine": repoPath },
            reviewer: { agent: "pi", model: "openai-codex/gpt-5.4", effort: "high" },
          },
        },
      };
      const task: BoardTask = {
        id: "501",
        channel: "projects/app",
        state: "ready",
        text: "Add caching layer",
        labels: {},
        raw: {},
      };
      const gitDetector: GitChangeDetector = {
        captureHeadSha: () => "aaaa111",
        detectChanges: () => ({
          hasChanges: true,
          currentHeadSha: "bbbb222",
          dirtyFiles: 0,
          detail: "1 commit since aaaa111",
        }),
      };

      const h = setupMockHarness({ swarm, projects, task, gitDetector });

      // Tick 1: Claim task and spawn implementer (claude) with review-gated instructions
      await h.dispatcher.tick();
      assert.equal(h.dispatcher.activeWorkers.size, 1);
      const implPromptCall = h.herdrCalls.find((c) => c[0] === "agent" && c[1] === "prompt");
      assert.match(implPromptCall?.[3] ?? "", /STATUS: READY_FOR_REVIEW/);

      // Implementer finishes and posts READY_FOR_REVIEW
      h.threadReplies.push({
        id: "reply_impl_1",
        text: "Implemented cache with TTL tests.\n\nSTATUS: READY_FOR_REVIEW",
        by: { profile: "worker-worker-machine-501" },
      });

      // Tick 2: Dispatcher spawns Reviewer Round 1 (pi with openai-codex/gpt-5.4) in same workspace
      await h.dispatcher.tick();
      assert.equal(h.openTabs.size, 2);
      assert.equal(h.openTabs.get("w1:t1")?.label, "task-501 [IN-REVIEW r1] (claude)");
      assert.equal(h.openTabs.get("w1:t2")?.label, "review-501 r1 (pi)");

      const revStart = h.herdrCalls.find(
        (c) => c[0] === "agent" && c[1] === "start" && c[2] === "r1-501",
      );
      assert.ok(revStart, "reviewer round 1 agent should start");
      assert.ok(revStart.includes("pi"));
      assert.ok(revStart.includes("openai-codex/gpt-5.4"));

      // Reviewer Round 1 requests changes
      h.threadReplies.push({
        id: "reply_rev_1",
        text: "Found missing eviction edge case in cache.ts:42.\n\nVERDICT: REQUEST_CHANGES",
        by: { profile: "reviewer-worker-machine-501" },
      });

      // Tick 3: Dispatcher closes reviewer tab and wakes ORIGINAL implementer (w-501) in warm tab
      await h.dispatcher.tick();
      assert.ok(!h.openTabs.has("w1:t2"), "reviewer r1 tab should close");
      assert.equal(h.openTabs.get("w1:t1")?.label, "task-501 fix-r1 (claude)");
      const fixPrompts = h.herdrCalls.filter(
        (c) => c[0] === "agent" && c[1] === "prompt" && c[2] === "w-501",
      );
      assert.equal(fixPrompts.length, 2, "original implementer should receive fix prompt");
      assert.match(fixPrompts[1]?.[3] ?? "", /review round 1\/2/i);

      // Implementer posts fix & READY_FOR_REVIEW again
      h.threadReplies.push({
        id: "reply_impl_2",
        text: "Fixed eviction edge case and added regression test.\n\nSTATUS: READY_FOR_REVIEW",
        by: { profile: "worker-worker-machine-501" },
      });

      // Tick 4: Dispatcher spawns Reviewer Round 2
      await h.dispatcher.tick();
      assert.equal(h.openTabs.get("w1:t1")?.label, "task-501 [IN-REVIEW r2] (claude)");
      assert.equal(h.openTabs.get("w1:t3")?.label, "review-501 r2 (pi)");

      // Reviewer Round 2 approves!
      h.threadReplies.push({
        id: "reply_rev_2",
        text: "All blocking issues fixed, tests pass.\n\nVERDICT: APPROVE",
        by: { profile: "reviewer-worker-machine-501" },
      });

      // Tick 5: Dispatcher completes task on Board and closes BOTH tabs
      await h.dispatcher.tick();
      assert.equal(h.boardTasks["501"]?.state, "completed");
      assert.equal(h.openTabs.size, 0, "all tabs should close on approval");
      assert.equal(h.dispatcher.activeWorkers.size, 0);
      assert.ok(
        h.boardCalls.some((c) => c[1] === "tasks" && c[2] === "complete" && c[3] === "501"),
      );
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("skips review and completes immediately when skipIfNoDiff is true and no git changes exist", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "swarm-review-nodiff-"));
    const repoPath = join(tmpBase, "app");
    mkdirSync(repoPath);

    try {
      const swarm = makeSwarmWithReviewer({ agent: "codex", skipIfNoDiff: true });
      const projects: ProjectsConfig = {
        projects: {
          app: {
            defaultMachine: "worker-machine",
            baseBranch: "main",
            paths: { "worker-machine": repoPath },
          },
        },
      };
      const task: BoardTask = {
        id: "502",
        channel: "projects/app",
        state: "ready",
        text: "Summarize README.md",
        labels: {},
        raw: {},
      };
      const gitDetector: GitChangeDetector = {
        captureHeadSha: () => "aaaa111",
        detectChanges: () => ({
          hasChanges: false,
          currentHeadSha: "aaaa111",
          dirtyFiles: 0,
          detail: "no local git changes",
        }),
      };

      const h = setupMockHarness({ swarm, projects, task, gitDetector });

      await h.dispatcher.tick();
      h.threadReplies.push({
        id: "reply_impl_1",
        text: "README summarizes the CLI.\n\nSTATUS: READY_FOR_REVIEW",
        by: { profile: "worker-worker-machine-502" },
      });

      await h.dispatcher.tick();
      assert.equal(h.boardTasks["502"]?.state, "completed");
      assert.equal(h.openTabs.size, 0);
      const reviewerStarts = h.herdrCalls.filter(
        (c) => c[0] === "agent" && c[1] === "start" && c[2]?.startsWith("r"),
      );
      assert.equal(reviewerStarts.length, 0, "should not spawn reviewer when there is no git diff");
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("escalates to blocked and parks [BLOCKED] tab when maxRounds is exhausted", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "swarm-review-cap-"));
    const repoPath = join(tmpBase, "app");
    mkdirSync(repoPath);

    try {
      const swarm = makeSwarmWithReviewer({ agent: "codex", maxRounds: 1 });
      const projects: ProjectsConfig = {
        projects: {
          app: {
            defaultMachine: "worker-machine",
            baseBranch: "main",
            paths: { "worker-machine": repoPath },
          },
        },
      };
      const task: BoardTask = {
        id: "503",
        channel: "projects/app",
        state: "ready",
        text: "Risky refactor",
        labels: {},
        raw: {},
      };
      const gitDetector: GitChangeDetector = {
        captureHeadSha: () => "aaaa111",
        detectChanges: () => ({
          hasChanges: true,
          currentHeadSha: "cccc333",
          dirtyFiles: 0,
          detail: "1 commit",
        }),
      };

      const h = setupMockHarness({ swarm, projects, task, gitDetector });

      await h.dispatcher.tick();
      h.threadReplies.push({
        id: "r1",
        text: "Done.\nSTATUS: READY_FOR_REVIEW",
        by: { profile: "worker-worker-machine-503" },
      });
      await h.dispatcher.tick(); // spawns round 1 reviewer

      h.threadReplies.push({
        id: "r2",
        text: "Still broken.\nVERDICT: REQUEST_CHANGES",
        by: { profile: "reviewer-worker-machine-503" },
      });
      await h.dispatcher.tick(); // maxRounds=1 exhausted -> escalate!

      assert.equal(h.boardTasks["503"]?.state, "blocked");
      assert.equal(h.dispatcher.activeWorkers.size, 0);
      assert.ok(h.dispatcher.parkedTabs.has("503"));
      assert.equal(h.openTabs.get("w1:t1")?.label, "[BLOCKED] task-503 (claude)");
      assert.ok(
        h.boardCalls.some(
          (c) => c[1] === "tasks" && c[2] === "block" && c.includes("awaiting_approval"),
        ),
      );
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

describe("mise run reviewer CLI config updates", () => {
  it("updates minimal swarm.json without bloating keys and clears stale model on agent switch", () => {
    const minimalRaw = {
      $schema: "./swarm.schema.json",
      machines: {
        "worker-machine": { role: "worker", os: "macos", maxWorkers: 2 },
      },
    };

    const setPi = applyWorkerReviewerUpdate(
      minimalRaw,
      parseReviewerCliArgs([
        "--agent",
        "pi",
        "--model",
        "openai-codex/gpt-5.4",
        "--effort",
        "high",
        "--max-rounds",
        "3",
      ]),
    );
    assert.deepEqual(Object.keys(setPi.nextRaw).toSorted(), [
      "$schema",
      "machines",
      "workerDefaults",
    ]);
    assert.equal(setPi.parsed.workerDefaults.reviewer.enabled, true);
    assert.equal(setPi.parsed.workerDefaults.reviewer.agent, "pi");
    assert.equal(setPi.parsed.workerDefaults.reviewer.model, "openai-codex/gpt-5.4");
    assert.equal(setPi.parsed.workerDefaults.reviewer.maxRounds, 3);

    // Switching agent to codex without --model drops the stale pi model
    const switchCodex = applyWorkerReviewerUpdate(
      setPi.nextRaw,
      parseReviewerCliArgs(["--agent", "codex"]),
    );
    assert.equal(switchCodex.parsed.workerDefaults.reviewer.agent, "codex");
    assert.equal(switchCodex.parsed.workerDefaults.reviewer.model, "");

    // --off disables without losing configured agent
    const disabled = applyWorkerReviewerUpdate(
      switchCodex.nextRaw,
      parseReviewerCliArgs(["--off"]),
    );
    assert.equal(disabled.parsed.workerDefaults.reviewer.enabled, false);
    assert.equal(disabled.parsed.workerDefaults.reviewer.agent, "codex");

    // --reset removes workerDefaults.reviewer cleanly
    const reset = applyWorkerReviewerUpdate(disabled.nextRaw, parseReviewerCliArgs(["--reset"]));
    assert.equal(reset.parsed.workerDefaults.reviewer.enabled, false);
    assert.equal("workerDefaults" in reset.nextRaw, false);
  });

  it("updates, disables, and resets per-project reviewer overrides cleanly", () => {
    const swarm = makeSwarmWithReviewer({ agent: "codex", effort: "high" });
    const projects: ProjectsConfig = {
      $schema: "./projects.schema.json",
      projects: {
        "my-app": {
          defaultMachine: "worker-machine",
          baseBranch: "main",
          paths: { "worker-machine": "/tmp/my-app" },
        },
      },
    };

    const setProj = applyProjectReviewerUpdate(
      projects,
      swarm,
      "my-app",
      parseReviewerCliArgs([
        "--project",
        "my-app",
        "--agent",
        "pi",
        "--model",
        "openai-codex/gpt-5.4",
      ]),
    );
    assert.equal(setProj.projects["my-app"]?.reviewer?.agent, "pi");
    assert.equal(setProj.projects["my-app"]?.reviewer?.model, "openai-codex/gpt-5.4");

    const disabledProj = applyProjectReviewerUpdate(
      setProj,
      swarm,
      "my-app",
      parseReviewerCliArgs(["--project", "my-app", "--off"]),
    );
    assert.equal(disabledProj.projects["my-app"]?.reviewer?.enabled, false);

    const inherited = applyProjectReviewerUpdate(
      disabledProj,
      swarm,
      "my-app",
      parseReviewerCliArgs(["--project", "my-app", "--inherit"]),
    );
    assert.equal(inherited.projects["my-app"]?.reviewer, undefined);

    assert.throws(
      () =>
        applyProjectReviewerUpdate(
          projects,
          swarm,
          "nonexistent",
          parseReviewerCliArgs(["--project", "nonexistent", "--agent", "codex"]),
        ),
      /not found in config\/projects\.json/i,
    );
  });
});
