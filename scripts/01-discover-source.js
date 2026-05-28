import {
  ListInstancesCommand,
  ListQueuesCommand,
  DescribeQueueCommand,
  ListRoutingProfilesCommand,
  DescribeRoutingProfileCommand,
  ListRoutingProfileQueuesCommand,
  ListRoutingProfileManualAssignmentQueuesCommand,
  ListSecurityProfilesCommand,
  ListSecurityProfilePermissionsCommand,
  ListUsersCommand,
  DescribeUserCommand,
  ListUserHierarchyGroupsCommand,
  ListHoursOfOperationsCommand,
  DescribeHoursOfOperationCommand,
  ListHoursOfOperationOverridesCommand,
  DescribeHoursOfOperationOverrideCommand,
  ListPromptsCommand,
  DescribePromptCommand,
  ListContactFlowsCommand,
  DescribeContactFlowCommand,
  ListContactFlowModulesCommand,
  DescribeContactFlowModuleCommand,
  ListQuickConnectsCommand,
  DescribeQuickConnectCommand,
  ListQueueQuickConnectsCommand,
  ListDataTablesCommand,
  DescribeDataTableCommand,
  ListDataTableAttributesCommand,
  ListDataTableValuesCommand,
  ListAgentStatusesCommand,
  DescribeAgentStatusCommand,
  ListPredefinedAttributesCommand,
  DescribePredefinedAttributeCommand
} from "@aws-sdk/client-connect";
import { loadConfig } from "../lib/config.js";
import { connectClient } from "../lib/aws-clients.js";
import { paginate, sleep } from "../lib/pagination.js";
import { writeJson, writeText } from "../lib/io.js";
import { sanitizeName } from "../lib/naming.js";

const cfg = await loadConfig();
const connect = connectClient(cfg.sourceProfile, cfg.sourceRegion);
const InstanceId = cfg.sourceInstanceId;

async function safeDescribe(label, fn) {
  try {
    return await fn();
  } catch (e) {
    console.warn(`WARN: ${label} failed: ${e.name || e.message}`);
    return null;
  }
}

const instances = await paginate(connect, ListInstancesCommand, {}, "InstanceSummaryList");
if (!instances.find((i) => i.Id === InstanceId || i.Arn === cfg.sourceInstanceArn)) {
  throw new Error(`Configured source instance was not found using profile ${cfg.sourceProfile} in region ${cfg.sourceRegion}.`);
}

const queuesRaw = await paginate(connect, ListQueuesCommand, { InstanceId, QueueTypes: ["STANDARD"] }, "QueueSummaryList");
const queues = [];
for (const q of queuesRaw) {
  const d = await safeDescribe(`DescribeQueue ${q.Name}`, () => connect.send(new DescribeQueueCommand({ InstanceId, QueueId: q.Id })));
  if (d?.Queue) queues.push(d.Queue);
}
await writeJson("inventory/source/queues.json", queues);

const hoursRaw = await paginate(connect, ListHoursOfOperationsCommand, { InstanceId }, "HoursOfOperationSummaryList");
const hoursOfOperations = [];
for (const h of hoursRaw) {
  const d = await safeDescribe(`DescribeHoursOfOperation ${h.Name}`, () => connect.send(new DescribeHoursOfOperationCommand({ InstanceId, HoursOfOperationId: h.Id })));
  if (d?.HoursOfOperation) {
    const hoursRecord = d.HoursOfOperation;
    const hoursId = hoursRecord.HoursOfOperationId || hoursRecord.Id || h.Id;

    const overridesRaw = await paginate(
      connect,
      ListHoursOfOperationOverridesCommand,
      { InstanceId, HoursOfOperationId: hoursId, MaxResults: 100 },
      "HoursOfOperationOverrideList"
    ).catch((e) => {
      console.warn(`WARN: ListHoursOfOperationOverrides ${h.Name} failed: ${e.name || e.message}`);
      return [];
    });

    const overrides = [];
    for (const o of overridesRaw || []) {
      const overrideId = o.HoursOfOperationOverrideId || o.Id;
      const describedOverride = overrideId
        ? await safeDescribe(`DescribeHoursOfOperationOverride ${h.Name}/${o.Name}`, () =>
            connect.send(new DescribeHoursOfOperationOverrideCommand({
              InstanceId,
              HoursOfOperationId: hoursId,
              HoursOfOperationOverrideId: overrideId
            }))
          )
        : null;

      overrides.push(describedOverride?.HoursOfOperationOverride || o);
      await sleep(50);
    }

    hoursRecord.Overrides = overrides;
    hoursOfOperations.push(hoursRecord);
  }
}
await writeJson("inventory/source/hours-of-operation.json", hoursOfOperations);

const promptsRaw = await paginate(connect, ListPromptsCommand, { InstanceId }, "PromptSummaryList").catch(() => []);
const prompts = [];
for (const p of promptsRaw) {
  const d = await safeDescribe(`DescribePrompt ${p.Name}`, () => connect.send(new DescribePromptCommand({ InstanceId, PromptId: p.Id })));
  prompts.push({ ...p, ...(d?.Prompt || {}) });
}
await writeJson("inventory/source/prompts.json", prompts);


const agentStatusesRaw = await paginate(connect, ListAgentStatusesCommand, { InstanceId }, "AgentStatusSummaryList").catch(() => []);
const agentStatuses = [];
for (const s of agentStatusesRaw) {
  const d = await safeDescribe(`DescribeAgentStatus ${s.Name}`, () =>
    connect.send(new DescribeAgentStatusCommand({ InstanceId, AgentStatusId: s.Id }))
  );
  agentStatuses.push({ ...s, ...(d?.AgentStatus || {}) });
}
await writeJson("inventory/source/agent-statuses.json", agentStatuses);

const predefinedAttributesRaw = await paginate(connect, ListPredefinedAttributesCommand, { InstanceId, MaxResults: 100 }, "PredefinedAttributeSummaryList").catch(() => []);
const predefinedAttributes = [];
for (const a of predefinedAttributesRaw) {
  const d = await safeDescribe(`DescribePredefinedAttribute ${a.Name}`, () =>
    connect.send(new DescribePredefinedAttributeCommand({ InstanceId, Name: a.Name }))
  );
  predefinedAttributes.push(d?.PredefinedAttribute || a);
}
await writeJson("inventory/source/predefined-attributes.json", predefinedAttributes);

const securityProfilesRaw = await paginate(connect, ListSecurityProfilesCommand, { InstanceId }, "SecurityProfileSummaryList");
const securityProfiles = [];
for (const sp of securityProfilesRaw) {
  const permissions = [];
  let token;
  do {
    const page = await safeDescribe(`ListSecurityProfilePermissions ${sp.Name}`, () =>
      connect.send(new ListSecurityProfilePermissionsCommand({ InstanceId, SecurityProfileId: sp.Id, MaxResults: 100, NextToken: token }))
    );
    if (!page) break;
    permissions.push(...(page.Permissions || []));
    token = page.NextToken;
  } while (token);
  securityProfiles.push({ ...sp, Permissions: permissions });
}
await writeJson("inventory/source/security-profiles.json", securityProfiles);

const routingProfilesRaw = await paginate(connect, ListRoutingProfilesCommand, { InstanceId }, "RoutingProfileSummaryList");
const routingProfiles = [];
for (const rp of routingProfilesRaw) {
  const d = await safeDescribe(`DescribeRoutingProfile ${rp.Name}`, () => connect.send(new DescribeRoutingProfileCommand({ InstanceId, RoutingProfileId: rp.Id })));
  const queueConfigs = [];
  let token;
  do {
    const page = await safeDescribe(`ListRoutingProfileQueues ${rp.Name}`, () =>
      connect.send(new ListRoutingProfileQueuesCommand({ InstanceId, RoutingProfileId: rp.Id, MaxResults: 100, NextToken: token }))
    );
    if (!page) break;
    queueConfigs.push(...(page.RoutingProfileQueueConfigSummaryList || []));
    token = page.NextToken;
  } while (token);

  const manualAssignmentQueueConfigs = [];
  token = undefined;
  do {
    const page = await safeDescribe(`ListRoutingProfileManualAssignmentQueues ${rp.Name}`, () =>
      connect.send(new ListRoutingProfileManualAssignmentQueuesCommand({ InstanceId, RoutingProfileId: rp.Id, MaxResults: 100, NextToken: token }))
    );
    if (!page) break;
    manualAssignmentQueueConfigs.push(...(page.RoutingProfileQueueConfigSummaryList || page.RoutingProfileManualAssignmentQueueConfigSummaryList || []));
    token = page.NextToken;
  } while (token);

  routingProfiles.push({
    ...(d?.RoutingProfile || rp),
    QueueConfigs: queueConfigs,
    ManualAssignmentQueueConfigs: manualAssignmentQueueConfigs
  });
}
await writeJson("inventory/source/routing-profiles.json", routingProfiles);

const hierarchyGroups = await paginate(connect, ListUserHierarchyGroupsCommand, { InstanceId }, "UserHierarchyGroupSummaryList").catch(() => []);

const usersRaw = await paginate(connect, ListUsersCommand, { InstanceId }, "UserSummaryList");
const users = [];
for (const u of usersRaw) {
  const d = await safeDescribe(`DescribeUser ${u.Username}`, () => connect.send(new DescribeUserCommand({ InstanceId, UserId: u.Id })));
  if (d?.User) users.push(d.User);
}
await writeJson("inventory/source/users.json", users);

const flowsRawAll = await paginate(connect, ListContactFlowsCommand, { InstanceId }, "ContactFlowSummaryList");
const flowsRaw = flowsRawAll.filter((f) => cfg.flowTypes.includes(f.ContactFlowType));
const contactFlows = [];
for (const f of flowsRaw) {
  const d = await safeDescribe(`DescribeContactFlow ${f.Name}`, () => connect.send(new DescribeContactFlowCommand({ InstanceId, ContactFlowId: f.Id })));
  if (d?.ContactFlow) {
    contactFlows.push(d.ContactFlow);
    await writeText(`flows/source/contact-flows/${sanitizeName(f.Name)}__${f.Id}.json`, d.ContactFlow.Content || "{}");
  }
  await sleep(100);
}
await writeJson("inventory/source/contact-flows.json", contactFlows);

const modulesRaw = await paginate(connect, ListContactFlowModulesCommand, { InstanceId }, "ContactFlowModulesSummaryList").catch(() => []);
const contactFlowModules = [];
for (const m of modulesRaw) {
  const d = await safeDescribe(`DescribeContactFlowModule ${m.Name}`, () =>
    connect.send(new DescribeContactFlowModuleCommand({ InstanceId, ContactFlowModuleId: m.Id }))
  );
  if (d?.ContactFlowModule) {
    contactFlowModules.push(d.ContactFlowModule);
    await writeText(`flows/source/contact-flow-modules/${sanitizeName(m.Name)}__${m.Id}.json`, d.ContactFlowModule.Content || "{}");
  }
  await sleep(100);
}
await writeJson("inventory/source/contact-flow-modules.json", contactFlowModules);

const quickConnectsRaw = await paginate(connect, ListQuickConnectsCommand, { InstanceId }, "QuickConnectSummaryList");
const quickConnects = [];
for (const qc of quickConnectsRaw) {
  const d = await safeDescribe(`DescribeQuickConnect ${qc.Name}`, () => connect.send(new DescribeQuickConnectCommand({ InstanceId, QuickConnectId: qc.Id })));
  if (d?.QuickConnect) quickConnects.push(d.QuickConnect);
}
await writeJson("inventory/source/quick-connects.json", quickConnects);

const queueQuickConnectAssociations = [];
for (const q of queues || []) {
  const queueId = q.QueueId || q.Id;
  if (!queueId) continue;

  const associated = await paginate(
    connect,
    ListQueueQuickConnectsCommand,
    { InstanceId, QueueId: queueId },
    "QuickConnectSummaryList"
  ).catch((e) => {
    console.warn(`WARN: ListQueueQuickConnects ${q.Name} failed: ${e.name || e.message}`);
    return [];
  });

  queueQuickConnectAssociations.push({
    queueId,
    queueArn: q.QueueArn || q.Arn,
    queueName: q.Name,
    quickConnects: associated
  });
}

await writeJson("inventory/source/queue-quick-connect-associations.json", queueQuickConnectAssociations);


const dataTablesRaw = cfg.scope?.migrateDataTables === false ? [] : await paginate(
  connect,
  ListDataTablesCommand,
  { InstanceId, MaxResults: 1000 },
  "DataTableSummaryList"
).catch((e) => {
  console.warn(`WARN: ListDataTables failed: ${e.name || e.message}`);
  return [];
});

const dataTables = [];
for (const dt of dataTablesRaw) {
  const tableId = dt.Id || dt.DataTableId;

  const described = await safeDescribe(`DescribeDataTable ${dt.Name}`, () =>
    connect.send(new DescribeDataTableCommand({ InstanceId, DataTableId: tableId }))
  );

  const attributesResp = await safeDescribe(`ListDataTableAttributes ${dt.Name}`, () =>
    connect.send(new ListDataTableAttributesCommand({ InstanceId, DataTableId: tableId, MaxResults: 1000 }))
  );

  const values = [];
  let valueNextToken;
  do {
    const valuePage = await safeDescribe(`ListDataTableValues ${dt.Name}`, () =>
      connect.send(new ListDataTableValuesCommand({
        InstanceId,
        DataTableId: tableId,
        MaxResults: 1000,
        NextToken: valueNextToken
      }))
    );

    if (!valuePage) break;
    values.push(...(valuePage.Values || valuePage.DataTableValues || []));
    valueNextToken = valuePage.NextToken;
  } while (valueNextToken);

  const record = {
    summary: dt,
    table: described?.DataTable || described || null,
    attributes: attributesResp?.Attributes || attributesResp?.DataTableAttributes || [],
    values
  };

  dataTables.push(record);
  await writeJson(`inventory/source/data-tables/${sanitizeName(dt.Name)}__${tableId}.json`, record);
  await sleep(100);
}
await writeJson("inventory/source/data-tables.json", dataTables);

const inventory = {
  discoveredAt: new Date().toISOString(),
  instanceArn: cfg.sourceInstanceArn,
  instanceId: cfg.sourceInstanceId,
  queues,
  hoursOfOperations,
  prompts,
  agentStatuses,
  predefinedAttributes,
  securityProfiles,
  routingProfiles,
  hierarchyGroups,
  users,
  contactFlows,
  contactFlowModules,
  quickConnects,
  queueQuickConnectAssociations,
  dataTables
};

await writeJson("inventory/source/source-inventory.json", inventory);

console.log("Discovery complete.");
console.log({
  queues: queues.length,
  hoursOfOperations: hoursOfOperations.length,
  prompts: prompts.length,
  agentStatuses: agentStatuses.length,
  predefinedAttributes: predefinedAttributes.length,
  securityProfiles: securityProfiles.length,
  routingProfiles: routingProfiles.length,
  users: users.length,
  contactFlows: contactFlows.length,
  contactFlowModules: contactFlowModules.length,
  quickConnects: quickConnects.length,
  queueQuickConnectAssociations: queueQuickConnectAssociations.length,
  dataTables: dataTables.length
});
