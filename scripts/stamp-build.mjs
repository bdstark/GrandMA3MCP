// Writes dist/build-info.json after tsc (part of `npm run build`). The server compares it with the
// checkout's source at startup and in gma3_status to report a build that is older than its source.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBuildStamp } from "../dist/buildinfo.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = writeBuildStamp(root);
console.log(`build-info: ${stamp.sourceHash.slice(0, 12)}${stamp.commit ? ` at ${stamp.commit.slice(0, 7)}${stamp.dirty ? " (uncommitted changes)" : ""}` : ""}`);
