import { readJson, writeText } from "../lib/io.js";

async function optional(file, fallback = {}) {
  try {
    return await readJson(file);
  } catch {
    return fallback;
  }
}

const source = await optional("inventory/source/source-inventory.json");
const scope = await optional("inventory/reports/scope-classification.json");
const deps = await optional("inventory/reports/flow-dependencies.json");
const baseDeploy = await optional("inventory/target/base-deploy-result.json");
const dataTables = await optional("inventory/target/data-table-migration-result.json");
const flows = await optional("inventory/target/flow-deploy-result.json");
const users = await optional("inventory/target/user-migration-result.json");
const qc = await optional("inventory/target/quick-connect-migration-result.json");
const optionalServices = await optional("inventory/target/optional-services-result.json");
const validation = await optional("inventory/reports/target-validation.json");

function fencedJson(obj) {
  return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

const md = `# Amazon Connect Migration Report

Generated: ${new Date().toISOString()}

## Source discovery

- Queues: ${source.queues?.length || 0}
- Hours of operation: ${source.hoursOfOperations?.length || 0}
- Prompts: ${source.prompts?.length || 0}
- Security profiles: ${source.securityProfiles?.length || 0}
- Routing profiles: ${source.routingProfiles?.length || 0}
- Agent statuses: ${source.agentStatuses?.length || 0}
- Predefined attributes: ${source.predefinedAttributes?.length || 0}
- Users: ${source.users?.length || 0}
- Contact flows: ${source.contactFlows?.length || 0}
- Contact flow modules: ${source.contactFlowModules?.length || 0}
- Quick connects: ${source.quickConnects?.length || 0}
- Data tables: ${source.dataTables?.length || 0}

## Scope summary

${fencedJson({
  migrate: scope.migrate || [],
  skip: scope.skip || [],
  warnings: scope.warnings || []
})}

## Dependency-first base deployment

${fencedJson(baseDeploy)}

## Data Tables

${fencedJson({
  sourceTables: (source.dataTables || []).map((x) => ({
    name: x.summary?.Name,
    id: x.summary?.Id || x.summary?.DataTableId,
    arn: x.summary?.Arn,
    attributeCount: x.attributes?.length || 0,
    valueCount: x.values?.length || 0
  })),
  migrationResult: dataTables
})}

## Flow deployment

${fencedJson(flows)}

## User migration

${fencedJson(users)}

## Quick Connect migration and queue associations

${fencedJson(qc)}

## Optional dependencies discovered

${fencedJson(deps.optionalServices || {})}

## Optional services migration result

${fencedJson(optionalServices)}

## Validation

${fencedJson(validation)}
`;

await writeText("inventory/reports/migration-report.md", md);
console.log("Migration report generated at inventory/reports/migration-report.md");
