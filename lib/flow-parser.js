export function extractReferencedArnsAndIds(flowContentString) {
  const text = flowContentString || "";
  const arnRegex = /arn:aws[a-zA-Z-]*:[^"\\\s]+/g;
  const arns = [...new Set(text.match(arnRegex) || [])];

  const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const uuids = [...new Set(text.match(uuidRegex) || [])];

  const lambdaArns = arns.filter((x) => x.includes(":lambda:"));
  const lexArns = arns.filter((x) => x.includes(":lex:") || x.includes(":lexv2:"));
  const queueArns = arns.filter((x) => x.includes(":queue/"));
  const flowArns = arns.filter((x) => x.includes(":contact-flow/"));
  const moduleArns = arns.filter((x) => x.includes(":contact-flow-module/"));
  const promptArns = arns.filter((x) => x.includes(":prompt/"));
  const dataTableArns = arns.filter((x) => x.includes(":data-table/"));

  return { arns, uuids, lambdaArns, lexArns, queueArns, flowArns, moduleArns, promptArns, dataTableArns };
}

export function replaceAllResourceReferences(content, replacements) {
  let patched = content;

  const ordered = Object.entries(replacements || {})
    .filter(([from, to]) => from && to && from !== to)
    .sort((a, b) => b[0].length - a[0].length);

  for (const [from, to] of ordered) {
    patched = patched.split(from).join(to);
  }

  return patched;
}

export function ensureNoSourceReferences(content, cfg, label) {
  const failures = [];
  if (
    cfg.safety?.failIfSourceAccountIdRemainsInFlow &&
    cfg.sourceAccountId !== cfg.destAccountId &&
    content.includes(cfg.sourceAccountId)
  ) {
    failures.push(`source account ID ${cfg.sourceAccountId}`);
  }
  if (content.includes(cfg.sourceInstanceArn)) {
    failures.push(`source instance ARN ${cfg.sourceInstanceArn}`);
  }
  if (failures.length) {
    throw new Error(`${label} still contains ${failures.join(", ")} after patching.`);
  }
}
