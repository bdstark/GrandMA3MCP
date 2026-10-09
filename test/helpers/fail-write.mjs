// Preload for script tests (node --import): makes fs.writeSync throw ENOSPC for the file named in
// KB02_FAIL_WRITE_ON, after the file has been created. Simulates a disk-full failure mid-write.
import fs from "node:fs";
import path from "node:path";
const target = process.env.KB02_FAIL_WRITE_ON;
if (target) {
  const fdPaths = new Map();
  const openSync = fs.openSync;
  fs.openSync = function (p, ...rest) { const fd = openSync.call(fs, p, ...rest); fdPaths.set(fd, String(p)); return fd; };
  const writeSync = fs.writeSync;
  fs.writeSync = function (fd, ...rest) {
    if (path.basename(fdPaths.get(fd) ?? "") === target) { const e = new Error("ENOSPC: no space left on device, write"); e.code = "ENOSPC"; throw e; }
    return writeSync.call(fs, fd, ...rest);
  };
}
