import {
  ListQueuesCommand,
  ListUsersCommand,
  ListContactFlowsCommand,
  ListQuickConnectsCommand,
  ListAgentStatusesCommand,
  ListPredefinedAttributesCommand
} from "@aws-sdk/client-connect";
import { loadConfig } from "../lib/config.js";
import { connectClient } from "../lib/aws-clients.js";
import { paginate } from "../lib/pagination.js";
import { readJson, writeJson } from "../lib/io.js";

const cfg = await loadConfig();
const src = await readJson("inventory/source/source-inventory.json");
const dest = connectClient(cfg.destProfile, cfg.destRegion);
const InstanceId = cfg.destInstanceId;

const target = {
  queues: await paginate(dest, ListQueuesCommand, { InstanceId, QueueTypes: ["STANDARD"] }, "QueueSummaryList"),
  users: await paginate(dest, ListUsersCommand, { InstanceId }, "UserSummaryList"),
  contactFlows: await paginate(dest, ListContactFlowsCommand, { InstanceId }, "ContactFlowSummaryList"),
  quickConnects: await paginate(dest, ListQuickConnectsCommand, { InstanceId }, "QuickConnectSummaryList"),
  agentStatuses: await paginate(dest, ListAgentStatusesCommand, { InstanceId }, "AgentStatusSummaryList").catch(() => []),
  predefinedAttributes: await paginate(dest, ListPredefinedAttributesCommand, { InstanceId, MaxResults: 100 }, "PredefinedAttributeSummaryList").catch(() => [])
};

function names(items, key = "Name") {
  return new Set((items || []).map((x) => x[key]).filter(Boolean));
}

const targetQueueNames = names(target.queues);
const targetUsernames = names(target.users, "Username");
const targetFlowNames = names(target.contactFlows);
const targetQcNames = names(target.quickConnects);
const targetAgentStatusNames = names(target.agentStatuses);
const targetPredefinedAttributeNames = names(target.predefinedAttributes);

const validation = {
  generatedAt: new Date().toISOString(),
  missing: {
    queues: (src.queues || []).filter((x) => !(cfg.skip?.queues || []).includes(x.Name) && !targetQueueNames.has(x.Name)).map((x) => x.Name),
    users: cfg.scope.migrateUsers ? (src.users || []).filter((x) => !targetUsernames.has(x.Username)).map((x) => x.Username) : [],
    contactFlows: (src.contactFlows || []).filter((x) => !targetFlowNames.has(x.Name)).map((x) => x.Name),
    quickConnects: cfg.scope.migrateQuickConnects
      ? (src.quickConnects || []).filter((x) => !(cfg.skip?.quickConnectTypes || []).includes(x.QuickConnectConfig?.QuickConnectType) && !targetQcNames.has(x.Name)).map((x) => x.Name)
      : [],
    agentStatuses: (src.agentStatuses || []).filter((x) => !targetAgentStatusNames.has(x.Name)).map((x) => x.Name),
    predefinedAttributes: (src.predefinedAttributes || []).filter((x) => !targetPredefinedAttributeNames.has(x.Name)).map((x) => x.Name)
  }
};

validation.pass = Object.values(validation.missing).every((arr) => arr.length === 0);
await writeJson("inventory/reports/target-validation.json", validation);

if (!validation.pass) {
  console.error("Validation failed. See inventory/reports/target-validation.json");
  process.exitCode = 1;
} else {
  console.log("Validation passed.");
}
