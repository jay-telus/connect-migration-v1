import {
  ListQuickConnectsCommand,
  CreateQuickConnectCommand, AssociateQueueQuickConnectsCommand
} from "@aws-sdk/client-connect";
import { loadConfig } from "../lib/config.js";
import { connectClient } from "../lib/aws-clients.js";
import { paginate, sleep } from "../lib/pagination.js";
import { readJson, writeJson } from "../lib/io.js";

const cfg = await loadConfig();
if (!cfg.scope.migrateQuickConnects) {
  console.log("Quick connect migration disabled in config.");
  process.exit(0);
}

const src = await readJson("inventory/source/source-inventory.json");
const map = await readJson("inventory/target/resource-map.json");
const dest = connectClient(cfg.destProfile, cfg.destRegion);
const InstanceId = cfg.destInstanceId;

const existing = await paginate(dest, ListQuickConnectsCommand, { InstanceId }, "QuickConnectSummaryList");
const existingByName = new Map(existing.map((x) => [x.Name, x]));
const result = { created: [], skipped: [], warnings: [] };

function patchQuickConnectConfig(qc) {
  const cfgIn = qc.QuickConnectConfig || {};
  const type = cfgIn.QuickConnectType;

  if ((cfg.skip?.quickConnectTypes || []).includes(type)) {
    return { skip: `Quick connect type ${type} is out of scope.` };
  }

  if (type === "USER") {
    const sourceUserId = cfgIn.UserConfig?.UserId;
    const targetUserId = map.maps.users.map[sourceUserId];
    if (!targetUserId) return { skip: "Missing target user mapping." };
    return { config: { QuickConnectType: "USER", UserConfig: { UserId: targetUserId, ContactFlowId: map.maps.contactFlows.map[cfgIn.UserConfig.ContactFlowId] || cfgIn.UserConfig.ContactFlowId } } };
  }

  if (type === "QUEUE") {
    const sourceQueueId = cfgIn.QueueConfig?.QueueId;
    const targetQueueId = map.maps.queues.map[sourceQueueId];
    if (!targetQueueId) return { skip: "Missing target queue mapping." };
    return { config: { QuickConnectType: "QUEUE", QueueConfig: { QueueId: targetQueueId, ContactFlowId: map.maps.contactFlows.map[cfgIn.QueueConfig.ContactFlowId] || cfgIn.QueueConfig.ContactFlowId } } };
  }

  if (type === "PHONE_NUMBER") {
    return { skip: "Phone number quick connects are out of scope." };
  }

  return { skip: `Unsupported quick connect type ${type}.` };
}

for (const qc of src.quickConnects || []) {
  if (existingByName.has(qc.Name)) {
    result.skipped.push({ name: qc.Name, reason: "Already exists in destination." });
    continue;
  }

  const patched = patchQuickConnectConfig(qc);
  if (patched.skip) {
    result.skipped.push({ name: qc.Name, reason: patched.skip });
    continue;
  }

  try {
    const resp = await dest.send(new CreateQuickConnectCommand({
      InstanceId,
      Name: qc.Name,
      Description: qc.Description || `Migrated quick connect ${qc.Name}`,
      QuickConnectConfig: patched.config,
      Tags: qc.Tags || {}
    }));
    result.created.push({ name: qc.Name, id: resp.QuickConnectId, arn: resp.QuickConnectARN });
  } catch (e) {
    result.warnings.push(`Create quick connect ${qc.Name} failed: ${e.message}`);
  }

  await sleep(300);
}



const queueAssociationResult = { associated: [], skipped: [], warnings: [] };

const refreshedTargetQuickConnects = await paginate(
  dest,
  ListQuickConnectsCommand,
  { InstanceId },
  "QuickConnectSummaryList"
).catch((e) => {
  queueAssociationResult.warnings.push(`ListQuickConnects refresh failed before queue association: ${e.message}`);
  return [];
});

const refreshedQuickConnectByName = new Map(
  refreshedTargetQuickConnects.map((x) => [x.Name, x])
);

const refreshedQuickConnectMap = {};
const refreshedQuickConnectMissing = [];

for (const sourceQc of src.quickConnects || []) {
  const targetQc = refreshedQuickConnectByName.get(sourceQc.Name);
  const sourceQcId = sourceQc.QuickConnectId || sourceQc.Id;

  if (sourceQcId && targetQc?.Id) {
    refreshedQuickConnectMap[sourceQcId] = targetQc.Id;
  } else {
    refreshedQuickConnectMissing.push({
      name: sourceQc.Name,
      sourceId: sourceQcId
    });
  }
}

result.refreshedQuickConnectMap = {
  map: refreshedQuickConnectMap,
  missing: refreshedQuickConnectMissing
};

for (const assoc of src.queueQuickConnectAssociations || []) {
  const sourceQueueId = assoc.queueId;
  const targetQueueId =
    map.maps?.queues?.map?.[sourceQueueId] ||
    assoc.targetQueueId;

  if (!targetQueueId) {
    queueAssociationResult.skipped.push({
      queueName: assoc.queueName,
      reason: "Missing target queue mapping"
    });
    continue;
  }

  const targetQuickConnectIds = [];

  for (const qc of assoc.quickConnects || []) {
    const sourceQcId = qc.Id || qc.QuickConnectId;
    let targetQcId = refreshedQuickConnectMap[sourceQcId];

    if (!targetQcId && qc.Name) {
      const targetByName = refreshedQuickConnectByName.get(qc.Name);
      targetQcId = targetByName?.Id;
    }

    if (targetQcId) {
      targetQuickConnectIds.push(targetQcId);
    } else {
      queueAssociationResult.skipped.push({
        queueName: assoc.queueName,
        quickConnectName: qc.Name,
        reason: "Missing target quick connect mapping after refresh"
      });
    }
  }

  const uniqueIds = [...new Set(targetQuickConnectIds)];

  for (let i = 0; i < uniqueIds.length; i += 50) {
    const batch = uniqueIds.slice(i, i + 50);
    if (batch.length === 0) continue;

    try {
      await dest.send(new AssociateQueueQuickConnectsCommand({
        InstanceId,
        QueueId: targetQueueId,
        QuickConnectIds: batch
      }));

      queueAssociationResult.associated.push({
        queueName: assoc.queueName,
        targetQueueId,
        quickConnectCount: batch.length
      });
    } catch (e) {
      const msg = String(e.message || "");

      if (
        msg.toLowerCase().includes("already") ||
        msg.toLowerCase().includes("duplicate") ||
        msg.toLowerCase().includes("exists")
      ) {
        queueAssociationResult.skipped.push({
          queueName: assoc.queueName,
          reason: `Association already exists or duplicate: ${msg}`
        });
      } else {
        queueAssociationResult.warnings.push(`AssociateQueueQuickConnects ${assoc.queueName} failed: ${msg}`);
      }
    }

    await sleep(200);
  }
}

result.queueAssociations = queueAssociationResult;

await writeJson("inventory/target/quick-connect-migration-result.json", result);
console.log("Quick connect migration complete.");
