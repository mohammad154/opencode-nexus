#!/usr/bin/env node
/**
 * Fail the installer when orchestrator/implementer permission globs do not
 * match absolute paths. Prints the denial; does not continue.
 */
import { runPermissionSelfTest } from "./lib/permission-self-test.js";

const result = runPermissionSelfTest();
if (!result.ok) {
  console.error("Nexus permission self-test failed.");
  console.error(
    "The orchestrator must be able to write its own .opencode state at an absolute path, and implementer denies must match that same absolute path.",
  );
  for (const error of result.errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log("  [permissions] orchestrator absolute-path write: ok");
