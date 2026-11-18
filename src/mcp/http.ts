import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpConfig } from "../config.js";
import { createMcpServer, type ServerDeps } from "./server.js";

export type HttpDeps = ServerDeps & {
  mcp: McpConfig;
  token: string;
  /** Builds a fresh server per request; the transport is stateless. */
  createServer?: (deps: ServerDeps) => McpServer;
};

const MAX_BODY_BYTES = 1_000_000;

function sameSecret(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Payload too large");
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/**
 * Stateless Streamable HTTP on Node's own http server.
 *
 * Rakazo plugins reach a public HTTPS endpoint, so this listens on loopback and
 * expects a tunnel (or a reverse proxy) in front. Every request needs the
 * bearer token: the account behind these tools is a personal one.
 */
export function startMcpHttpServer(deps: HttpDeps): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const build = deps.createServer ?? createMcpServer;

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname !== deps.mcp.path) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    if (!sameSecret(deps.token, bearer(req.headers.authorization))) {
      res.setHeader("www-authenticate", 'Bearer realm="rakazo-discord"');
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (req.method !== "POST") {
      // Stateless mode: there is no standing SSE stream and nothing to delete.
      rpcError(res, 405, "Method not allowed. POST JSON-RPC to this endpoint.");
      return;
    }

    let parsed: unknown;
    try {
      parsed = await readJsonBody(req);
    } catch (error) {
      rpcError(res, error instanceof Error && error.message === "Payload too large" ? 413 : 400, "Invalid JSON body");
      return;
    }

    const server = build(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (error) {
      if (!res.headersSent) rpcError(res, 500, `MCP error: ${String(error)}`);
    }
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(deps.mcp.port, deps.mcp.host, () => {
      http.off("error", reject);
      const url = `http://${deps.mcp.host}:${deps.mcp.port}${deps.mcp.path}`;
      resolve({
        server: http,
        url,
        close: () =>
          new Promise<void>((done) => {
            http.closeAllConnections?.();
            http.close(() => done());
          }),
      });
    });
  });
}
