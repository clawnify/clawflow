import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  FlowRunner,
  defaultRegistry,
  listVersions,
  publishDraft,
  readLatestVersion,
  readVersion,
  resolveFlowFile,
  startFlowServer,
} from "../src/index.js";
import type { FlowDefinition } from "../src/index.js";

const tmpDir = path.join(os.tmpdir(), `ocf-manage-test-${Date.now()}`);
const workspace = path.join(tmpDir, "workspace");

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const simpleFlow: FlowDefinition = {
  flow: "manage-test",
  nodes: [{ name: "step1", do: "code", run: "return 1", output: "result" }],
};

function writeDraft(name: string, def: unknown = simpleFlow): string {
  const file = path.join(workspace, "flows", `${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(def, null, 2));
  return file;
}

// ---- resolveFlowFile ------------------------------------------------------------

describe("resolveFlowFile", () => {
  after(cleanup);

  it("resolves plain names to workspace/flows/<name>.json", () => {
    assert.equal(
      resolveFlowFile(workspace, "my-flow"),
      path.join(workspace, "flows", "my-flow.json"),
    );
  });

  it("strips a .json suffix from plain names", () => {
    assert.equal(
      resolveFlowFile(workspace, "my-flow.json"),
      path.join(workspace, "flows", "my-flow.json"),
    );
  });

  it("resolves relative paths against the workspace", () => {
    assert.equal(
      resolveFlowFile(workspace, "custom/dir/f.json"),
      path.join(workspace, "custom/dir/f.json"),
    );
  });

  it("passes absolute paths through", () => {
    assert.equal(resolveFlowFile(workspace, "/tmp/x.json"), "/tmp/x.json");
  });
});

// ---- publishDraft + version readers ----------------------------------------------

describe("publishDraft", () => {
  after(cleanup);

  it("publishes v1 stamped into the definition, then v2", () => {
    writeDraft("incr");
    const first = publishDraft(workspace, "incr");
    assert.equal(first.version, 1);
    assert.equal(first.flow, "manage-test");
    assert.equal(first.totalVersions, 1);
    const onDisk = JSON.parse(fs.readFileSync(first.file, "utf-8"));
    assert.equal(onDisk.version, "1");

    const second = publishDraft(workspace, "incr");
    assert.equal(second.version, 2);
    assert.deepEqual(listVersions(workspace, "incr"), [1, 2]);
  });

  it("does not modify the draft file", () => {
    const draftPath = writeDraft("immutable");
    const before = fs.readFileSync(draftPath, "utf-8");
    publishDraft(workspace, "immutable");
    assert.equal(fs.readFileSync(draftPath, "utf-8"), before);
  });

  it("round-trips through readVersion / readLatestVersion", () => {
    writeDraft("readback");
    publishDraft(workspace, "readback");
    publishDraft(workspace, "readback");

    const v1 = readVersion(workspace, "readback", 1);
    assert.equal(v1?.version, "1");
    assert.equal(readVersion(workspace, "readback", 99), null);

    const latest = readLatestVersion(workspace, "readback");
    assert.equal(latest?.version, 2);
    assert.equal(latest?.def.version, "2");
    assert.equal(readLatestVersion(workspace, "never-published"), null);
  });

  it("throws when the draft is missing", () => {
    assert.throws(() => publishDraft(workspace, "nope"), /Draft not found/);
  });

  it("throws when the draft is not valid JSON", () => {
    const file = path.join(workspace, "flows", "broken.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    assert.throws(() => publishDraft(workspace, "broken"), /Failed to parse/);
  });
});

// ---- POST /flows/validate (flow server) -------------------------------------------

describe("flow server validate route", () => {
  let server: ReturnType<typeof startFlowServer>;
  let base: string;

  before(async () => {
    const runner = new FlowRunner({
      stateDir: path.join(tmpDir, "state"),
      memoryDir: path.join(tmpDir, "memory"),
    });
    server = startFlowServer({
      runner,
      serve: { port: 0, path: "/flows" },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    base = `http://127.0.0.1:${addr.port}/flows`;
  });

  after(() => {
    server.close();
    cleanup();
  });

  it("validates a good definition", async () => {
    const res = await fetch(`${base}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(simpleFlow),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; errors: unknown[] };
    assert.equal(body.ok, true);
    assert.deepEqual(body.errors, []);
  });

  it("reports node-level errors for a bad definition", async () => {
    const res = await fetch(`${base}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flow: "bad", nodes: [{ name: "x", do: "nope" }] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      errors: { node?: string; message: string }[];
    };
    assert.equal(body.ok, false);
    assert.ok(body.errors.some((e) => e.message.includes('Unknown node type "nope"')));
  });

  it("knows custom steps registered in this process's registry", async () => {
    defaultRegistry.register({
      name: "manage_test_step",
      allowedKeys: ["message"],
      run: () => ({}),
    });
    const flow: FlowDefinition = {
      flow: "custom",
      nodes: [
        {
          name: "c",
          do: "manage_test_step" as unknown as "code",
          // @ts-expect-error custom field not in built-in types
          message: "hi",
        } as unknown as FlowDefinition["nodes"][number],
      ],
    };
    const res = await fetch(`${base}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(flow),
    });
    const body = (await res.json()) as { ok: boolean; errors: { message: string }[] };
    assert.equal(body.ok, true, JSON.stringify(body.errors));
  });

  it("rejects malformed JSON and non-object bodies", async () => {
    const bad1 = await fetch(`${base}/validate`, { method: "POST", body: "{ nope" });
    assert.equal(bad1.status, 400);
    const bad2 = await fetch(`${base}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([1, 2]),
    });
    assert.equal(bad2.status, 400);
  });

  it("does not shadow the run route", async () => {
    // A flow literally named "validate" must still be runnable by name.
    const res = await fetch(`${base}/validate/run`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404); // routed as run (no such flow saved), not validate
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Flow not found: validate/);
  });
});
