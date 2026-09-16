import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Two imports of the same module file under different specifiers are two
// module instances in Node — exactly what a plugin importing clawflow from
// src/ while the gateway runs dist/ produces. The default registry must be
// the same object in both.
describe("default step registry", () => {
  it("is shared across separately loaded module instances", async () => {
    const a = await import("../src/core/custom-steps.js?instance=a");
    const b = await import("../src/core/custom-steps.js?instance=b");
    assert.notEqual(a, b, "test setup: expected two module instances");
    assert.equal(a.defaultRegistry, b.defaultRegistry);

    a.registerStepType({ name: "shared_probe_step", allowedKeys: [], run: () => 1 });
    assert.ok(b.defaultRegistry.has("shared_probe_step"), "a step registered through one instance is visible through the other");
    a.defaultRegistry.clear();
  });
});
