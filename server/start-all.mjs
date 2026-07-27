// Supervises the web host and the local controller bridge as one pair so the
// published image works as a single `docker run` container. Compose keeps
// running each process as its own service by overriding the image command.
//
// The bridge keeps its loopback default here on purpose: inside the container
// the web host reaches it at 127.0.0.1:8765 without configuration, and the
// bridge port is never reachable from outside the container.
import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

const children = new Map();
let shuttingDown = false;
let exitCode = 0;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (children.size === 0) process.exit(exitCode);
  for (const child of children.values()) child.kill("SIGTERM");
  // Escalate if a child ignores SIGTERM; the container runtime would otherwise
  // wait out its own stop grace period and SIGKILL the whole tree anyway.
  setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
  }, 4000).unref();
}

function launch(name, script, env) {
  const child = spawn(process.execPath, [script], {
    stdio: "inherit",
    env,
  });
  children.set(name, child);
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (shuttingDown) {
      if (children.size === 0) process.exit(exitCode);
      return;
    }
    // One process dying would leave a half-working container. Take the whole
    // container down so a restart policy brings back a working pair.
    console.error(
      `flexidim ${name} exited unexpectedly (code=${code}, signal=${signal}); stopping`,
    );
    exitCode = code ?? 1;
    shutdown();
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const bridgeEnv = { ...process.env };
if (!bridgeEnv.FLEXIDIM_TRANSFER_AUDIT_PATH && process.env.CONFIG_DIR) {
  // Match the Compose deployment: sanitized transfer-safety events land on the
  // persistent volume instead of being lost with the container.
  bridgeEnv.FLEXIDIM_TRANSFER_AUDIT_PATH = join(
    process.env.CONFIG_DIR,
    "transfer-audit.jsonl",
  );
}

launch("bridge", "bridge/server.mjs", bridgeEnv);
launch("web", "server/host.mjs", process.env);
