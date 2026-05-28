import {
  ListDataTablesCommand,
  CreateDataTableCommand,
  DescribeDataTableCommand,
  ListDataTableAttributesCommand,
  CreateDataTableAttributeCommand,
  ListDataTableValuesCommand,
  BatchCreateDataTableValueCommand
} from "@aws-sdk/client-connect";
import { loadConfig } from "../lib/config.js";
import { connectClient } from "../lib/aws-clients.js";
import { paginate, chunk, sleep } from "../lib/pagination.js";
import { readJson, writeJson } from "../lib/io.js";

const cfg = await loadConfig();

if (cfg.scope?.migrateDataTables === false) {
  console.log("Data Table migration disabled in config.");
  process.exit(0);
}

const src = await readJson("inventory/source/source-inventory.json");
const dest = connectClient(cfg.destProfile, cfg.destRegion);
const InstanceId = cfg.destInstanceId;

const result = {
  createdTables: [],
  existingTables: [],
  createdAttributes: [],
  skippedAttributes: [],
  createdValues: [],
  skippedValues: [],
  warnings: []
};

function tableName(dt) {
  return dt.summary?.Name || dt.table?.Name || dt.Name;
}

function cleanTags(tags) {
  const out = {};
  for (const [k, v] of Object.entries(tags || {})) {
    if (!k || k.toLowerCase().startsWith("aws:")) continue;
    out[k] = String(v);
  }
  return out;
}

function cleanDescription(value, fallback = "") {
  const text = String(value || fallback || "").trim();
  return text.length > 250 ? text.slice(0, 250) : text;
}

function normalizeAttribute(attr) {
  const name = attr.Name || attr.AttributeName;
  if (!name) return null;
  if (String(name).toLowerCase().startsWith("connect:") || String(name).toLowerCase().startsWith("aws:")) return null;

  const input = {
    Name: name,
    ValueType: attr.ValueType || attr.Type || "TEXT",
    Primary: Boolean(attr.Primary),
    Description: cleanDescription(attr.Description)
  };

  if (attr.Validation && Object.keys(attr.Validation).length > 0) {
    input.Validation = attr.Validation;
  }

  return input;
}

function normalizeValue(value) {
  const AttributeName = value.AttributeName || value.Name;
  if (!AttributeName || value.Value === undefined || value.Value === null) return null;

  const out = {
    AttributeName,
    Value: String(value.Value)
  };

  const primaryValues = value.PrimaryValues || [];
  if (Array.isArray(primaryValues) && primaryValues.length > 0) {
    out.PrimaryValues = primaryValues
      .map((p) => ({
        AttributeName: p.AttributeName || p.Name,
        Value: String(p.Value ?? "")
      }))
      .filter((p) => p.AttributeName && p.Value !== undefined);
  }

  return out;
}

async function listTargetAttributes(dataTableId) {
  const attrs = [];
  let token;
  do {
    const page = await dest.send(new ListDataTableAttributesCommand({
      InstanceId,
      DataTableId: dataTableId,
      MaxResults: 1000,
      NextToken: token
    }));
    attrs.push(...(page.Attributes || page.DataTableAttributes || []));
    token = page.NextToken;
  } while (token);
  return attrs;
}

async function listTargetValues(dataTableId) {
  const values = [];
  let token;
  do {
    const page = await dest.send(new ListDataTableValuesCommand({
      InstanceId,
      DataTableId: dataTableId,
      MaxResults: 1000,
      NextToken: token
    }));
    values.push(...(page.Values || page.DataTableValues || []));
    token = page.NextToken;
  } while (token);
  return values;
}

async function describeTargetTable(dataTableId) {
  const resp = await dest.send(new DescribeDataTableCommand({
    InstanceId,
    DataTableId: dataTableId
  }));
  return resp.DataTable || resp;
}

function getDataTableLockVersion(table) {
  return table?.LockVersion?.DataTable
    || table?.DataTable?.LockVersion?.DataTable
    || table?.Version
    || table?.DataTableVersion
    || null;
}

function getValueLockLevel(table, sourceTable) {
  return table?.ValueLockLevel
    || table?.DataTable?.ValueLockLevel
    || sourceTable?.ValueLockLevel
    || "NONE";
}

function withLockVersion(value, valueLockLevel, dataTableLockVersion) {
  const item = { ...value };

  if (valueLockLevel === "DATA_TABLE" && dataTableLockVersion) {
    item.LockVersion = {
      DataTable: dataTableLockVersion
    };
  }

  return item;
}

function valueKey(v) {
  const pv = (v.PrimaryValues || [])
    .map((p) => `${p.AttributeName || p.Name}=${p.Value}`)
    .sort()
    .join("|");
  return `${v.AttributeName || v.Name}|${pv}|${v.Value}`;
}

async function batchCreateValuesWithLock(name, targetTableId, values, sourceTable) {
  if (values.length === 0) return;

  const latestTable = await describeTargetTable(targetTableId).catch((e) => {
    result.warnings.push(`DescribeDataTable ${name} before value insert failed: ${e.message}`);
    return null;
  });

  const valueLockLevel = getValueLockLevel(latestTable, sourceTable);
  const dataTableLockVersion = getDataTableLockVersion(latestTable);
  const batchValues = values.map((v) => withLockVersion(v, valueLockLevel, dataTableLockVersion));

  try {
    const resp = await dest.send(new BatchCreateDataTableValueCommand({
      InstanceId,
      DataTableId: targetTableId,
      Values: batchValues
    }));

    result.createdValues.push({
      table: name,
      attempted: batchValues.length,
      successful: resp.Successful?.length ?? null,
      failed: resp.Failed?.length ?? 0
    });

    if (resp.Failed?.length) {
      result.warnings.push(`BatchCreateDataTableValue ${name} had ${resp.Failed.length} failed item(s): ${JSON.stringify(resp.Failed)}`);
    }

    return;
  } catch (e) {
    result.warnings.push(`BatchCreateDataTableValue ${name} failed for batch of ${batchValues.length}: ${e.message}`);
  }

  if (valueLockLevel !== "DATA_TABLE") return;

  for (const single of values) {
    const currentTable = await describeTargetTable(targetTableId).catch((e) => {
      result.warnings.push(`DescribeDataTable ${name} before single value insert failed: ${e.message}`);
      return null;
    });

    const currentLockVersion = getDataTableLockVersion(currentTable);
    const item = withLockVersion(single, valueLockLevel, currentLockVersion);

    try {
      const resp = await dest.send(new BatchCreateDataTableValueCommand({
        InstanceId,
        DataTableId: targetTableId,
        Values: [item]
      }));

      result.createdValues.push({
        table: name,
        attempted: 1,
        successful: resp.Successful?.length ?? null,
        failed: resp.Failed?.length ?? 0
      });

      if (resp.Failed?.length) {
        result.warnings.push(`BatchCreateDataTableValue ${name} single value failed: ${JSON.stringify(resp.Failed)}`);
      }
    } catch (e) {
      result.warnings.push(`BatchCreateDataTableValue ${name} single value failed: ${e.message}`);
    }

    await sleep(150);
  }
}

const sourceTables = src.dataTables || [];
const destTables = await paginate(dest, ListDataTablesCommand, { InstanceId, MaxResults: 1000 }, "DataTableSummaryList").catch((e) => {
  result.warnings.push(`ListDataTables failed in destination: ${e.message}`);
  return [];
});

let destTableByName = new Map(destTables.map((x) => [x.Name, x]));

for (const dt of sourceTables) {
  const name = tableName(dt);
  if (!name) {
    result.warnings.push("Skipped a source data table because it had no name.");
    continue;
  }

  let target = destTableByName.get(name);
  const sourceTable = dt.table || {};

  if (!target) {
    const input = {
      InstanceId,
      Name: name,
      Description: cleanDescription(sourceTable.Description || dt.summary?.Description, `Migrated data table ${name}`),
      Status: "PUBLISHED",
      TimeZone: sourceTable.TimeZone || "UTC",
      ValueLockLevel: sourceTable.ValueLockLevel || "NONE",
      Tags: cleanTags(sourceTable.Tags || dt.summary?.Tags || {})
    };

    try {
      const resp = await dest.send(new CreateDataTableCommand(input));
      target = { Name: name, Id: resp.Id, Arn: resp.Arn };
      destTableByName.set(name, target);
      result.createdTables.push({ name, id: resp.Id, arn: resp.Arn });
      await sleep(500);
    } catch (e) {
      result.warnings.push(`CreateDataTable ${name} failed: ${e.message}`);
      continue;
    }
  } else {
    result.existingTables.push({ name, id: target.Id, arn: target.Arn });
  }

  const targetTableId = target.Id || target.DataTableId;
  if (!targetTableId) {
    result.warnings.push(`Could not determine target DataTableId for ${name}.`);
    continue;
  }

  const targetAttrs = await listTargetAttributes(targetTableId).catch((e) => {
    result.warnings.push(`ListDataTableAttributes ${name} failed: ${e.message}`);
    return [];
  });
  const targetAttrNames = new Set(targetAttrs.map((x) => x.Name || x.AttributeName));

  const sourceAttrs = (dt.attributes || [])
    .map(normalizeAttribute)
    .filter(Boolean)
    .sort((a, b) => Number(b.Primary) - Number(a.Primary));

  for (const attr of sourceAttrs) {
    if (targetAttrNames.has(attr.Name)) {
      result.skippedAttributes.push({ table: name, attribute: attr.Name, reason: "Already exists" });
      continue;
    }

    try {
      const input = { InstanceId, DataTableId: targetTableId, ...attr };
      const resp = await dest.send(new CreateDataTableAttributeCommand(input));
      result.createdAttributes.push({ table: name, attribute: attr.Name, attributeId: resp.AttributeId || null });
      targetAttrNames.add(attr.Name);
      await sleep(250);
    } catch (e) {
      result.warnings.push(`CreateDataTableAttribute ${name}.${attr.Name} failed: ${e.message}`);
    }
  }

  const targetValues = await listTargetValues(targetTableId).catch((e) => {
    result.warnings.push(`ListDataTableValues ${name} failed: ${e.message}`);
    return [];
  });
  const existingValueKeys = new Set(targetValues.map((v) => valueKey(normalizeValue(v) || v)));

  const sourceValues = (dt.values || [])
    .map(normalizeValue)
    .filter(Boolean)
    .filter((v) => {
      const key = valueKey(v);
      if (existingValueKeys.has(key)) {
        result.skippedValues.push({ table: name, attribute: v.AttributeName, reason: "Already exists" });
        return false;
      }
      return true;
    });

  for (const batch of chunk(sourceValues, 25)) {
    await batchCreateValuesWithLock(name, targetTableId, batch, sourceTable);
    await sleep(250);
  }
}

await writeJson("inventory/target/data-table-migration-result.json", result);
console.log("Data Table migration complete.");
console.log({
  createdTables: result.createdTables.length,
  existingTables: result.existingTables.length,
  createdAttributes: result.createdAttributes.length,
  createdValueBatches: result.createdValues.length,
  warnings: result.warnings.length
});
