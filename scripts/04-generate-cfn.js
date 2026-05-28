import { readJson, writeJson } from "../lib/io.js";

const scope = await readJson("inventory/reports/scope-classification.json");

const template = {
  AWSTemplateFormatVersion: "2010-09-09",
  Description: "Placeholder template for optional AWS dependencies discovered by Amazon Connect migration scripts. Review before deployment.",
  Parameters: {},
  Resources: {},
  Outputs: {}
};

const deps = scope.inScope.optionalAwsDependencies || {};
for (const [service, items] of Object.entries(deps)) {
  if (!items || items.length === 0) continue;
  template.Outputs[`${service}Discovered`] = {
    Description: `Discovered ${service} references. This script does not auto-clone runtime code/data. Review manually.`,
    Value: String(items.length)
  };
}

await writeJson("cfn/generated/optional-dependencies-placeholder.json", template);
console.log("Generated placeholder CloudFormation for review. No optional services are auto-created by this v1 script.");
