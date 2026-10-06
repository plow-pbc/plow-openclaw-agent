import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

for (const name of ["boot/personality", "boot/health", "boot/agent-index", "boot/extensions", "boot/config", "boot/identity", "boot/log", "boot/prompt", "boot/main", "boot/process", "boot/probe", "boot/probe-fixture", "boot/mcp-bridge", "plugin/index", "plugin/delivery-guard", "plugin/threads", "plugin/transport", "plugin/email", "plugin/experience", "plugin/experience-state", "plugin/personality-page"]) {
  const source = await readFile(`/opt/plow/${name}.ts`, "utf8");
  const imports = source.replaceAll(/(from "\.\.\/boot\/[^"\n]+)\.ts"/g, '$1.js"');
  const compiledSource = name.startsWith("plugin/") ? imports.replaceAll('from "../boot/', 'from "../../boot/') : imports;
  const output = name.startsWith("plugin/") ? name.replace("plugin/", "plugin/dist/") : name;
  await mkdir(`/opt/plow/${output.substring(0, output.lastIndexOf("/"))}`, { recursive: true });
  await writeFile(`/opt/plow/${output}.js`, stripTypeScriptTypes(compiledSource.replaceAll(/(from "\.\/[^"\n]+)\.ts"/g, '$1.js"')));
}
await writeFile("/opt/plow/probe", '#!/usr/bin/env node\nimport "./boot/probe.js";\n');
await writeFile("/opt/plow/plugin/dist/personality-ui.html", await readFile("/opt/plow/plugin/personality-ui.html", "utf8"));
