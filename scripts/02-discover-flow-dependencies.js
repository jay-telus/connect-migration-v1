import { readJson, writeJson } from "../lib/io.js";
import { extractReferencedArnsAndIds } from "../lib/flow-parser.js";

const inv = await readJson("inventory/source/source-inventory.json");

const flowDeps = [];
for (const f of inv.contactFlows || []) {
  flowDeps.push({
    type: "CONTACT_FLOW",
    id: f.Id,
    arn: f.Arn,
    name: f.Name,
    flowType: f.Type,
    dependencies: extractReferencedArnsAndIds(f.Content || "")
  });
}

const moduleDeps = [];
for (const m of inv.contactFlowModules || []) {
  moduleDeps.push({
    type: "CONTACT_FLOW_MODULE",
    id: m.Id,
    arn: m.Arn,
    name: m.Name,
    dependencies: extractReferencedArnsAndIds(m.Content || "")
  });
}

const allArns = [...flowDeps, ...moduleDeps].flatMap((x) => x.dependencies.arns);
const optionalServices = {
  lambda: [...new Set(allArns.filter((x) => x.includes(":lambda:")))],
  lex: [...new Set(allArns.filter((x) => x.includes(":lex:") || x.includes(":lexv2:")))],
  dynamodb: [...new Set(allArns.filter((x) => x.includes(":dynamodb:")))],
  kinesis: [...new Set(allArns.filter((x) => x.includes(":kinesis:")))],
  firehose: [...new Set(allArns.filter((x) => x.includes(":firehose:")))],
  s3: [...new Set(allArns.filter((x) => x.includes(":s3:")))],
  eventbridge: [...new Set(allArns.filter((x) => x.includes(":events:")))],
  connectDataTables: [...new Set(allArns.filter((x) => x.includes(":data-table/")))]
};

const report = {
  generatedAt: new Date().toISOString(),
  flowDeps,
  moduleDeps,
  optionalServices
};

await writeJson("inventory/reports/flow-dependencies.json", report);
console.log("Flow dependency discovery complete.");
console.log(optionalServices);
