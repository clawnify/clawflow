// Runs one flow in a process of its own, for tests that need a run whose
// process really is another one. Arguments, each as JSON: the runner config,
// the flow definition, the instance id. The test watches the run's record and
// kills this process once it has seen what it needs.
import { FlowRunner } from "../../src/index.js";

const [cfg, flow, instanceId] = process.argv.slice(2);
const runner = new FlowRunner(JSON.parse(cfg));
await runner.run(JSON.parse(flow), {}, JSON.parse(instanceId));
