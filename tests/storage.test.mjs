import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../server/workspace-store.mjs";
import {
  parseWorkspacePutRequest,
} from "../app/workspace-api.ts";
import {
  GET as getWorkspace,
  PUT as putWorkspace,
} from "../app/api/workspace/route.ts";
import { POST as postEvent } from "../app/api/events/route.ts";

function content() {
  return {
    rooms: [],
    channels: [],
    switches: [],
    sceneGroups: [],
    scenes: [],
    deletedScenes: [],
    periods: [],
    users: [],
    assignments: [],
    modules: [],
    deletedItems: [],
  };
}

function workspace() {
  return {
    activeSiteId: "SITE-1",
    activeConfigId: 1,
    sites: [{
      name: "Test",
      id: "SITE-1",
      ip: "",
      port: 15273,
      description: "",
      address: "",
      timezone: "Europe/London",
      dst: "UK / Europe",
      remote: false,
      configurations: [{
        id: 1,
        name: "Test",
        description: "",
        lastUpdated: "",
        content: content(),
      }],
    }],
  };
}

test("validates server workspace writes before persistence", () => {
  const value = parseWorkspacePutRequest({
    workspace: workspace(),
    expectedRevision: 0,
  });
  assert.equal(value.workspace.activeSiteId, "SITE-1");
  assert.equal(value.expectedRevision, 0);
  assert.throws(
    () => parseWorkspacePutRequest({
      workspace: { ...workspace(), activeSiteId: "" },
      expectedRevision: 0,
    }),
    /invalid ownership structure/,
  );
  const invalid = workspace();
  invalid.sites[0].configurations[0].content.channels.push({
    id: 1,
    name: "Dangling",
    roomId: 999,
    module: "",
    kind: "",
    level: 0,
  });
  assert.throws(
    () => parseWorkspacePutRequest({
      workspace: invalid,
      expectedRevision: 0,
    }),
    /missing room 999/,
  );
});

test("writes the workspace atomically and rejects stale revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flexidim-storage-"));
  const previous = process.env.CONFIG_DIR;
  process.env.CONFIG_DIR = directory;
  try {
    assert.equal(await readWorkspaceFile(), null);
    const first = await writeWorkspaceFile(workspace(), 0);
    assert.equal(first.conflict, false);
    assert.equal(first.revision, 1);

    const stored = await readWorkspaceFile();
    assert.equal(stored.revision, 1);
    assert.equal(stored.workspace.activeSiteId, "SITE-1");
    assert.equal(
      JSON.parse(await readFile(join(directory, "workspace.json"), "utf8"))
        .schemaVersion,
      3,
    );
    const metadata = await stat(join(directory, "workspace.json"));
    assert.equal(metadata.mode & 0o077, 0);

    const stale = await writeWorkspaceFile(workspace(), 0);
    assert.equal(stale.conflict, true);
    assert.equal(stale.revision, 1);
  } finally {
    if (previous === undefined) delete process.env.CONFIG_DIR;
    else process.env.CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace API creates, reads and conflict-checks the server file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flexidim-api-"));
  const previous = process.env.CONFIG_DIR;
  process.env.CONFIG_DIR = directory;
  try {
    const empty = await getWorkspace();
    assert.deepEqual(await empty.json(), {
      workspace: null,
      revision: 0,
      updatedAt: null,
    });
    const created = await putWorkspace(new Request("http://localhost/api/workspace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: workspace(), expectedRevision: 0 }),
    }));
    assert.equal(created.status, 200);
    assert.equal((await created.json()).revision, 1);

    const loaded = await getWorkspace();
    const payload = await loaded.json();
    assert.equal(payload.revision, 1);
    assert.equal(payload.workspace.activeSiteId, "SITE-1");

    const stale = await putWorkspace(new Request("http://localhost/api/workspace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: workspace(), expectedRevision: 0 }),
    }));
    assert.equal(stale.status, 409);
  } finally {
    if (previous === undefined) delete process.env.CONFIG_DIR;
    else process.env.CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("client import events are validated before server logging", async () => {
  const invalid = await postEvent(new Request("http://localhost/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "anything", status: "failed" }),
  }));
  assert.equal(invalid.status, 400);

  const originalLog = console.log;
  let logged = "";
  console.log = (message) => {
    logged = String(message);
  };
  try {
    const response = await postEvent(new Request("http://localhost/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "configuration-import",
        status: "succeeded",
        fileName: "example.fd4cfg",
        fileSize: 123,
        rooms: 2,
      }),
    }));
    assert.equal(response.status, 204);
    assert.match(logged, /Configuration import succeeded: example\.fd4cfg/);
    assert.match(logged, /rooms=2/);
  } finally {
    console.log = originalLog;
  }
});
