import {
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../../../server/workspace-store.mjs";
import { parseWorkspacePutRequest } from "../../workspace-api.ts";

const json = (value: unknown, init?: ResponseInit) =>
  Response.json(value, {
    ...init,
    headers: {
      "cache-control": "no-store",
      ...init?.headers,
    },
  });

export async function GET() {
  try {
    const stored = await readWorkspaceFile();
    if (!stored) {
      console.log("Workspace load: no saved configuration");
      return json({ workspace: null, revision: 0, updatedAt: null });
    }
    console.log(`Workspace load: revision ${stored.revision}`);
    return json(stored);
  } catch (error) {
    console.error(
      "Workspace load failed:",
      error instanceof Error ? error.message : error,
    );
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The workspace file could not be read",
      },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  let body;
  try {
    body = parseWorkspacePutRequest(await request.json());
  } catch (error) {
    console.error(
      "Workspace save rejected:",
      error instanceof Error ? error.message : error,
    );
    return json(
      {
        error:
          error instanceof Error ? error.message : "Invalid workspace",
      },
      { status: 400 },
    );
  }
  try {
    const result = await writeWorkspaceFile(
      body.workspace,
      body.expectedRevision,
    );
    if (result.conflict) {
      console.warn(`Workspace save conflict at revision ${result.revision}`);
      return json(
        {
          error: "The workspace changed on the server",
          revision: result.revision,
        },
        { status: 409 },
      );
    }
    console.log(`Workspace saved: revision ${result.revision}`);
    return json(result);
  } catch (error) {
    console.error(
      "Workspace save failed:",
      error instanceof Error ? error.message : error,
    );
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The workspace file could not be written",
      },
      { status: 500 },
    );
  }
}
