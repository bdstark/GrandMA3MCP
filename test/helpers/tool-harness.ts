/**
 * Runs tool modules in-process against a FakeBridge without spawning the MCP server.
 *
 * `captureTools(register, ctx)` calls a module's register function with a stub McpServer that
 * records every registerTool() call, so a test can invoke a tool handler directly with parsed
 * arguments and assert on the returned MCP result. The arguments are validated against the
 * tool's zod input schema first, exactly as the SDK would.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Gma3Bridge } from "../../src/bridge.ts";
import { MutationLock } from "../../src/mutations.ts";
import type { ToolContext, RegisterTools } from "../../src/tools/context.ts";
import type { ToolResult } from "../../src/results.ts";
import { FakeBridge } from "./fake-bridge.ts";

export interface CapturedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  /** Validate `args` with the tool's schema and run the handler. */
  call(args: Record<string, unknown>): Promise<ToolResult>;
}

export function captureTools(register: RegisterTools, ctx: ToolContext): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  const stub = {
    registerTool(name: string, def: { title?: string; description?: string; inputSchema?: Record<string, z.ZodTypeAny> }, handler: (args: Record<string, unknown>) => Promise<ToolResult>) {
      const tool: CapturedTool = {
        name,
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        handler,
        async call(args) {
          if (def.inputSchema) {
            const parsed = z.object(def.inputSchema).safeParse(args);
            if (!parsed.success) {
              return { content: [{ type: "text", text: `input validation failed: ${parsed.error.message}` }], isError: true };
            }
            return handler(parsed.data as Record<string, unknown>);
          }
          return handler(args);
        },
      };
      tools.set(name, tool);
    },
    registerResource() {},
  } as unknown as McpServer;
  register(stub, ctx);
  return tools;
}

export interface Harness {
  fake: FakeBridge;
  bridge: Gma3Bridge;
  ctx: ToolContext;
  tools: Map<string, CapturedTool>;
  /** Call a tool by name, asserting it exists. */
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** Call a tool and parse its JSON text content. */
  callJson<T = any>(name: string, args?: Record<string, unknown>): Promise<{ result: T; isError: boolean; text: string }>;
  close(): Promise<void>;
}

export async function startHarness(register: RegisterTools, opts: { requestTimeoutMs?: number } = {}): Promise<Harness> {
  const fake = new FakeBridge();
  const port = await fake.listen();
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port, requestTimeoutMs: opts.requestTimeoutMs ?? 400, connectTimeoutMs: 1000 });
  const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: opts.requestTimeoutMs ?? 400, luaToolAllowed: true };
  const tools = captureTools(register, ctx);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool ${name} is not registered (have: ${[...tools.keys()].join(", ")})`);
    return tool.call(args);
  };
  return {
    fake,
    bridge,
    ctx,
    tools,
    call,
    async callJson(name, args) {
      const res = await call(name, args);
      const text = res.content.map((c) => c.text).join("\n");
      let result: any;
      try {
        result = JSON.parse(text);
      } catch {
        result = text;
      }
      return { result, isError: Boolean(res.isError), text };
    },
    async close() {
      bridge.close();
      await fake.close();
    },
  };
}

export const textOf = (res: ToolResult): string => res.content.map((c) => c.text).join("\n");
