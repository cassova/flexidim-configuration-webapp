// Assemble the committed user-profile transfer oracle fixture from private
// captures produced by tools/oracle/private/user_capture.m.
//
// Every input is a wholly synthetic archive derived from the Golden Test House
// data, so the captured frames — including user payload bytes — are safe to
// commit. Never point this at a private or reference archive.
//
// usage:
//   node --experimental-strip-types tools/oracle/build-user-transfer-oracle-fixture.mjs \
//     <capture-directory>
//
// The capture directory must hold <case>.fd4cfg and <case>-wire.json for each
// case listed below, and the archives are copied into the fixtures directory
// so the regression test compiles from exactly the bytes that were captured.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");
const source = process.argv[2];
if (!source) {
  console.error(
    "usage: node --experimental-strip-types tools/oracle/build-user-transfer-oracle-fixture.mjs <capture-directory>",
  );
  process.exit(64);
}

// One case per behaviour the sender has to reproduce.
const CASES = [
  {
    name: "no-users",
    describes: "no users: prepare, terminator and make-permanent in one tick",
    builderArguments: ["--include-switches"],
  },
  {
    name: "one-user",
    describes: "one user: a single final-marker payload frame",
    builderArguments: ["--include-switches", "--include-users", "--user-count=1"],
  },
  {
    name: "three-users",
    describes: "three users: one tick per user, archive order preserved",
    builderArguments: ["--include-switches", "--include-users", "--user-count=3"],
  },
  {
    name: "five-users",
    describes:
      "five users: dictionary enumeration reorders the wire indices (504, 501, 505, 502, 503)",
    builderArguments: [
      "--include-switches",
      "--include-users",
      "--user-count=5",
      "--profile-versions=1,2,3,4,5",
    ],
  },
  {
    name: "wide-access",
    describes: "wider access: payloads that need two chunks per user",
    builderArguments: [
      "--include-switches",
      "--include-users",
      "--user-count=2",
      "--user-access=Lounge,Kitchen,Ground Floor",
    ],
  },
];

/** Frames of the first complete pass: up to and including the first ff fe. */
function firstPass(frames) {
  const end = frames.findIndex((frame) => {
    const unescaped = [frame[0]];
    for (let index = 1; index < frame.length; index += 1) {
      if (frame[index] === 0x1b) index += 1;
      unescaped.push(frame[index]);
    }
    return unescaped[0] === 0xff && unescaped[1] === 0xfe;
  });
  if (end < 0) throw new Error("capture never reached the make-permanent frame");
  return frames.slice(0, end + 1);
}

const cases = CASES.map((entry) => {
  const archive = path.join(source, `${entry.name}.fd4cfg`);
  const wire = path.join(source, `${entry.name}-wire.json`);
  const frames = JSON.parse(fs.readFileSync(wire, "utf8")).map((hex) =>
    Buffer.from(hex, "hex"),
  );
  const archiveName = `user-transfer-${entry.name}.fd4cfg`;
  fs.copyFileSync(archive, path.join(fixtures, archiveName));
  return {
    ...entry,
    archive: archiveName,
    frames: firstPass(frames).map((frame) => frame.toString("hex")),
  };
});

const fixture = {
  format: "FlexiDim user-profile transfer oracle capture",
  version: 1,
  capturedWith: "tools/oracle/private/user_capture.m",
  orderingProvenWith: "tools/oracle/private/user_order.m",
  note:
    "Escaped frames written by -[JCLTabViewController sendUserData:userOnly:] for wholly synthetic Golden Test House archives. Each case lists one complete pass: the prepare frame, every user payload chunk in the original app's own transmission order, the all-users terminator and the make-permanent frame.",
  cases,
};
fs.writeFileSync(
  path.join(fixtures, "user-transfer-oracle.json"),
  `${JSON.stringify(fixture, null, 2)}\n`,
);
console.log(
  `wrote user-transfer-oracle.json with ${cases.length} cases (${cases.reduce((total, entry) => total + entry.frames.length, 0)} frames)`,
);
