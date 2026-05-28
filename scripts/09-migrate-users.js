import {
  ListUsersCommand,
  CreateUserCommand
} from "@aws-sdk/client-connect";
import { loadConfig } from "../lib/config.js";
import { connectClient } from "../lib/aws-clients.js";
import { paginate, sleep } from "../lib/pagination.js";
import { readJson, writeJson } from "../lib/io.js";

const cfg = await loadConfig();
if (!cfg.scope.migrateUsers) {
  console.log("User migration disabled in config.");
  process.exit(0);
}

const src = await readJson("inventory/source/source-inventory.json");
const map = await readJson("inventory/target/resource-map.json");
const dest = connectClient(cfg.destProfile, cfg.destRegion);
const InstanceId = cfg.destInstanceId;

const existingUsers = await paginate(dest, ListUsersCommand, { InstanceId }, "UserSummaryList");
const userByUsername = new Map(existingUsers.map((u) => [u.Username, u]));

const result = { created: [], updated: [], skipped: [], warnings: [] };

for (const u of src.users || []) {
  if (!u.Username) continue;

  const SecurityProfileIds = (u.SecurityProfileIds || []).map((id) => map.maps.securityProfiles.map[id]).filter(Boolean);
  const RoutingProfileId = map.maps.routingProfiles.map[u.RoutingProfileId];

  if (!RoutingProfileId || SecurityProfileIds.length === 0) {
    result.skipped.push({ username: u.Username, reason: "Missing target routing profile or security profile mapping." });
    continue;
  }

  const existing = userByUsername.get(u.Username);

  if (!existing) {
    try {
      const resp = await dest.send(new CreateUserCommand({
        InstanceId,
        Username: u.Username,
        Password: `Temp-${Date.now()}!ChangeMe`,
        IdentityInfo: u.IdentityInfo,
        PhoneConfig: u.PhoneConfig,
        SecurityProfileIds,
        RoutingProfileId,
        Tags: u.Tags || {}
      }));
      result.created.push({ username: u.Username, id: resp.UserId });
    } catch (e) {
      result.skipped.push({ username: u.Username, reason: e.message });
    }
  } else {
    result.skipped.push({
      username: u.Username,
      id: existing.Id,
      reason: "User already exists in destination; skipped by design."
    });
  }
  await sleep(300);
}

await writeJson("inventory/target/user-migration-result.json", result);
console.log("User migration complete.");
