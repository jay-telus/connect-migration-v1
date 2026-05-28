import fs from "fs-extra";

export async function loadConfig() {
  const cfg = await fs.readJson("config/migration-config.json");
  cfg.sourceRegion = cfg.sourceRegion || cfg.region;
  cfg.destRegion = cfg.destRegion || cfg.region;
  if (!cfg.sourceRegion || !cfg.destRegion || !cfg.sourceProfile || !cfg.destProfile || !cfg.sourceInstanceArn || !cfg.destInstanceArn) {
    throw new Error("config/migration-config.json is missing required values. Required: sourceRegion, destRegion, sourceProfile, destProfile, sourceInstanceArn, destInstanceArn.");
  }
  if (cfg.sourceInstanceArn.includes("<") || cfg.destInstanceArn.includes("<")) {
    throw new Error("Replace placeholder sourceInstanceArn and destInstanceArn in config/migration-config.json.");
  }
  cfg.sourceInstanceId = instanceIdFromArn(cfg.sourceInstanceArn);
  cfg.destInstanceId = instanceIdFromArn(cfg.destInstanceArn);
  cfg.sourceAccountId = accountIdFromArn(cfg.sourceInstanceArn);
  cfg.destAccountId = accountIdFromArn(cfg.destInstanceArn);
  const sourceArnRegion = regionFromArn(cfg.sourceInstanceArn);
  const destArnRegion = regionFromArn(cfg.destInstanceArn);
  if (sourceArnRegion !== cfg.sourceRegion) {
    throw new Error(`sourceRegion ${cfg.sourceRegion} does not match sourceInstanceArn region ${sourceArnRegion}.`);
  }
  if (destArnRegion !== cfg.destRegion) {
    throw new Error(`destRegion ${cfg.destRegion} does not match destInstanceArn region ${destArnRegion}.`);
  }
  return cfg;
}

export function instanceIdFromArn(arn) {
  const marker = ":instance/";
  const idx = arn.indexOf(marker);
  if (idx < 0) throw new Error(`Invalid Connect instance ARN: ${arn}`);
  return arn.slice(idx + marker.length).split("/")[0];
}

export function accountIdFromArn(arn) {
  return arn.split(":")[4];
}

export function regionFromArn(arn) {
  return arn.split(":")[3];
}
