import fs from "fs-extra";
import path from "path";

export async function writeJson(file, data) {
  await fs.ensureDir(path.dirname(file));
  await fs.writeJson(file, data, { spaces: 2 });
  console.log(`Wrote ${file}`);
}

export async function readJson(file, fallback = null) {
  if (!(await fs.pathExists(file))) {
    if (fallback !== null) return fallback;
    throw new Error(`Missing required file: ${file}`);
  }
  return fs.readJson(file);
}

export async function writeText(file, data) {
  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, data);
  console.log(`Wrote ${file}`);
}
