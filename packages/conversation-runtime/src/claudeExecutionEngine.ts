import { createNativeAcpExecutionEngine } from "./nativeAcpExecutionEngine.js";

export function createClaudeExecutionEngine(options: { launcher: string; models: string[] }) {
  return createNativeAcpExecutionEngine("claude", options);
}
