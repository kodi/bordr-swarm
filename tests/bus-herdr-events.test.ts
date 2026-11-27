import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import type { SwarmEvent } from "../src/bus/events.ts";
import { HerdrEventSource, parseHerdrStatusSocket } from "../src/bus/herdr-event-source.ts";
import { ManualTimers } from "./helpers/bus-fakes.ts";

interface FakeConn {
  socket: Socket;
  requests: Array<{ id: string; method: string; params: { subscriptions: unknown[] } }>;
}

/** In-process stand-in for the Herdr server socket (newline-delimited JSON). */
class FakeHerdrServer {
  readonly path: string;
  readonly conns: FakeConn[] = [];
  reply: (req: FakeConn["requests"][number]) => unknown = (req) => ({
    id: req.id,
    result: { type: "subscription_started" },
  });
  private server: Server | null = null;

  constructor(path: string) {
    this.path = path;
  }

  async listen(): Promise<void> {
    this.server = createServer((socket) => {
      const conn: FakeConn = { socket, requests: [] };
      this.conns.push(conn);
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buf += chunk;
        let idx = buf.indexOf("\n");
        while (idx >= 0) {
          const req = JSON.parse(buf.slice(0, idx)) as FakeConn["requests"][number];
          buf = buf.slice(idx + 1);
          conn.requests.push(req);
          const res = this.reply(req);
          if (res !== undefined) socket.write(`${JSON.stringify(res)}\n`);
          idx = buf.indexOf("\n");
        }
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => this.server!.listen(this.path, resolve));
  }

  live(): FakeConn[] {
    return this.conns.filter((c) => !c.socket.destroyed);
  }

  broadcast(line: unknown): void {
    for (const c of this.live()) c.socket.write(`${JSON.stringify(line)}\n`);
  }

  dropAll(): void {
    for (const c of this.live()) c.socket.destroy();
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    this.server = null;
  }
}

async function until(pred: () => boolean, what: string): Promise<void> {
  // Real socket I/O needs real event-loop turns; a deadline bounds a broken test.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const dir = mkdtempSync(join(tmpdir(), "herdr-events-"));
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
after(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;

async function setup() {
  const server = new FakeHerdrServer(join(dir, `h${++seq}.sock`));
  await server.listen();
  const timers = new ManualTimers();
  const events: SwarmEvent[] = [];
  const source = new HerdrEventSource({
    target: "local",
    socketPath: server.path,
    onEvent: (ev) => events.push(ev),
    timers,
    backoffInitialMs: 1_000,
    backoffMaxMs: 4_000,
  });
  cleanups.push(
    () => source.stop(),
    () => server.close(),
  );
  return { server, timers, events, source };
}

describe("parseHerdrStatusSocket", () => {
  it("reads the socket line from `herdr status server`", () => {
    const out =
      "status: running\nversion: 0.9.5\nprivate_protocol: 22\nsocket: /tmp/h/herdr.sock\n";
    assert.equal(parseHerdrStatusSocket(out), "/tmp/h/herdr.sock");
    assert.equal(parseHerdrStatusSocket("status: stopped\n"), null);
  });
});

describe("HerdrEventSource", () => {
  it("subscribes to global events, reports health, and forwards parsed events", async () => {
    const { server, events, source } = await setup();
    source.start();
    await until(() => source.isHealthy, "healthy");
    assert.deepEqual(server.conns[0]?.requests[0]?.params.subscriptions, [
      { type: "tab.closed" },
      { type: "pane.exited" },
      { type: "pane.closed" },
    ]);
    server.broadcast({ event: "tab_closed", data: { tab_id: "w1:t2", type: "tab_closed" } });
    server.broadcast({ id: "other", result: { type: "ok" } });
    await until(() => events.some((e) => e.kind === "herdr.tab_closed"), "tab_closed");
    assert.deepEqual(
      events.map((e) => e.kind),
      ["source.health", "herdr.tab_closed"],
    );
    source.stop();
    await until(() => server.live().length === 0, "connections closed");
    await server.close();
  });

  it("opens one connection per watched pane and closes it when the pane is dropped", async () => {
    const { server, events, source } = await setup();
    source.setWatchedPanes(["w1:p1"]);
    source.start();
    await until(
      () => server.live().filter((c) => c.requests.length > 0).length === 2,
      "global + pane connection subscribed",
    );
    source.setWatchedPanes(["w1:p1", "w1:p2"]);
    await until(
      () => server.live().filter((c) => c.requests.length > 0).length === 3,
      "second pane connection subscribed",
    );
    const paneSubs = server.conns
      .map((c) => c.requests[0]?.params.subscriptions[0] as { type: string; pane_id?: string })
      .filter((sub) => sub?.type === "pane.agent_status_changed")
      .toSorted((a, b) => String(a.pane_id).localeCompare(String(b.pane_id)));
    assert.deepEqual(paneSubs, [
      { type: "pane.agent_status_changed", pane_id: "w1:p1" },
      { type: "pane.agent_status_changed", pane_id: "w1:p2" },
    ]);

    const pane2 = server.conns.find((c) =>
      JSON.stringify(c.requests[0]?.params.subscriptions).includes("w1:p2"),
    )!;
    pane2.socket.write(
      `${JSON.stringify({ event: "pane_agent_status_changed", data: { pane_id: "w1:p2", workspace_id: "w1", agent_status: "idle", agent: "claude" } })}\n`,
    );
    await until(() => events.some((e) => e.kind === "herdr.agent_status"), "agent status");

    source.setWatchedPanes(["w1:p2"]);
    await until(() => server.live().length === 2, "pane 1 connection closed");
    assert.deepEqual(source.watchedPaneIds, ["w1:p2"]);
    source.stop();
    await until(() => server.live().length === 0, "all closed");
    await server.close();
  });

  it("reconnects with backoff and re-subscribes after the server drops connections", async () => {
    const { server, timers, events, source } = await setup();
    source.setWatchedPanes(["w1:p9"]);
    source.start();
    await until(() => source.isHealthy && server.live().length === 2, "connected");
    server.dropAll();
    await until(() => !source.isHealthy, "unhealthy");
    assert.equal(server.live().length, 0);
    timers.advance(1_000);
    await until(
      () => source.isHealthy && server.live().filter((c) => c.requests.length > 0).length === 2,
      "reconnected",
    );
    assert.equal(server.conns.length, 4);
    const resubscribed = server
      .live()
      .map((c) => JSON.stringify(c.requests[0]?.params.subscriptions))
      .toSorted();
    assert.deepEqual(
      resubscribed,
      [
        JSON.stringify([{ type: "pane.agent_status_changed", pane_id: "w1:p9" }]),
        JSON.stringify([{ type: "tab.closed" }, { type: "pane.exited" }, { type: "pane.closed" }]),
      ].toSorted(),
    );
    const health = events.filter((e) => e.kind === "source.health");
    assert.deepEqual(
      health.map((e) => (e.kind === "source.health" ? e.healthy : null)),
      [true, false, true],
    );
    source.stop();
    await server.close();
    assert.equal(timers.pendingCount, 0);
  });

  it("falls back (unhealthy, retrying) when the socket is missing or subscribe is rejected", async () => {
    const timers = new ManualTimers();
    const events: SwarmEvent[] = [];
    const logs: string[] = [];
    const missing = new HerdrEventSource({
      target: "local",
      socketPath: join(dir, "nope.sock"),
      onEvent: (ev) => events.push(ev),
      log: (_l, m) => logs.push(m),
      timers,
    });
    cleanups.push(() => missing.stop());
    missing.start();
    await until(() => events.length === 1, "unhealthy event");
    assert.deepEqual(events[0], {
      kind: "source.health",
      source: "herdr",
      healthy: false,
      detail: (events[0] as { detail: string }).detail,
    });
    timers.advance(1_000);
    await until(() => timers.pendingCount === 1, "second retry scheduled");
    assert.equal(logs.length, 1, "logs the fallback once");
    missing.stop();
    assert.equal(timers.pendingCount, 0);

    const { server, source, events: evs2 } = await setup();
    server.reply = (req) => ({
      id: req.id,
      error: { code: "bad", message: "unknown subscription" },
    });
    source.start();
    await until(() => evs2.some((e) => e.kind === "source.health" && !e.healthy), "rejected");
    source.stop();
    await server.close();
  });

  it("reopens pane subscriptions after stop() and start()", async () => {
    const { server, source } = await setup();
    source.setWatchedPanes(["w1:p5"]);
    source.start();
    await until(
      () => server.live().filter((c) => c.requests.length > 0).length === 2,
      "first start subscribed",
    );
    source.stop();
    await until(() => server.live().length === 0, "closed");
    source.start();
    await until(
      () => server.live().filter((c) => c.requests.length > 0).length === 2,
      "restart re-subscribed the pane",
    );
  });

  it("is disabled for a non-local herdrTarget", () => {
    const events: SwarmEvent[] = [];
    const source = new HerdrEventSource({
      target: "remote-box",
      socketPath: "/does/not/matter",
      onEvent: (ev) => events.push(ev),
      connect: () => assert.fail("must not connect"),
    });
    assert.equal(source.enabled, false);
    source.start();
    source.setWatchedPanes(["p1"]);
    assert.equal(source.isHealthy, false);
    assert.deepEqual(events, []);
  });
});
