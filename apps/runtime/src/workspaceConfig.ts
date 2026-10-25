import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

export function validateWorkspaceRoot(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1000 || !path.isAbsolute(value.trim())) {
    throw new Error("workspaceRoot must be an absolute directory path");
  }
  const root = path.resolve(value.trim());
  if (!statSync(root).isDirectory()) throw new Error("workspaceRoot must be a directory");
  accessSync(root, constants.R_OK | constants.X_OK);
  return root;
}
