import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as requestHttp } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = join(root, "dist", "client");
const workerPath = new URL("../dist/server/index.js", import.meta.url);
const { default: worker } = await import(workerPath.href);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const bridgeHost =
  process.env.FLEXIDIM_BRIDGE_UPSTREAM_HOST || "127.0.0.1";
const bridgePort = Number(
  process.env.FLEXIDIM_BRIDGE_UPSTREAM_PORT || 8765,
);
const bridgeToken = process.env.FLEXIDIM_BRIDGE_TOKEN || "";
const bridgeProxySockets = new Set();
const pendingBridgeRequests = new Set();
let shuttingDown = false;

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function fetchAsset(request) {
  const url = new URL(request.url);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const candidate = resolve(clientRoot, `.${pathname}`);
  if (candidate !== clientRoot && !candidate.startsWith(`${clientRoot}${sep}`))
    return new Response("Forbidden", { status: 403 });
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) return new Response("Not Found", { status: 404 });
    return new Response(Readable.toWeb(createReadStream(candidate)), {
      headers: {
        "cache-control":
          pathname === "/sw.js"
            ? "no-store"
            : pathname.startsWith("/assets/")
              ? "public, max-age=31536000, immutable"
              : "no-cache",
        "content-length": String(metadata.size),
        "content-type":
          contentTypes[extname(candidate).toLowerCase()] ??
          "application/octet-stream",
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return new Response("Not Found", { status: 404 });
    throw error;
  }
}

const context = {
  waitUntil(promise) {
    promise.catch((error) => console.error("Background task failed", error));
  },
  passThroughOnException() {},
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url || "/", `http://${incoming.headers.host || "localhost"}`);
    const method = incoming.method || "GET";
    const startedAt = performance.now();
    const logRequest =
      url.pathname === "/" ||
      url.pathname.startsWith("/api/");
    if (logRequest) {
      outgoing.once("finish", () => {
        console.log(
          `${method} ${url.pathname} ${outgoing.statusCode} ${Math.round(performance.now() - startedAt)}ms`,
        );
      });
    }
    if (url.pathname === "/healthz") {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end('{"status":"ok"}');
      return;
    }
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : Readable.toWeb(incoming);
    const request = new Request(url, {
      method,
      headers: incoming.headers,
      body,
      ...(body ? { duplex: "half" } : {}),
    });
    let response;
    if (method === "GET" || method === "HEAD") {
      const assetResponse = await fetchAsset(request);
      if (assetResponse.status !== 404) response = assetResponse;
    }
    response ??= await worker.fetch(
      request,
      { ASSETS: { fetch: fetchAsset } },
      context,
    );
    const responseHeaders = Object.fromEntries(response.headers.entries());
    if (url.pathname === "/") responseHeaders["cache-control"] = "no-store";
    outgoing.writeHead(
      response.status,
      responseHeaders,
    );
    if (method === "HEAD" || !response.body) return outgoing.end();
    Readable.fromWeb(response.body).pipe(outgoing);
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("Internal Server Error");
  }
});

server.on("upgrade", (incoming, clientSocket, clientHead) => {
  let pathname;
  try {
    pathname = new URL(
      incoming.url || "/",
      `http://${incoming.headers.host || "localhost"}`,
    ).pathname;
  } catch {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  if (pathname !== "/bridge") {
    clientSocket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const origin = String(incoming.headers.origin || "");
  const forwardedHost = String(incoming.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const expectedHost = forwardedHost || String(incoming.headers.host || "");
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = "";
    }
    if (!expectedHost || originHost !== expectedHost) {
      clientSocket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n",
      );
      return;
    }
  }

  const upstreamPath = bridgeToken
    ? `/?token=${encodeURIComponent(bridgeToken)}`
    : "/";
  const upstreamRequest = requestHttp({
    host: bridgeHost,
    port: bridgePort,
    path: upstreamPath,
    method: "GET",
    headers: {
      ...incoming.headers,
      host: `${bridgeHost}:${bridgePort}`,
      connection: "Upgrade",
      upgrade: "websocket",
    },
  });
  pendingBridgeRequests.add(upstreamRequest);

  upstreamRequest.on("upgrade", (response, bridgeSocket, bridgeHead) => {
    pendingBridgeRequests.delete(upstreamRequest);
    bridgeProxySockets.add(clientSocket);
    bridgeProxySockets.add(bridgeSocket);
    const forgetSockets = () => {
      bridgeProxySockets.delete(clientSocket);
      bridgeProxySockets.delete(bridgeSocket);
    };
    clientSocket.once("close", forgetSockets);
    bridgeSocket.once("close", forgetSockets);
    const headers = Object.entries(response.headers)
      .flatMap(([name, value]) =>
        Array.isArray(value)
          ? value.map((item) => `${name}: ${item}`)
          : value == null
            ? []
            : [`${name}: ${value}`],
      );
    clientSocket.write(
      [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`, ...headers, "", ""]
        .join("\r\n"),
    );
    if (clientHead.length) bridgeSocket.write(clientHead);
    if (bridgeHead.length) clientSocket.write(bridgeHead);
    clientSocket.pipe(bridgeSocket).pipe(clientSocket);
  });
  upstreamRequest.on("response", (response) => {
    pendingBridgeRequests.delete(upstreamRequest);
    clientSocket.end(
      `HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || "Bad Gateway"}\r\nConnection: close\r\n\r\n`,
    );
    response.resume();
  });
  upstreamRequest.on("error", (error) => {
    pendingBridgeRequests.delete(upstreamRequest);
    console.error(`FlexiDim bridge proxy failed: ${error.message}`);
    if (!clientSocket.destroyed)
      clientSocket.end(
        "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n",
      );
  });
  upstreamRequest.end();
});

server.listen(port, host, () => {
  console.log(
    `FlexiDim Web listening on http://${host}:${port}; configuration directory: ${
      process.env.CONFIG_DIR || "./config"
    }`,
  );
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`FlexiDim Web received ${signal}; shutting down`);

  for (const request of pendingBridgeRequests) request.destroy();
  pendingBridgeRequests.clear();
  for (const socket of bridgeProxySockets) socket.end();

  const deadline = setTimeout(() => {
    for (const socket of bridgeProxySockets) socket.destroy();
    server.closeAllConnections?.();
    console.error("FlexiDim Web shutdown deadline reached");
    process.exit(1);
  }, 4000);

  server.close((error) => {
    clearTimeout(deadline);
    if (error) {
      console.error(`FlexiDim Web shutdown failed: ${error.message}`);
      process.exit(1);
    }
    console.log("FlexiDim Web stopped cleanly");
    process.exit(0);
  });
  server.closeIdleConnections?.();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
