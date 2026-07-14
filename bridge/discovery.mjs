import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";

export const FLEXIDIM_DISCOVERY_PORT = 15270;
export const FLEXIDIM_DISCOVERY_REPLY_PORT = 15001;
export const FLEXIDIM_DISCOVERY_MESSAGE = "FLEX";

function ipv4ToNumber(address) {
  const octets = String(address).split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return undefined;
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function numberToIpv4(value) {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

export function isPrivateIpv4(address) {
  const value = ipv4ToNumber(address);
  if (value === undefined) return false;
  return (value >= ipv4ToNumber("10.0.0.0") && value <= ipv4ToNumber("10.255.255.255"))
    || (value >= ipv4ToNumber("172.16.0.0") && value <= ipv4ToNumber("172.31.255.255"))
    || (value >= ipv4ToNumber("192.168.0.0") && value <= ipv4ToNumber("192.168.255.255"));
}

export function lanCandidates(preferredHost = "", interfaces = os.networkInterfaces()) {
  const candidates = new Set();
  if (isPrivateIpv4(preferredHost)) candidates.add(preferredHost);
  for (const records of Object.values(interfaces)) {
    for (const record of records || []) {
      if (record.internal || record.family !== "IPv4" || !isPrivateIpv4(record.address)) continue;
      const address = ipv4ToNumber(record.address);
      let mask = ipv4ToNumber(record.netmask);
      if (address === undefined || mask === undefined) continue;
      let network = (address & mask) >>> 0;
      let broadcast = (network | (~mask >>> 0)) >>> 0;
      // Avoid unexpectedly scanning a very large corporate/VPN subnet.
      if (broadcast - network > 1023) {
        mask = ipv4ToNumber("255.255.255.0");
        network = (address & mask) >>> 0;
        broadcast = (network | (~mask >>> 0)) >>> 0;
      }
      for (let value = network + 1; value < broadcast; value += 1) {
        if (value !== address) candidates.add(numberToIpv4(value >>> 0));
      }
    }
  }
  return [...candidates];
}

function probe(host, port, timeout) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (found) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(found ? host : undefined);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function discoverControllerUdp({ timeout = 2400 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let settled = false;
    let timer;
    const finish = (host) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* socket never opened */ }
      resolve(host);
    };
    timer = setTimeout(() => finish(undefined), timeout);
    socket.once("error", () => finish(undefined));
    socket.on("message", (_message, remote) => {
      if (isPrivateIpv4(remote.address)) finish(remote.address);
    });
    socket.bind(FLEXIDIM_DISCOVERY_REPLY_PORT, () => {
      try {
        socket.setBroadcast(true);
        socket.send(Buffer.from(FLEXIDIM_DISCOVERY_MESSAGE, "utf8"), FLEXIDIM_DISCOVERY_PORT, "255.255.255.255");
      } catch { finish(undefined); }
    });
  });
}

export async function discoverController({ preferredHost = "", port = 15273, timeout = 450, concurrency = 48, interfaces, udpTimeout = 2400 } = {}) {
  const udpHost = await discoverControllerUdp({ timeout: udpTimeout });
  if (udpHost) return udpHost;
  const candidates = lanCandidates(preferredHost, interfaces);
  let cursor = 0;
  let found;
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (!found && cursor < candidates.length) {
      const host = candidates[cursor];
      cursor += 1;
      const result = await probe(host, port, timeout);
      if (result) found = result;
    }
  }));
  return found;
}
