import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { loadConfig } from "../lib/config.js";
import { stsClient } from "../lib/aws-clients.js";

async function who(profile, region) {
  const sts = stsClient(profile, region);
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  return identity;
}

const cfg = await loadConfig();

for (const profile of ["base", cfg.sourceProfile, cfg.destProfile]) {
  const region = profile === cfg.destProfile ? cfg.destRegion : cfg.sourceRegion;
  const identity = await who(profile, region);
  console.log(`${profile}: ${identity.Arn} (${identity.Account})`);
}

console.log("AWS CLI/SDK profiles validated successfully.");
