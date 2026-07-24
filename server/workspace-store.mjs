import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const workspaceFile = () =>
  resolve(process.env.CONFIG_DIR || "./config", "workspace.json");

let writeQueue = Promise.resolve();

export async function readWorkspaceFile() {
  try {
    const stored = JSON.parse(await readFile(workspaceFile(), "utf8"));
    if (
      !stored ||
      typeof stored !== "object" ||
      !Number.isInteger(stored.revision) ||
      !stored.workspace
    )
      throw new Error("The stored workspace file has an invalid format");
    return stored;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return null;
    throw error;
  }
}

export function writeWorkspaceFile(workspace, expectedRevision) {
  const operation = writeQueue.then(async () => {
    const existing = await readWorkspaceFile();
    const currentRevision = existing?.revision ?? 0;
    if (currentRevision !== expectedRevision)
      return { conflict: true, revision: currentRevision };

    const revision = currentRevision + 1;
    const updatedAt = new Date().toISOString();
    const destination = workspaceFile();
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(
      temporary,
      JSON.stringify(
        { schemaVersion: 3, revision, updatedAt, workspace },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, destination);
    return { conflict: false, revision, updatedAt };
  });
  writeQueue = operation.catch(() => undefined);
  return operation;
}
