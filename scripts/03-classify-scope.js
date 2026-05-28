import { loadConfig } from "../lib/config.js";
import { readJson, writeJson } from "../lib/io.js";

const cfg = await loadConfig();
const inv = await readJson("inventory/source/source-inventory.json");
const deps = await readJson("inventory/reports/flow-dependencies.json");

function skipQueue(q) { return (cfg.skip?.queues || []).includes(q.Name); }
function row(name, file, arr, reason = "Not discovered or empty") {
  return (arr || []).length ? { type: "migrate", name, file, count: arr.length } : { type: "skip", name, file, reason };
}

const inScope = {
  queues: (inv.queues || []).filter((q) => !skipQueue(q)).map((q) => ({ id: q.QueueId || q.Id, arn: q.QueueArn || q.Arn, name: q.Name })),
  securityProfiles: (inv.securityProfiles || []).map((x) => ({ id: x.Id, arn: x.Arn, name: x.Name, permissionsCount: x.Permissions?.length || 0 })),
  routingProfiles: (inv.routingProfiles || []).map((x) => ({ id: x.RoutingProfileId || x.Id, arn: x.Arn, name: x.Name, queueConfigCount: x.QueueConfigs?.length || 0 })),
  agentStatuses: (inv.agentStatuses || []).map((x) => ({ id: x.AgentStatusId || x.Id, arn: x.AgentStatusARN || x.AgentStatusArn || x.Arn, name: x.Name, state: x.State, type: x.Type })),
  predefinedAttributes: (inv.predefinedAttributes || []).map((x) => ({ name: x.Name, valueCount: x.Values?.StringList?.length || 0, purposeCount: x.Purposes?.length || 0 })),
  users: cfg.scope.migrateUsers ? (inv.users || []).map((x) => ({ id: x.Id, arn: x.Arn, username: x.Username })) : [],
  hoursOfOperations: (inv.hoursOfOperations || []).map((x) => ({ id: x.HoursOfOperationId || x.Id, arn: x.Arn, name: x.Name })),
  contactFlows: cfg.scope.migrateAllFlowsDiscovered ? (inv.contactFlows || []).map((x) => ({ id: x.Id, arn: x.Arn, name: x.Name, type: x.Type })) : [],
  contactFlowModules: cfg.scope.migrateAllFlowsDiscovered ? (inv.contactFlowModules || []).map((x) => ({ id: x.Id, arn: x.Arn, name: x.Name })) : [],
  queueQuickConnectAssociations: (inv.queueQuickConnectAssociations || []).map((x) => ({ queueName: x.queueName, queueId: x.queueId, quickConnectCount: x.quickConnects?.length || 0 })),
  quickConnects: cfg.scope.migrateQuickConnects ? (inv.quickConnects || []).filter((x) => !(cfg.skip?.quickConnectTypes || []).includes(x.QuickConnectConfig?.QuickConnectType)).map((x) => ({ id: x.QuickConnectId || x.Id, arn: x.QuickConnectARN || x.Arn, name: x.Name, type: x.QuickConnectConfig?.QuickConnectType })) : [],
  dataTables: cfg.scope.migrateDataTables ? (inv.dataTables || []).map((x) => ({ id: x.summary?.Id || x.summary?.DataTableId, arn: x.summary?.Arn, name: x.summary?.Name, attributeCount: x.attributes?.length || 0, valueCount: x.values?.length || 0 })) : [],
  optionalAwsDependencies: deps.optionalServices
};

const rows = [
  row("Amazon Connect queues", "queues.json", inScope.queues),
  row("Amazon Connect routing profiles", "routing-profiles.json", inScope.routingProfiles),
  row("Amazon Connect security profiles", "security-profiles.json", inScope.securityProfiles),
  row("Amazon Connect agent statuses", "agent-statuses.json", inScope.agentStatuses),
  row("Amazon Connect predefined attributes", "predefined-attributes.json", inScope.predefinedAttributes),
  row("Amazon Connect users", "users.json", inScope.users, cfg.scope.migrateUsers ? "Not discovered or empty" : "Disabled by migration scope"),
  row("Amazon Connect hours of operation", "hours-of-operation.json", inScope.hoursOfOperations),
  row("Amazon Connect contact flows", "contact-flows.json", inScope.contactFlows),
  row("Amazon Connect contact flow modules", "contact-flow-modules.json", inScope.contactFlowModules),
  row("Amazon Connect quick connects", "quick-connects.json", inScope.quickConnects, cfg.scope.migrateQuickConnects ? "Not discovered or empty" : "Disabled by migration scope"),
  row("Amazon Connect queue quick connect associations", "queue-quick-connect-associations.json", inScope.queueQuickConnectAssociations),
  row("Amazon Connect data tables", "data-tables.json", inScope.dataTables, cfg.scope.migrateDataTables ? "Not discovered or empty" : "Disabled by migration scope")
];

const report = {
  generatedAt: new Date().toISOString(),
  migrate: rows.filter((x) => x.type === "migrate").map(({ type, ...x }) => x),
  skip: [
    ...rows.filter((x) => x.type === "skip").map(({ type, ...x }) => x),
    ...(cfg.scope.excludePhoneNumbers ? [{ name: "Phone numbers", reason: "Excluded by migration scope" }] : []),
    ...(cfg.scope.excludeZendeskSideConfig ? [{ name: "Zendesk-side configuration", reason: "Excluded by migration scope" }] : [])
  ],
  inScope,
  warnings: []
};

await writeJson("inventory/reports/scope-classification.json", report);
console.log("Scope classification complete.");
