import { expect } from "vitest";
import { test } from "../fixtures/swarm-test.ts";

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
        texts.some((t) => t.includes('"worker-2"'))
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
});
