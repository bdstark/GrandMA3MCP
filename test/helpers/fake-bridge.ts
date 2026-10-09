/**
 * A scriptable stand-in for the gma3_mcp_bridge plugin: JSON lines over TCP on 127.0.0.1.
 *
 * Tests register per-op handlers. A handler returns a value (sent as {ok:true,result}), throws
 * (sent as {ok:false,error}), or returns the SILENT symbol to never answer (simulating a lost
 * reply so the client sees a dispatched timeout). Every request is recorded in `requests`.
 */
import net from "node:net";

export type BridgeRequest = { id: string; op: string; args: Record<string, unknown> };
export const SILENT = Symbol("silent");

/** Throw this from a handler to answer with the bridge's structured error reply ({error, code, detail}, bridge 0.7.0). */
export class BridgeReplyError extends Error {
  constructor(message: string, public readonly code?: string, public readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = "BridgeReplyError";
  }
}
export type OpHandler = (args: Record<string, unknown>, req: BridgeRequest) => unknown | typeof SILENT | Promise<unknown | typeof SILENT>;

export class FakeBridge {
  readonly requests: BridgeRequest[] = [];
  private handlers = new Map<string, OpHandler>();
  private sockets = new Set<net.Socket>();
  private server: net.Server;
  port = 0;

  constructor() {
    this.server = net.createServer((sock) => {
      this.sockets.add(sock);
      sock.on("close", () => this.sockets.delete(sock));
      sock.on("error", () => {});
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) void this.handle(JSON.parse(line) as BridgeRequest, sock);
        }
      });
    });
  }

  private async handle(req: BridgeRequest, sock: net.Socket): Promise<void> {
    this.requests.push(req);
    const handler = this.handlers.get(req.op) ?? this.handlers.get("*");
    let msg: unknown;
    if (!handler) {
      msg = { id: req.id, ok: false, error: `unknown op '${req.op}'` };
    } else {
      try {
        const result = await handler(req.args ?? {}, req);
        if (result === SILENT) return;
        msg = { id: req.id, ok: true, result: result === undefined ? null : result };
      } catch (err) {
        msg = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
        if (err instanceof BridgeReplyError) msg = { ...(msg as object), code: err.code, detail: err.detail };
      }
    }
    if (!sock.destroyed) sock.write(JSON.stringify(msg) + "\n");
  }

  /** The handler currently registered for an op, so a test can wrap it. */
  handlerFor(op: string): OpHandler | undefined {
    return this.handlers.get(op);
  }

  /** Register a handler for an op ("*" catches everything else). Returns this for chaining. */
  on(op: string, handler: OpHandler): this {
    this.handlers.set(op, handler);
    return this;
  }

  /** Convenience: answer "cmd" requests with a feedback string chosen per command. */
  onCommand(feedback: (command: string) => string | typeof SILENT): this {
    return this.on("cmd", (args) => {
      const fb = feedback(String(args.command));
      return fb === SILENT ? SILENT : { command: args.command, feedback: fb };
    });
  }

  reset(): void {
    this.requests.length = 0;
    this.handlers.clear();
  }

  /** Commands sent through "cmd", in order. */
  get commands(): string[] {
    return this.requests.filter((r) => r.op === "cmd").map((r) => String(r.args.command));
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this.port;
  }

  /** Drop every client connection (simulates the console going away) but keep listening. */
  dropClients(): void {
    for (const s of this.sockets) s.destroy();
  }

  async close(): Promise<void> {
    this.dropClients();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
