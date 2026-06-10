import {
  ListContactFlowsCommand,
  CreateContactFlowCommand,
  UpdateContactFlowContentCommand,
  ListContactFlowModulesCommand,
  CreateContactFlowModuleCommand,
  UpdateContactFlowModuleContentCommand
} from "@aws-sdk/client-connect";

import { loadConfig } from "../lib/config.js";
import { connectClient } from "../lib/aws-clients.js";
import { paginate, sleep } from "../lib/pagination.js";
import { readJson, writeJson, writeText } from "../lib/io.js";
import { sanitizeName } from "../lib/naming.js";
import {
  replaceAllResourceReferences,
  ensureNoSourceReferences
} from "../lib/flow-parser.js";

const cfg = await loadConfig();

const src = await readJson("inventory/source/source-inventory.json");

const existingMap = await readJson("inventory/target/resource-map.json", {
  maps: {},
  replacements: {}
});

const dest = connectClient(cfg.destProfile, cfg.destRegion);
const InstanceId = cfg.destInstanceId;

const result = {
  createdFlows: [],
  existingFlows: [],
  updatedFlows: [],
  createdModules: [],
  existingModules: [],
  updatedModules: [],
  warnings: []
};

/**
 * Normal contact flow placeholder.
 *
 * Important:
 * - Normal contact flows must NOT include Settings.
 * - Contact flow modules require Settings.
 */
const SAFE_FLOW_PLACEHOLDER_CONTENT = JSON.stringify({
  Version: "2019-10-30",
  StartAction: "00000000-0000-0000-0000-000000000001",
  Metadata: {
    entryPointPosition: {
      x: 40,
      y: 40
    },
    ActionMetadata: {
      "00000000-0000-0000-0000-000000000001": {
        position: {
          x: 160,
          y: 120
        }
      }
    }
  },
  Actions: [
    {
      Identifier: "00000000-0000-0000-0000-000000000001",
      Type: "DisconnectParticipant",
      Parameters: {},
      Transitions: {}
    }
  ]
});

/**
 * Contact flow module placeholder.
 *
 * Important:
 * - Modules require Settings.
 * - This placeholder is only used to create the module and get a destination ID/ARN.
 * - The real module content is updated in pass 2.
 */
const SAFE_MODULE_PLACEHOLDER_CONTENT = JSON.stringify({
  Version: "2019-10-30",
  StartAction: "00000000-0000-0000-0000-000000000001",
  Metadata: {
    entryPointPosition: {
      x: 40,
      y: 40
    },
    ActionMetadata: {
      "00000000-0000-0000-0000-000000000001": {
        position: {
          x: 160,
          y: 120
        }
      }
    }
  },
  Actions: [
    {
      Identifier: "00000000-0000-0000-0000-000000000001",
      Type: "DisconnectParticipant",
      Parameters: {},
      Transitions: {}
    }
  ],
  Settings: {
    InputParameters: [],
    OutputParameters: []
  }
});

function byName(items = []) {
  return new Map(items.filter((x) => x?.Name).map((x) => [x.Name, x]));
}

function flowId(x) {
  return x?.Id || x?.ContactFlowId;
}

function flowArn(x) {
  return x?.Arn || x?.ContactFlowArn;
}

function moduleId(x) {
  return x?.Id || x?.ContactFlowModuleId;
}

function moduleArn(x) {
  return x?.Arn || x?.ContactFlowModuleArn;
}

function sourceFlowId(x) {
  return x?.Id || x?.ContactFlowId;
}

function sourceFlowArn(x) {
  return x?.Arn || x?.ContactFlowArn;
}

function sourceModuleId(x) {
  return x?.Id || x?.ContactFlowModuleId;
}

function sourceModuleArn(x) {
  return x?.Arn || x?.ContactFlowModuleArn;
}

function addReplacement(replacements, from, to) {
  if (from && to && from !== to) {
    replacements[from] = to;
  }
}

async function listTargetFlows() {
  return paginate(
    dest,
    ListContactFlowsCommand,
    { InstanceId },
    "ContactFlowSummaryList"
  );
}

async function listTargetModules() {
  try {
    return await paginate(
      dest,
      ListContactFlowModulesCommand,
      { InstanceId },
      "ContactFlowModulesSummaryList"
    );
  } catch (err) {
    result.warnings.push({
      type: "LIST_CONTACT_FLOW_MODULES_FAILED",
      message: err.message
    });

    return [];
  }
}

async function createMissingModulesFirst() {
  const targetModules = await listTargetModules();
  const targetModuleByName = byName(targetModules);

  for (const m of src.contactFlowModules || []) {
    if (!m?.Name) {
      result.warnings.push({
        type: "SOURCE_MODULE_MISSING_NAME",
        module: m
      });
      continue;
    }

    if (targetModuleByName.has(m.Name)) {
      const existing = targetModuleByName.get(m.Name);

      result.existingModules.push({
        name: m.Name,
        id: moduleId(existing),
        arn: moduleArn(existing)
      });

      continue;
    }

    try {
      const resp = await dest.send(
        new CreateContactFlowModuleCommand({
          InstanceId,
          Name: m.Name,
          Description: m.Description || `Migrated module ${m.Name}`,
          Content: SAFE_MODULE_PLACEHOLDER_CONTENT,
          Tags: m.Tags || {}
        })
      );

      result.createdModules.push({
        name: m.Name,
        id: resp.Id || resp.ContactFlowModuleId,
        arn: resp.Arn || resp.ContactFlowModuleArn
      });

      await sleep(300);
    } catch (err) {
      result.warnings.push({
        type: "CREATE_CONTACT_FLOW_MODULE_FAILED",
        name: m.Name,
        message: err.message,
        metadata: err.$metadata,
        reason: err.Reason || null
      });

      throw err;
    }
  }
}

async function createMissingFlowsFirst() {
  const targetFlows = await listTargetFlows();
  const targetFlowByName = byName(targetFlows);

  for (const f of src.contactFlows || []) {
    if (!f?.Name) {
      result.warnings.push({
        type: "SOURCE_FLOW_MISSING_NAME",
        flow: f
      });
      continue;
    }

    if (targetFlowByName.has(f.Name)) {
      const existing = targetFlowByName.get(f.Name);

      result.existingFlows.push({
        name: f.Name,
        id: flowId(existing),
        arn: flowArn(existing)
      });

      continue;
    }

    try {
      const resp = await dest.send(
        new CreateContactFlowCommand({
          InstanceId,
          Name: f.Name,
          Type: f.Type,
          Description: f.Description || `Migrated ${f.Name}`,
          Content: SAFE_FLOW_PLACEHOLDER_CONTENT,
          Status: "PUBLISHED",
          Tags: f.Tags || {}
        })
      );

      result.createdFlows.push({
        name: f.Name,
        id: resp.ContactFlowId,
        arn: resp.ContactFlowArn
      });

      await sleep(300);
    } catch (err) {
      result.warnings.push({
        type: "CREATE_CONTACT_FLOW_FAILED",
        name: f.Name,
        flowType: f.Type,
        message: err.message,
        problems: err.problems || [],
        metadata: err.$metadata
      });

      throw err;
    }
  }
}

async function buildFreshFlowModuleReplacements() {
  const targetFlows = await listTargetFlows();
  const targetModules = await listTargetModules();

  const targetFlowByName = byName(targetFlows);
  const targetModuleByName = byName(targetModules);

  const replacements = {
    ...(existingMap.replacements || {})
  };

  addReplacement(replacements, cfg.sourceInstanceArn, cfg.destInstanceArn);
  addReplacement(replacements, cfg.sourceInstanceId, cfg.destInstanceId);

  const maps = {
    ...(existingMap.maps || {}),
    contactFlows: {
      map: {},
      missing: []
    },
    contactFlowModules: {
      map: {},
      missing: []
    }
  };

  for (const f of src.contactFlows || []) {
    const target = targetFlowByName.get(f.Name);

    if (!target) {
      maps.contactFlows.missing.push({
        name: f.Name,
        sourceId: sourceFlowId(f),
        sourceArn: sourceFlowArn(f)
      });

      continue;
    }

    const sid = sourceFlowId(f);
    const tid = flowId(target);

    maps.contactFlows.map[sid] = tid;

    addReplacement(replacements, sid, tid);
    addReplacement(replacements, sourceFlowArn(f), flowArn(target));
  }

  for (const m of src.contactFlowModules || []) {
    const target = targetModuleByName.get(m.Name);

    if (!target) {
      maps.contactFlowModules.missing.push({
        name: m.Name,
        sourceId: sourceModuleId(m),
        sourceArn: sourceModuleArn(m)
      });

      continue;
    }

    const sid = sourceModuleId(m);
    const tid = moduleId(target);

    maps.contactFlowModules.map[sid] = tid;

    addReplacement(replacements, sid, tid);
    addReplacement(replacements, sourceModuleArn(m), moduleArn(target));
  }

  const freshMap = {
    ...existingMap,
    generatedAt: new Date().toISOString(),
    maps,
    replacements
  };

  await writeJson("inventory/target/resource-map.json", freshMap);

  return {
    targetFlows,
    targetModules,
    targetFlowByName,
    targetModuleByName,
    replacements
  };
}

async function updateModulesWithFinalContent(targetModuleByName, replacements) {
  for (const m of src.contactFlowModules || []) {
    const target = targetModuleByName.get(m.Name);

    if (!target) {
      result.warnings.push({
        type: "CONTACT_FLOW_MODULE_NOT_FOUND_AFTER_CREATE",
        name: m.Name,
        sourceId: sourceModuleId(m)
      });

      continue;
    }

    try {
      const rawContent = m.Content || "{}";
      const content = replaceAllResourceReferences(rawContent, replacements);

      ensureNoSourceReferences(content, cfg, `ContactFlowModule ${m.Name}`);

      const file = `flows/patched/contact-flow-modules/${sanitizeName(
        m.Name
      )}__${sourceModuleId(m)}.json`;

      await writeText(file, content);

      await dest.send(
        new UpdateContactFlowModuleContentCommand({
          InstanceId,
          ContactFlowModuleId: moduleId(target),
          Content: content
        })
      );

      result.updatedModules.push({
        name: m.Name,
        id: moduleId(target)
      });

      await sleep(300);
    } catch (err) {
      result.warnings.push({
        type: "UPDATE_CONTACT_FLOW_MODULE_FAILED",
        name: m.Name,
        sourceId: sourceModuleId(m),
        targetId: moduleId(target),
        message: err.message,
        problems: err.problems || [],
        metadata: err.$metadata
      });

      throw err;
    }
  }
}

async function updateFlowsWithFinalContent(targetFlowByName, replacements) {
  for (const f of src.contactFlows || []) {
    const target = targetFlowByName.get(f.Name);

    if (!target) {
      result.warnings.push({
        type: "CONTACT_FLOW_NOT_FOUND_AFTER_CREATE",
        name: f.Name,
        sourceId: sourceFlowId(f)
      });

      continue;
    }

    try {
      const rawContent = f.Content || "{}";
      const content = replaceAllResourceReferences(rawContent, replacements);

      ensureNoSourceReferences(content, cfg, `ContactFlow ${f.Name}`);

      const file = `flows/patched/contact-flows/${sanitizeName(
        f.Name
      )}__${sourceFlowId(f)}.json`;

      await writeText(file, content);

      await dest.send(
        new UpdateContactFlowContentCommand({
          InstanceId,
          ContactFlowId: flowId(target),
          Content: content
        })
      );

      result.updatedFlows.push({
        name: f.Name,
        id: flowId(target)
      });

      await sleep(300);
    } catch (err) {
      result.warnings.push({
        type: "UPDATE_CONTACT_FLOW_FAILED",
        name: f.Name,
        sourceId: sourceFlowId(f),
        targetId: flowId(target),
        message: err.message,
        problems: err.problems || [],
        metadata: err.$metadata
      });

      throw err;
    }
  }
}

console.log("Starting two-pass contact flow/module deployment...");

try {
  console.log("Pass 1: creating missing contact flow modules as placeholders...");
  await createMissingModulesFirst();

  console.log("Pass 1: creating missing contact flows as placeholders...");
  await createMissingFlowsFirst();

  console.log("Refreshing destination flow/module mappings...");
  const { targetFlowByName, targetModuleByName, replacements } =
    await buildFreshFlowModuleReplacements();

  console.log("Pass 2: updating contact flow modules with final patched content...");
  await updateModulesWithFinalContent(targetModuleByName, replacements);

  console.log("Pass 2: updating contact flows with final patched content...");
  await updateFlowsWithFinalContent(targetFlowByName, replacements);

  await writeJson("inventory/target/flow-deploy-result.json", result);

  console.log("Two-pass flow/module deployment complete.");
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  await writeJson("inventory/target/flow-deploy-result.json", result);

  console.error("Two-pass flow/module deployment failed.");
  console.error("Partial result written to inventory/target/flow-deploy-result.json");
  console.error(JSON.stringify(result, null, 2));

  throw err;
}