import { readJson, writeJson } from "../lib/io.js";

const deps = await readJson("inventory/reports/flow-dependencies.json");

const result = {
  generatedAt: new Date().toISOString(),
  mode: "safe-skip",
  message: "Optional AWS services are discovered and reported only in v1. Do not auto-clone Lambda code, DynamoDB data, S3 content, Lex bots, Kinesis, EventBridge, or CloudWatch until approved.",
  discovered: deps.optionalServices || {},
  skipped: {}
};

for (const [service, items] of Object.entries(result.discovered)) {
  result.skipped[service] = items?.length
    ? `Discovered ${items.length} reference(s). Review and migrate manually or implement service-specific migration.`
    : "Not discovered.";
}

await writeJson("inventory/target/optional-services-result.json", result);
console.log("Optional AWS dependency step complete.");
