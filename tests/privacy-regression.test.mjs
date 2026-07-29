import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const textExtensions = new Set([
  "", ".css", ".gitignore", ".html", ".js", ".json", ".md", ".mjs",
  ".toml", ".ts", ".tsx", ".webmanifest", ".yaml", ".yml",
]);
const binaryFixtureExtensions = new Set([".bin", ".fd4cfg"]);

function gitVisibleFiles() {
  return execFileSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
}

test("Git-visible files contain no private installation identifiers", () => {
  // Build private sentinels in pieces so this test does not contain the value
  // it is designed to reject.
  const forbidden = [
    ["Cheq", "uers End"].join(""),
    ["0714", "0002"].join(""),
    ["192.168.", "178."].join(""),
    ["0x", "4287"].join(""),
    ["39", "22"].join(""),
    ["39", ",017"].join(""),
    ["39", "017"].join(""),
  ];
  const violations = [];

  for (const relative of gitVisibleFiles()) {
    const lowerName = relative.toLowerCase();
    for (const value of forbidden) {
      if (lowerName.includes(value.toLowerCase()))
        violations.push(`${relative}: private value in filename`);
    }

    const extension =
      path.basename(relative) === ".gitignore"
        ? ".gitignore"
        : path.extname(relative).toLowerCase();
    if (!textExtensions.has(extension) && !binaryFixtureExtensions.has(extension))
      continue;
    const source = fs.readFileSync(path.join(root, relative));
    const searchable = source.toString("latin1").toLowerCase();
    for (const value of forbidden) {
      if (searchable.includes(value.toLowerCase()))
        violations.push(`${relative}: private installation fingerprint`);
    }
  }

  assert.deepEqual(violations, []);
});

test("committed configuration fixtures use explicitly synthetic identities", () => {
  const oracleFixtures = path.join(root, "tools", "oracle", "fixtures");
  const fixtures = [
    path.join(root, "tests", "fixtures", "golden.fd4cfg"),
    path.join(oracleFixtures, "transfer-oracle.fd4cfg"),
    // The user-profile transfer cases carry captured user payload bytes, so
    // their synthetic origin matters just as much.
    ...fs
      .readdirSync(oracleFixtures)
      .filter((name) => /^user-transfer-.+\.fd4cfg$/.test(name))
      .map((name) => path.join(oracleFixtures, name)),
  ];
  assert.ok(
    fixtures.length > 2,
    "the user-profile transfer fixtures must be covered here",
  );
  for (const fixture of fixtures) {
    const source = fs.readFileSync(fixture).toString("latin1");
    assert.match(source, /Golden Test House/);
    assert.match(source, /example\.test/);
    assert.match(source, /FD4-GOLD/);
  }
});
