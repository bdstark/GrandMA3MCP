import net from "node:net";

/**
 * JSON-lines over TCP client for the gma3_mcp_bridge Lua plugin running inside grandMA3 onPC.
 */

export interface BridgeOptions {
  host: string;
  port: number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}

interface Pending {
  op: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class BridgeError extends Error {
  /**
   * True when the request was already written to the bridge before the failure
   * (timeout, or the connection dropped while waiting for the reply). The
   * command may or may not have executed inside onPC; callers must not retry
   * non-idempotent commands on another transport.
   */
  constructor(message: string, public readonly op?: string, public readonly dispatched = false) {
    super(message);
    this.name = "BridgeError";
  }
}

/** The bridge could not be reached at all; nothing was sent. Safe to fall back to another transport. */
export class BridgeUnreachableError extends BridgeError {
  constructor(message: string, op?: string) {
    super(message, op, false);
    this.name = "BridgeUnreachableError";
  }
}

export class Gma3Bridge {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private buffer = "";
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private lastError: string | null = null;

  constructor(private readonly opts: BridgeOptions) {}

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  get description(): string {
    return `${this.opts.host}:${this.opts.port}`;
  }

  get lastErrorMessage(): string | null {
    return this.lastError;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = new net.Socket();
      const timeout = this.opts.connectTimeoutMs ?? 3000;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.lastError = err.message;
        sock.destroy();
        reject(err instanceof BridgeUnreachableError ? err : new BridgeUnreachableError(`cannot connect to bridge at ${this.description}: ${err.message}`));
      };
      sock.setNoDelay(true);
      sock.setTimeout(timeout, () => fail(new BridgeUnreachableError(`connect timeout to ${this.description}`)));
      sock.once("error", (err) => {
        if (!settled) fail(err);
        else this.handleClose(err);
      });
      sock.connect(this.opts.port, this.opts.host, () => {
        settled = true;
        sock.setTimeout(0);
        this.socket = sock;
        this.lastError = null;
        sock.on("data", (chunk) => this.onData(chunk));
        sock.on("close", () => this.handleClose());
        resolve();
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private handleClose(err?: Error): void {
    this.socket = null;
    this.buffer = "";
    const reason = err ? err.message : "connection closed";
    this.lastError = reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      // The request was already on the wire: its outcome is unknown.
      p.reject(new BridgeError(`bridge ${reason} while waiting for reply`, p.op, true));
      this.pending.delete(id);
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const id = msg?.id !== undefined && msg?.id !== null ? String(msg.id) : null;
      if (!id) continue;
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new BridgeError(String(msg.error ?? "unknown bridge error")));
    }
  }

  async request<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    await this.connect();
    const sock = this.socket;
    if (!sock) throw new BridgeUnreachableError("not connected", op);
    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, op, args }) + "\n";
    const timeout = timeoutMs ?? this.opts.requestTimeoutMs ?? 15000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`timeout after ${timeout}ms waiting for '${op}'`, op, true));
      }, timeout);
      this.pending.set(id, { op, resolve: resolve as (v: unknown) => void, reject, timer });
      sock.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          // A write error does not prove the bytes never left; treat the outcome as unknown.
          reject(new BridgeError(`bridge write failed: ${err.message}`, op, true));
        }
      });
    });
  }
}
