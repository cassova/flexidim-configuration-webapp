import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { discoverController } from "./discovery.mjs";
import { parseControllerReplies } from "./controller-replies.mjs";
import { packet } from "./protocol.mjs";
import { authenticationRecord } from "./session.mjs";
import { capabilityFor, SAFE_LOCAL_PROFILE } from "./controller-capabilities.mjs";
import { localResponse } from "./local-responses.mjs";
import { fallbackFirmwareProfile } from "./firmware-profiles.mjs";
import { VerifySession } from "./verify-session.mjs";
import { ConfigurationTransferRunner } from "./transfer-runner.mjs";
import { UserProfileSendRunner } from "./user-profile-runner.mjs";
import {
  SanitizedTransferAudit,
  TransferSafetyCoordinator,
} from "./transfer-safety.mjs";
import {
  closeFrame,
  decodeFrames,
  IDLE_TIMEOUT_MS,
  PING_INTERVAL_MS,
  pingFrame,
  pongFrame,
  websocketFrame,
  WebSocketHeartbeat,
} from "./websocket.mjs";

const BRIDGE_PORT = Number(process.env.FLEXIDIM_BRIDGE_PORT || 8765);
const BRIDGE_HOST = String(process.env.FLEXIDIM_BRIDGE_HOST || "127.0.0.1");
const BRIDGE_TOKEN = String(process.env.FLEXIDIM_BRIDGE_TOKEN || "");
const BRIDGE_ORIGINS = String(process.env.FLEXIDIM_BRIDGE_ORIGINS || "")
  .split(",").map((value) => value.trim()).filter(Boolean);
// Sending user profiles writes to the controller on a path whose reply has
// never been observed, so it stays off until the operator turns it on for a
// bridge process. The frames themselves are oracle-verified.
const USER_PROFILE_SEND_ENABLED =
  String(process.env.FLEXIDIM_ENABLE_USER_PROFILE_SEND || "") === "1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK_HOSTS.has(BRIDGE_HOST) && !BRIDGE_TOKEN) {
  throw new Error("FLEXIDIM_BRIDGE_TOKEN is required when the bridge binds beyond loopback");
}
const sockets = new Set();
const controllers = new Map();
const transfers = new Map();
const userProfileSends = new Map();
const clientIds = new WeakMap();
const transferSafety = new TransferSafetyCoordinator({
  audit: new SanitizedTransferAudit(
    String(process.env.FLEXIDIM_TRANSFER_AUDIT_PATH || ""),
  ),
});

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...args);
}
const hex = (buffer) =>
  buffer.length ? buffer.toString("hex").match(/.{1,2}/g).join(" ") : "(empty)";

function emit(ws, value) { if (!ws.destroyed) ws.write(websocketFrame(value)); }

// A browser that vanishes without a close frame or a FIN would otherwise keep
// its Scene Controller session — the controller's only control slot — open for
// the lifetime of the bridge process. Reaping it releases the controller by the
// ordinary `close` path, so an in-flight transfer is cancelled and the socket
// destroyed exactly as it is for a deliberate disconnect.
const heartbeat = new WebSocketHeartbeat({
  intervalMs: Number(process.env.FLEXIDIM_BRIDGE_PING_INTERVAL_MS || PING_INTERVAL_MS),
  timeoutMs: Number(process.env.FLEXIDIM_BRIDGE_IDLE_TIMEOUT_MS || IDLE_TIMEOUT_MS),
  ping: (ws) => {
    if (!ws.destroyed) ws.write(pingFrame());
  },
  reap: (ws, silentMs) => {
    log(`○ app client unresponsive for ${silentMs}ms; releasing its Scene Controller session`);
    ws.destroy();
  },
});

function queueControllerStatus(ws, controller, statuses) {
  controller.flexidimPendingLevels ??= {};
  controller.flexidimKnownLevels ??= new Map();
  controller.flexidimStatusReports ??= 0;
  controller.flexidimStatusChanges ??= 0;
  for (const status of statuses) {
    const previous = controller.flexidimKnownLevels.get(status.channel);
    controller.flexidimKnownLevels.set(status.channel, status.level);
    controller.flexidimPendingLevels[status.channel] = status.level;
    controller.flexidimStatusReports += 1;
    if (previous !== status.level) controller.flexidimStatusChanges += 1;
    if (controller.flexidimStatusReports >= 128) {
      log(`↻ controller status synchronized: 128 channel reports, ${controller.flexidimStatusChanges} level changes`);
      controller.flexidimStatusReports = 0;
      controller.flexidimStatusChanges = 0;
    }
  }
  if (!controller.flexidimStatusTimer) {
    controller.flexidimStatusTimer = setTimeout(() => {
      controller.flexidimStatusTimer = undefined;
      const levels = controller.flexidimPendingLevels;
      controller.flexidimPendingLevels = {};
      if (Object.keys(levels).length) emit(ws, { type: "channelStatus", levels });
    }, 500);
  }
}

function writeController(ws, bytes, label) {
  const controller = controllers.get(ws);
  if (!controller || controller.destroyed || !controller.writable || !controller.flexidimAuthenticated) {
    log(`✗ NOT SENT (controller not connected): ${label}`);
    return emit(ws, { type: "status", state: "error", message: "Scene Controller is not connected" });
  }
  const ok = controller.write(bytes);
  controller.flexidimLastTx = { at: Date.now(), label, bytes: Buffer.from(bytes) };
  log(`→ TX ${label}  [${hex(bytes)}]${ok ? "" : "  (socket buffer full)"}`);
  emit(ws, { type: "trace", message: `${label} · ${hex(bytes)}` });
}

function connectController(
  ws,
  host,
  port,
  securityCode,
  { transferRunner, userProfileRunner, onConnected, onFailed, quiet = false } = {},
) {
    controllers.get(ws)?.destroy();
    if (!/^([a-z\d-]+\.)*[a-z\d-]+$|^\d{1,3}(\.\d{1,3}){3}$/i.test(host)) return emit(ws, { type: "status", state: "error", message: "Enter a valid Scene Controller address" });
    log(`connect → ${host}:${port}`);
    if (!quiet)
      emit(ws, { type: "status", state: "connecting", message: `Connecting to ${host}:${port}` });
    let connected = false; let failed = false; let connectedAt = 0;
    let failureReported = false;
    const reportFailure = () => {
      if (failureReported) return;
      failureReported = true;
      onFailed?.();
    };
    const controller = net.createConnection({ host, port, timeout: 7000 }); controllers.set(ws, controller);
    controller.flexidimConnection = { host, port, securityCode };
    controller.flexidimTransferRunner = transferRunner;
    controller.flexidimUserProfileRunner = userProfileRunner;
    controller.on("connect", () => {
      // The timeout above is for establishing the TCP connection only. Leaving it
      // enabled disconnects a healthy but idle controller seven seconds later.
      controller.setTimeout(0);
      controller.setKeepAlive(true, 3000);
      let login;
      try {
        login = authenticationRecord(securityCode);
      } catch (error) {
        failed = true;
        log(`✗ controller authentication not sent: ${error.message}`);
        emit(ws, { type: "status", state: "error", message: error.message });
        controller.destroy();
        reportFailure();
        return;
      }
      connected = true;
      connectedAt = Date.now();
      // Recovered from stream0:handleEvent: in the iOS app. A site-type-0
      // session starts with key + six-digit random nonce + 0xff. The app only
      // enters tcpState 3 (command-ready) after writing this record.
      controller.write(login);
      controller.flexidimAuthenticated = true;
      log(`→ TX controller authentication [16-byte key redacted + ${login.subarray(16, 22).toString("ascii")} + ff]`);
      log(`✓ controller authenticated: ${host}:${port}`);
      if (!quiet) {
        emit(ws, { type: "trace", message: "Controller authentication sent (security code redacted)" });
        emit(ws, { type: "status", state: "connected", message: `Authenticated with Scene Controller at ${host}:${port}` });
      }
      onConnected?.(controller);
      // Do not add an application-level poll here. The controller volunteers its
      // f2 level scan unprompted (confirmed by a 50s passive capture), so no poll
      // is needed. The period-flag request is `ff f1 00` and stays gated until a
      // reply has been observed; 0x05 — previously misattributed here as a poll —
      // is actually the channel-search command, whose payload packing is not
      // fully traced. Sending either as a guess has already been seen to make a
      // real controller terminate the stream.
    });
    controller.on("data", (data) => {
      const ordinaryData = controller.flexidimTransferRunner?.active
        ? controller.flexidimTransferRunner.receive(data)
        : controller.flexidimUserProfileRunner?.active
          ? controller.flexidimUserProfileRunner.receive(data)
          : controller.flexidimVerifySession?.active
            ? controller.flexidimVerifySession.receive(data)
            : data;
      if (!ordinaryData.length) return;
      controller.flexidimRxBuffer = Buffer.concat([controller.flexidimRxBuffer ?? Buffer.alloc(0), ordinaryData]);
      const replies = parseControllerReplies(controller.flexidimRxBuffer);
      controller.flexidimRxBuffer = Buffer.from(replies.rest);
      if (replies.invalid.length) {
        log(`✗ controller reply integrity check failed [${hex(Buffer.concat(replies.invalid))}]`);
        emit(ws, { type: "trace", message: `Controller reply failed integrity check · ${hex(Buffer.concat(replies.invalid))}` });
      }
      if (replies.statuses.length) queueControllerStatus(ws, controller, replies.statuses);
      if (replies.visible.length) {
        const visible = Buffer.concat(replies.visible);
        log(`← RX controller reply  [${hex(visible)}]`);
        emit(ws, { type: "trace", message: `Controller reply · ${hex(visible)}` });
      }
    });
    controller.on("timeout", () => {
      failed = true;
      log(`✗ controller timed out (${host}:${port})`);
      controller.destroy();
      if (!quiet)
        emit(ws, { type: "status", state: "error", message: "Scene Controller connection timed out" });
      reportFailure();
    });
    controller.on("error", (error) => {
      failed = true;
      log(`✗ controller error: ${error.code || ""} ${error.message}`);
      if (!quiet)
        emit(ws, { type: "status", state: "error", message: `Controller connection failed: ${error.message}` });
      reportFailure();
    });
    controller.on("close", (hadError) => {
      controller.flexidimVerifySession?.cancel();
      if (controller.flexidimStatusTimer) clearTimeout(controller.flexidimStatusTimer);
      const last = controller.flexidimLastTx;
      const age = last ? Date.now() - last.at : undefined;
      const lifetime = connectedAt ? Date.now() - connectedAt : 0;
      const diagnostic = last
        ? `; ${age}ms after TX ${last.label} [${hex(last.bytes)}]`
        : `; no command sent during ${lifetime}ms connection`;
      log(`controller connection closed${hadError ? " (after error)" : ""}${connected ? "" : " (never established)"}${diagnostic}`);
      if (controller.flexidimTransferRunner?.active)
        controller.flexidimTransferRunner.disconnected();
      if (controller.flexidimUserProfileRunner?.active)
        controller.flexidimUserProfileRunner.disconnected();
      if (!connected) reportFailure();
      if (!quiet && !ws.destroyed && connected && !failed) emit(ws, {
        type: "status",
        state: "bridge",
        message: `Scene Controller disconnected${last ? ` after ${last.label}` : ""}`,
      });
    });
}

function startLiveTransfer(ws, clientId, message) {
  const controller = controllers.get(ws);
  if (!controller?.flexidimAuthenticated || controller.destroyed)
    throw new Error("Scene Controller is not connected");
  if (controller.flexidimVerifySession?.active)
    throw new Error("wait for Compare to finish before sending");
  if (message.confirm !== "Continue")
    throw new Error("the original-app Continue confirmation was not received");

  const prepared = transferSafety.beginLive(clientId, message);
  const connection = controller.flexidimConnection;
  let runner;
  const write = (bytes, frame) => {
    const activeController = controllers.get(ws);
    if (
      !activeController ||
      activeController.destroyed ||
      !activeController.writable ||
      !activeController.flexidimAuthenticated
    ) {
      throw new Error(`Scene Controller disconnected before ${frame.name}`);
    }
    activeController.write(bytes);
    activeController.flexidimLastTx = {
      at: Date.now(),
      label: frame.name,
      bytes: Buffer.alloc(0),
    };
    const detail =
      frame.blockIndex === undefined
        ? `${frame.name}, ${bytes.length} bytes`
        : `${frame.name} ${frame.blockIndex + 1}/${runner.session.transfer.blockCount}, ${bytes.length} bytes`;
    log(`→ TX transfer ${detail}`);
  };

  runner = new ConfigurationTransferRunner({
    sessionOptions: prepared.sessionOptions,
    write,
    reconnect: ({ connected, failed }) => {
      connectController(
        ws,
        connection.host,
        connection.port,
        connection.securityCode,
        {
          transferRunner: runner,
          onConnected: () => connected(),
          onFailed: () => failed(),
          quiet: true,
        },
      );
    },
    close: () => controllers.get(ws)?.destroy(),
    ordinaryData: (data) => {
      const activeController = controllers.get(ws);
      if (!activeController || !data.length) return;
      activeController.flexidimRxBuffer = Buffer.concat([
        activeController.flexidimRxBuffer ?? Buffer.alloc(0),
        data,
      ]);
    },
    progress: (value) => emit(ws, { type: "transferProgress", ...value }),
    result: (value) => {
      transfers.delete(ws);
      transferSafety.finishLive(clientId, value.outcome, {
        imageChecksum: prepared.imageChecksum,
        frameCount: value.frameCount,
      });
      emit(ws, {
        type: "transferResult",
        state: value.outcome === "completed" ? "completed" : "failed",
        outcome: value.outcome,
        message:
          value.outcome === "completed"
            ? "Download completed successfully. Scene controller running normally."
            : value.message ?? value.messages.at(-1) ?? `Transfer stopped: ${value.outcome}`,
        imageChecksum: prepared.imageChecksum,
        frameCount: value.frameCount,
      });
    },
  });
  transfers.set(ws, { runner, imageChecksum: prepared.imageChecksum });
  controller.flexidimTransferRunner = runner;
  runner.start();
}

/**
 * Send user profiles only, with no configuration image. The frames match the
 * original app byte-for-byte; the controller's side of the exchange has never
 * been observed, which is why this needs the operator opt-in below.
 */
function startUserProfileSend(ws, clientId, message) {
  const controller = controllers.get(ws);
  if (!controller?.flexidimAuthenticated || controller.destroyed)
    throw new Error("Scene Controller is not connected");
  if (controller.flexidimVerifySession?.active)
    throw new Error("wait for Compare to finish before sending");
  if (transfers.get(ws)?.runner?.active)
    throw new Error("a configuration transfer is already running");

  const prepared = transferSafety.beginLiveUserProfiles(clientId, message, {
    operatorEnabled: USER_PROFILE_SEND_ENABLED,
  });
  const runner = new UserProfileSendRunner({
    userPayloads: prepared.userPayloads,
    write: (bytes, frame) => {
      const active = controllers.get(ws);
      if (
        !active ||
        active.destroyed ||
        !active.writable ||
        !active.flexidimAuthenticated
      )
        throw new Error(`Scene Controller disconnected before ${frame.name}`);
      active.write(bytes);
      active.flexidimLastTx = {
        at: Date.now(),
        label: frame.name,
        bytes: Buffer.alloc(0),
      };
      log(`→ TX user profile ${frame.name}, ${bytes.length} bytes`);
    },
    reconnect: ({ connected, failed }) => {
      const connection = controller.flexidimConnection;
      connectController(
        ws,
        connection.host,
        connection.port,
        connection.securityCode,
        {
          userProfileRunner: runner,
          onConnected: () => connected(),
          onFailed: () => failed(),
          quiet: true,
        },
      );
    },
    ordinaryData: (data) => {
      const active = controllers.get(ws);
      if (!active || !data.length) return;
      active.flexidimRxBuffer = Buffer.concat([
        active.flexidimRxBuffer ?? Buffer.alloc(0),
        data,
      ]);
    },
    progress: (value) => emit(ws, { type: "userProfileProgress", ...value }),
    result: (value) => {
      userProfileSends.delete(ws);
      transferSafety.finishLiveUserProfiles(clientId, value.outcome, {
        frameCount: value.frameCount,
        userCount: value.userCount,
        // Whatever the controller said is the evidence this path was missing.
        controllerBytes: value.controllerBytes.length,
        normalStatusCount: value.normalStatusCount,
      });
      if (value.controllerBytes.length)
        log(
          `← RX user-profile exchange: ${value.controllerBytes
            .map((item) => `${item.phase}:${item.hex}`)
            .join(" ")}`,
        );
      emit(ws, {
        type: "userProfileResult",
        state: value.outcome === "completed" ? "completed" : "failed",
        ...value,
      });
    },
  });
  userProfileSends.set(ws, { runner });
  controller.flexidimUserProfileRunner = runner;
  runner.start();
}

function handleMessage(ws, raw) {
  let message;
  try { message = JSON.parse(raw); } catch { log(`✗ invalid message: ${raw}`); return emit(ws, { type: "status", state: "error", message: "Invalid bridge message" }); }
  log(
    `client → ${message.type}` +
      (message.type === "dim" ? ` (ch ${message.channel}, ${message.level}%, t=${message.transition})` : "") +
      (message.type === "switch" ? ` (sw ${message.switch}, btn ${message.button})` : ""),
  );
  // Answered locally, ahead of the capability refusal, so the app gets the
  // precise reason rather than a generic profile error.
  const local = localResponse(message);
  if (local) return emit(ws, local);
  if (!capabilityFor(message.type)) {
    return emit(ws, {
      type: "status", state: "error",
      message: `${message.type} is disabled by controller profile ${SAFE_LOCAL_PROFILE.id}; captured protocol evidence and recoverable hardware validation are required`,
    });
  }
  const clientId = clientIds.get(ws);
  if (message.type === "transferSafetyStatus") {
    return emit(ws, transferSafety.status(clientId, message.imageChecksum));
  }
  if (message.type === "transferAudit") {
    return emit(ws, {
      type: "transferAudit",
      entries: transferSafety.audit.recent(message.limit),
    });
  }
  if (message.type === "transferDryRun") {
    try {
      emit(ws, { type: "transferProgress", state: "preflight", message: "Validating compiled bytes offline…" });
      return emit(ws, transferSafety.dryRun(clientId, message));
    } catch (error) {
      return emit(ws, {
        type: "transferPreflight",
        state: "failed",
        message: `Offline dry run failed: ${error.message}`,
        liveWritesEnabled: false,
      });
    }
  }
  if (message.type === "userProfileDryRun") {
    try {
      return emit(ws, transferSafety.userProfileDryRun(clientId, message));
    } catch (error) {
      return emit(ws, {
        type: "userProfilePreflight",
        state: "failed",
        message: `Offline user-profile dry run failed: ${error.message}`,
        liveSendAvailable: false,
      });
    }
  }
  if (message.type === "transferEmergencyStop") {
    transferSafety.emergencyStop("operator");
    for (const controller of controllers.values()) controller.destroy();
    emit(ws, {
      type: "transferProgress",
      state: "stopped",
      message: "Emergency stop latched. Controller connections were closed; no transfer may run.",
    });
    return emit(ws, transferSafety.status(clientId, message.imageChecksum));
  }
  if (message.type === "transferSafetyReset") {
    if (message.confirm !== "RESET OFFLINE SAFETY")
      return emit(ws, {
        type: "transferPreflight",
        state: "failed",
        message: "Safety reset confirmation was not exact.",
        liveWritesEnabled: false,
      });
    transferSafety.resetEmergencyStop();
    return emit(ws, transferSafety.status(clientId, message.imageChecksum));
  }
  if (message.type === "transferCancel") {
    const transfer = transfers.get(ws);
    if (!transfer?.runner.active)
      return emit(ws, {
        type: "transferResult",
        state: "failed",
        outcome: "not-active",
        message: "No configuration transfer is active.",
      });
    transfer.runner.cancel("operator");
    return;
  }
  if (message.type === "connect") {
    connectController(ws, String(message.host || ""), Number(message.port || 15273), String(message.securityCode || ""));
    return;
  }
  if (message.type === "discover") {
    const port = Number(message.port || 15273);
    emit(ws, { type: "status", state: "discovering", message: `Searching the local network for a FlexiDim controller on port ${port}…` });
    discoverController({
      preferredHost: String(message.host || ""),
      fallbackHost: String(process.env.FLEXIDIM_DISCOVERY_SEED || ""),
      port,
    }).then((host) => {
      if (ws.destroyed) return;
      if (!host) return emit(ws, { type: "status", state: "error", message: `No FlexiDim controller was found on this local network at port ${port}` });
      emit(ws, { type: "discovered", host, port });
      connectController(ws, host, port, String(message.securityCode || ""));
    }).catch((error) => emit(ws, { type: "status", state: "error", message: `Controller discovery failed: ${error.message}` }));
    return;
  }
  if (message.type === "verify") {
    const controller = controllers.get(ws);
    if (!controller?.flexidimAuthenticated) {
      emit(ws, {
        type: "verifyResult",
        state: "error",
        message: "Scene Controller is not connected.",
      });
      return;
    }
    controller.flexidimVerifySession ??= new VerifySession({
      send: (bytes, label) => writeController(ws, bytes, label),
      result: (value) => {
        transferSafety.recordComparison(clientId, value);
        emit(ws, value);
      },
    });
    if (!controller.flexidimVerifySession.start(message.localChecksum)) {
      emit(ws, {
        type: "verifyResult",
        state: "error",
        message: "A controller comparison is already in progress.",
      });
    }
  } else if (message.type === "sync") {
    try {
      startLiveTransfer(ws, clientId, message);
    } catch (error) {
      transferSafety.finishLive(clientId, "failed");
      emit(ws, {
        type: "transferResult",
        state: "failed",
        outcome: "preflight-failed",
        message: `Configuration transfer blocked: ${error.message}`,
      });
    }
  } else if (message.type === "dim") writeController(ws, packet(0x04, [message.channel, message.level, message.transition]), `Channel ${message.channel} → ${message.level}%`);
  // The app always sends a 6-byte switch body: ff f3 00 <switch> <button> 00.
  // The trailing 0x00 is part of what the controller's CRC/length check expects.
  else if (message.type === "switch") writeController(ws, packet(0x00, [message.switch, message.button, 0]), `Switch ${message.switch}, button ${message.button}`);
  else if (message.type === "scene") for (const [channel, level] of Object.entries(message.levels || {})) writeController(ws, packet(0x04, [channel, level, message.transition]), `Scene channel ${channel} → ${level}%`);
}

const server = http.createServer((request, response) => {
  const origin = request.headers.origin;
  if (origin && (BRIDGE_ORIGINS.includes(origin) || (LOOPBACK_HOSTS.has(BRIDGE_HOST) && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))))
    response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ service: "FlexiDim local bridge", status: "ready", port: BRIDGE_PORT }));
});

server.on("upgrade", (request, socket) => {
  const origin = String(request.headers.origin || "");
  const token = new URL(request.url || "/", "http://bridge.local").searchParams.get("token") || "";
  const originAllowed = !BRIDGE_ORIGINS.length || BRIDGE_ORIGINS.includes(origin) ||
    (LOOPBACK_HOSTS.has(BRIDGE_HOST) && (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)));
  if (!originAllowed || (BRIDGE_TOKEN && token !== BRIDGE_TOKEN)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  const key = request.headers["sec-websocket-key"]; if (!key) return socket.destroy();
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "\r\n"].join("\r\n"));
  sockets.add(socket); let pending = Buffer.alloc(0); log("● app client connected"); emit(socket, { type: "status", state: "bridge", message: "Local FlexiDim bridge ready" });
  clientIds.set(socket, randomUUID());
  // The announced profile comes from the firmware acceptance matrix. No
  // controller identifies itself yet, so this is always the deny-by-default
  // fallback; the evidence map travels with it so the UI can explain refusals.
  const active = fallbackFirmwareProfile();
  emit(socket, {
    type: "capabilities",
    profile: active.capabilities,
    evidence: active.evidence,
  });
  emit(socket, transferSafety.status(clientIds.get(socket)));
  heartbeat.add(socket);
  // `http.Server` creates its connections with `allowHalfOpen: true`, so a peer
  // FIN raises `end` and leaves the socket writable — `close` never fires, and
  // the Scene Controller session released by that handler would be held for the
  // life of the process. A client that has stopped talking cannot be answered,
  // so complete the close here and let the ordinary `close` path clean up.
  socket.on("end", () => {
    if (!socket.destroyed) socket.end();
  });
  socket.on("data", (chunk) => {
    // Any inbound byte proves the client is alive, so record liveness before
    // decoding rather than only when a pong arrives.
    heartbeat.touch(socket);
    pending = Buffer.concat([pending, chunk]);
    const decoded = decodeFrames(pending); pending = decoded.rest;
    // A peer that pings us is owed a pong carrying its exact payload.
    for (const payload of decoded.pings)
      if (!socket.destroyed) socket.write(pongFrame(payload));
    for (const message of decoded.messages) handleMessage(socket, message);
    if (decoded.closeRequested && !socket.destroyed) {
      socket.write(closeFrame());
      socket.end();
    }
  });
  socket.on("close", () => {
    log("○ app client disconnected");
    heartbeat.remove(socket);
    transfers.get(socket)?.runner.cancel("web app disconnected");
    transfers.delete(socket);
    sockets.delete(socket);
    controllers.get(socket)?.destroy();
    controllers.delete(socket);
  });
  socket.on("error", () => undefined);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`FlexiDim bridge is already running at ws://127.0.0.1:${BRIDGE_PORT}`);
    process.exit(1);
  }
  console.error(`FlexiDim bridge failed to start: ${error.message}`);
  process.exit(1);
});

server.listen(BRIDGE_PORT, BRIDGE_HOST, () => console.log(`FlexiDim local bridge ready at ws://${BRIDGE_HOST}:${BRIDGE_PORT}`));

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`FlexiDim local bridge received ${signal}; shutting down`);
  heartbeat.stop();

  for (const socket of sockets) {
    if (!socket.destroyed) {
      socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe9]));
      socket.end();
    }
  }
  for (const controller of controllers.values()) controller.end();

  const deadline = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
    for (const controller of controllers.values()) controller.destroy();
    server.closeAllConnections?.();
    console.error("FlexiDim local bridge shutdown deadline reached");
    process.exit(1);
  }, 4000);

  server.close((error) => {
    clearTimeout(deadline);
    if (error) {
      console.error(`FlexiDim local bridge shutdown failed: ${error.message}`);
      process.exit(1);
    }
    console.log("FlexiDim local bridge stopped cleanly");
    process.exit(0);
  });
  server.closeIdleConnections?.();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
