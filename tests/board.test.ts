import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOARD_PROFILE_REGEX,
  BoardClient,
  BoardCommandError,
  buildBoardProfile,
  claimProfileFromActor,
  isClaimConflictError,
  MAX_BOARD_PROFILE_LENGTH,
  parseBoardErrorOutput,
  registryBoardProfile,
  type ExecRunner,
} from "../src/lib/board.ts";
import { parseSwarmConfig } from "../src/lib/config.ts";
import { buildBoardEnv } from "../src/lib/dispatcher-effects.ts";
import { reviewerBoardProfile, workerBoardProfile } from "../src/lib/routing.ts";

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

describe("buildBoardProfile / Board profile limits", () => {
  const uuidTask = "msg_0a3e4c6e-f4ed-4d2c-bef5-beed17baf5c8_1";

  it("preserves short already-valid worker, reviewer, and registry profiles verbatim", () => {
    assert.equal(workerBoardProfile("worker-machine", "1"), "worker-worker-machine-1");
    assert.equal(workerBoardProfile("worker-machine", uuidTask), "worker-worker-machine-0a3e4c6e");
    assert.equal(reviewerBoardProfile("worker-machine", "1"), "reviewer-worker-machine-1");
    assert.equal(registryBoardProfile("worker-machine"), "registry-worker-machine");
    assert.equal(registryBoardProfile("example-macbook-pro"), "registry-example-macbook-pro");
  });

  it("shortens long machine names deterministically to <= 32 valid Board profile chars", () => {
    const worker = workerBoardProfile("example-macbook-pro", uuidTask);
    const reviewer = reviewerBoardProfile("example-macbook-pro", uuidTask);
    const registry = registryBoardProfile("very-long-corporate-macbook-pro-workstation");

    for (const profile of [worker, reviewer, registry]) {
      assert.ok(
        profile.length <= MAX_BOARD_PROFILE_LENGTH,
        `expected <= 32 chars, got ${profile.length}: ${profile}`,
      );
      assert.match(profile, BOARD_PROFILE_REGEX);
    }

    assert.ok(worker.startsWith("worker-example-"));
    assert.ok(worker.endsWith("-0a3e4c6e"));
    assert.ok(reviewer.startsWith("reviewer-example-"));
    assert.ok(reviewer.endsWith("-0a3e4c6e"));
    assert.ok(registry.startsWith("registry-very-long-"));
    assert.equal(worker, workerBoardProfile("example-macbook-pro", uuidTask));
  });

  it("avoids collisions across long shared-prefix names and lossy punctuation sanitization", () => {
    const mac1 = workerBoardProfile("example-macbook-pro-1", uuidTask);
    const mac2 = workerBoardProfile("example-macbook-pro-2", uuidTask);
    assert.notEqual(mac1, mac2);
    assert.match(mac1, BOARD_PROFILE_REGEX);
    assert.match(mac2, BOARD_PROFILE_REGEX);

    const underscored = workerBoardProfile("my_host", uuidTask);
    const hyphenated = workerBoardProfile("my-host", uuidTask);
    assert.notEqual(underscored, hyphenated);
    assert.match(underscored, BOARD_PROFILE_REGEX);
    assert.equal(hyphenated, "worker-my-host-0a3e4c6e");

    const weird = buildBoardProfile("99", "___", "task_with_underscores_and_extra_length");
    assert.ok(weird.length <= MAX_BOARD_PROFILE_LENGTH);
    assert.match(weird, BOARD_PROFILE_REGEX);
  });
});

describe("BoardClient error surfacing", () => {
  it("parses Vercel CLI JSON error payloads into BoardCommandError", async () => {
    const jsonErr = JSON.stringify({
      status: "error",
      reason: "invalid_arguments",
      message: "Can't reach the board.",
      data: {
        error: {
          code: "invalid_request",
          message:
            "as: worker-example-macbook-pro-0a3e4c6e: profiles start with a letter and use up to 32 letters, numbers, and hyphens",
          status: 400,
        },
      },
    });
    const runner: ExecRunner = async () => {
      const err = new Error("Command failed: vercel board tasks claim ...") as Error & {
        stdout?: string;
        stderr?: string;
      };
      err.stdout = jsonErr;
      err.stderr = "";
      throw err;
    };

    const client = new BoardClient({}, runner);
    await assert.rejects(
      () => client.claimTaskById("msg_1", { asProfile: "worker-x-1", lease: "15m" }),
      (err: unknown) => {
        assert.ok(err instanceof BoardCommandError);
        assert.equal(err.httpStatus, 400);
        assert.equal(err.code, "invalid_request");
        assert.match(err.message, /vercel board tasks claim failed \(400 invalid_request\):/);
        assert.match(err.message, /up to 32 letters, numbers, and hyphens/);
        assert.equal(isClaimConflictError(err), false);
        return true;
      },
    );
  });

  it("includes plain stderr text when Board CLI fails without JSON", async () => {
    const stderrMsg = "Error: Not authenticated. Run `vercel login`.";
    const runner: ExecRunner = async () => {
      const err = new Error("Command failed: vercel board tasks claim ...") as Error & {
        stdout?: string;
        stderr?: string;
      };
      err.stdout = "";
      err.stderr = stderrMsg;
      throw err;
    };

    const client = new BoardClient({}, runner);
    await assert.rejects(
      () => client.claimTaskById("msg_1", { asProfile: "worker-x-1", lease: "15m" }),
      (err: unknown) => {
        assert.ok(err instanceof BoardCommandError);
        assert.match(err.message, /Not authenticated/);
        assert.equal(isClaimConflictError(err), false);
        return true;
      },
    );
  });

  it("identifies claim conflict errors (409 / already_claimed) separately from other failures", () => {
    const parsed = parseBoardErrorOutput(
      JSON.stringify({
        status: "error",
        data: {
          error: { code: "already_claimed", message: "Task is already claimed", status: 409 },
        },
      }),
      "",
    );
    assert.deepEqual(parsed, {
      code: "already_claimed",
      httpStatus: 409,
      message: "Task is already claimed",
    });

    const conflictErr = new BoardCommandError({
      message: "vercel board tasks claim failed (409 already_claimed): Task is already claimed",
      subcommand: "vercel board tasks claim",
      code: "already_claimed",
      httpStatus: 409,
      stdout: "",
      stderr: "",
    });
    assert.equal(isClaimConflictError(conflictErr), true);

    const authErr = new BoardCommandError({
      message: "vercel board tasks claim failed (401 unauthorized): Not authenticated",
      subcommand: "vercel board tasks claim",
      code: "unauthorized",
      httpStatus: 401,
      stdout: "",
      stderr: "",
    });
    assert.equal(isClaimConflictError(authErr), false);
  });
});
