import {
  isFlexiDimWorkspace,
  validateConfigContent,
  type FlexiDimWorkspace,
} from "./fd4cfg.ts";

export const MAX_WORKSPACE_BYTES = 8 * 1024 * 1024;

export type WorkspacePutRequest = {
  workspace: FlexiDimWorkspace;
  expectedRevision: number;
};

export function parseWorkspacePutRequest(value: unknown): WorkspacePutRequest {
  if (!value || typeof value !== "object")
    throw new Error("The request body must be an object");
  const candidate = value as Partial<WorkspacePutRequest>;
  if (!isFlexiDimWorkspace(candidate.workspace))
    throw new Error("The workspace has an invalid ownership structure");
  if (
    !Number.isInteger(candidate.expectedRevision) ||
    candidate.expectedRevision! < 0
  )
    throw new Error("The expected revision must be a non-negative integer");

  for (const site of candidate.workspace.sites) {
    for (const configuration of site.configurations) {
      const issues = validateConfigContent(configuration.content);
      if (issues.length)
        throw new Error(
          `${site.name} / ${configuration.name}: ${issues[0]}`,
        );
    }
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify(candidate.workspace),
  ).byteLength;
  if (bytes > MAX_WORKSPACE_BYTES)
    throw new Error("The workspace is too large to store");
  return candidate as WorkspacePutRequest;
}
