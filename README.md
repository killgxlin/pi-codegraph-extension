# pi-codegraph

CodeGraph MCP tools for the original Pi Coding Agent.

This package targets:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
```

It does **not** target the Oh My Pi package import:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
```

## Install

```bash
pi install npm:pi-codegraph-extension
```

Or copy the extension file manually into your Pi extension directory.

## Requirements

Install CodeGraph globally:

```bash
npm install -g @colbymchenry/codegraph
```

Or install it in the project you want to inspect:

```bash
npm install -D @colbymchenry/codegraph
```

Initialize the project index:

```bash
cd /path/to/project
codegraph init -i
codegraph status
```

Then launch Pi from the same shell so it inherits your PATH.

## Optional environment overrides

```bash
export CODEGRAPH_COMMAND=codegraph
export CODEGRAPH_ARGS="serve --mcp"
export CODEGRAPH_TIMEOUT_MS=30000
```

## Tools

- `codegraph_status`
- `codegraph_files`
- `codegraph_search`
- `codegraph_context`
- `codegraph_callers`
- `codegraph_callees`
- `codegraph_impact`
- `codegraph_node`
- `codegraph_explore`

## Notes

For `codegraph_files`, pass a repo-relative `path` filter such as:

```text
src
src/components
app
```

Do not pass the full project root as `path`. Use `projectPath` for the root project directory.
