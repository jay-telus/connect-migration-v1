import { loadConfig } from "../lib/config.js";
import { readJson, writeJson, writeText } from "../lib/io.js";
import { replaceAllResourceReferences, ensureNoSourceReferences } from "../lib/flow-parser.js";
import { sanitizeName } from "../lib/naming.js";

const cfg = await loadConfig();
const src = await readJson("inventory/source/source-inventory.json");
const map = await readJson("inventory/target/resource-map.json");

const patchedSummary = { contactFlows: [], contactFlowModules: [], warnings: [] };

for (const f of src.contactFlows || []) {
  const content = replaceAllResourceReferences(f.Content || "{}", map.replacements || {});
  ensureNoSourceReferences(content, cfg, `ContactFlow ${f.Name}`);
  await writeText(`flows/patched/contact-flows/${sanitizeName(f.Name)}__${f.Id}.json`, content);
  patchedSummary.contactFlows.push({ sourceId: f.Id, name: f.Name, type: f.Type });
}

for (const m of src.contactFlowModules || []) {
  const content = replaceAllResourceReferences(m.Content || "{}", map.replacements || {});
  ensureNoSourceReferences(content, cfg, `ContactFlowModule ${m.Name}`);
  await writeText(`flows/patched/contact-flow-modules/${sanitizeName(m.Name)}__${m.Id}.json`, content);
  patchedSummary.contactFlowModules.push({ sourceId: m.Id, name: m.Name });
}

await writeJson("inventory/reports/patch-summary.json", patchedSummary);
console.log("Flow patching complete.");
