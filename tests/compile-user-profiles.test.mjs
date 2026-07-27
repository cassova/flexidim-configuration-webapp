import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileUserProfiles } from "../app/compile-user-profiles.ts";
import {
  canonicalizeAppData,
  materializeAppData,
  migrateWorkspaceChannelProfileOrder,
  migrateWorkspaceControllerCode,
  migrateWorkspaceImportedUserAccess,
  parseLegacyFd4Config,
} from "../app/fd4cfg.ts";
import { foundationDictionaryOrder } from "../app/foundation-dictionary-order.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const oracleFixtures = path.join(here, "..", "tools", "oracle", "fixtures");

function modelFromFixture() {
  const raw = fs.readFileSync(
    path.join(oracleFixtures, "transfer-oracle.fd4cfg"),
  );
  return parseLegacyFd4Config(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
  );
}

test("the user-profile compiler reproduces the wholly synthetic iOS oracle payload", () => {
  const model = modelFromFixture();
  const expected = JSON.parse(
    fs.readFileSync(
      path.join(oracleFixtures, "transfer-oracle-user-payloads.json"),
      "utf8",
    ),
  ).map((value) => Buffer.from(value, "base64"));
  const result = compileUserProfiles(model);
  assert.equal(result.complete, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.payloads.map(Buffer.from), expected);
});

test("unsupported profile fields fail closed instead of emitting plausible data", () => {
  const model = modelFromFixture();
  model.channels[0].hardwareType = 256;
  model.configurations[0].controllerCode = "";
  model.users[0].securityCode = "not-a-key";
  const result = compileUserProfiles(model);
  assert.equal(result.complete, false);
  assert.match(result.problems.join("\n"), /eight-character controller code/);
  assert.match(result.problems.join("\n"), /16-character security code/);
  assert.match(result.problems.join("\n"), /hardware type 256/);
});

test("Darwin NSString dictionary order is reproduced for profile rank ties", () => {
  assert.deepEqual(
    foundationDictionaryOrder([101, 102, 103, 201, 202, 203, 301, 302]),
    [5, 1, 4, 0, 7, 3, 2, 6],
  );
  // Includes a five-character key, which exercises Apple's four-character
  // unrolled hash step rather than a superficially equivalent 257 recurrence.
  assert.deepEqual(
    foundationDictionaryOrder([-4, 9, 101, 4001, 17, 203, 65535, 1, 300]),
    [0, 5, 6, 8, 3, 1, 4, 2, 7],
  );
});

test("an old persisted import migrates back to the exact synthetic oracle payloads", () => {
  const fresh = modelFromFixture();
  const expected = compileUserProfiles(fresh);
  let workspace = canonicalizeAppData(fresh);
  workspace = {
    ...workspace,
    sites: workspace.sites.map((site) => ({
      ...site,
      configurations: site.configurations.map((configuration) => {
        const oldConfiguration = { ...configuration };
        delete oldConfiguration.controllerCode;
        return {
          ...oldConfiguration,
          content: {
            ...configuration.content,
            channels: configuration.content.channels.map((channel) => {
              const oldChannel = { ...channel };
              delete oldChannel.profileOrder;
              return oldChannel;
            }),
            users: configuration.content.users.map((user) => ({
              ...user,
              roomIds: [],
              switchIds: [],
            })),
          },
        };
      }),
    })),
  };
  const stale = compileUserProfiles(materializeAppData(workspace));
  assert.equal(stale.complete, false);
  assert.match(stale.problems.join("\n"), /missing its retained profile order/);
  assert.match(stale.problems.join("\n"), /unresolved room and switch access/);
  workspace = migrateWorkspaceImportedUserAccess(
    migrateWorkspaceChannelProfileOrder(
      migrateWorkspaceControllerCode(workspace),
    ),
  );
  const migrated = compileUserProfiles(materializeAppData(workspace));
  assert.equal(migrated.complete, true);
  assert.deepEqual(
    migrated.payloads.map(Buffer.from),
    expected.payloads.map(Buffer.from),
  );
});
