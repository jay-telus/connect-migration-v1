import {
  ListQueuesCommand,
  ListHoursOfOperationsCommand,
  ListPromptsCommand,
  ListSecurityProfilesCommand,
  ListAgentStatusesCommand,
  ListPredefinedAttributesCommand,
  ListRoutingProfilesCommand,
  ListUsersCommand,
  ListContactFlowsCommand,
  ListContactFlowModulesCommand,
  ListQuickConnectsCommand,
  ListDataTablesCommand
} from "@aws-sdk/client-connect";
import { loadConfig } from "../lib/config.js";
import { connectClient } from "../lib/aws-clients.js";
import { paginate } from "../lib/pagination.js";
import { readJson, writeJson } from "../lib/io.js";
import { sameNameMap } from "../lib/naming.js";

const cfg = await loadConfig();
const src = await readJson("inventory/source/source-inventory.json");
const dest = connectClient(cfg.destProfile, cfg.destRegion);
const InstanceId = cfg.destInstanceId;

const target = {
  queues: await paginate(dest, ListQueuesCommand, { InstanceId, QueueTypes: ["STANDARD"] }, "QueueSummaryList"),
  hoursOfOperations: await paginate(dest, ListHoursOfOperationsCommand, { InstanceId }, "HoursOfOperationSummaryList").catch(() => []),
  prompts: await paginate(dest, ListPromptsCommand, { InstanceId }, "PromptSummaryList").catch(() => []),
  agentStatuses: await paginate(dest, ListAgentStatusesCommand, { InstanceId }, "AgentStatusSummaryList").catch(() => []),
  predefinedAttributes: await paginate(dest, ListPredefinedAttributesCommand, { InstanceId, MaxResults: 100 }, "PredefinedAttributeSummaryList").catch(() => []),
  securityProfiles: await paginate(dest, ListSecurityProfilesCommand, { InstanceId }, "SecurityProfileSummaryList"),
  routingProfiles: await paginate(dest, ListRoutingProfilesCommand, { InstanceId }, "RoutingProfileSummaryList"),
  users: await paginate(dest, ListUsersCommand, { InstanceId }, "UserSummaryList"),
  contactFlows: await paginate(dest, ListContactFlowsCommand, { InstanceId }, "ContactFlowSummaryList"),
  contactFlowModules: await paginate(dest, ListContactFlowModulesCommand, { InstanceId }, "ContactFlowModulesSummaryList").catch(() => []),
  quickConnects: await paginate(dest, ListQuickConnectsCommand, { InstanceId }, "QuickConnectSummaryList"),
  dataTables: await paginate(dest, ListDataTablesCommand, { InstanceId, MaxResults: 1000 }, "DataTableSummaryList").catch(() => [])
};

await writeJson("inventory/target/target-inventory-lite.json", target);

const maps = {};
maps.queues = sameNameMap(src.queues || [], target.queues, "Name", "Name", "QueueId", "Id");
maps.hoursOfOperations = sameNameMap(src.hoursOfOperations || [], target.hoursOfOperations, "Name", "Name", "HoursOfOperationId", "Id");
maps.prompts = sameNameMap(src.prompts || [], target.prompts, "Name", "Name", "Id", "Id");
maps.agentStatuses = sameNameMap(src.agentStatuses || [], target.agentStatuses, "Name", "Name", "AgentStatusId", "Id");
maps.predefinedAttributes = sameNameMap(src.predefinedAttributes || [], target.predefinedAttributes, "Name", "Name", "Name", "Name");
maps.securityProfiles = sameNameMap(src.securityProfiles || [], target.securityProfiles, "Name", "Name", "Id", "Id");
maps.routingProfiles = sameNameMap(src.routingProfiles || [], target.routingProfiles, "Name", "Name", "RoutingProfileId", "Id");
maps.users = sameNameMap(src.users || [], target.users, "Username", "Username", "Id", "Id");
maps.contactFlows = sameNameMap(src.contactFlows || [], target.contactFlows, "Name", "Name", "Id", "Id");
maps.contactFlowModules = sameNameMap(src.contactFlowModules || [], target.contactFlowModules, "Name", "Name", "Id", "Id");
maps.quickConnects = sameNameMap(src.quickConnects || [], target.quickConnects, "Name", "Name", "QuickConnectId", "Id");
const srcDataTablesLite = (src.dataTables || []).map((x) => ({ Id: x.summary?.Id || x.summary?.DataTableId, Arn: x.summary?.Arn, Name: x.summary?.Name }));
maps.dataTables = sameNameMap(srcDataTablesLite, target.dataTables, "Name", "Name", "Id", "Id");

const replacements = {
  [cfg.sourceInstanceArn]: cfg.destInstanceArn,
  [cfg.sourceInstanceId]: cfg.destInstanceId
};

function addArnReplacement(srcArn, targetArn) {
  if (srcArn && targetArn) replacements[srcArn] = targetArn;
}

for (const s of src.hoursOfOperations || []) {
  const sid = s.HoursOfOperationId || s.Id;
  const tid = maps.hoursOfOperations.map[sid];
  const t = target.hoursOfOperations.find((x) => x.Id === tid);
  addArnReplacement(s.Arn, t?.Arn);
  if (sid && tid) replacements[sid] = tid;
}
for (const s of src.prompts || []) {
  const sid = s.Id;
  const tid = maps.prompts.map[sid];
  const t = target.prompts.find((x) => x.Id === tid);
  addArnReplacement(s.Arn, t?.Arn);
  if (sid && tid) replacements[sid] = tid;
}
for (const s of src.agentStatuses || []) {
  const sid = s.AgentStatusId || s.Id;
  const tid = maps.agentStatuses.map[sid];
  const t = target.agentStatuses.find((x) => x.Id === tid);
  addArnReplacement(s.AgentStatusARN || s.AgentStatusArn || s.Arn, t?.Arn);
  if (sid && tid) replacements[sid] = tid;
}
for (const s of src.queues || []) {
  const sid = s.QueueId || s.Id;
  const tid = maps.queues.map[sid];
  const t = target.queues.find((x) => x.Id === tid);
  addArnReplacement(s.QueueArn || s.Arn, t?.Arn);
  if (sid && tid) replacements[sid] = tid;
}
for (const s of src.routingProfiles || []) {
  const sid = s.RoutingProfileId || s.Id;
  const tid = maps.routingProfiles.map[sid];
  const t = target.routingProfiles.find((x) => x.Id === tid);
  addArnReplacement(s.Arn, t?.Arn);
  if (sid && tid) replacements[sid] = tid;
}
for (const s of src.securityProfiles || []) {
  const sid = s.Id;
  const tid = maps.securityProfiles.map[sid];
  const t = target.securityProfiles.find((x) => x.Id === tid);
  addArnReplacement(s.Arn, t?.Arn);
  if (sid && tid) replacements[sid] = tid;
}
for (const s of src.contactFlows || []) {
  const tid = maps.contactFlows.map[s.Id];
  const t = target.contactFlows.find((x) => x.Id === tid);
  addArnReplacement(s.Arn, t?.Arn);
  if (s.Id && tid) replacements[s.Id] = tid;
}
for (const s of src.contactFlowModules || []) {
  const tid = maps.contactFlowModules.map[s.Id];
  const t = target.contactFlowModules.find((x) => x.Id === tid);
  addArnReplacement(s.Arn, t?.Arn);
  if (s.Id && tid) replacements[s.Id] = tid;
}
for (const s of srcDataTablesLite) {
  const tid = maps.dataTables.map[s.Id];
  const t = target.dataTables.find((x) => x.Id === tid);
  addArnReplacement(s.Arn, t?.Arn);
  if (s.Id && tid) replacements[s.Id] = tid;
}

await writeJson("inventory/target/resource-map.json", { generatedAt: new Date().toISOString(), maps, replacements });
console.log("Resource map generated. Review missing arrays before patch/deploy.");
