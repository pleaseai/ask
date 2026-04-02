#!/usr/bin/env node

import { Command } from "commander";
import { getSource } from "./sources/index.js";
import type {
  SourceConfig,
  NpmSourceOptions,
  GithubSourceOptions,
  WebSourceOptions,
} from "./sources/index.js";
import {
  loadConfig,
  addDocEntry,
  removeDocEntry,
} from "./config.js";
import { saveDocs, removeDocs, listDocs } from "./storage.js";
import { generateSkill, removeSkill } from "./skill.js";
import { generateAgentsMd } from "./agents.js";

const program = new Command();

program
  .name("ask")
  .description("Agent Skills Kit - Download version-specific library docs for AI coding agents")
  .version("0.1.0");

const docs = program.command("docs").description("Manage library documentation");

// ask docs add <name@version> --source <type> [options]
docs
  .command("add <spec>")
  .description("Download documentation for a library")
  .requiredOption("-s, --source <type>", "Source type: npm, github, web")
  .option("--repo <owner/repo>", "GitHub repository (for github source)")
  .option("--branch <branch>", "Git branch (for github source)")
  .option("--tag <tag>", "Git tag (for github source)")
  .option("--docs-path <path>", "Path to docs within the package/repo")
  .option("--url <urls...>", "Documentation URLs (for web source)")
  .option("--max-depth <n>", "Max crawl depth for web source", "1")
  .option("--path-prefix <prefix>", "URL path prefix filter for web source")
  .action(async (spec: string, opts) => {
    const projectDir = process.cwd();
    const { name, version } = parseSpec(spec);

    console.log(`\nDownloading ${name}@${version} docs (source: ${opts.source})...\n`);

    const sourceConfig = buildSourceConfig(name, version, opts);
    const source = getSource(opts.source);

    try {
      const result = await source.fetch(sourceConfig);
      console.log(`\nFetched ${result.files.length} doc files (resolved version: ${result.resolvedVersion})`);

      // Save docs
      const docsDir = saveDocs(projectDir, name, result.resolvedVersion, result.files);
      console.log(`Docs saved to: ${docsDir}`);

      // Update config
      const configEntry = { ...sourceConfig, version: result.resolvedVersion };
      addDocEntry(projectDir, configEntry);
      console.log("Config updated: .please/config.json");

      // Generate skill
      const skillPath = generateSkill(
        projectDir,
        name,
        result.resolvedVersion,
        result.files.map((f) => f.path)
      );
      console.log(`Skill created: ${skillPath}`);

      // Update AGENTS.md
      const agentsPath = generateAgentsMd(projectDir);
      console.log(`AGENTS.md updated: ${agentsPath}`);

      console.log(`\nDone! ${name}@${result.resolvedVersion} docs are ready for AI agents.`);
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// ask docs sync
docs
  .command("sync")
  .description("Download/update all docs from .please/config.json")
  .action(async () => {
    const projectDir = process.cwd();
    const config = loadConfig(projectDir);

    if (config.docs.length === 0) {
      console.log("No docs configured in .please/config.json");
      return;
    }

    console.log(`Syncing ${config.docs.length} library docs...\n`);

    for (const entry of config.docs) {
      try {
        console.log(`  ${entry.name}@${entry.version} (${entry.source})...`);
        const source = getSource(entry.source);
        const result = await source.fetch(entry);

        saveDocs(projectDir, entry.name, result.resolvedVersion, result.files);
        generateSkill(
          projectDir,
          entry.name,
          result.resolvedVersion,
          result.files.map((f) => f.path)
        );

        console.log(`    -> ${result.files.length} files (v${result.resolvedVersion})`);
      } catch (err) {
        console.error(
          `    -> Error: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    generateAgentsMd(projectDir);
    console.log("\nSync complete. AGENTS.md updated.");
  });

// ask docs list
docs
  .command("list")
  .description("List downloaded documentation")
  .action(() => {
    const projectDir = process.cwd();
    const docs = listDocs(projectDir);

    if (docs.length === 0) {
      console.log("No docs downloaded yet. Use `ask docs add` to get started.");
      return;
    }

    console.log("\nDownloaded documentation:\n");
    for (const { name, version, fileCount } of docs) {
      console.log(`  ${name}@${version}  (${fileCount} files)`);
    }
    console.log();
  });

// ask docs remove <name[@version]>
docs
  .command("remove <spec>")
  .description("Remove downloaded documentation")
  .action((spec: string) => {
    const projectDir = process.cwd();
    const { name, version } = parseSpec(spec);
    // If no explicit version in spec (i.e., "zod" not "zod@3"), remove all versions
    const hasExplicitVersion = spec.lastIndexOf("@") > 0;
    const ver = hasExplicitVersion ? version : undefined;

    removeDocs(projectDir, name, ver);
    removeSkill(projectDir, name);
    removeDocEntry(projectDir, name, ver);
    generateAgentsMd(projectDir);

    console.log(`Removed docs for ${name}${ver ? `@${ver}` : " (all versions)"}`);
  });

function parseSpec(spec: string): { name: string; version: string } {
  // Handle scoped packages: @scope/pkg@version
  const lastAt = spec.lastIndexOf("@");
  if (lastAt > 0) {
    return {
      name: spec.substring(0, lastAt),
      version: spec.substring(lastAt + 1),
    };
  }
  return { name: spec, version: "latest" };
}

function buildSourceConfig(
  name: string,
  version: string,
  opts: Record<string, unknown>
): SourceConfig {
  const base = { name, version };

  switch (opts.source) {
    case "npm":
      return {
        ...base,
        source: "npm",
        docsPath: opts.docsPath as string | undefined,
      } satisfies NpmSourceOptions;

    case "github":
      if (!opts.repo) {
        throw new Error("--repo is required for github source");
      }
      return {
        ...base,
        source: "github",
        repo: opts.repo as string,
        branch: opts.branch as string | undefined,
        tag: opts.tag as string | undefined,
        docsPath: opts.docsPath as string | undefined,
      } satisfies GithubSourceOptions;

    case "web":
      if (!opts.url || (opts.url as string[]).length === 0) {
        throw new Error("--url is required for web source");
      }
      return {
        ...base,
        source: "web",
        urls: opts.url as string[],
        maxDepth: parseInt(opts.maxDepth as string, 10),
        allowedPathPrefix: opts.pathPrefix as string | undefined,
      } satisfies WebSourceOptions;

    default:
      throw new Error(`Unknown source: ${opts.source}`);
  }
}

program.parse();
