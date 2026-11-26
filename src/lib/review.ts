import { execFileSync } from "node:child_process";
import type { BoardMessage } from "./board.ts";

export type ReviewVerdict = "approve" | "request_changes";

export interface GitChangeCheck {
  hasChanges: boolean;
  currentHeadSha: string | null;
  dirtyFiles: number;
  detail: string;
}

export interface GitChangeDetector {
  captureHeadSha(repoPath: string): string | null;
  detectChanges(repoPath: string, startHeadSha: string | null, baseBranch: string): GitChangeCheck;
}

function getMessageProfile(msg: BoardMessage): string {
  return (msg.by?.profile ?? msg.author?.name ?? "").trim().toLowerCase();
}

/**
 * Detects an implementer handoff marker (`STATUS: READY_FOR_REVIEW`) in a Board reply.
 * Tolerates surrounding Markdown formatting (bold/backticks/whitespace).
 */
export function parseReadyForReviewSignal(text: string): boolean {
  return /(?:^|\s)[*_`]*STATUS\s*:\s*READY_FOR_REVIEW[*_`]*(?:\s|$|[.,!])/im.test(text);
}

/**
 * Extracts the final reviewer verdict (`VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`)
 * from a Board reply. Uses the last match so quoted instructions earlier in the text do not collide.
 */
export function parseReviewVerdict(text: string): ReviewVerdict | null {
  const re = /(?:^|\s)[*_`]*VERDICT\s*:\s*(APPROVE|REQUEST_CHANGES)[*_`]*(?:\s|$|[.,!])/gim;
  let last: ReviewVerdict | null = null;
  for (const match of text.matchAll(re)) {
    const raw = match[1]?.toUpperCase();
    if (raw === "APPROVE") last = "approve";
    else if (raw === "REQUEST_CHANGES") last = "request_changes";
  }
  return last;
}

export function extractOneLineSummary(text: string, fallback: string, maxLen = 200): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (/^[*_`]*STATUS\s*:/i.test(l)) return false;
      if (/^[*_`]*VERDICT\s*:/i.test(l)) return false;
      if (l.startsWith("```")) return false;
      return true;
    })
    .map((l) =>
      l
        .replace(/^#+\s*/, "")
        .replace(/^[-*]\s+/, "")
        .replace(/\*\*/g, "")
        .trim(),
    )
    .filter(Boolean);

  const chosen = lines[0] ?? fallback;
  if (chosen.length <= maxLen) return chosen;
  return `${chosen.slice(0, maxLen - 1)}…`;
}

export function findReadyForReviewReply(
  replies: BoardMessage[],
  seenReplyIds: ReadonlySet<string>,
  reviewerProfile?: string,
): { reply: BoardMessage; summary: string } | null {
  const excluded = reviewerProfile?.trim().toLowerCase() ?? "";
  let found: BoardMessage | null = null;

  for (const reply of replies) {
    if (reply.deleted || seenReplyIds.has(reply.id)) continue;
    const prof = getMessageProfile(reply);
    if (excluded && prof === excluded) continue;
    if (parseReadyForReviewSignal(reply.text)) {
      found = reply;
    }
  }

  if (!found) return null;
  return {
    reply: found,
    summary: extractOneLineSummary(found.text, "Implementation ready for review"),
  };
}

export function findReviewVerdictReply(
  replies: BoardMessage[],
  seenReplyIds: ReadonlySet<string>,
  reviewerProfile: string,
): { reply: BoardMessage; verdict: ReviewVerdict; summary: string } | null {
  const targetProfile = reviewerProfile.trim().toLowerCase();
  let matchedByProfile: { reply: BoardMessage; verdict: ReviewVerdict } | null = null;
  let fallbackMatch: { reply: BoardMessage; verdict: ReviewVerdict } | null = null;

  for (const reply of replies) {
    if (reply.deleted || seenReplyIds.has(reply.id)) continue;
    const verdict = parseReviewVerdict(reply.text);
    if (!verdict) continue;

    const prof = getMessageProfile(reply);
    if (targetProfile && prof === targetProfile) {
      matchedByProfile = { reply, verdict };
    } else if (!targetProfile || prof.startsWith("reviewer-")) {
      fallbackMatch = { reply, verdict };
    }
  }

  const chosen = matchedByProfile ?? fallbackMatch;
  if (!chosen) return null;

  return {
    reply: chosen.reply,
    verdict: chosen.verdict,
    summary: extractOneLineSummary(
      chosen.reply.text,
      chosen.verdict === "approve" ? "Approved by reviewer" : "Changes requested by reviewer",
    ),
  };
}

function runGit(repoPath: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

export function captureGitHeadSha(repoPath: string): string | null {
  const sha = runGit(repoPath, ["rev-parse", "HEAD"]);
  return sha && sha.length >= 7 ? sha : null;
}

export function detectGitChanges(
  repoPath: string,
  startHeadSha: string | null,
  baseBranch: string,
): GitChangeCheck {
  const currentHeadSha = captureGitHeadSha(repoPath);
  const porcelain = runGit(repoPath, ["status", "--porcelain"]);
  const dirtyLines = porcelain ? porcelain.split(/\r?\n/).filter((line) => line.trim() !== "") : [];

  if (dirtyLines.length > 0) {
    return {
      hasChanges: true,
      currentHeadSha,
      dirtyFiles: dirtyLines.length,
      detail: `${dirtyLines.length} uncommitted file(s)`,
    };
  }

  if (startHeadSha && currentHeadSha && startHeadSha !== currentHeadSha) {
    const countRaw = runGit(repoPath, ["rev-list", "--count", `${startHeadSha}..HEAD`]);
    const commitCount = countRaw ? Number(countRaw) : 1;
    const diffStat = runGit(repoPath, ["diff", "--stat", `${startHeadSha}..HEAD`]);
    if (diffStat && diffStat.trim().length > 0) {
      return {
        hasChanges: true,
        currentHeadSha,
        dirtyFiles: 0,
        detail: `${Number.isFinite(commitCount) ? commitCount : 1} commit(s) since ${startHeadSha.slice(0, 7)}`,
      };
    }
    return {
      hasChanges: false,
      currentHeadSha,
      dirtyFiles: 0,
      detail: "empty diff since start commit",
    };
  }

  if (!startHeadSha && currentHeadSha && baseBranch) {
    const diffStat = runGit(repoPath, ["diff", "--stat", `${baseBranch}...HEAD`]);
    if (diffStat && diffStat.trim().length > 0) {
      return {
        hasChanges: true,
        currentHeadSha,
        dirtyFiles: 0,
        detail: `changes relative to ${baseBranch}`,
      };
    }
  }

  return {
    hasChanges: false,
    currentHeadSha,
    dirtyFiles: 0,
    detail: "no local git changes",
  };
}

export const defaultGitChangeDetector: GitChangeDetector = {
  captureHeadSha: captureGitHeadSha,
  detectChanges: detectGitChanges,
};

export function renderReviewerPrompt(
  template: string,
  vars: {
    taskId: string;
    channel: string;
    project: string;
    boardProfile: string;
    baseRef: string;
    branch: string;
    round: number;
    maxRounds: number;
    reviewerProfile: string;
    humanHandle: string;
  },
): string {
  return template
    .replaceAll("{{TASK_ID}}", vars.taskId)
    .replaceAll("{{CHANNEL}}", vars.channel)
    .replaceAll("{{PROJECT}}", vars.project)
    .replaceAll("{{BOARD_PROFILE}}", vars.boardProfile)
    .replaceAll("{{BASE_REF}}", vars.baseRef)
    .replaceAll("{{BRANCH}}", vars.branch)
    .replaceAll("{{ROUND}}", String(vars.round))
    .replaceAll("{{MAX_ROUNDS}}", String(vars.maxRounds))
    .replaceAll("{{REVIEWER_PROFILE}}", vars.reviewerProfile)
    .replaceAll("{{HUMAN_HANDLE}}", vars.humanHandle);
}

export function buildFixRoundPrompt(vars: {
  taskId: string;
  round: number;
  maxRounds: number;
  reviewerProfile: string;
}): string {
  return [
    `Code review round ${vars.round}/${vars.maxRounds} by \`${vars.reviewerProfile}\` requested changes on task \`${vars.taskId}\`.`,
    "",
    "1. Read the reviewer's comments on the Vercel Board thread:",
    `   \`vercel board read ${vars.taskId}\``,
    "2. Address all blocking issues raised by the reviewer, re-run verification/tests, and commit your fixes on the current task branch.",
    `3. Post a concise reply to thread \`${vars.taskId}\` explaining what you fixed and end the reply with \`STATUS: READY_FOR_REVIEW\` (do NOT call \`vercel board tasks complete\`).`,
    `4. Stop cleanly once posted — the Dispatcher will launch review round ${vars.round + 1}/${vars.maxRounds}.`,
  ].join("\n");
}
