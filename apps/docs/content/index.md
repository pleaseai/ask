---
title: ASK
seo:
  title: Version-accurate library docs for AI coding agents
  description: ASK (Agent Skills Kit) downloads version-specific library documentation and generates AGENTS.md and Claude Code skills so AI agents reference accurate docs instead of training data.
---

::u-page-hero
#headline
  :::u-button{to="https://github.com/pleaseai/ask/releases" target="_blank" variant="outline" size="sm"}
  ASK is on npm →
  :::

#title
Version-accurate library docs for AI coding agents.

#description
ASK downloads version-specific library docs and generates **AGENTS.md** + **Claude Code skills** so your agent reads real code at the version your project actually runs — not last year's training snapshot.

#links
  :::u-button{to="/docs/getting-started/introduction" size="lg"}
  Get Started →
  :::

  :::u-button{to="https://github.com/pleaseai/ask" target="_blank" variant="outline" size="lg"}
  Star on GitHub
  :::
::

::u-page-section
  :::u-page-grid{class="lg:grid-cols-2"}
    ::::u-page-card{class="col-span-1"}
    #title
    Pinned to your [lockfile]{.text-primary}

    #description
    ASK resolves versions from `bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock` — every read reflects the version your project actually installs.
    ::::

    ::::u-page-card{class="col-span-1"}
    #title
    Generates [AGENTS.md]{.text-primary}

    #description
    Each library lands as a Claude Code skill under `.claude/skills/<name>-docs/SKILL.md`, indexed by a single auto-generated `AGENTS.md` block.
    ::::

    ::::u-page-card{class="col-span-2"}
    #title
    Works with [npm, PyPI, Go, Crates, Pub, Hex, NuGet, Maven]{.text-primary}

    #description
    The ASK Registry maps ecosystem specs (`npm:react`, `pypi:fastapi`, `crates:tokio`) to their GitHub source and docs path. Bare `owner/repo` works too.

    #body
    ```bash
    ask install                       # resolve every entry in ask.json
    ask add npm:next                  # add a library and regenerate AGENTS.md
    ask docs zod                      # print candidate doc paths for the version in lockfile
    ask src facebook/react            # print the cached checkout root
    ```
    ::::

    ::::u-page-card{class="col-span-1"}
    #title
    [One-shot reading]{.text-primary} commands

    #description
    `ask docs <spec>` and `ask src <spec>` emit absolute paths to stdout — drop them straight into `$(…)` for `rg`, `cat`, `fd`, or any tool that takes a path.
    ::::

    ::::u-page-card{class="col-span-1"}
    #title
    Cached at [`~/.ask/`]{.text-primary}

    #description
    Every fetched library is stored once under `~/.ask/`. Multiple projects share the same cache; `ask cache ls` and `ask cache clean` manage disk pressure.
    ::::
  :::
::
