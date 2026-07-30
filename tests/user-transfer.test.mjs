// The user-profile-only sender must match the original iOS app frame for
// frame. Evidence: tools/oracle/private/user_capture.m drove
// -[JCLTabViewController sendUserData:userOnly:] over the synthetic archives
// committed beside the capture; ordering evidence comes from
// tools/oracle/private/user_order.m.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseLegacyFd4Config } from "../app/fd4cfg.ts";
import {
  compileUserProfiles,
  userProfileSendOrder,
} from "../app/compile-user-profiles.ts";
import { buildGoldenAppData } from "./golden-app-data.mjs";
import {
  UserProfileTransferSession,
  compileUserProfileTranscript,
} from "../bridge/user-transfer.mjs";
import {
  TransferSafetyCoordinator,
  validateTransferFrame,
} from "../bridge/transfer-safety.mjs";
import {
  capabilityFor,
  gatedMessageTypes,
} from "../bridge/controller-capabilities.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "tools", "oracle", "fixtures");
const oracle = JSON.parse(
  fs.readFileSync(path.join(fixtures, "user-transfer-oracle.json"), "utf8"),
);

function archiveData(name) {
  const bytes = fs.readFileSync(path.join(fixtures, name));
  return parseLegacyFd4Config(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

function unescapeFrame(frame) {
  const output = [frame[0]];
  for (let index = 1; index < frame.length; index += 1) {
    if (frame[index] === 0x1b) index += 1;
    output.push(frame[index]);
  }
  return Buffer.from(output);
}

for (const item of oracle.cases) {
  test(`user-profile send matches the original app: ${item.name} (${item.describes})`, () => {
    const data = archiveData(item.archive);
    const compiled = compileUserProfiles(data);
    assert.deepEqual(
      compiled.problems,
      [],
      "the synthetic archive must compile without profile problems",
    );
    const transcript = compileUserProfileTranscript({
      userPayloads: compiled.payloads,
    });
    const expected = item.frames.map((hex) => Buffer.from(hex, "hex"));
    assert.equal(
      transcript.frames.length,
      expected.length,
      "frame count must match the original app",
    );
    transcript.frames.forEach((frame, index) => {
      assert.deepEqual(
        frame.bytes,
        expected[index],
        `frame ${index} (${frame.name}) must be byte-identical to the original app`,
      );
    });
  });
}

test("the pass is prepare, one tick per user, then terminator and make-permanent", () => {
  const data = archiveData("user-transfer-three-users.fd4cfg");
  const { payloads } = compileUserProfiles(data);
  const session = new UserProfileTransferSession({ userPayloads: payloads });

  const first = session.next();
  assert.deepEqual(
    first.frames.map((frame) => frame.name),
    ["prepare-user-data", "user-data"],
    "the first tick prepares the controller and sends the first profile",
  );
  assert.equal(first.snapshot.userIndex, 1);
  assert.equal(first.snapshot.complete, false);

  for (let index = 1; index < payloads.length; index += 1) {
    const tick = session.next();
    assert.deepEqual(
      tick.frames.map((frame) => frame.name),
      ["user-data"],
      "each later tick sends exactly one profile",
    );
    assert.equal(tick.frames[0].userIndex, index);
    assert.equal(tick.snapshot.complete, false);
  }

  const last = session.next();
  assert.deepEqual(last.frames.map((frame) => frame.name), [
    "all-users-complete",
    "make-user-data-permanent",
  ]);
  assert.equal(last.snapshot.complete, true);
});

test("a payload longer than one block is split with counted then final markers", () => {
  const data = archiveData("user-transfer-wide-access.fd4cfg");
  const { payloads } = compileUserProfiles(data);
  assert.ok(
    payloads[0].length > 256,
    "the wide-access fixture must exercise multi-chunk framing",
  );
  const [firstTick] = compileUserProfileTranscript({
    userPayloads: payloads,
  }).ticks;
  const chunks = firstTick.frames.filter((frame) => frame.name === "user-data");
  assert.equal(chunks.length, Math.ceil(payloads[0].length / 256));
  assert.deepEqual(
    chunks.map((frame) => frame.marker),
    [...chunks.slice(0, -1).map((_, index) => index), 0x3fff],
    "non-final chunks count up from zero and the last carries the final marker",
  );
  assert.ok(
    chunks.every((frame) => frame.userIndex === 0),
    "every chunk of one profile carries that profile's index",
  );
});

test("profiles are transmitted in the original app's dictionary order", () => {
  // JCLFDConfig.users is an NSMutableDictionary keyed by the decimal string of
  // each user's archive key, and the sender walks the list built from
  // enumerating it. user_order.m observed 501..505 enumerate as
  // 504, 501, 505, 502, 503.
  const keys = [501, 502, 503, 504, 505];
  assert.deepEqual(
    userProfileSendOrder(keys.map((legacyKey, index) => ({ legacyKey, id: index + 1 }))),
    [3, 0, 4, 1, 2],
  );
  // Three or fewer users land in their own buckets, which is why smaller
  // configurations never revealed the reordering.
  assert.deepEqual(
    userProfileSendOrder([501, 502, 503].map((legacyKey) => ({ legacyKey }))),
    [0, 1, 2],
  );
});

test("the five-user fixture sends the Golden Test House profiles under the reordered indices", () => {
  const data = archiveData("user-transfer-five-users.fd4cfg");
  const compiled = compileUserProfiles(data);
  const names = compiled.payloads.map(
    (payload) => Buffer.from(payload).toString("utf8").split("|")[1],
  );
  assert.deepEqual(names, [
    "Occupant 4",
    "Owner",
    "Occupant 5",
    "Occupant 2",
    "Occupant 3",
  ]);
  // Every profile still reaches the controller exactly once.
  assert.deepEqual(
    [...names].sort(),
    [...data.users.map((user) => user.name)].sort(),
  );
});

test("the Golden Test House site compiles and sends its single profile", () => {
  // Every case here is built from the Golden Test House data; this one is the
  // plain single-user site.
  const data = archiveData("user-transfer-one-user.fd4cfg");
  assert.equal(data.site.name, buildGoldenAppData().site.name);
  assert.equal(data.site.id, "FD4-GOLD");
  const compiled = compileUserProfiles(data);
  assert.deepEqual(compiled.problems, []);
  assert.equal(compiled.payloads.length, data.users.length);
  const transcript = compileUserProfileTranscript({
    userPayloads: compiled.payloads,
  });
  assert.deepEqual(
    transcript.frames.map((frame) => frame.name),
    [
      "prepare-user-data",
      "user-data",
      "all-users-complete",
      "make-user-data-permanent",
    ],
  );
  // The constant frames are the recovered six-byte templates, CRC included.
  const prepare = unescapeFrame(transcript.frames[0].bytes);
  assert.deepEqual(prepare.subarray(0, 6), Buffer.from([0xff, 0xfc, 0, 0, 0, 0]));
  const permanent = unescapeFrame(transcript.frames[3].bytes);
  assert.deepEqual(
    permanent.subarray(0, 6),
    Buffer.from([0xff, 0xfe, 0, 0, 0, 0]),
  );
  const terminator = unescapeFrame(transcript.frames[2].bytes);
  assert.deepEqual(
    terminator.subarray(0, 5),
    Buffer.from([0xff, 0xf2, 0xe0, 0x7f, 0x7f]),
  );
  assert.equal(terminator.length, 5 + 256 + 2);
  assert.ok(
    terminator.subarray(5, 5 + 256).every((byte) => byte === 0),
    "the terminator carries a zeroed block",
  );
});

test("a configuration with no users still prepares and terminates in one tick", () => {
  const transcript = compileUserProfileTranscript({ userPayloads: [] });
  assert.deepEqual(
    transcript.frames.map((frame) => frame.name),
    ["prepare-user-data", "all-users-complete", "make-user-data-permanent"],
  );
  assert.equal(transcript.ticks.length, 1);
});

test("the user index field cannot be overrun", () => {
  assert.throws(
    () =>
      new UserProfileTransferSession({
        userPayloads: Array.from({ length: 0xe1 }, () => "x"),
      }),
    /at most 224 users/,
  );
});

test("every frame passes the bridge's own CRC and escaping self-check", () => {
  const data = archiveData("user-transfer-wide-access.fd4cfg");
  const { payloads } = compileUserProfiles(data);
  const transcript = compileUserProfileTranscript({ userPayloads: payloads });
  for (const frame of transcript.frames)
    assert.equal(validateTransferFrame(frame), true, frame.name);
});

test("the offline preflight reports the send without writing to a controller", () => {
  const data = archiveData("user-transfer-three-users.fd4cfg");
  const { payloads } = compileUserProfiles(data);
  const safety = new TransferSafetyCoordinator();
  const preflight = safety.userProfileDryRun("test-client", {
    userPayloadsBase64: payloads.map((payload) =>
      Buffer.from(payload).toString("base64"),
    ),
  });
  assert.equal(preflight.state, "passed");
  assert.equal(preflight.userCount, 3);
  assert.equal(preflight.frameCount, 6);
  assert.equal(preflight.tickCount, 4);
  // Sending profiles is a controller write and no reply to this exchange has
  // been observed on hardware, so the live path must stay closed.
  assert.equal(preflight.liveSendAvailable, false);
  assert.match(preflight.message, /no controller bytes were written/);
  assert.equal(
    safety.audit.recent(1)[0].event,
    "user-profile-dry-run-passed",
  );
});

test("the preflight refuses more payloads than the wire format allows", () => {
  const safety = new TransferSafetyCoordinator();
  assert.throws(
    () =>
      safety.userProfileDryRun("test-client", {
        userPayloadsBase64: Array.from({ length: 225 }, () =>
          Buffer.from("x").toString("base64"),
        ),
      }),
    /at most 224 entries/,
  );
});

test("the offline preflight is allowed but the controller write stays gated", () => {
  // A handler absent from the registry is refused outright, so the dry run has
  // to be registered; the write it previews must not be.
  assert.equal(capabilityFor("userProfileDryRun"), true);
  assert.equal(capabilityFor("userProfiles"), false);
  // gatedMessageTypes() also lists local operations, so capabilityFor is the
  // authority on what the bridge will actually run.
  assert.ok(gatedMessageTypes().includes("userProfiles"));
});
