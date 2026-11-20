import { parseArgs } from "node:util";
import { importJsonState } from "../src/core/migrate-storage.js";

const { values } = parseArgs({ options: {
  source: { type: "string" }, sqlite: { type: "string" },
  "postgres-env": { type: "string" }, namespace: { type: "string" },
  "writers-stopped": { type: "boolean" },
} });
if (!values.source || !values["writers-stopped"] || (!!values.sqlite === !!values["postgres-env"]) || (values["postgres-env"] && !values.namespace)) {
  console.error("Stop all ClawFlow writers first. Usage: npm run migrate:storage -- --writers-stopped --source <stateDir> (--sqlite <file> | --postgres-env <ENV_NAME> --namespace <name>)");
  process.exitCode = 1;
} else {
  const config = values.sqlite
    ? { backend: "sqlite" as const, path: values.sqlite }
    : { backend: "postgres" as const, connectionStringEnv: values["postgres-env"]!, namespace: values.namespace! };
  console.log(JSON.stringify(await importJsonState(values.source, config)));
}
