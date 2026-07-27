import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LIVE_WRITES_ENABLED,
  SanitizedTransferAudit,
  TransferSafetyCoordinator,
  validateTransferFrame,
} from "../bridge/transfer-safety.mjs";
import { configurationBlock } from "../bridge/config-transfer.mjs";
import { crc16X25 } from "../bridge/protocol.mjs";

const clock = {
  year: 2026, month: 7, day: 26, weekday: 0,
  hour: 12, minute: 43, second: 40, dst: true,
};

function image(length = 600) {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1)
    bytes[index] = (index * 37 + 11) & 0xff;
  const firstPass = Math.min(400, length) - 1;
  bytes[24] = firstPass & 0xff;
  bytes[25] = (firstPass >>> 8) & 0xff;
  bytes[26] = (firstPass >>> 16) & 0xff;
  return bytes;
}

function request(bytes = image(), userPayloads = [Buffer.from("synthetic|user|")]) {
  return {
    imageBase64: bytes.toString("base64"),
    imageChecksum: crc16X25(bytes).toString(16).padStart(4, "0"),
    userPayloadsBase64: userPayloads.map((payload) => payload.toString("base64")),
    clock,
    siteType: 0,
    firmwareProfile: "type-0-live-only",
  };
}

test("offline preflight validates every generated frame before live writes", () => {
  const coordinator = new TransferSafetyCoordinator();
  const result = coordinator.dryRun("client-a", request());
  assert.equal(result.state, "passed");
  assert.equal(result.imageBytes, 600);
  assert.equal(result.blockCount, 3);
  assert.ok(result.frameCount > result.blockCount * 2);
  assert.match(result.transcriptSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.lifecycle, [
    "Compiling current local configuration",
    "Connecting to Scene Controller",
    "Downloading block 1",
    "Downloading block 2",
    "Downloading block 3",
    "Verifying Scene Controller",
    "Making permanent - this takes up to 60 seconds",
    "Download complete - resetting Scene Controller",
    "This takes about 60 seconds",
    "Scene Controller reset detected; reconnecting in 3 seconds",
    "Reconnected; waiting for normal Scene Controller status",
    "Download completed successfully",
    "Scene controller running normally",
  ]);
  assert.deepEqual(result.runnerQualification, {
    state: "passed",
    resetReconnectExercised: true,
    validatedStatusRecords: 10,
  });
  assert.equal(result.liveWritesEnabled, true);
  assert.equal(LIVE_WRITES_ENABLED, true);
  assert.equal(coordinator.active, null);
});

test("synthetic mutation corpus covers image boundaries, escapes and user chunk boundaries", () => {
  const cases = [
    { length: 27, pattern: 0x00, users: [] },
    { length: 251, pattern: 0x1b, users: [Buffer.alloc(0)] },
    { length: 252, pattern: 0xfd, users: [Buffer.alloc(1, 0xff)] },
    { length: 255, pattern: 0xfe, users: [Buffer.alloc(255, 0x1b)] },
    { length: 256, pattern: 0xff, users: [Buffer.alloc(256, 0xfd)] },
    { length: 257, pattern: 0x06, users: [Buffer.alloc(257, 0xfe)] },
    {
      length: 4093,
      pattern: 0x15,
      users: [Buffer.alloc(513, 0xff), Buffer.from("second|synthetic|user|")],
    },
  ];
  const summaries = [];
  for (const fixture of cases) {
    const bytes = Buffer.alloc(fixture.length, fixture.pattern);
    const firstPass = Math.max(27, Math.floor(fixture.length / 2)) - 1;
    bytes[24] = firstPass & 0xff;
    bytes[25] = (firstPass >>> 8) & 0xff;
    bytes[26] = (firstPass >>> 16) & 0xff;
    const result = new TransferSafetyCoordinator().dryRun(
      `mutation-${fixture.length}`,
      request(bytes, fixture.users),
    );
    assert.equal(result.state, "passed");
    assert.equal(result.imageBytes, fixture.length);
    assert.equal(result.userCount, fixture.users.length);
    summaries.push([
      result.imageBytes,
      result.blockCount,
      result.userCount,
      result.userBytes,
      result.frameCount,
      result.transcriptSha256,
    ]);
  }
  // Re-run every mutation to ensure the generated transcript is deterministic
  // when its fixed clock and input bytes are unchanged.
  cases.forEach((fixture, index) => {
    const bytes = Buffer.alloc(fixture.length, fixture.pattern);
    const firstPass = Math.max(27, Math.floor(fixture.length / 2)) - 1;
    bytes[24] = firstPass & 0xff;
    bytes[25] = (firstPass >>> 8) & 0xff;
    bytes[26] = (firstPass >>> 16) & 0xff;
    const result = new TransferSafetyCoordinator().dryRun(
      `repeat-${fixture.length}`,
      request(bytes, fixture.users),
    );
    assert.deepEqual(
      [
        result.imageBytes,
        result.blockCount,
        result.userCount,
        result.userBytes,
        result.frameCount,
        result.transcriptSha256,
      ],
      summaries[index],
    );
  });
});

test("recent Compare is bound to the exact image and expires", () => {
  let now = 1_000;
  const coordinator = new TransferSafetyCoordinator({
    now: () => now,
    compareMaxAgeMs: 500,
  });
  const first = request();
  coordinator.recordComparison("client-a", {
    state: "different",
    localChecksum: first.imageChecksum,
    controllerChecksum: "beef",
    version: "4.0",
  });
  assert.equal(coordinator.dryRun("client-a", first).eligibleAfterHardwareQualification, false);
  const changed = image();
  changed[50] ^= 1;
  assert.equal(coordinator.dryRun("client-a", request(changed)).comparison.bound, false);
  now += 501;
  const expired = coordinator.dryRun("client-a", first);
  assert.equal(expired.comparison.fresh, false);
  assert.equal(expired.eligibleAfterHardwareQualification, false);
});

test("live transfer requires an exact fresh dry run and matching Compare", () => {
  let now = 10_000;
  const coordinator = new TransferSafetyCoordinator({ now: () => now });
  const value = request();
  assert.throws(
    () => coordinator.beginLive("client-a", value),
    /run Compare/,
  );
  coordinator.recordComparison("client-a", {
    state: "match",
    localChecksum: value.imageChecksum,
    controllerChecksum: value.imageChecksum,
    version: "4.0",
  });
  assert.throws(
    () => coordinator.beginLive("client-a", value),
    /offline transfer dry run/,
  );
  coordinator.dryRun("client-a", value);
  const prepared = coordinator.beginLive("client-a", value);
  assert.equal(prepared.imageChecksum, value.imageChecksum);
  assert.equal(prepared.lock.state, "transferring");
  assert.equal(coordinator.finishLive("client-a", "completed", {
    imageChecksum: value.imageChecksum,
    frameCount: 12,
  }), true);
  assert.equal(coordinator.active, null);

  coordinator.dryRun("client-a", value);
  now += 5 * 60 * 1000 + 1;
  assert.throws(
    () => coordinator.beginLive("client-a", value),
    /run Compare/,
  );
});

test("live transfer rejects a changed image after qualification", () => {
  const coordinator = new TransferSafetyCoordinator();
  const original = request();
  coordinator.recordComparison("client-a", {
    state: "match",
    localChecksum: original.imageChecksum,
    controllerChecksum: original.imageChecksum,
    version: "4.0",
  });
  coordinator.dryRun("client-a", original);
  const changed = image();
  changed[100] ^= 1;
  assert.throws(
    () => coordinator.beginLive("client-a", request(changed)),
    /run Compare/,
  );
});

test("live transfer rejects a matching checksum from unqualified firmware", () => {
  const coordinator = new TransferSafetyCoordinator();
  const value = request();
  coordinator.recordComparison("client-a", {
    state: "match",
    localChecksum: value.imageChecksum,
    controllerChecksum: value.imageChecksum,
    version: "9.9",
  });
  coordinator.dryRun("client-a", value);
  assert.throws(
    () => coordinator.beginLive("client-a", value),
    /firmware 4\.0/,
  );
});

test("the lock excludes overlap, the deadline fails closed, and stop stays latched", () => {
  let now = 0;
  const coordinator = new TransferSafetyCoordinator({
    now: () => now,
    overallDeadlineMs: 100,
  });
  coordinator.acquire("client-a", "binding-a");
  assert.throws(
    () => coordinator.acquire("client-b", "binding-b"),
    /already holds the lock/,
  );
  now = 101;
  assert.equal(coordinator.checkDeadline(), true);
  assert.equal(coordinator.emergencyStopped, true);
  assert.throws(() => coordinator.acquire("client-a", "binding-a"), /stop is latched/);
  coordinator.resetEmergencyStop();
  coordinator.acquire("client-a", "binding-a");
  coordinator.emergencyStop("operator");
  assert.equal(coordinator.active, null);
  assert.equal(coordinator.emergencyStopped, true);
});

test("frame self-check rejects corruption after escaping", () => {
  const payload = Buffer.alloc(256, 0x1b);
  const frame = configurationBlock(payload, 0);
  assert.equal(validateTransferFrame(frame), true);
  const bytes = Buffer.from(frame.bytes);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  assert.throws(
    () => validateTransferFrame({ ...frame, bytes }),
    /CRC|changed during escaping/,
  );
});

test("dry-run input fails closed on checksum, base64, profile and size errors", () => {
  const coordinator = new TransferSafetyCoordinator();
  assert.throws(
    () => coordinator.dryRun("a", { ...request(), imageChecksum: "0000" }),
    /disagree/,
  );
  assert.throws(
    () => coordinator.dryRun("a", { ...request(), imageBase64: "not base64!" }),
    /canonical base64/,
  );
  assert.throws(
    () => coordinator.dryRun("a", { ...request(), firmwareProfile: "unknown" }),
    /unsupported transfer firmware profile/,
  );
  assert.throws(
    () => coordinator.dryRun("a", {
      ...request(),
      userPayloadsBase64: Array.from({ length: 225 }, () => ""),
    }),
    /at most 224/,
  );
});

test("audit persistence is append-only and excludes payloads and private fields", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flexidim-audit-"));
  const file = path.join(directory, "audit.jsonl");
  const audit = new SanitizedTransferAudit(file);
  audit.append("dry-run-passed", {
    owner: "client",
    binding: "abc",
    imageChecksum: "cafe",
    payload: "PRIVATE",
    securityCode: "PRIVATE",
    controllerHost: "PRIVATE",
  });
  audit.append("lock-released", { outcome: "passed" });
  const source = fs.readFileSync(file, "utf8");
  assert.equal(source.trim().split("\n").length, 2);
  assert.doesNotMatch(source, /PRIVATE|payload|securityCode|controllerHost/);
  assert.match(source, /dry-run-passed/);
});

test("an unavailable audit path fails qualification without crashing preflight", () => {
  const audit = new SanitizedTransferAudit("/dev/null/not-a-directory/audit.jsonl");
  const coordinator = new TransferSafetyCoordinator({ audit });
  const value = request();
  coordinator.recordComparison("client", {
    state: "match",
    localChecksum: value.imageChecksum,
    controllerChecksum: value.imageChecksum,
    version: "4.0",
  });
  const result = coordinator.dryRun("client", value);
  assert.equal(result.state, "passed");
  assert.equal(result.eligibleAfterHardwareQualification, false);
  assert.ok(audit.persistenceError);
  assert.equal(coordinator.status("client", value.imageChecksum).auditPersistent, false);
});
