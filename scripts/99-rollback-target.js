import * as Connect from "@aws-sdk/client-connect";
import { loadConfig } from "../lib/config.js";
import { connectClient } from "../lib/aws-clients.js";
import { readJson, writeJson } from "../lib/io.js";
import { sleep } from "../lib/pagination.js";

const cfg = await loadConfig();
const dest = connectClient(cfg.destProfile, cfg.destRegion);
const InstanceId = cfg.destInstanceId;

const dryRun = process.argv.includes("--dry-run") || process.env.ROLLBACK_CONFIRM !== "DELETE";

async function optionalJson(file, fallback = {}) {
  try {
    return await readJson(file);
  } catch {
    return fallback;
  }
}

const baseDeploy = await optionalJson("inventory/target/base-deploy-result.json", {});
const dataTables = await optionalJson("inventory/target/data-table-migration-result.json", {});
const flows = await optionalJson("inventory/target/flow-deploy-result.json", {});
const users = await optionalJson("inventory/target/user-migration-result.json", {});
const quickConnects = await optionalJson("inventory/target/quick-connect-migration-result.json", {});
const resourceMap = await optionalJson("inventory/target/resource-map.json", { maps: {} });
const sourceInventory = await optionalJson("inventory/source/source-inventory.json", {});

const result = {
  dryRun,
  startedAt: new Date().toISOString(),
  actions: [],
  skipped: [],
  warnings: []
};

function commandCtor(name) {
  const ctor = Connect[name];
  if (!ctor) {
    result.warnings.push(`${name} is not available in the installed @aws-sdk/client-connect package. Skipping related rollback action.`);
    return null;
  }
  return ctor;
}

async function sendCommand(commandName, input, label, options = {}) {
  const Ctor = commandCtor(commandName);
  if (!Ctor) return false;

  if (dryRun) {
    result.actions.push({ action: "DRY_RUN", command: commandName, label, input });
    return true;
  }

  try {
    await dest.send(new Ctor(input));
    result.actions.push({ action: "DONE", command: commandName, label });
    return true;
  } catch (e) {
    const message = String(e.message || "");
    const name = String(e.name || "");

    if (
      options.ignoreNotFound !== false &&
      (name.includes("ResourceNotFound") || message.toLowerCase().includes("resource not found"))
    ) {
      result.skipped.push({ label, reason: "Already not found" });
      return true;
    }

    result.warnings.push(`${label} failed: ${name || "Error"} ${message}`);
    return false;
  }
}

function idsFromCreated(items = []) {
  return (items || [])
    .map((x) => x.id || x.Id || x.userId || x.UserId || x.queueId || x.QueueId || x.contactFlowId || x.ContactFlowId || x.routingProfileId || x.RoutingProfileId || x.securityProfileId || x.SecurityProfileId || x.quickConnectId || x.QuickConnectId || x.dataTableId || x.DataTableId)
    .filter(Boolean);
}

function createdName(item) {
  return item?.name || item?.Name || item?.username || item?.Username || item?.label || "unknown";
}

function sourceQcToTargetQcId(sourceQc) {
  const sourceQcId = sourceQc.Id || sourceQc.QuickConnectId;
  return (
    quickConnects.refreshedQuickConnectMap?.map?.[sourceQcId] ||
    resourceMap.maps?.quickConnects?.map?.[sourceQcId]
  );
}

function sourceQueueToTargetQueueId(sourceQueueId) {
  return resourceMap.maps?.queues?.map?.[sourceQueueId];
}

async function rollbackQueueQuickConnectAssociations() {
  const associations = sourceInventory.queueQuickConnectAssociations || [];
  for (const assoc of associations) {
    const targetQueueId = sourceQueueToTargetQueueId(assoc.queueId);
    if (!targetQueueId) {
      result.skipped.push({ label: `Queue quick connect association for ${assoc.queueName}`, reason: "Missing target queue mapping" });
      continue;
    }

    const targetQuickConnectIds = [...new Set(
      (assoc.quickConnects || [])
        .map(sourceQcToTargetQcId)
        .filter(Boolean)
    )];

    if (targetQuickConnectIds.length === 0) {
      result.skipped.push({ label: `Queue quick connect association for ${assoc.queueName}`, reason: "No mapped target quick connects" });
      continue;
    }

    for (let i = 0; i < targetQuickConnectIds.length; i += 50) {
      const batch = targetQuickConnectIds.slice(i, i + 50);
      await sendCommand(
        "DisassociateQueueQuickConnectsCommand",
        { InstanceId, QueueId: targetQueueId, QuickConnectIds: batch },
        `Disassociate ${batch.length} quick connect(s) from queue ${assoc.queueName}`,
        { ignoreNotFound: true }
      );
      await sleep(150);
    }
  }
}

async function rollbackQuickConnects() {
  for (const qc of quickConnects.created || []) {
    const id = qc.id || qc.quickConnectId || qc.QuickConnectId;
    if (!id) continue;
    await sendCommand(
      "DeleteQuickConnectCommand",
      { InstanceId, QuickConnectId: id },
      `Delete quick connect ${createdName(qc)}`,
      { ignoreNotFound: true }
    );
    await sleep(200);
  }
}

async function rollbackUsers() {
  for (const u of users.created || []) {
    const id = u.id || u.userId || u.UserId;
    if (!id) continue;
    await sendCommand(
      "DeleteUserCommand",
      { InstanceId, UserId: id },
      `Delete user ${createdName(u)}`,
      { ignoreNotFound: true }
    );
    await sleep(200);
  }
}

async function rollbackFlowsAndModules() {
  for (const f of flows.createdFlows || []) {
    const id = f.id || f.contactFlowId || f.ContactFlowId;
    if (!id) continue;
    await sendCommand(
      "DeleteContactFlowCommand",
      { InstanceId, ContactFlowId: id },
      `Delete contact flow ${createdName(f)}`,
      { ignoreNotFound: true }
    );
    await sleep(200);
  }

  for (const m of flows.createdModules || []) {
    const id = m.id || m.contactFlowModuleId || m.ContactFlowModuleId;
    if (!id) continue;
    await sendCommand(
      "DeleteContactFlowModuleCommand",
      { InstanceId, ContactFlowModuleId: id },
      `Delete contact flow module ${createdName(m)}`,
      { ignoreNotFound: true }
    );
    await sleep(200);
  }
}

async function rollbackDataTables() {
  for (const dt of dataTables.createdTables || []) {
    const id = dt.id || dt.dataTableId || dt.DataTableId;
    if (!id) continue;
    await sendCommand(
      "DeleteDataTableCommand",
      { InstanceId, DataTableId: id },
      `Delete data table ${createdName(dt)}`,
      { ignoreNotFound: true }
    );
    await sleep(300);
  }
}

async function rollbackRoutingProfiles() {
  for (const rp of baseDeploy.routingProfiles || []) {
    const id = rp.id || rp.routingProfileId || rp.RoutingProfileId;
    if (!id) continue;
    await sendCommand(
      "DeleteRoutingProfileCommand",
      { InstanceId, RoutingProfileId: id },
      `Delete routing profile ${createdName(rp)}`,
      { ignoreNotFound: true }
    );
    await sleep(250);
  }
}

async function rollbackQueues() {
  for (const q of baseDeploy.queues || []) {
    const id = q.id || q.queueId || q.QueueId;
    if (!id) continue;
    await sendCommand(
      "DeleteQueueCommand",
      { InstanceId, QueueId: id },
      `Delete queue ${createdName(q)}`,
      { ignoreNotFound: true }
    );
    await sleep(250);
  }
}

async function rollbackPrompts() {
  for (const p of baseDeploy.prompts || []) {
    const id = p.id || p.promptId || p.PromptId;
    if (!id) continue;
    await sendCommand(
      "DeletePromptCommand",
      { InstanceId, PromptId: id },
      `Delete prompt ${createdName(p)}`,
      { ignoreNotFound: true }
    );
    await sleep(250);
  }
}

async function rollbackCustomPredefinedAttributes() {
  for (const a of baseDeploy.predefinedAttributes || []) {
    if (a.action !== "created") {
      result.skipped.push({
        label: `Predefined attribute ${createdName(a)}`,
        reason: "Not created by migration; updated/existing resources are not removed"
      });
      continue;
    }

    const name = a.name || a.Name;
    if (!name || String(name).toLowerCase().startsWith("connect:")) {
      result.skipped.push({
        label: `Predefined attribute ${name || "unknown"}`,
        reason: "System or invalid predefined attribute is not removed"
      });
      continue;
    }

    await sendCommand(
      "DeletePredefinedAttributeCommand",
      { InstanceId, Name: name },
      `Delete predefined attribute ${name}`,
      { ignoreNotFound: true }
    );
    await sleep(200);
  }
}

async function rollbackSecurityProfiles() {
  for (const sp of baseDeploy.securityProfiles || []) {
    const id = sp.id || sp.securityProfileId || sp.SecurityProfileId;
    if (!id) continue;
    await sendCommand(
      "DeleteSecurityProfileCommand",
      { InstanceId, SecurityProfileId: id },
      `Delete security profile ${createdName(sp)}`,
      { ignoreNotFound: true }
    );
    await sleep(250);
  }
}

async function rollbackAgentStatuses() {
  for (const s of baseDeploy.agentStatuses || []) {
    const id = s.id || s.agentStatusId || s.AgentStatusId;
    if (!id) continue;

    await sendCommand(
      "UpdateAgentStatusCommand",
      {
        InstanceId,
        AgentStatusId: id,
        State: "DISABLED",
        Description: `Disabled by migration rollback: ${createdName(s)}`
      },
      `Disable agent status ${createdName(s)}`,
      { ignoreNotFound: true }
    );
    await sleep(200);
  }
}


async function rollbackHoursOfOperationOverrides() {
  for (const o of baseDeploy.hoursOfOperationOverrides || []) {
    const hoursId = o.hoursOfOperationId || o.HoursOfOperationId;
    const overrideId = o.id || o.hoursOfOperationOverrideId || o.HoursOfOperationOverrideId;
    if (!hoursId || !overrideId) continue;

    await sendCommand(
      "DeleteHoursOfOperationOverrideCommand",
      { InstanceId, HoursOfOperationId: hoursId, HoursOfOperationOverrideId: overrideId },
      `Delete hours of operation override ${createdName(o)}`,
      { ignoreNotFound: true }
    );
    await sleep(200);
  }
}

async function rollbackHoursOfOperation() {
  for (const h of baseDeploy.hoursOfOperations || []) {
    const id = h.id || h.hoursOfOperationId || h.HoursOfOperationId;
    if (!id) continue;
    await sendCommand(
      "DeleteHoursOfOperationCommand",
      { InstanceId, HoursOfOperationId: id },
      `Delete hours of operation ${createdName(h)}`,
      { ignoreNotFound: true }
    );
    await sleep(250);
  }
}

console.log(dryRun
  ? "Rollback dry-run mode. No resources will be deleted. Set ROLLBACK_CONFIRM=DELETE to execute."
  : "Rollback confirmed. Removing only resources recorded as created by this migration."
);

await rollbackQueueQuickConnectAssociations();
await rollbackQuickConnects();
await rollbackUsers();
await rollbackFlowsAndModules();
await rollbackDataTables();
await rollbackRoutingProfiles();
await rollbackQueues();
await rollbackPrompts();
await rollbackCustomPredefinedAttributes();
await rollbackSecurityProfiles();
await rollbackAgentStatuses();
await rollbackHoursOfOperationOverrides();
await rollbackHoursOfOperation();

result.completedAt = new Date().toISOString();

await writeJson("inventory/target/rollback-result.json", result);

console.log("Rollback process complete.");
console.log({
  dryRun: result.dryRun,
  actions: result.actions.length,
  skipped: result.skipped.length,
  warnings: result.warnings.length
});

if (dryRun) {
  console.log("Dry run only. To execute rollback:");
  console.log("ROLLBACK_CONFIRM=DELETE npm run rollback");
}
