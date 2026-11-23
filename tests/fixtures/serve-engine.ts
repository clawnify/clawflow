// A whole engine in a process of its own: the plugin registered the way a
// gateway registers it, with its flow server, scheduler and timers. Arguments:
// the workspace and the port to serve on. Tests kill it to see what the next
// engine on the same workspace makes of the runs it left behind.
import * as path from "node:path";

process.env.CLAWFLOW_SERVE = "1"; // this process is not `openclaw gateway run`
const { default: plugin } = await import("../../src/plugin/index.js");

const [workspace, port] = process.argv.slice(2);
plugin.register({
  registerTool: () => {},
  registerHook: () => {},
  config: {
    workspace,
    plugins: { entries: { clawflow: { config: {
      stateDir: path.join(workspace, "state"),
      memoryDir: path.join(workspace, "memory"),
      serve: { port: Number(port) },
    } } } },
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as never);
