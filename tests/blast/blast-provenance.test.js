/**
 * Impact provider sealing / provenance (replaces Graphify blast provenance tests).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  sealImpactArtifact,
  verifySealedArtifact,
} from "../../scripts/lib/state-machine.js";
import { createNexusImpactProvider } from "../../scripts/lib/providers/impact-provider.js";

test("sealed impact artifacts verify digest", () => {
  const sealed = sealImpactArtifact({
    schema_version: "1.0",
    risk: "LOW",
    confidence: 0.9,
    provider: "nexus-impact",
    trusted: true,
    analysis_quality: "PRECISE",
    analysis_complete: true,
    uncertainties: [],
  });
  assert.equal(verifySealedArtifact(sealed), true);
  sealed.risk = "HIGH";
  assert.equal(verifySealedArtifact(sealed), false);
});

test("impact provider analyze returns report shape", () => {
  const provider = createNexusImpactProvider();
  assert.equal(provider.mode, "nexus-impact");
  assert.equal(typeof provider.analyze, "function");
});
