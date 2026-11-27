import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect } from "vitest";
import { BoardClient, type ExecRunner } from "../../../../src/lib/board.ts";
import { test } from "../fixtures/swarm-test.ts";

const execFileAsync = promisify(execFile);

test("both `vb` and `vercel board` authenticate and run against the self-hosted container board without vercel login", async ({
  compose,
  swarm,
}) => {
  // 1. Host-side `vb` against ephemeral host port
  const hostWhoami = await swarm.vbJson<Record<string, unknown>>(["whoami"]);
  expect(String(hostWhoami.handle ?? "")).toContain("owner");

  // 2. Container-side `vercel board` against http://board:4100/api/board with NO ~/.config/com.vercel.cli login
  const vercelWhoami = await compose.exec("worker-1", [
    "vercel",
    "board",
    "whoami",
    "--json",
    "--url",
    "http://board:4100/api/board",
  ]);
  expect(vercelWhoami.status, `stderr=${vercelWhoami.stderr}`).toBe(0);
  const parsed = JSON.parse(vercelWhoami.stdout) as Record<string, unknown>;
  expect(String(parsed.handle ?? "")).toContain("owner");

  // 3. Verify `vercel board` can post and read on the self-hosted board
  const postRes = await compose.exec("worker-1", [
    "vercel",
    "board",
    "post",
    "smoke",
    "hello from vercel cli",
    "--as",
    "cli-smoke",
    "--json",
    "--url",
    "http://board:4100/api/board",
  ]);
  expect(postRes.status, `stderr=${postRes.stderr}`).toBe(0);
  const posted = JSON.parse(postRes.stdout) as { message?: { id?: string } };
  expect(posted.message?.id).toBeTruthy();

  const readBack = await swarm.vbJson<{ message?: { text?: string } }>([
    "read",
    posted.message!.id!,
  ]);
  expect(readBack.message?.text).toBe("hello from vercel cli");
});

test("workers automatically publish their capabilities to #swarm/registry on boot", async ({
  swarm,
}) => {
  // Wait for both worker-1 and worker-2 to publish registry entries after reset/restart.
  const deadline = Date.now() + 30_000;
  let texts: string[] = [];
  while (Date.now() < deadline) {
    try {
      const channel = await swarm.vbJson<{ threads?: Array<{ message?: { text?: string } }> }>([
        "read",
        "swarm/registry",
      ]);
      texts = (channel.threads ?? []).map((t) => String(t.message?.text ?? ""));
      if (
        texts.some((t) => t.includes('"worker-1"')) &&
        texts.some((t) => t.includes('"worker-2"')) &&
        texts.some((t) => t.includes('"worker-3"'))
      ) {
        break;
      }
    } catch {
      // Channel may not exist yet before the first worker tick.
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  expect(texts.some((t) => t.includes('"worker-1"') && t.includes('"demo-app"'))).toBe(true);
  expect(texts.some((t) => t.includes('"worker-2"') && t.includes('"demo-app"'))).toBe(true);
  expect(
    texts.some(
      (t) => t.includes('"worker-3"') && t.includes('"demo-app"') && t.includes('"runtime": "rex"'),
    ),
  ).toBe(true);
});

test("BoardClient.listTasks paginates across multiple pages with --after against real @vercel/board", async ({
  swarm,
}) => {
  // Use an unregistered project channel so workers do not claim these tasks while we paginate.
  const createdIds: string[] = [];
  for (let i = 1; i <= 12; i += 1) {
    const { id } = await swarm.createTask(
      "projects/pagination-test",
      `Paginated task #${String(i).padStart(2, "0")}`,
    );
    createdIds.push(id);
  }

  const pageArgs: string[][] = [];
  const warnings: string[] = [];
  const runner: ExecRunner = async (cmd, args, opts) => {
    pageArgs.push(args);
    const res = await execFileAsync(cmd, args, {
      encoding: "utf8",
      timeout: opts?.timeoutMs ?? 30_000,
      env: {
        ...process.env,
        BOARD_URL: swarm.config.boardUrl,
        BOARD_TOKEN: swarm.config.boardToken,
      },
    });
    return { stdout: res.stdout, stderr: res.stderr };
  };

  const client = new BoardClient(
    {
      url: swarm.config.boardUrl,
      binary: swarm.vbBin,
      onWarn: (msg) => warnings.push(msg),
    },
    runner,
  );

  // Page size 5 over 12 tasks => 5 + 5 + 2 (short final page must terminate cleanly even if cursor is non-null).
  const listed = await client.listTasks("projects/pagination-test", { state: "open", limit: 5 });

  expect(warnings).toEqual([]);
  expect(pageArgs.length).toBe(3);
  expect(pageArgs[0]).not.toContain("--after");
  expect(pageArgs[1]).toContain("--after");
  expect(pageArgs[2]).toContain("--after");

  const listedIds = listed.map((t) => t.id);
  expect(new Set(listedIds).size).toBe(12);
  for (const id of createdIds) {
    expect(listedIds).toContain(id);
  }

  // Also test exact multiple of page size (4 + 4 + 4 + 0 empty final page).
  pageArgs.length = 0;
  const listedExact = await client.listTasks("projects/pagination-test", {
    state: "open",
    limit: 4,
  });
  expect(warnings).toEqual([]);
  expect(pageArgs.length).toBe(4);
  expect(listedExact.length).toBe(12);
});
