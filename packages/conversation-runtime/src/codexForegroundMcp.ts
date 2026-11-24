import { createHmac } from "node:crypto";

// The dedicated App Server receives only the derived MCP bearer, not a new
// persisted credential or a way to authenticate to the general runtime API.
export function codexForegroundMcpBearer(runtimeToken: string | undefined): string | undefined {
  if (!runtimeToken || Buffer.byteLength(runtimeToken) < 32) return;
  return createHmac("sha256", runtimeToken).update("lark:codex-foreground:mcp-bearer:v1").digest("base64url");
}
