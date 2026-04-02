import fs from "node:fs";
import path from "node:path";
import type { SourceConfig } from "./sources/index.js";

export interface AskConfig {
  docs: SourceConfig[];
}

const DEFAULT_CONFIG: AskConfig = { docs: [] };

export function getConfigPath(projectDir: string): string {
  return path.join(projectDir, ".please", "config.json");
}

export function loadConfig(projectDir: string): AskConfig {
  const configPath = getConfigPath(projectDir);
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as AskConfig;
}

export function saveConfig(projectDir: string, config: AskConfig): void {
  const configPath = getConfigPath(projectDir);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function addDocEntry(
  projectDir: string,
  entry: SourceConfig
): AskConfig {
  const config = loadConfig(projectDir);
  // Replace existing entry for same name@version
  const idx = config.docs.findIndex(
    (d) => d.name === entry.name && d.version === entry.version
  );
  if (idx >= 0) {
    config.docs[idx] = entry;
  } else {
    config.docs.push(entry);
  }
  saveConfig(projectDir, config);
  return config;
}

export function removeDocEntry(
  projectDir: string,
  name: string,
  version?: string
): AskConfig {
  const config = loadConfig(projectDir);
  config.docs = config.docs.filter(
    (d) => !(d.name === name && (!version || d.version === version))
  );
  saveConfig(projectDir, config);
  return config;
}
