import type { SourceConfig } from './sources/index.js'
import type { Config } from './schemas.js'
import {
  getConfigPath,
  readConfig,
  writeConfig,
} from './io.js'

export type AskConfig = Config

export { getConfigPath }

export function loadConfig(projectDir: string): AskConfig {
  return readConfig(projectDir)
}

export function saveConfig(projectDir: string, config: AskConfig): void {
  writeConfig(projectDir, config)
}

export function addDocEntry(
  projectDir: string,
  entry: SourceConfig,
): AskConfig {
  const config = loadConfig(projectDir)
  // Replace existing entry for same name (regardless of version — versions
  // change over time and we keep one entry per library)
  const idx = config.docs.findIndex(d => d.name === entry.name)
  if (idx >= 0) {
    config.docs[idx] = entry
  }
  else {
    config.docs.push(entry)
  }
  saveConfig(projectDir, config)
  return config
}

export function removeDocEntry(
  projectDir: string,
  name: string,
  version?: string,
): AskConfig {
  const config = loadConfig(projectDir)
  config.docs = config.docs.filter(
    d => !(d.name === name && (!version || d.version === version)),
  )
  saveConfig(projectDir, config)
  return config
}
