import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shouldServe } from "../src/plugin/index.js";

// The scheduler and flow server belong to exactly one process per box: the
// gateway. Every other load of the plugin must stay passive.
describe("shouldServe", () => {
  const gateway = ["node", "/usr/bin/openclaw", "gateway", "run"];
  const help = ["node", "/usr/bin/openclaw", "--help"];
  const cronList = ["node", "/usr/bin/openclaw", "cron", "list", "--agent", "main"];

  it("serves in the gateway process with a full registration", () => {
    assert.equal(shouldServe({ registrationMode: "full" }, gateway, {}), true);
    assert.equal(shouldServe({}, gateway, {}), true, "older hosts without registrationMode");
    assert.equal(shouldServe({ registrationMode: "full" }, ["node", "openclaw", "gateway"], {}), true, "bare `openclaw gateway`");
  });

  it("stays passive in CLI, discovery and setup loads", () => {
    assert.equal(shouldServe({ registrationMode: "full" }, help, {}), false, "openclaw --help");
    assert.equal(shouldServe({ registrationMode: "full" }, cronList, {}), false, "openclaw cron list");
    assert.equal(shouldServe({ registrationMode: "cli-metadata" }, gateway, {}), false);
    assert.equal(shouldServe({ registrationMode: "discovery" }, gateway, {}), false);
    assert.equal(shouldServe({ registrationMode: "setup-only" }, gateway, {}), false);
    assert.equal(shouldServe({ registrationMode: "full" }, ["node", "openclaw", "gateway", "status"], {}), false, "gateway status is a client, not the daemon");
  });

  it("honours the explicit env switches either way", () => {
    assert.equal(shouldServe({ registrationMode: "full" }, gateway, { CLAWFLOW_NO_SERVE: "1" }), false);
    assert.equal(shouldServe({ registrationMode: "cli-metadata" }, help, { CLAWFLOW_SERVE: "1" }), true);
    assert.equal(shouldServe({ registrationMode: "full" }, gateway, { CLAWFLOW_NO_SERVE: "1", CLAWFLOW_SERVE: "1" }), false, "NO_SERVE wins: a spawned child must never bind");
  });
});
