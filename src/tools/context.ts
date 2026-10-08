import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Gma3Bridge } from "../bridge.js";
import type { MutationLock } from "../mutations.js";
import type { OperationResult, ToolResult } from "../results.js";
import { toToolResult } from "../results.js";

/** What every tool module gets from index.ts. */
export interface ToolContext {
  bridge: Gma3Bridge;
  /** Serialises mutations from this server; see mutations.ts. */
  mutations: MutationLock;
  /** Default per-request timeout in ms. */
  requestTimeoutMs: number;
  /** Whether the gma3_lua tool is registered (workflow tools never depend on it). */
  luaToolAllowed: boolean;
}

export type RegisterTools = (server: McpServer, ctx: ToolContext) => void;

/**
 * Wrap a workflow tool handler: the handler returns an OperationResult (or throws), and this
 * renders it as an MCP tool result, flagging anything but a verified success as an error.
 */
export function operation(fn: () => Promise<OperationResult>): Promise<ToolResult> {
  return fn().then(toToolResult, (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  });
}

/** Plain JSON tool result for read-only tools (no outcome model). */
export function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}
