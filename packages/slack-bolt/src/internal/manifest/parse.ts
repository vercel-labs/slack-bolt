import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Manifest } from "./types";

function isYaml(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".yaml" || ext === ".yml";
}

export function parseManifest(raw: string, filePath: string): Manifest {
  if (isYaml(filePath)) {
    return parseYaml(raw) as Manifest;
  }
  return JSON.parse(raw) as Manifest;
}

export function stringifyManifest(
  manifest: Manifest,
  filePath: string,
): string {
  if (isYaml(filePath)) {
    return stringifyYaml(manifest);
  }
  return JSON.stringify(manifest, null, 2);
}
