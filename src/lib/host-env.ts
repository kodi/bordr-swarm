import { execFileSync } from "node:child_process";
import { hostname, userInfo } from "node:os";

export interface VercelBoardIdentity {
  ok: boolean;
  handle: string;
  boardUrl: string;
  team: string;
  rawSummary: string;
  error: string;
}

export interface TailscaleInfo {
  ok: boolean;
  dnsName: string;
  online: boolean;
}

export function firstMeaningfulLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^Vercel CLI\s+\d/i.test(line));
  return lines[0] ?? text.split("\n")[0]?.trim() ?? "";
}

export function runQuickCommand(
  cmd: string,
  args: string[],
  timeoutMs = 15_000,
): { ok: boolean; stdout: string; stderr: string; output: string } {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    const trimmed = out.trim();
    return { ok: true, stdout: trimmed, stderr: "", output: trimmed };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const stdout = typeof e.stdout === "string" ? e.stdout.trim() : "";
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    const combined = [stderr, stdout, e.message]
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .join("\n")
      .trim();
    return { ok: false, stdout, stderr, output: combined || String(err) };
  }
}

export function detectLocalHostnames(): { full: string; short: string; sanitizedName: string } {
  const full = hostname().trim();
  const short = (full.split(".")[0] ?? full).trim();
  const sanitizedName =
    short
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "my-machine";
  return { full, short, sanitizedName };
}

export function detectVercelBoardIdentity(): VercelBoardIdentity {
  const res = runQuickCommand("vercel", ["board", "whoami", "--json"], 15_000);
  if (!res.ok) {
    return {
      ok: false,
      handle: "",
      boardUrl: "",
      team: "",
      rawSummary: "",
      error: firstMeaningfulLine(res.output) || "not authenticated",
    };
  }

  const startIdx = res.stdout.indexOf("{");
  if (startIdx === -1) {
    return {
      ok: true,
      handle: "",
      boardUrl: "",
      team: "",
      rawSummary: firstMeaningfulLine(res.stdout),
      error: "",
    };
  }

  try {
    const parsed = JSON.parse(res.stdout.slice(startIdx)) as {
      handle?: unknown;
      username?: unknown;
      board?: unknown;
      team?: unknown;
      scope?: unknown;
      user?: { handle?: unknown; username?: unknown };
    };
    const rawHandle =
      (typeof parsed.handle === "string" && parsed.handle) ||
      (typeof parsed.user?.handle === "string" && parsed.user.handle) ||
      (typeof parsed.username === "string" && parsed.username) ||
      (typeof parsed.user?.username === "string" && parsed.user.username) ||
      "";
    const handle = rawHandle ? (rawHandle.startsWith("@") ? rawHandle : `@${rawHandle}`) : "";
    const boardUrl = typeof parsed.board === "string" ? parsed.board.trim() : "";
    const team =
      (typeof parsed.team === "string" && parsed.team.trim()) ||
      (typeof parsed.scope === "string" && parsed.scope.trim()) ||
      "";
    const summaryParts = [handle || undefined, boardUrl || undefined].filter(Boolean);
    return {
      ok: true,
      handle,
      boardUrl,
      team,
      rawSummary: summaryParts.join(" | ") || firstMeaningfulLine(res.stdout),
      error: "",
    };
  } catch {
    return {
      ok: true,
      handle: "",
      boardUrl: "",
      team: "",
      rawSummary: firstMeaningfulLine(res.stdout),
      error: "",
    };
  }
}

export function detectTailscaleInfo(): TailscaleInfo {
  const res = runQuickCommand("tailscale", ["status", "--json"], 5_000);
  if (!res.ok) {
    return { ok: false, dnsName: "", online: false };
  }
  const startIdx = res.stdout.indexOf("{");
  if (startIdx === -1) {
    return { ok: false, dnsName: "", online: false };
  }
  try {
    const parsed = JSON.parse(res.stdout.slice(startIdx)) as {
      Self?: { DNSName?: unknown; Online?: unknown };
    };
    const rawDns = typeof parsed.Self?.DNSName === "string" ? parsed.Self.DNSName.trim() : "";
    const dnsName = rawDns.replace(/\.+$/, "");
    const online = parsed.Self?.Online === true;
    return { ok: Boolean(dnsName), dnsName, online };
  } catch {
    return { ok: false, dnsName: "", online: false };
  }
}

export function detectLinuxLinger(): {
  supported: boolean;
  enabled: boolean;
  user: string;
} {
  if (process.platform !== "linux") {
    return { supported: false, enabled: true, user: "" };
  }
  let username = process.env.USER ?? "";
  try {
    username = userInfo().username || username;
  } catch {
    // Keep env fallback
  }
  if (!username) {
    return { supported: false, enabled: true, user: "" };
  }
  const res = runQuickCommand(
    "loginctl",
    ["show-user", username, "-p", "Linger", "--value"],
    5_000,
  );
  if (!res.ok) {
    return { supported: false, enabled: true, user: username };
  }
  return {
    supported: true,
    enabled: res.stdout.trim().toLowerCase() === "yes",
    user: username,
  };
}

export function detectInstalledAgentKinds(extraKinds: string[] = []): string[] {
  const candidates = [...new Set(["claude", "agy", "codex", "pi", ...extraKinds])];
  const found: string[] = [];
  for (const kind of candidates) {
    const res = runQuickCommand("which", [kind], 5_000);
    if (res.ok) {
      found.push(kind);
    }
  }
  return found;
}
