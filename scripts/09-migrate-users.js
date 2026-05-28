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


function cleanTags(tags) {
  const out = {};
  for (const [k, v] of Object.entries(tags || {})) {
    if (!k || k.toLowerCase().startsWith("aws:")) continue;
    out[k] = String(v);
  }
  return out;
}

function userConfigArrays(u) {
  return {
    AutoAcceptConfigs: Array.isArray(u.AutoAcceptConfigs) ? u.AutoAcceptConfigs : undefined,
    AfterContactWorkConfigs: Array.isArray(u.AfterContactWorkConfigs) ? u.AfterContactWorkConfigs : undefined,
    PhoneNumberConfigs: Array.isArray(u.PhoneNumberConfigs) ? u.PhoneNumberConfigs : undefined,
    PersistentConnectionConfigs: Array.isArray(u.PersistentConnectionConfigs) ? u.PersistentConnectionConfigs : undefined,
    VoiceEnhancementConfigs: Array.isArray(u.VoiceEnhancementConfigs) ? u.VoiceEnhancementConfigs : undefined
  };
}

function hasItems(value) {
  return Array.isArray(value) && value.length > 0;
}

function buildPhoneConfigForCreate(u, advanced) {
  const phone = { ...(u.PhoneConfig || {}) };
  if (!Object.keys(phone).length) return undefined;

  if (hasItems(advanced.AutoAcceptConfigs)) delete phone.AutoAccept;
  if (hasItems(advanced.AfterContactWorkConfigs)) delete phone.AfterContactWorkTimeLimit;
  if (hasItems(advanced.PersistentConnectionConfigs)) delete phone.PersistentConnection;
  if (hasItems(advanced.PhoneNumberConfigs)) {
    delete phone.PhoneType;
    delete phone.DeskPhoneNumber;
    delete phone.PhoneNumber;
  }

  return Object.keys(phone).length ? phone : undefined;
}

function buildCreateUserInput(u, SecurityProfileIds, RoutingProfileId) {
  const advanced = userConfigArrays(u);
  const PhoneConfig = buildPhoneConfigForCreate(u, advanced);

  const input = {
    InstanceId,
    Username: u.Username,
    Password: `Temp-${Date.now()}!ChangeMe`,
    IdentityInfo: u.IdentityInfo,
    SecurityProfileIds,
    RoutingProfileId,
    Tags: cleanTags(u.Tags || {})
  };

  if (PhoneConfig) input.PhoneConfig = PhoneConfig;
  if (hasItems(advanced.AutoAcceptConfigs)) input.AutoAcceptConfigs = advanced.AutoAcceptConfigs;
  if (hasItems(advanced.AfterContactWorkConfigs)) input.AfterContactWorkConfigs = advanced.AfterContactWorkConfigs;
  if (hasItems(advanced.PhoneNumberConfigs)) input.PhoneNumberConfigs = advanced.PhoneNumberConfigs;
  if (hasItems(advanced.PersistentConnectionConfigs)) input.PersistentConnectionConfigs = advanced.PersistentConnectionConfigs;
  if (hasItems(advanced.VoiceEnhancementConfigs)) input.VoiceEnhancementConfigs = advanced.VoiceEnhancementConfigs;

  return input;
}


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
      const createInput = buildCreateUserInput(u, SecurityProfileIds, RoutingProfileId);
      const resp = await dest.send(new CreateUserCommand(createInput));
      result.created.push({
        username: u.Username,
        id: resp.UserId,
        migratedAdvancedUserConfig: Boolean(
          createInput.AutoAcceptConfigs ||
          createInput.AfterContactWorkConfigs ||
          createInput.PhoneNumberConfigs ||
          createInput.PersistentConnectionConfigs ||
          createInput.VoiceEnhancementConfigs
        )
      });
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
