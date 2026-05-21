import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { pathToFileURL } from "node:url";
import * as path from "node:path";

/**
 * CodeGraph Extension for Pi Coding Agent — MCP Edition
 *
 * This version targets the original Pi package:
 *
 *   @earendil-works/pi-coding-agent
 *
 * It intentionally does NOT use the Oh My Pi package:
 *
 *   @oh-my-pi/pi-coding-agent
 *
 * Linux/WSL fixes:
 * - No hardcoded Windows node.exe or pnpm.mjs path.
 * - Runs `codegraph serve --mcp` from PATH.
 * - Adds the project-local `node_modules/.bin` to PATH before spawning.
 * - Supports CODEGRAPH_COMMAND and CODEGRAPH_ARGS overrides.
 * - Normalizes absolute file paths passed to codegraph_files into repo-relative filters.
 *
 * Expected CodeGraph install:
 *
 *   npm install -g @colbymchenry/codegraph
 *
 * Or project-local:
 *
 *   npm install -D @colbymchenry/codegraph
 *   pnpm add -D @colbymchenry/codegraph
 *   bun add -d @colbymchenry/codegraph
 */

const REQUEST_TIMEOUT_MS = Number(process.env.CODEGRAPH_TIMEOUT_MS ?? 30000);

type MCPToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) args.push(current);
  return args;
}

function getCodeGraphSpawn(cwd: string): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const localBin = path.join(cwd, "node_modules", ".bin");
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const existingPath = process.env[pathKey] ?? process.env.PATH ?? "";

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [pathKey]: `${localBin}${path.delimiter}${existingPath}`,
  };

  const command =
    process.env.CODEGRAPH_COMMAND ??
    (process.platform === "win32" ? "codegraph.cmd" : "codegraph");

  const args = process.env.CODEGRAPH_ARGS
    ? splitArgs(process.env.CODEGRAPH_ARGS)
    : ["serve", "--mcp"];

  return { command, args, env };
}

function expandHome(input: string): string {
  if (input === "~") {
    return process.env.HOME ?? input;
  }

  if (input.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", input.slice(2));
  }

  return input;
}

function resolveProjectRoot(cwd: string, maybeProjectPath?: unknown): string {
  if (typeof maybeProjectPath !== "string" || maybeProjectPath.trim() === "") {
    return cwd;
  }

  return path.resolve(cwd, expandHome(maybeProjectPath.trim()));
}

function normalizeFilesPath(value: unknown, projectRoot: string): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  const raw = expandHome(value.trim());
  const resolved = path.resolve(projectRoot, raw);

  // CodeGraph's `path` parameter is a filter under the indexed project.
  // If Pi passes the full project root as `path`, omit the filter.
  if (resolved === projectRoot) {
    return undefined;
  }

  // If Pi passes an absolute path inside the project, convert it to a
  // repo-relative path so CodeGraph can match indexed files.
  const relative = path.relative(projectRoot, resolved);
  if (
    path.isAbsolute(raw) &&
    relative &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  ) {
    return relative.split(path.sep).join("/");
  }

  // Otherwise assume the user already supplied a repo-relative path.
  return raw.replaceAll("\\", "/").replace(/^\.?\//, "");
}

class MCPClient {
  private proc: ReturnType<typeof spawn>;
  private rl: readline.Interface;
  private pending = new Map<string, (msg: any) => void>();
  private timers = new Map<string, NodeJS.Timeout>();
  private idCounter = 0;
  private closed = false;

  constructor(cwd: string) {
    const { command, args, env } = getCodeGraphSpawn(cwd);

    this.proc = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    const stdout = this.proc.stdout;
    if (!stdout) throw new Error("No stdout from MCP process");

    this.rl = readline.createInterface({
      input: stdout,
      terminal: false,
    });

    this.rl.on("line", (line) => this.onLine(line));

    const stderr = this.proc.stderr;
    if (stderr) {
      stderr.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) console.error("[CodeGraph MCP]", text);
      });
    }

    const stdin = this.proc.stdin;
    if (!stdin) throw new Error("No stdin from MCP process");

    this.proc.on("error", (err) => {
      this.closed = true;
      for (const [id, handler] of this.pending) {
        clearTimeout(this.timers.get(id)!);
        handler({ error: { message: `Failed to start CodeGraph MCP server: ${err.message}` } });
      }
      this.pending.clear();
      this.timers.clear();
    });

    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      for (const [id, handler] of this.pending) {
        clearTimeout(this.timers.get(id)!);
        handler({ error: { message: `MCP server exited with ${reason}` } });
      }
      this.pending.clear();
      this.timers.clear();
    });
  }

  private onLine(line: string): void {
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && this.pending.has(String(msg.id))) {
        const id = String(msg.id);
        clearTimeout(this.timers.get(id)!);
        this.timers.delete(id);
        const handler = this.pending.get(id)!;
        this.pending.delete(id);
        handler(msg);
      }
    } catch {
      // Ignore non-JSON log lines from the MCP process.
    }
  }

  async initialize(rootUri: string, signal?: AbortSignal): Promise<any> {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "pi-codegraph-extension",
          version: "1.0.0",
        },
        rootUri,
      },
      signal
    );

    this.notify("notifications/initialized", {});
    return result;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    return this.request("tools/call", { name, arguments: args }, signal);
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("MCP server connection is closed"));
        return;
      }

      const id = ++this.idCounter;
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });

      const cleanup = () => {
        this.pending.delete(String(id));
        this.timers.delete(String(id));
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`MCP request timeout (${REQUEST_TIMEOUT_MS}ms): ${method}`));
      }, REQUEST_TIMEOUT_MS);

      const onAbort = () => {
        cleanup();
        this.close();
        reject(new Error("MCP request cancelled by user"));
      };

      signal?.addEventListener("abort", onAbort);
      this.timers.set(String(id), timer);

      const stdin = this.proc.stdin;
      if (!stdin) {
        cleanup();
        reject(new Error("No stdin from MCP process"));
        return;
      }

      this.pending.set(String(id), (msg: any) => {
        cleanup();
        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      });

      stdin.write(msg + "\n");
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) return;
    const stdin = this.proc.stdin;
    if (!stdin) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    stdin.write(msg + "\n");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const [id, handler] of this.pending) {
      clearTimeout(this.timers.get(id)!);
      handler({ error: { message: "MCP client closed" } });
    }

    this.pending.clear();
    this.timers.clear();
    this.rl.close();

    const stdin = this.proc.stdin;
    if (stdin && !stdin.destroyed) {
      stdin.end();
    }

    if (!this.proc.killed) {
      this.proc.kill();
    }
  }
}

async function runMCPTool(
  cwd: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<MCPToolResult> {
  const projectRoot = resolveProjectRoot(cwd, args.projectPath);
  const client = new MCPClient(projectRoot);

  try {
    const rootUri = pathToFileURL(projectRoot).href;
    await client.initialize(rootUri, signal);

    const finalArgs = {
      ...args,
      projectPath: projectRoot,
    };

    const result = await client.callTool(toolName, finalArgs, signal);
    return result as MCPToolResult;
  } finally {
    client.close();
  }
}

function handleError(err: unknown, toolName: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  details: { error: string; tool: string };
} {
  let message = err instanceof Error ? err.message : String(err);

  if (
    message.includes("ENOENT") ||
    message.includes("spawn") ||
    message.includes("Failed to start CodeGraph")
  ) {
    message =
      "CodeGraph CLI not found or could not be started.\n\n" +
      "Install globally:\n" +
      "  npm install -g @colbymchenry/codegraph\n\n" +
      "Or install in the project:\n" +
      "  npm install -D @colbymchenry/codegraph\n" +
      "  pnpm add -D @colbymchenry/codegraph\n" +
      "  bun add -d @colbymchenry/codegraph\n\n" +
      "Then verify from the same shell that launches Pi:\n" +
      "  codegraph --version\n" +
      "  codegraph serve --mcp\n\n" +
      "Optional override:\n" +
      "  CODEGRAPH_COMMAND=codegraph\n" +
      "  CODEGRAPH_ARGS=\"serve --mcp\"";
  } else if (message.includes("not initialized") || message.includes(".codegraph")) {
    message =
      `${message}\n\nInitialize and index the project first:\n` +
      "  codegraph init -i\n" +
      "  codegraph status";
  }

  return {
    content: [{ type: "text" as const, text: `CodeGraph ${toolName} failed: ${message}` }],
    isError: true,
    details: { error: message, tool: toolName },
  };
}

const projectPathProperty = Type.Optional(
  Type.String({
    description:
      "Path to a different project with .codegraph/ initialized. If omitted, uses current project.",
  })
);

export default function codegraphExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "codegraph_search",
    label: "CodeGraph Search",
    description: "Search for symbols across the codebase using CodeGraph's semantic index",
    promptSnippet: "Search codebase symbols via CodeGraph",
    promptGuidelines: [
      "Use codegraph_search when you need to find symbols by name across the codebase",
      "Use for: finding function definitions, class implementations, types, routes",
      "Prefer codegraph_context for exploration tasks — it composes multiple searches in one call",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or partial name, e.g. auth or UserService" }),
      kind: Type.Optional(
        Type.Union(
          [
            Type.Literal("function"),
            Type.Literal("method"),
            Type.Literal("class"),
            Type.Literal("interface"),
            Type.Literal("type"),
            Type.Literal("variable"),
            Type.Literal("route"),
            Type.Literal("component"),
          ],
          { description: "Filter by node kind" }
        )
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum results. Default: 20", default: 20 })),
      projectPath: projectPathProperty,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await runMCPTool(
          ctx.cwd,
          "codegraph_search",
          {
            query: params.query,
            kind: params.kind,
            limit: params.limit ?? 20,
            projectPath: params.projectPath,
          },
          signal
        );

        return {
          content: result.content,
          isError: result.isError,
          details: { tool: "search", query: params.query },
        };
      } catch (err) {
        return handleError(err, "search");
      }
    },
  });

  pi.registerTool({
    name: "codegraph_context",
    label: "CodeGraph Context",
    description:
      "Build comprehensive code context for a task. PRIMARY tool — composes search, node, callers, and callees in one call.",
    promptSnippet: "Build code context via CodeGraph",
    promptGuidelines: [
      "Use codegraph_context as the PRIMARY tool for understanding code areas",
      "Returns large context — often enough without additional tool calls",
      "Use for: onboarding, feature exploration, bug investigation",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Task description, bug, or feature to build context for" }),
      maxNodes: Type.Optional(Type.Number({ description: "Maximum symbols to include. Default: 20", default: 20 })),
      includeCode: Type.Optional(Type.Boolean({ description: "Include code snippets. Default: true", default: true })),
      projectPath: projectPathProperty,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await runMCPTool(
          ctx.cwd,
          "codegraph_context",
          {
            task: params.task,
            maxNodes: params.maxNodes ?? 20,
            includeCode: params.includeCode ?? true,
            projectPath: params.projectPath,
          },
          signal
        );

        return {
          content: result.content,
          isError: result.isError,
          details: { tool: "context", task: params.task },
        };
      } catch (err) {
        return handleError(err, "context");
      }
    },
  });

  pi.registerTool({
    name: "codegraph_callers",
    label: "CodeGraph Callers",
    description: "Find all functions/methods that call a specific symbol",
    promptSnippet: "Find callers of a symbol",
    promptGuidelines: [
      "Use codegraph_callers before modifying a function to see call sites",
      "Use for: understanding usage patterns, impact analysis",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "Function, method, or class name to find callers for" }),
      limit: Type.Optional(Type.Number({ description: "Maximum callers. Default: 20", default: 20 })),
      projectPath: projectPathProperty,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await runMCPTool(
          ctx.cwd,
          "codegraph_callers",
          {
            symbol: params.symbol,
            limit: params.limit ?? 20,
            projectPath: params.projectPath,
          },
          signal
        );

        return {
          content: result.content,
          isError: result.isError,
          details: { tool: "callers", symbol: params.symbol },
        };
      } catch (err) {
        return handleError(err, "callers");
      }
    },
  });

  pi.registerTool({
    name: "codegraph_callees",
    label: "CodeGraph Callees",
    description: "Find all functions/methods that a specific symbol calls",
    promptSnippet: "Find callees of a symbol",
    promptGuidelines: [
      "Use codegraph_callees to understand dependencies and code flow",
      "Use for: tracing execution paths, understanding what a function depends on",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "Function, method, or class name to find callees for" }),
      limit: Type.Optional(Type.Number({ description: "Maximum callees. Default: 20", default: 20 })),
      projectPath: projectPathProperty,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await runMCPTool(
          ctx.cwd,
          "codegraph_callees",
          {
            symbol: params.symbol,
            limit: params.limit ?? 20,
            projectPath: params.projectPath,
          },
          signal
        );

        return {
          content: result.content,
          isError: result.isError,
          details: { tool: "callees", symbol: params.symbol },
        };
      } catch (err) {
        return handleError(err, "callees");
      }
    },
  });

  pi.registerTool({
    name: "codegraph_impact",
    label: "CodeGraph Impact",
    description: "Analyze the impact radius of changing a symbol",
    promptSnippet: "Analyze impact of changes",
    promptGuidelines: [
      "Use codegraph_impact before making changes to see affected code",
      "Use for: refactor planning, assessing blast radius of modifications",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol to analyze impact for" }),
      depth: Type.Optional(Type.Number({ description: "Dependency traversal depth. Default: 2", default: 2 })),
      projectPath: projectPathProperty,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await runMCPTool(
          ctx.cwd,
          "codegraph_impact",
          {
            symbol: params.symbol,
            depth: params.depth ?? 2,
            projectPath: params.projectPath,
          },
          signal
        );

        return {
          content: result.content,
          isError: result.isError,
          details: { tool: "impact", symbol: params.symbol },
        };
      } catch (err) {
        return handleError(err, "impact");
      }
    },
  });

  pi.registerTool({
    name: "codegraph_node",
    label: "CodeGraph Node",
    description: "Get detailed information about a specific code symbol",
    promptSnippet: "Get symbol details via CodeGraph",
    promptGuidelines: [
      "Use codegraph_node when you need full source code of a symbol",
      "Set includeCode=true only when needed — it increases token usage",
      "Use codegraph_search first to find the exact symbol name",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name to get details for" }),
      includeCode: Type.Optional(Type.Boolean({ description: "Include full source code. Default: false", default: false })),
      projectPath: projectPathProperty,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await runMCPTool(
          ctx.cwd,
          "codegraph_node",
          {
            symbol: params.symbol,
            includeCode: params.includeCode ?? false,
            projectPath: params.projectPath,
          },
          signal
        );

        return {
          content: result.content,
          isError: result.isError,
          details: { tool: "node", symbol: params.symbol },
        };
      } catch (err) {
        return handleError(err, "node");
      }
    },
  });

  pi.registerTool({
    name: "codegraph_explore",
    label: "CodeGraph Explore",
    description:
      "Deep exploration tool — returns comprehensive context for a topic in a single call. Groups source code by file with relationship maps.",
    promptSnippet: "Deep exploration via CodeGraph",
    promptGuidelines: [
      "Use codegraph_explore for thorough understanding of unfamiliar topics",
      "Use specific symbol names, file names, or short code terms — NOT natural language sentences",
      "Use codegraph_search first to discover relevant symbol names",
      "Respect the explore budget — do not make more calls than recommended",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Symbol names, file names, or short code terms to explore. Bad: how are prompts loaded. Good: readAgentsFromDirectory createClaudeSession",
      }),
      maxFiles: Type.Optional(Type.Number({ description: "Maximum files to include source from. Default: 12", default: 12 })),
      projectPath: projectPathProperty,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await runMCPTool(
          ctx.cwd,
          "codegraph_explore",
          {
            query: params.query,
            maxFiles: params.maxFiles ?? 12,
            projectPath: params.projectPath,
          },
          signal
        );

        return {
          content: result.content,
          isError: result.isError,
          details: { tool: "explore", query: params.query },
        };
      } catch (err) {
        return handleError(err, "explore");
      }
    },
  });

  pi.registerTool({
    name: "codegraph_status",
    label: "CodeGraph Status",
    description: "Get the status of the CodeGraph index — files, nodes, edges, backend type",
    promptSnippet: "Check CodeGraph index status",
    promptGuidelines: [
      "Use codegraph_status to verify the index is ready before other operations",
      "Check backend type — wasm fallback is slower than native",
    ],
    parameters: Type.Object({
      projectPath: projectPathProperty,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await runMCPTool(
          ctx.cwd,
          "codegraph_status",
          {
            projectPath: params.projectPath,
          },
          signal
        );

        return {
          content: result.content,
          isError: result.isError,
          details: { tool: "status" },
        };
      } catch (err) {
        return handleError(err, "status");
      }
    },
  });

  pi.registerTool({
    name: "codegraph_files",
    label: "CodeGraph Files",
    description:
      "Get project file structure from the CodeGraph index. Faster than filesystem scanning. Use first when exploring project structure.",
    promptSnippet: "List project files via CodeGraph",
    promptGuidelines: [
      "Use codegraph_files first when exploring project structure or finding files",
      "Much faster than Glob/filesystem scanning",
      "Use tree format for overview, grouped for language breakdown",
      "For path, pass a repo-relative directory like src/components; do not pass the full project root",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "Repo-relative filter under the project, e.g. src/components. Absolute paths are normalized when possible.",
        })
      ),
      pattern: Type.Optional(Type.String({ description: "Glob pattern filter, e.g. *.tsx or **/*.test.ts" })),
      format: Type.Optional(
        Type.Union([Type.Literal("tree"), Type.Literal("flat"), Type.Literal("grouped")], {
          description: "Output format. Default: tree",
        })
      ),
      includeMetadata: Type.Optional(Type.Boolean({ description: "Include language and symbol count. Default: true", default: true })),
      maxDepth: Type.Optional(Type.Number({ description: "Maximum directory depth" })),
      projectPath: projectPathProperty,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const projectRoot = resolveProjectRoot(ctx.cwd, params.projectPath);
        const normalizedPath = normalizeFilesPath(params.path, projectRoot);

        const args: Record<string, unknown> = {
          projectPath: projectRoot,
        };

        if (normalizedPath != null) args.path = normalizedPath;
        if (params.pattern != null) args.pattern = params.pattern;
        if (params.format != null) args.format = params.format;
        if (params.includeMetadata != null) args.includeMetadata = params.includeMetadata;
        if (params.maxDepth != null) args.maxDepth = params.maxDepth;

        const result = await runMCPTool(ctx.cwd, "codegraph_files", args, signal);

        return {
          content: result.content,
          isError: result.isError,
          details: { tool: "files", args },
        };
      } catch (err) {
        return handleError(err, "files");
      }
    },
  });

  pi.registerCommand("codegraph-status", {
    description: "Check CodeGraph MCP server connectivity",
    handler: async (_args, ctx) => {
      try {
        const result = await runMCPTool(ctx.cwd, "codegraph_status", {});
        const text = result.content.map((c) => c.text).join("\n");
        ctx.ui.notify(`CodeGraph MCP connected.\n${text}`, "info");
      } catch (err) {
        const handled = handleError(err, "status");
        ctx.ui.notify(handled.content[0]?.text ?? "CodeGraph MCP connection failed", "error");
      }
    },
  });
}
