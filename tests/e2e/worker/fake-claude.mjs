#!/usr/bin/env node
/**
 * Hermetic, provider-free fake `claude` CLI for real Herdr + Vercel Board E2E tests.
 *
 * - Announces Claude readiness markers + reports `idle` via Herdr's `pane.report_agent` Unix socket
 *   so real `herdr agent start --kind claude` succeeds deterministically.
 * - Reads the prompt delivered by `herdr agent prompt` over the PTY, reports `working`, reads the
 *   real task thread from the self-hosted Board using the real Board CLI (`vercel board` or `vb`),
 *   executes scripted directives found in the task text, and reports `idle`.
 *
 * Supported task directives:
 *   [sleep:<ms>]          Wait `<ms>` milliseconds before completing (for crash/lease tests).
 *   [commit:<filename>]   Create `<filename>` in the repo checkout and git commit it.
 *   [block:<reason>]      Block the task (`tasks block`) with `<reason>` and stay open.
 *   [fail-exit]           Exit non-zero without completing (tests unexpected exit handling).
 *   [review-ready]        Reply with `STATUS: READY_FOR_REVIEW` instead of completing.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Set /proc/<pid>/comm to "claude" so Herdr's process detector recognizes the pane as Claude Code.
process.title = "claude";

const BOARD_BIN = process.env.BOARD_CLI_BIN || "vercel";
const IS_VERCEL = BOARD_BIN === "vercel" || BOARD_BIN.endsWith("/vercel");

function runBoard(subArgs) {
  const args = IS_VERCEL ? ["board", ...subArgs] : [...subArgs];
  if (process.env.BOARD_URL) {
    args.push("--url", process.env.BOARD_URL);
  }
  return execFileSync(BOARD_BIN, args, {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
}

function reportHerdrState(state) {
  const paneId = process.env.HERDR_PANE_ID;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!paneId || !socketPath) return Promise.resolve();

  const payload = `${JSON.stringify({
    id: `fake-claude:${process.pid}:${Date.now()}:${state}`,
    method: "pane.report_agent",
    params: {
      pane_id: paneId,
      source: "herdr:claude",
      agent: "claude",
      seq: Date.now() * 1000,
      state,
    },
  })}\n`;

  return new Promise((resolve) => {
    const sock = createConnection(socketPath);
    sock.setTimeout(2_000);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", () => {
      sock.end();
      resolve();
    });
    sock.on("error", () => resolve());
    sock.on("timeout", () => {
      sock.destroy();
      resolve();
    });
  });
}

function normalizePrompt(raw) {
  return raw
    .replaceAll("\x1b[200~", "")
    .replaceAll("\x1b[201~", "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
}

function readPromptFromStdin(idleMs = 600) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    let buf = "";
    let timer = null;

    const finish = () => {
      if (timer) clearTimeout(timer);
      process.stdin.off("data", onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      resolve(normalizePrompt(buf));
    };

    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      if (timer) clearTimeout(timer);
      // Only settle once we received non-whitespace payload bytes.
      if (normalizePrompt(buf).length > 0) {
        timer = setTimeout(finish, idleMs);
      }
    };

    process.stdin.on("data", onData);
  });
}

function extractTaskId(prompt) {
  const match =
    prompt.match(/vercel board read\s+([A-Za-z0-9_-]+)/) ??
    prompt.match(/task\s+#?([A-Za-z0-9_-]+)/i) ??
    prompt.match(/msg_[A-Za-z0-9_-]+/);
  return match ? (match[1] ?? match[0]) : null;
}

async function handleTurn(prompt) {
  await reportHerdrState("working");
  process.stdout.write("\x1b]0;⠂ Working\x07\n");

  const taskId = extractTaskId(prompt);
  if (!taskId) {
    process.stdout.write("fake-claude: could not find task ID in prompt\n");
    await reportHerdrState("idle");
    return;
  }

  let taskText = "";
  try {
    const raw = runBoard(["read", taskId, "--json"]);
    const parsed = JSON.parse(raw);
    taskText = String(parsed?.message?.text ?? "");
  } catch (err) {
    process.stderr.write(
      `fake-claude: board read failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  const sleepMatch = taskText.match(/\[sleep:(\d+)\]/);
  if (sleepMatch) {
    await delay(Number.parseInt(sleepMatch[1], 10));
  }

  if (taskText.includes("[fail-exit]")) {
    process.stdout.write("fake-claude: simulated fatal crash on task\n");
    process.exit(1);
  }

  const blockMatch = taskText.match(/\[block:([^\]]+)\]/);
  if (blockMatch) {
    runBoard(["tasks", "block", taskId, blockMatch[1].trim(), "--kind", "needs_input"]);
    await reportHerdrState("idle");
    process.stdout.write("\x1b]0;✳ Claude Code\x07\n❯ \n");
    return;
  }

  const commitMatch = taskText.match(/\[commit:([^\]]+)\]/);
  if (commitMatch) {
    const filename = commitMatch[1].trim();
    writeFileSync(
      join(process.cwd(), filename),
      `created by ${process.env.BOARD_PROFILE ?? "fake-claude"}\n`,
    );
    execFileSync("git", ["add", filename], { stdio: "ignore" });
    execFileSync("git", ["commit", "-m", `task ${taskId}: add ${filename}`], { stdio: "ignore" });
  }

  const machine = process.env.SWARM_MACHINE ?? "worker";
  runBoard([
    "reply",
    taskId,
    `fake-claude (${process.env.BOARD_PROFILE ?? machine}) processed task ${taskId}`,
  ]);

  if (taskText.includes("[review-ready]")) {
    runBoard(["reply", taskId, "Changes ready.\nSTATUS: READY_FOR_REVIEW"]);
  } else {
    runBoard(["tasks", "complete", taskId, `Completed by fake-claude on ${machine}`]);
  }

  await reportHerdrState("idle");
  process.stdout.write(
    "\x1b]0;✳ Claude Code\x07\n──────────────────────────────────────────────────────\n❯ \n──────────────────────────────────────────────────────\n",
  );
}

// Announce Claude UI prompt + Herdr idle state so `herdr agent start --kind claude` succeeds.
process.stdout.write(
  "\x1b]0;✳ Claude Code\x07\n──────────────────────────────────────────────────────\n❯ \n──────────────────────────────────────────────────────\n",
);
await reportHerdrState("idle");

// Multi-turn loop: stay interactive until the dispatcher closes the tab.
while (true) {
  const prompt = await readPromptFromStdin();
  if (!prompt) break;
  await handleTurn(prompt);
}
