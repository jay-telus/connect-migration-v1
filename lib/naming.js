export function sameNameMap(sourceItems, targetItems, sourceNameKey = "Name", targetNameKey = "Name", sourceIdKey = "Id", targetIdKey = "Id") {
  const targetByName = new Map((targetItems || []).map((x) => [x[targetNameKey], x]));
  const out = {};
  const missing = [];

  for (const s of sourceItems || []) {
    const t = targetByName.get(s[sourceNameKey]);
    if (t) out[s[sourceIdKey]] = t[targetIdKey];
    else missing.push({ name: s[sourceNameKey], sourceId: s[sourceIdKey] });
  }

  return { map: out, missing };
}

export function arnToId(arn) {
  if (!arn) return "";
  return arn.split("/").pop();
}

export function sanitizeName(name) {
  return String(name || "")
    .replace(/[\\/:*?"<>|#{}$]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
