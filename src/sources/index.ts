export interface DocFile {
  path: string;
  content: string;
}

export interface FetchResult {
  files: DocFile[];
  resolvedVersion: string;
}

export interface DocSourceOptions {
  name: string;
  version: string;
}

export interface NpmSourceOptions extends DocSourceOptions {
  source: "npm";
  package?: string;
  docsPath?: string;
}

export interface GithubSourceOptions extends DocSourceOptions {
  source: "github";
  repo: string;
  branch?: string;
  tag?: string;
  docsPath?: string;
}

export interface WebSourceOptions extends DocSourceOptions {
  source: "web";
  urls: string[];
  maxDepth?: number;
  allowedPathPrefix?: string;
}

export type SourceConfig =
  | NpmSourceOptions
  | GithubSourceOptions
  | WebSourceOptions;

export interface DocSource {
  fetch(options: SourceConfig): Promise<FetchResult>;
}

import { NpmSource } from "./npm.js";
import { GithubSource } from "./github.js";
import { WebSource } from "./web.js";

const sources: Record<string, DocSource> = {
  npm: new NpmSource(),
  github: new GithubSource(),
  web: new WebSource(),
};

export function getSource(type: string): DocSource {
  const source = sources[type];
  if (!source) {
    throw new Error(
      `Unknown source type: ${type}. Available: ${Object.keys(sources).join(", ")}`
    );
  }
  return source;
}
