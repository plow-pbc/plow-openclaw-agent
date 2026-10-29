import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

for (const name of ["boot/agent-index", "boot/config", "boot/front", "boot/identity", "boot/log", "boot/prompt", "boot/main", "boot/process", "boot/probe", "boot/probe-fixture", "boot/warm-record", "plugin/index", "plugin/transport", "plugin/email", "plugin/report-bug"]) {
  const source = await readFile(`/opt/plow/${name}.ts`, "utf8");
  const output = name.startsWith("plugin/") ? name.replace("plugin/", "plugin/dist/") : name;
  await mkdir(`/opt/plow/${output.substring(0, output.lastIndexOf("/"))}`, { recursive: true });
  await writeFile(`/opt/plow/${output}.js`, stripTypeScriptTypes(source.replaceAll(/(from "\.\/[^"\n]+)\.ts"/g, '$1.js"')));
}
await writeFile("/opt/plow/probe", '#!/usr/bin/env node\nimport "./boot/probe.js";\n');
