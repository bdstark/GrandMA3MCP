import dgram from "node:dgram";

/**
 * Minimal OSC 1.0 message encoder and UDP sender.
 * grandMA3 accepts command-line commands at the "/cmd" address with a single string argument
 * when "Receive Command" is enabled for the OSC configuration line (Menu > In & Out > OSC).
 */

export type OscArg = string | number | boolean | { int: number } | { float: number };

function padTo4(buf: Buffer): Buffer {
  const pad = (4 - (buf.length % 4)) % 4;
  return pad === 0 ? buf : Buffer.concat([buf, Buffer.alloc(pad)]);
}

function oscString(s: string): Buffer {
  return padTo4(Buffer.concat([Buffer.from(s, "utf8"), Buffer.alloc(1)]));
}

export function encodeOscMessage(address: string, args: OscArg[] = []): Buffer {
  let tags = ",";
  const parts: Buffer[] = [];
  for (const a of args) {
    if (typeof a === "string") {
      tags += "s";
      parts.push(oscString(a));
    } else if (typeof a === "boolean") {
      tags += a ? "T" : "F";
    } else if (typeof a === "number") {
      if (Number.isInteger(a)) {
        tags += "i";
        const b = Buffer.alloc(4);
        b.writeInt32BE(a);
        parts.push(b);
      } else {
        tags += "f";
        const b = Buffer.alloc(4);
        b.writeFloatBE(a);
        parts.push(b);
      }
    } else if ("int" in a) {
      tags += "i";
      const b = Buffer.alloc(4);
      b.writeInt32BE(a.int);
      parts.push(b);
    } else {
      tags += "f";
      const b = Buffer.alloc(4);
      b.writeFloatBE(a.float);
      parts.push(b);
    }
  }
  return Buffer.concat([oscString(address), oscString(tags), ...parts]);
}

export interface OscOptions {
  host: string;
  port: number;
  /** Optional prefix configured in the grandMA3 OSC settings (without slashes). */
  prefix?: string;
}

export class OscSender {
  constructor(private readonly opts: OscOptions) {}

  get description(): string {
    const prefix = this.opts.prefix ? `/${this.opts.prefix}` : "";
    return `udp://${this.opts.host}:${this.opts.port}${prefix}`;
  }

  address(path: string): string {
    const p = path.startsWith("/") ? path : `/${path}`;
    return this.opts.prefix ? `/${this.opts.prefix}${p}` : p;
  }

  send(path: string, args: OscArg[] = []): Promise<void> {
    const msg = encodeOscMessage(this.address(path), args);
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket("udp4");
      sock.send(msg, this.opts.port, this.opts.host, (err) => {
        sock.close();
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Send a grandMA3 command line command via the /cmd address. Fire-and-forget: OSC gives no feedback. */
  sendCommand(command: string): Promise<void> {
    return this.send("/cmd", [command]);
  }
}
