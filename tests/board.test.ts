import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BoardClient, claimProfileFromActor, type ExecRunner } from "../src/lib/board.ts";
import { parseSwarmConfig } from "../src/lib/config.ts";
import { buildBoardEnv } from "../src/lib/dispatcher-effects.ts";

describe("claimProfileFromActor", () => {
  it("strips principal prefix for both vercel and self-hosted/local actors", () => {
    assert.equal(claimProfileFromActor("vercel:user:u123+worker-mac-abc"), "worker-mac-abc");
    assert.equal(claimProfileFromActor("local:user:test+worker-1-abc"), "worker-1-abc");
    assert.equal(claimProfileFromActor("tailscale:user:ada+lead"), "lead");
    assert.equal(claimProfileFromActor("worker-plain"), "worker-plain");
  });
});

describe("BoardClient URL and binary handling", () => {
  it("passes --url and omits --scope/--name when url is set", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: ExecRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '{"handle":"@owner"}', stderr: "" };
    };

    const client = new BoardClient(
      {
        url: "http://board:4100/api/board",
        scope: "ignored-team",
        boardName: "ignored-name",
      },
      runner,
    );
    await client.whoami();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cmd, "vercel");
    assert.deepEqual(calls[0]?.args, [
      "board",
      "whoami",
      "--json",
      "--url",
      "http://board:4100/api/board",
    ]);
  });

  it("omits the board subcommand prefix when using the standalone vb binary", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: ExecRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '{"handle":"@owner"}', stderr: "" };
    };

    const client = new BoardClient(
      {
        binary: "vb",
        url: "http://board:4100/api/board",
      },
      runner,
    );
    await client.whoami();

    assert.equal(calls[0]?.cmd, "vb");
    assert.deepEqual(calls[0]?.args, ["whoami", "--json", "--url", "http://board:4100/api/board"]);
  });
});

describe("buildBoardEnv", () => {
  it("forwards BOARD_URL and BOARD_TOKEN and suppresses VERCEL_SCOPE when targeting a custom board", () => {
    const swarm = parseSwarmConfig({
      board: {
        url: "http://board:4100/api/board",
        scope: "my-team",
      },
      machines: {
        "worker-1": { role: "worker", os: "linux" },
      },
    });

    const env = buildBoardEnv(swarm, "worker-1-abc", { BOARD_TOKEN: "test-secret" });
    assert.deepEqual(env, {
      BOARD_PROFILE: "worker-1-abc",
      BOARD_URL: "http://board:4100/api/board",
      BOARD_TOKEN: "test-secret",
    });
  });
});
