import {
  ListQueuesCommand,
  CreateQueueCommand,
  ListHoursOfOperationsCommand,
  CreateHoursOfOperationCommand,
  ListHoursOfOperationOverridesCommand,
  CreateHoursOfOperationOverrideCommand,
  ListPromptsCommand,
  CreatePromptCommand,
  ListSecurityProfilesCommand,
  CreateSecurityProfileCommand,
  ListAgentStatusesCommand,
  CreateAgentStatusCommand,
  ListPredefinedAttributesCommand,
  CreatePredefinedAttributeCommand,
  UpdatePredefinedAttributeCommand,
  UpdateSecurityProfileCommand,
  ListRoutingProfilesCommand,
  CreateRoutingProfileCommand,
  AssociateRoutingProfileQueuesCommand
} from "@aws-sdk/client-connect";
import { loadConfig } from "../lib/config.js";
import { connectClient } from "../lib/aws-clients.js";
import { paginate, chunk, sleep } from "../lib/pagination.js";
import { readJson, writeJson } from "../lib/io.js";

const cfg = await loadConfig();
const srcInv = await readJson("inventory/source/source-inventory.json");
const dest = connectClient(cfg.destProfile, cfg.destRegion);
const InstanceId = cfg.destInstanceId;

const created = { hoursOfOperations: [], hoursOfOperationOverrides: [], prompts: [], queues: [], securityProfiles: [], agentStatuses: [], predefinedAttributes: [], routingProfiles: [], warnings: [] };

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

function sourceQueueId(q) {
  return q.QueueId || q.Id;
}

async function listTargetQueues() {
  return paginate(dest, ListQueuesCommand, { InstanceId, QueueTypes: ["STANDARD"] }, "QueueSummaryList");
}


function outboundCallerConfigNameOnly(config) {
  if (!config) return undefined;
  const out = {};
  if (config.OutboundCallerIdName) out.OutboundCallerIdName = config.OutboundCallerIdName;
  return Object.keys(out).length ? out : undefined;
}

async function listTargetHours() {
  return paginate(dest, ListHoursOfOperationsCommand, { InstanceId }, "HoursOfOperationSummaryList").catch(() => []);
}

async function listTargetPrompts() {
  return paginate(dest, ListPromptsCommand, { InstanceId }, "PromptSummaryList").catch(() => []);
}

async function listTargetSecurityProfiles() {
  return paginate(dest, ListSecurityProfilesCommand, { InstanceId }, "SecurityProfileSummaryList");
}

async function listTargetRoutingProfiles() {
  return paginate(dest, ListRoutingProfilesCommand, { InstanceId }, "RoutingProfileSummaryList");
}

async function listTargetAgentStatuses() {
  return paginate(dest, ListAgentStatusesCommand, { InstanceId }, "AgentStatusSummaryList").catch(() => []);
}

async function listTargetPredefinedAttributes() {
  return paginate(dest, ListPredefinedAttributesCommand, { InstanceId, MaxResults: 100 }, "PredefinedAttributeSummaryList").catch(() => []);
}

function cleanTags(tags) {
  const out = {};
  for (const [k, v] of Object.entries(tags || {})) {
    if (!k || k.toLowerCase().startsWith("aws:")) continue;
    out[k] = String(v);
  }
  return out;
}

function predefinedAttributeInput(attr) {
  if (!attr.Name || String(attr.Name).toLowerCase().startsWith("connect:")) {
    throw new Error(`System predefined attribute ${attr.Name || "empty"} is managed by Amazon Connect and will not be migrated`);
  }

  const input = stripUndefined({
    InstanceId,
    Name: attr.Name,
    Values: attr.Values,
    Purposes: attr.Purposes,
    AttributeConfiguration: attr.AttributeConfiguration
  });

  if (!input.Name || input.Name.length > 100) {
    throw new Error(`Invalid predefined attribute name: ${input.Name || "empty"}`);
  }

  const values = input.Values?.StringList || [];
  const invalidValue = values.find((v) => String(v).length > 100);
  if (invalidValue) {
    throw new Error(`Predefined attribute ${input.Name} has a value over 100 characters: ${invalidValue}`);
  }

  return input;
}

function hoursOverrideKey(o) {
  return [
    o.Name || "",
    o.EffectiveFrom || "",
    o.EffectiveTill || "",
    o.OverrideType || ""
  ].join("|");
}

async function listTargetHoursOverrides(hoursOfOperationId, label) {
  return paginate(
    dest,
    ListHoursOfOperationOverridesCommand,
    { InstanceId, HoursOfOperationId: hoursOfOperationId, MaxResults: 100 },
    "HoursOfOperationOverrideList"
  ).catch((e) => {
    created.warnings.push(`HoursOfOperation ${label}: list overrides failed: ${e.message}`);
    return [];
  });
}

function buildHoursOverrideInput(sourceOverride, targetHoursOfOperationId) {
  return stripUndefined({
    InstanceId,
    HoursOfOperationId: targetHoursOfOperationId,
    Name: sourceOverride.Name,
    Description: sourceOverride.Description,
    Config: sourceOverride.Config || [],
    EffectiveFrom: sourceOverride.EffectiveFrom,
    EffectiveTill: sourceOverride.EffectiveTill,
    OverrideType: sourceOverride.OverrideType,
    RecurrenceConfig: sourceOverride.RecurrenceConfig
  });
}

async function createMissingHoursOverridesForSource(sourceHours, targetHours) {
  const targetHoursId = targetHours?.Id || targetHours?.HoursOfOperationId;
  if (!targetHoursId) return;

  const sourceOverrides = sourceHours.Overrides || [];
  if (sourceOverrides.length === 0) return;

  const targetOverrides = await listTargetHoursOverrides(targetHoursId, sourceHours.Name);
  const targetOverrideKeys = new Set((targetOverrides || []).map(hoursOverrideKey));

  for (const override of sourceOverrides) {
    if (!override?.Name) continue;
    if (targetOverrideKeys.has(hoursOverrideKey(override))) continue;

    const input = buildHoursOverrideInput(override, targetHoursId);

    if (!input.Name || !input.EffectiveFrom || !input.EffectiveTill || !input.Config) {
      created.warnings.push(`HoursOfOperation ${sourceHours.Name}: skipped override ${override.Name || "unknown"} because required fields were missing.`);
      continue;
    }

    try {
      const resp = await dest.send(new CreateHoursOfOperationOverrideCommand(input));
      created.hoursOfOperationOverrides.push({
        hoursName: sourceHours.Name,
        name: override.Name,
        id: resp.HoursOfOperationOverrideId,
        hoursOfOperationId: targetHoursId
      });
      targetOverrideKeys.add(hoursOverrideKey(override));
    } catch (e) {
      const msg = String(e.message || "");
      if (msg.toLowerCase().includes("duplicate") || msg.toLowerCase().includes("already")) {
        created.warnings.push(`HoursOfOperation ${sourceHours.Name}: override ${override.Name} already exists or duplicate.`);
      } else {
        created.warnings.push(`HoursOfOperation ${sourceHours.Name}: create override ${override.Name} failed: ${e.message}`);
      }
    }

    await sleep(150);
  }
}

function buildRoutingProfileQueueConfig(sourceConfig) {
  const sourceQueueIdValue = sourceConfig.QueueId || sourceConfig.QueueReference?.QueueId;
  const channel = sourceConfig.Channel || sourceConfig.QueueReference?.Channel;
  const targetQueueId = targetQueueIdForSource(sourceQueueIdValue);

  if (!targetQueueId || !channel) {
    return {
      warning: `source queue ${sourceQueueIdValue || "unknown"} because target queue or channel was missing`
    };
  }

  return {
    config: {
      QueueReference: { QueueId: targetQueueId, Channel: channel },
      Priority: sourceConfig.Priority ?? 1,
      Delay: sourceConfig.Delay ?? 0
    }
  };
}

function buildManualAssignmentQueueConfig(sourceConfig) {
  const sourceQueueIdValue = sourceConfig.QueueId || sourceConfig.QueueReference?.QueueId;
  const channel = sourceConfig.Channel || sourceConfig.QueueReference?.Channel;
  const targetQueueId = targetQueueIdForSource(sourceQueueIdValue);

  if (!targetQueueId || !channel) {
    return {
      warning: `source manual queue ${sourceQueueIdValue || "unknown"} because target queue or channel was missing`
    };
  }

  return {
    config: {
      QueueReference: { QueueId: targetQueueId, Channel: channel }
    }
  };
}


let targetHours = await listTargetHours();
let targetHoursByName = new Map(targetHours.map((h) => [h.Name, h]));

for (const h of srcInv.hoursOfOperations || []) {
  if (targetHoursByName.has(h.Name)) continue;

  const input = stripUndefined({
    InstanceId,
    Name: h.Name,
    Description: h.Description || `Migrated hours of operation ${h.Name}`,
    TimeZone: h.TimeZone,
    Config: h.Config,
    Tags: h.Tags || {}
  });

  if (!input.TimeZone || !input.Config) {
    created.warnings.push(`HoursOfOperation ${h.Name}: skipped create because TimeZone or Config is missing.`);
    continue;
  }

  try {
    const resp = await dest.send(new CreateHoursOfOperationCommand(input));
    created.hoursOfOperations.push({ name: h.Name, id: resp.HoursOfOperationId, arn: resp.HoursOfOperationArn });
  } catch (e) {
    created.warnings.push(`HoursOfOperation ${h.Name}: create failed: ${e.message}`);
  }
  await sleep(200);
}

targetHours = await listTargetHours();
targetHoursByName = new Map(targetHours.map((h) => [h.Name, h]));

for (const sourceHours of srcInv.hoursOfOperations || []) {
  const targetHours = targetHoursByName.get(sourceHours.Name);
  if (targetHours) {
    await createMissingHoursOverridesForSource(sourceHours, targetHours);
  }
}

const sourceHoursById = new Map((srcInv.hoursOfOperations || []).map((h) => [h.HoursOfOperationId || h.Id, h]));

let targetPrompts = await listTargetPrompts();
let targetPromptByName = new Map(targetPrompts.map((p) => [p.Name, p]));

for (const p of srcInv.prompts || []) {
  if (targetPromptByName.has(p.Name)) continue;

  if (!p.S3Uri) {
    created.warnings.push(`Prompt ${p.Name}: skipped create because source prompt S3Uri was not returned. Existing destination prompts are still mapped by name.`);
    continue;
  }

  try {
    const resp = await dest.send(new CreatePromptCommand({
      InstanceId,
      Name: p.Name,
      Description: p.Description || `Migrated prompt ${p.Name}`,
      S3Uri: p.S3Uri,
      Tags: p.Tags || {}
    }));
    created.prompts.push({ name: p.Name, id: resp.PromptId, arn: resp.PromptARN || resp.PromptArn });
  } catch (e) {
    created.warnings.push(`Prompt ${p.Name}: create failed: ${e.message}`);
  }
  await sleep(200);
}

targetPrompts = await listTargetPrompts();
targetPromptByName = new Map(targetPrompts.map((p) => [p.Name, p]));

let targetQueues = await listTargetQueues();
let targetQueueByName = new Map(targetQueues.map((q) => [q.Name, q]));

for (const q of srcInv.queues || []) {
  if ((cfg.skip?.queues || []).includes(q.Name)) continue;
  if (targetQueueByName.has(q.Name)) continue;

  const sourceHoursId = q.HoursOfOperationId;
  const sourceHours = sourceHoursById.get(sourceHoursId);
  const targetHoursMatch = sourceHours ? targetHoursByName.get(sourceHours.Name) : null;

  if (!targetHoursMatch) {
    created.warnings.push(`Queue ${q.Name}: skipped create because target HoursOfOperation was not found for source hours ${sourceHours?.Name || sourceHoursId}.`);
    continue;
  }

  const input = stripUndefined({
    InstanceId,
    Name: q.Name,
    Description: q.Description || `Migrated queue ${q.Name}`,
    HoursOfOperationId: targetHoursMatch.Id,
    MaxContacts: q.MaxContacts,
    Tags: q.Tags || {}
  });

  const outboundCallerConfig = outboundCallerConfigNameOnly(q.OutboundCallerConfig);
  if (outboundCallerConfig) input.OutboundCallerConfig = outboundCallerConfig;

  try {
    const resp = await dest.send(new CreateQueueCommand(input));
    created.queues.push({ name: q.Name, id: resp.QueueId, arn: resp.QueueArn });
  } catch (e) {
    created.warnings.push(`Queue ${q.Name}: create failed: ${e.message}`);
  }

  await sleep(200);
}

targetQueues = await listTargetQueues();
targetQueueByName = new Map(targetQueues.map((q) => [q.Name, q]));
const sourceQueueById = new Map((srcInv.queues || []).map((q) => [sourceQueueId(q), q]));
function targetQueueIdForSource(sourceId) {
  const sq = sourceQueueById.get(sourceId);
  if (!sq) return null;
  return targetQueueByName.get(sq.Name)?.Id || null;
}

let targetSecurityProfiles = await listTargetSecurityProfiles();
let targetSpByName = new Map(targetSecurityProfiles.map((sp) => [sp.Name, sp]));

for (const sp of srcInv.securityProfiles || []) {
  if (targetSpByName.has(sp.Name)) continue;
  const permissions = sp.Permissions || [];
  try {
    const resp = await dest.send(new CreateSecurityProfileCommand({
      InstanceId,
      SecurityProfileName: sp.Name,
      Description: sp.Description || `Migrated security profile ${sp.Name}`,
      Permissions: permissions,
      Tags: cleanTags(sp.Tags || {})
    }));
    created.securityProfiles.push({ name: sp.Name, id: resp.SecurityProfileId });
  } catch (e) {
    created.warnings.push(`SecurityProfile ${sp.Name}: create failed: ${e.message}`);
  }
  await sleep(200);
}

targetSecurityProfiles = await listTargetSecurityProfiles();
targetSpByName = new Map(targetSecurityProfiles.map((sp) => [sp.Name, sp]));

for (const sp of srcInv.securityProfiles || []) {
  const target = targetSpByName.get(sp.Name);
  if (!target) continue;
  const permissions = sp.Permissions || [];
  if (cfg.safety?.doNotOverwriteSecurityProfileWithZeroPermissions && permissions.length === 0) {
    created.warnings.push(`SecurityProfile ${sp.Name}: skipped permission update because source permissions returned empty.`);
    continue;
  }
  await dest.send(new UpdateSecurityProfileCommand({
    InstanceId,
    SecurityProfileId: target.Id,
    Description: sp.Description || target.Description,
    Permissions: permissions
  })).catch((e) => created.warnings.push(`SecurityProfile ${sp.Name} update skipped: ${e.message}`));
}


let targetAgentStatuses = await listTargetAgentStatuses();
let targetAgentStatusByName = new Map(targetAgentStatuses.map((s) => [s.Name, s]));

for (const s of srcInv.agentStatuses || []) {
  if (!s.Name) continue;
  if (targetAgentStatusByName.has(s.Name)) continue;

  try {
    const input = stripUndefined({
      InstanceId,
      Name: s.Name,
      Description: s.Description || `Migrated agent status ${s.Name}`,
      DisplayOrder: s.DisplayOrder,
      State: s.State || "ENABLED",
      Tags: cleanTags(s.Tags || {})
    });

    const resp = await dest.send(new CreateAgentStatusCommand(input));
    created.agentStatuses.push({ name: s.Name, id: resp.AgentStatusId, arn: resp.AgentStatusARN || resp.AgentStatusArn });
  } catch (e) {
    created.warnings.push(`AgentStatus ${s.Name}: create failed: ${e.message}`);
  }

  await sleep(200);
}

let targetPredefinedAttributes = await listTargetPredefinedAttributes();
let targetPredefinedAttributeByName = new Map(targetPredefinedAttributes.map((a) => [a.Name, a]));

for (const a of srcInv.predefinedAttributes || []) {
  if (!a.Name) continue;

  let input;
  try {
    input = predefinedAttributeInput(a);
  } catch (e) {
    created.warnings.push(`PredefinedAttribute ${a.Name || "unknown"}: skipped: ${e.message}`);
    continue;
  }

  if (targetPredefinedAttributeByName.has(a.Name)) {
    try {
      await dest.send(new UpdatePredefinedAttributeCommand(input));
      created.predefinedAttributes.push({ name: a.Name, action: "updated-replaced" });
    } catch (e) {
      created.warnings.push(`PredefinedAttribute ${a.Name}: update/replace failed: ${e.message}`);
    }
  } else {
    try {
      const resp = await dest.send(new CreatePredefinedAttributeCommand(input));
      created.predefinedAttributes.push({ name: a.Name, action: "created", id: resp.PredefinedAttributeId || null });
    } catch (e) {
      created.warnings.push(`PredefinedAttribute ${a.Name}: create failed: ${e.message}`);
    }
  }

  await sleep(200);
}

let targetRoutingProfiles = await listTargetRoutingProfiles();
let targetRpByName = new Map(targetRoutingProfiles.map((rp) => [rp.Name, rp]));

for (const rp of srcInv.routingProfiles || []) {
  if (targetRpByName.has(rp.Name)) continue;

  const defaultOutboundSourceQueueId = rp.DefaultOutboundQueueId;
  const defaultOutboundTargetQueueId = targetQueueIdForSource(defaultOutboundSourceQueueId) || targetQueues[0]?.Id;

  if (!defaultOutboundTargetQueueId) {
    created.warnings.push(`RoutingProfile ${rp.Name}: skipped create because no default outbound target queue could be mapped.`);
    continue;
  }

  const mediaConcurrencies = (rp.MediaConcurrencies || [])
    .filter((mc) => mc.Channel && mc.Concurrency)
    .map((mc) => stripUndefined({
      Channel: mc.Channel,
      Concurrency: mc.Concurrency,
      CrossChannelBehavior: mc.CrossChannelBehavior
    }));

  if (mediaConcurrencies.length === 0) {
    created.warnings.push(`RoutingProfile ${rp.Name}: skipped create because source MediaConcurrencies is missing.`);
    continue;
  }

  try {
    const resp = await dest.send(new CreateRoutingProfileCommand({
      InstanceId,
      Name: rp.Name,
      Description: rp.Description || `Migrated routing profile ${rp.Name}`,
      DefaultOutboundQueueId: defaultOutboundTargetQueueId,
      MediaConcurrencies: mediaConcurrencies,
      AgentAvailabilityTimer: rp.AgentAvailabilityTimer,
      Tags: cleanTags(rp.Tags || {})
    }));

    const targetRoutingProfileId = resp.RoutingProfileId;
    created.routingProfiles.push({ name: rp.Name, id: targetRoutingProfileId, arn: resp.RoutingProfileArn });

    const queueConfigs = [];
    for (const qc of rp.QueueConfigs || []) {
      const built = buildRoutingProfileQueueConfig(qc);
      if (built.warning) {
        created.warnings.push(`RoutingProfile ${rp.Name}: skipped queue config for ${built.warning}.`);
        continue;
      }
      queueConfigs.push(built.config);
    }

    for (const batch of chunk(queueConfigs, 10)) {
      if (batch.length === 0) continue;
      await dest.send(new AssociateRoutingProfileQueuesCommand({
        InstanceId,
        RoutingProfileId: targetRoutingProfileId,
        QueueConfigs: batch
      })).catch((e) => created.warnings.push(`RoutingProfile ${rp.Name}: associate queues failed: ${e.message}`));
      await sleep(200);
    }

    const manualAssignmentQueueConfigs = [];
    for (const mc of rp.ManualAssignmentQueueConfigs || []) {
      const built = buildManualAssignmentQueueConfig(mc);
      if (built.warning) {
        created.warnings.push(`RoutingProfile ${rp.Name}: skipped manual assignment queue config for ${built.warning}.`);
        continue;
      }
      manualAssignmentQueueConfigs.push(built.config);
    }

    for (const batch of chunk(manualAssignmentQueueConfigs, 10)) {
      if (batch.length === 0) continue;
      await dest.send(new AssociateRoutingProfileQueuesCommand({
        InstanceId,
        RoutingProfileId: targetRoutingProfileId,
        ManualAssignmentQueueConfigs: batch
      })).catch((e) => created.warnings.push(`RoutingProfile ${rp.Name}: associate manual assignment queues failed: ${e.message}`));
      await sleep(200);
    }
  } catch (e) {
    created.warnings.push(`RoutingProfile ${rp.Name}: create failed: ${e.message}`);
  }

  await sleep(300);
}

await writeJson("inventory/target/base-deploy-result.json", created);
console.log("Target base deployment step complete with dependency-first resources and safe skips/warnings.");
