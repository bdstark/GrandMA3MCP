#!/usr/bin/env node
// Tiny CLI for the Lua bridge: node scripts/bridge-cli.mjs <op> [jsonArgs]
//   node scripts/bridge-cli.mjs ping
//   node scripts/bridge-cli.mjs cmd '{"command":"Go+ Sequence 1"}'
//   node scripts/bridge-cli.mjs lua '{"code":"SelectedSequence().name"}'
import net from "node:net";
const [op, argsJson] = process.argv.slice(2);
if (!op) { console.error("usage: bridge-cli <op> [jsonArgs]"); process.exit(2); }
const args = argsJson ? JSON.parse(argsJson) : {};
const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const sock = net.connect(port, host, () => sock.write(JSON.stringify({ id: "cli", op, args }) + "\n"));
let buf = "";
sock.setEncoding("utf8");
sock.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) { const m = JSON.parse(buf.slice(0, i)); console.log(JSON.stringify(m.ok ? m.result : { error: m.error }, null, 2)); sock.end(); process.exit(0); } });
sock.on("error", (e) => { console.error("bridge error:", e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 20000);
