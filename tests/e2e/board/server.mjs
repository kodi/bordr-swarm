import { createServer } from "node:http";
import { board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";

const MOUNT = "/api/board";
const PORT = Number.parseInt(process.env.PORT ?? "4100", 10);
const EXPECTED_TOKEN = (process.env.BOARD_TOKEN ?? "bordr-e2e-test-token").trim();
const HANDLE = (process.env.BOARD_HANDLE ?? "owner").trim();
const BODY_MAX = 8 * 1024 * 1024;

// Suppress Node's experimental SQLite stderr warning so logs stay clean.
const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === "string" ? warning : (warning?.message ?? "");
  if (/SQLite is an experimental feature/.test(text)) return;
  return origEmitWarning(warning, ...rest);
};

let currentBackend = null;
let currentTeam = null;

async function initBoard() {
  const prev = currentBackend;
  const backend = local({ memory: true });
  const team = board({
    backend,
    basePath: MOUNT,
    authenticate: (request) => {
      if (!request.credential || request.credential !== EXPECTED_TOKEN) {
        return null;
      }
      return {
        id: `local:user:${HANDLE}`,
        kind: "person",
        handle: HANDLE,
      };
    },
  });
  // Warm up SQLite schema before serving traffic.
  await team.channels({ limit: 1 });
  currentBackend = backend;
  currentTeam = team;
  if (prev) {
    await prev.close().catch(() => {});
  }
}

async function forwardToBoard(req, res) {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  try {
    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > BODY_MAX) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "too_large", message: "request too large" } }));
          return;
        }
        chunks.push(chunk);
      }
      body = new Uint8Array(Buffer.concat(chunks));
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      }
    }

    const host = String(req.headers.host ?? `127.0.0.1:${PORT}`);
    const origin = `http://${host}`;
    const response = await currentTeam.fetch(
      new Request(`${origin}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers,
        ...(body && body.length > 0 ? { body } : {}),
        signal: controller.signal,
      }),
    );

    const outHeaders = {};
    response.headers.forEach((value, key) => {
      if (key === "set-cookie") return;
      outHeaders[key] = value;
    });
    res.writeHead(response.status, outHeaders);
    if (response.body) {
      try {
        for await (const chunk of response.body) res.write(chunk);
      } catch {
        // Client closed connection early.
      }
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          code: "internal",
          message: error instanceof Error ? error.message : String(error),
        },
      }),
    );
  }
}

await initBoard();

const server = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && path === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mount: MOUNT }));
    return;
  }

  if (req.method === "POST" && path === "/__test/reset") {
    try {
      await initBoard();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reset: true }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }

  if (path === MOUNT || path.startsWith(`${MOUNT}/`)) {
    await forwardToBoard(req, res);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[board-server] listening on http://0.0.0.0:${PORT}${MOUNT} (handle=@${HANDLE})`);
});

const shutdown = async () => {
  server.closeAllConnections();
  await new Promise((done) => server.close(() => done()));
  await currentBackend?.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
