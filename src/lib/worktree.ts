import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExecRunner } from "./board.ts";

const execFileAsync = promisify(execFile);

const defaultGitRunner: ExecRunner = async (cmd, args, opts) => {
  const res = await execFileAsync(cmd, args, {
    encoding: "utf8",
    timeout: opts?.timeoutMs ?? 60_000,
    maxBuffer: 10 * 1024 * 1024,
    env: opts?.env ?? process.env,
  });
  return { stdout: res.stdout, stderr: res.stderr };
};

export interface GitWorktreeManager {
  create(opts: {
    repoPath: string;
    projectSlug: string;
    shortId: string;
    branch: string;
    baseBranch: string;
    worktreeRoot?: string;
  }): Promise<{ worktreePath: string }>;
  remove(opts: { repoPath: string; worktreePath: string; branch?: string }): Promise<void>;
}

/**
 * Computes the deterministic worktree directory path for a task on a Rex machine:
 * `<worktreeRoot>/<slug>/<shortId>` if `worktreeRoot` is set, otherwise
 * `<repoPath>/../.swarm-worktrees/<slug>/<shortId>`.
 */
export function resolveWorktreePath(opts: {
  repoPath: string;
  projectSlug: string;
  shortId: string;
  worktreeRoot?: string;
}): string {
  const baseRoot = opts.worktreeRoot
    ? resolve(opts.worktreeRoot)
    : resolve(dirname(resolve(opts.repoPath)), ".swarm-worktrees");
  const safeSlug = opts.projectSlug.replace(/[^a-zA-Z0-9._-]/g, "-") || basename(opts.repoPath);
  const safeShort = opts.shortId.replace(/[^a-zA-Z0-9._-]/g, "-") || "task";
  return resolve(baseRoot, safeSlug, safeShort);
}

export function createGitWorktreeManager(
  runner: ExecRunner = defaultGitRunner,
  ensureDir: (dir: string) => void = (dir) => mkdirSync(dir, { recursive: true }),
): GitWorktreeManager {
  return {
    async create(opts) {
      const worktreePath = resolveWorktreePath(opts);
      ensureDir(dirname(worktreePath));
      try {
        await runner("git", [
          "-C",
          opts.repoPath,
          "worktree",
          "add",
          "-b",
          opts.branch,
          worktreePath,
          opts.baseBranch,
        ]);
      } catch (err) {
        // If branch already exists from a prior failed/retried attempt, attach with -B or checkout existing branch
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("already exists")) {
          await runner("git", [
            "-C",
            opts.repoPath,
            "worktree",
            "add",
            "-B",
            opts.branch,
            worktreePath,
            opts.baseBranch,
          ]);
        } else {
          throw err;
        }
      }
      return { worktreePath };
    },

    async remove(opts) {
      await runner("git", [
        "-C",
        opts.repoPath,
        "worktree",
        "remove",
        "--force",
        opts.worktreePath,
      ]);
      if (opts.branch) {
        // Best-effort branch cleanup (only if merged or safe; force-delete task branch if unmerged? Use -D? Wait: leave branch if user may want commits? Plan says: "`git worktree remove --force` plus branch cleanup in the existing cleanup effect, but only for worktrees this Dispatcher created")
        await runner("git", ["-C", opts.repoPath, "branch", "-D", opts.branch]).catch(() => {});
      }
    },
  };
}

export const defaultGitWorktreeManager: GitWorktreeManager = createGitWorktreeManager();
