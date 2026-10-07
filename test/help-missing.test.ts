import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

/** Behaviour when no manual can be found anywhere. */

delete process.env.GMA3_HELP_DIR;
process.env.GMA3_INSTALL_DIR = path.join(os.tmpdir(), "gma3-no-such-install-dir");
const { helpDir, helpVersion, listHelpPages, lookupHelp } = await import("../src/help.ts");

test("lookups fail with a configuration hint when the manual is absent", () => {
  assert.equal(helpDir(), null);
  assert.equal(helpVersion(), null);
  assert.deepEqual(listHelpPages(), []);
  assert.match(lookupHelp("store").error ?? "", /GMA3_HELP_DIR or GMA3_INSTALL_DIR/);
});
