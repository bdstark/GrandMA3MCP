/**
 * Starts the real MCP server over stdio (as a client would) pointed at a FakeBridge, for
 * end-to-end checks of tool registration and transport behaviour.
 */
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export async function startMcpServer(env: Record<string, string>): Promise<Client> {
  const full: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) full[k] = v;
  Object.assign(full, {
    GMA3_HELP_DIR: path.join(repoRoot, "test", "no-such-manual"),
    GMA3_INSTALL_DIR: path.join(repoRoot, "test", "no-such-install"),
    ...env,
  });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts"], cwd: repoRoot, env: full, stderr: "pipe" });
  const client = new Client({ name: "gma3-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

export function mcpText(result: unknown): string {
  const r = result as { content: Array<{ type: string; text?: string }> };
  return r.content.map((c) => c.text ?? "").join("\n");
}
export const mcpIsError = (result: unknown): boolean => Boolean((result as { isError?: boolean }).isError);
