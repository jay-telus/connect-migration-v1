import {
  ListContactFlowsCommand,
  CreateContactFlowCommand,
  UpdateContactFlowContentCommand,
  ListContactFlowModulesCommand,
  CreateContactFlowModuleCommand,
  UpdateContactFlowModuleContentCommand
} from "@aws-sdk/client-connect";
import fs from "fs-extra";
import { loadConfig } from "../lib/config.js";
import { connectClient } from "../lib/aws-clients.js";
import { paginate, sleep } from "../lib/pagination.js";
import { readJson, writeJson } from "../lib/io.js";

const cfg = await loadConfig();
const src = await readJson("inventory/source/source-inventory.json");
const dest = connectClient(cfg.destProfile, cfg.destRegion);
const InstanceId = cfg.destInstanceId;

const result = { createdFlows: [], updatedFlows: [], createdModules: [], updatedModules: [], warnings: [] };

let targetFlows = await paginate(dest, ListContactFlowsCommand, { InstanceId }, "ContactFlowSummaryList");
let targetFlowByName = new Map(targetFlows.map((f) => [f.Name, f]));

for (const f of src.contactFlows || []) {
  const file = `flows/patched/contact-flows/${f.Name.replace(/[\\/:*?"<>|#{}$]/g, "-")}__${f.Id}.json`;
  const content = await fs.readFile(file, "utf8").catch(() => f.Content || "{}");
  const existing = targetFlowByName.get(f.Name);

  if (!existing) {
    const resp = await dest.send(new CreateContactFlowCommand({
      InstanceId,
      Name: f.Name,
      Type: f.Type,
      Description: f.Description || `Migrated ${f.Name}`,
      Content: content,
      Status: "PUBLISHED",
      Tags: f.Tags || {}
    }));
    result.createdFlows.push({ name: f.Name, id: resp.ContactFlowId, arn: resp.ContactFlowArn });
  } else {
    await dest.send(new UpdateContactFlowContentCommand({
      InstanceId,
      ContactFlowId: existing.Id,
      Content: content
    }));
    result.updatedFlows.push({ name: f.Name, id: existing.Id });
  }
  await sleep(300);
}

const targetModules = await paginate(dest, ListContactFlowModulesCommand, { InstanceId }, "ContactFlowModulesSummaryList").catch(() => []);
const targetModuleByName = new Map(targetModules.map((m) => [m.Name, m]));

for (const m of src.contactFlowModules || []) {
  const file = `flows/patched/contact-flow-modules/${m.Name.replace(/[\\/:*?"<>|#{}$]/g, "-")}__${m.Id}.json`;
  const content = await fs.readFile(file, "utf8").catch(() => m.Content || "{}");
  const existing = targetModuleByName.get(m.Name);

  if (!existing) {
    const resp = await dest.send(new CreateContactFlowModuleCommand({
      InstanceId,
      Name: m.Name,
      Description: m.Description || `Migrated module ${m.Name}`,
      Content: content,
      Tags: m.Tags || {}
    }));
    result.createdModules.push({ name: m.Name, id: resp.Id, arn: resp.Arn });
  } else {
    await dest.send(new UpdateContactFlowModuleContentCommand({
      InstanceId,
      ContactFlowModuleId: existing.Id,
      Content: content
    }));
    result.updatedModules.push({ name: m.Name, id: existing.Id });
  }
  await sleep(300);
}

await writeJson("inventory/target/flow-deploy-result.json", result);
console.log("Flow/module deployment complete.");
