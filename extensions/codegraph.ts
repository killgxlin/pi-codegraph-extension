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
 * - Discovers available tools from the CodeGraph MCP server via `tools/list`.
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
const DIAGNOSTIC_STDERR_LIMIT = 4000;

type MCPToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type MCPToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type MCPToolsListResult = {
  tools?: MCPToolDefinition[];
};

type ToolMetadata = {
  label: string;
  promptSnippet: string;
  promptGuidelines: string[];
  detailsName: string;
};

type ToolRegistration = {
  piName: string;
  mcpName: string;
  definition: MCPToolDefinition;
  metadata: ToolMetadata;
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

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
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

  if (resolved === projectRoot) {
    return undefined;
  }

  const relative = path.relative(projectRoot, resolved);
  if (
    path.isAbsolute(raw) &&
    relative &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  ) {
    return relative.split(path.sep).join("/");
  }

  return raw.replaceAll("\\", "/").replace(/^\.?\//, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeToolName(name: string): string | undefined {
  const sanitized = name.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!sanitized || !/^[A-Za-z_]/.test(sanitized)) return undefined;
  return sanitized;
}

function toTitle(input: string): string {
  return input
    .replace(/^codegraph[_-]?/, "")
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeInputSchema(toolName: string, inputSchema: unknown): Record<string, unknown> {
  if (!isObject(inputSchema)) {
    console.warn(
      `[CodeGraph MCP] Tool ${toolName} did not provide an object inputSchema; using an empty object schema.`
    );
    return Type.Object({}) as unknown as Record<string, unknown>;
  }

  if (inputSchema.type === "object" || isObject(inputSchema.properties)) {
    return inputSchema;
  }

  console.warn(
    `[CodeGraph MCP] Tool ${toolName} provided a non-object inputSchema; using an empty object schema.`
  );
  return Type.Object({}) as unknown as Record<string, unknown>;
}

function normalizeMCPResult(result: unknown): MCPToolResult {
  if (isObject(result) && Array.isArray(result.content)) {
    return result as MCPToolResult;
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

function appendProjectPath(args: Record<string, unknown>, projectRoot: string): Record<string, unknown> {
  return {
    ...args,
    projectPath: projectRoot,
  };
}

function prepareToolArguments(toolName: string, params: Record<string, unknown>, projectRoot: string): Record<string, unknown> {
  if (toolName !== "codegraph_files") {
    return appendProjectPath(params, projectRoot);
  }

  const normalizedPath = normalizeFilesPath(params.path, projectRoot);
  const args: Record<string, unknown> = { ...params, projectPath: projectRoot };

  if (normalizedPath == null) {
    delete args.path;
  } else {
    args.path = normalizedPath;
  }

  return args;
}

function createDiagnosticMessage(err: unknown, cwd: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const { command, args } = getCodeGraphSpawn(cwd);
  const commandLine = formatCommand(command, args);

  let diagnostic =
    `${message}\n\n` +
    `CodeGraph MCP command: ${commandLine}\n` +
    `Working directory: ${cwd}\n\n`;

  if (
    message.includes("ENOENT") ||
    message.includes("spawn") ||
    message.includes("Failed to start CodeGraph")
  ) {
    diagnostic +=
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
    diagnostic +=
      "Initialize and index the project first:\n" +
      "  codegraph init -i\n" +
      "  codegraph status";
  }

  return diagnostic.trim();
}

function handleError(err: unknown, toolName: string, cwd: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  details: { error: string; tool: string };
} {
  const message = createDiagnosticMessage(err, cwd);

  return {
    content: [{ type: "text", text: `CodeGraph ${toolName} failed: ${message}` }],
    isError: true,
    details: { error: message, tool: toolName },
  };
}

class MCPClient {
  private proc: ReturnType<typeof spawn>;
  private rl: readline.Interface;
  private pending = new Map<string, (msg: any) => void>();
  private timers = new Map<string, NodeJS.Timeout>();
  private idCounter = 0;
  private closed = false;
  private stderrBuffer = "";

  readonly commandLine: string;

  constructor(private readonly cwd: string) {
    const { command, args, env } = getCodeGraphSpawn(cwd);
    this.commandLine = formatCommand(command, args);

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
        const text = data.toString();
        this.stderrBuffer = (this.stderrBuffer + text).slice(-DIAGNOSTIC_STDERR_LIMIT);
        const trimmed = text.trim();
        // 过滤掉启动信息，只保留真正的错误
        if (
          trimmed &&
          !trimmed.includes("Attached to shared daemon") &&
          !trimmed.includes("Registered tools:")
        ) {
          console.error("[CodeGraph MCP]", trimmed);
        }
      });
    }

    const stdin = this.proc.stdin;
    if (!stdin) throw new Error("No stdin from MCP process");

    this.proc.on("error", (err) => {
      this.closed = true;
      this.rejectPending(`Failed to start CodeGraph MCP server: ${err.message}`);
    });

    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      this.rejectPending(`MCP server exited with ${reason}`);
    });
  }

  get diagnostics(): string {
    const stderr = this.stderrBuffer.trim();
    return [
      `CodeGraph MCP command: ${this.commandLine}`,
      `Working directory: ${this.cwd}`,
      stderr ? `Recent stderr:\n${stderr}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private rejectPending(message: string): void {
    const details = this.diagnostics;
    const errorMessage = details ? `${message}\n\n${details}` : message;

    for (const [id, handler] of this.pending) {
      clearTimeout(this.timers.get(id)!);
      handler({ error: { message: errorMessage } });
    }

    this.pending.clear();
    this.timers.clear();
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
          version: "0.1.1",
        },
        rootUri,
      },
      signal
    );

    this.notify("notifications/initialized", {});
    return result;
  }

  async listTools(signal?: AbortSignal): Promise<MCPToolDefinition[]> {
    const result = (await this.request("tools/list", {}, signal)) as MCPToolsListResult;
    if (!Array.isArray(result.tools)) {
      throw new Error("CodeGraph MCP tools/list returned no tools array");
    }
    return result.tools.filter((tool) => typeof tool.name === "string" && tool.name.length > 0);
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    return this.request("tools/call", { name, arguments: args }, signal);
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`MCP server connection is closed\n\n${this.diagnostics}`));
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
        reject(new Error(`MCP request timeout (${REQUEST_TIMEOUT_MS}ms): ${method}\n\n${this.diagnostics}`));
      }, REQUEST_TIMEOUT_MS);

      const onAbort = () => {
        cleanup();
        reject(new Error("MCP request cancelled by user"));
      };

      signal?.addEventListener("abort", onAbort);
      this.timers.set(String(id), timer);

      const stdin = this.proc.stdin;
      if (!stdin) {
        cleanup();
        reject(new Error(`No stdin from MCP process\n\n${this.diagnostics}`));
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

class CodeGraphMCPRegistry {
  private clients = new Map<string, Promise<MCPClient>>();
  private discovered = new Map<string, Promise<MCPToolDefinition[]>>();

  async getClient(projectRoot: string, signal?: AbortSignal): Promise<MCPClient> {
    const existing = this.clients.get(projectRoot);
    if (existing) return existing;

    const created = this.createClient(projectRoot, signal).catch((err) => {
      this.clients.delete(projectRoot);
      throw err;
    });
    this.clients.set(projectRoot, created);
    return created;
  }

  async discoverTools(projectRoot: string, signal?: AbortSignal): Promise<MCPToolDefinition[]> {
    const existing = this.discovered.get(projectRoot);
    if (existing) return existing;

    const discovered = this.getClient(projectRoot, signal)
      .then((client) => client.listTools(signal))
      .then((tools) => {
        if (tools.length === 0) {
          throw new Error("CodeGraph MCP tools/list returned an empty tools array");
        }
        return tools;
      })
      .catch((err) => {
        this.discovered.delete(projectRoot);
        throw err;
      });

    this.discovered.set(projectRoot, discovered);
    return discovered;
  }

  async callTool(
    projectRoot: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<MCPToolResult> {
    const client = await this.getClient(projectRoot, signal);
    const result = await client.callTool(toolName, args, signal);
    return normalizeMCPResult(result);
  }

  closeAll(): void {
    const clientPromises = [...this.clients.values()];
    this.clients.clear();
    this.discovered.clear();

    for (const clientPromise of clientPromises) {
      clientPromise.then((client) => client.close()).catch(() => {});
    }
  }

  private async createClient(projectRoot: string, signal?: AbortSignal): Promise<MCPClient> {
    const client = new MCPClient(projectRoot);
    try {
      const rootUri = pathToFileURL(projectRoot).href;
      await client.initialize(rootUri, signal);
      return client;
    } catch (err) {
      client.close();
      throw err;
    }
  }
}

const TOOL_METADATA: Record<string, ToolMetadata> = {
  codegraph_search: {
    label: "CodeGraph Search",
    promptSnippet: "Search codebase symbols via CodeGraph",
    promptGuidelines: [
      "Use codegraph_search when you need to find symbols by name across the codebase",
      "Use for: finding function definitions, class implementations, types, routes",
      "Prefer codegraph_explore for exploration tasks — it returns comprehensive context in one call",
    ],
    detailsName: "search",
  },
  codegraph_context: {
    label: "CodeGraph Context",
    promptSnippet: "Build code context via CodeGraph",
    promptGuidelines: [
      "Use codegraph_context only when the installed CodeGraph MCP server exposes it",
      "For newer CodeGraph versions, prefer codegraph_explore for onboarding, feature exploration, and bug investigation",
      "Returns large context — often enough without additional tool calls",
    ],
    detailsName: "context",
  },
  codegraph_callers: {
    label: "CodeGraph Callers",
    promptSnippet: "Find callers of a symbol",
    promptGuidelines: [
      "Use codegraph_callers before modifying a function to see call sites",
      "Use for: understanding usage patterns, impact analysis",
    ],
    detailsName: "callers",
  },
  codegraph_callees: {
    label: "CodeGraph Callees",
    promptSnippet: "Find callees of a symbol",
    promptGuidelines: [
      "Use codegraph_callees to understand dependencies and code flow",
      "Use for: tracing execution paths, understanding what a function depends on",
    ],
    detailsName: "callees",
  },
  codegraph_impact: {
    label: "CodeGraph Impact",
    promptSnippet: "Analyze impact of changes",
    promptGuidelines: [
      "Use codegraph_impact before making changes to see affected code",
      "Use for: refactor planning, assessing blast radius of modifications",
    ],
    detailsName: "impact",
  },
  codegraph_node: {
    label: "CodeGraph Node",
    promptSnippet: "Get symbol details via CodeGraph",
    promptGuidelines: [
      "Use codegraph_node when you need full source code of a symbol",
      "Set includeCode=true only when needed — it increases token usage",
      "Use codegraph_search first to find the exact symbol name",
    ],
    detailsName: "node",
  },
  codegraph_explore: {
    label: "CodeGraph Explore",
    promptSnippet: "Deep exploration via CodeGraph",
    promptGuidelines: [
      "Use codegraph_explore for thorough understanding of unfamiliar topics",
      "Use specific symbol names, file names, or short code terms — NOT natural language sentences",
      "Use codegraph_search first to discover relevant symbol names",
      "Respect the explore budget — do not make more calls than recommended",
    ],
    detailsName: "explore",
  },
  codegraph_status: {
    label: "CodeGraph Status",
    promptSnippet: "Check CodeGraph index status",
    promptGuidelines: [
      "Use codegraph_status to verify the index is ready before other operations",
      "Check backend type — wasm fallback is slower than native",
    ],
    detailsName: "status",
  },
  codegraph_files: {
    label: "CodeGraph Files",
    promptSnippet: "List project files via CodeGraph",
    promptGuidelines: [
      "Use codegraph_files first when exploring project structure or finding files",
      "Much faster than Glob/filesystem scanning",
      "Use tree format for overview, grouped for language breakdown",
      "For path, pass a repo-relative directory like src/components; do not pass the full project root",
    ],
    detailsName: "files",
  },
};

function metadataFor(tool: MCPToolDefinition): ToolMetadata {
  const known = TOOL_METADATA[tool.name];
  if (known) return known;

  const title = toTitle(tool.name) || tool.name;
  return {
    label: `CodeGraph ${title}`,
    promptSnippet: tool.description ?? `Call ${tool.name} via CodeGraph MCP`,
    promptGuidelines: [
      `Use ${tool.name} when the installed CodeGraph MCP server exposes this tool`,
      "Arguments are validated using the MCP tools/list inputSchema returned by CodeGraph",
    ],
    detailsName: title.toLowerCase().replaceAll(" ", "_"),
  };
}

function buildToolRegistrations(tools: MCPToolDefinition[]): ToolRegistration[] {
  const usedPiNames = new Set<string>();
  const registrations: ToolRegistration[] = [];

  for (const tool of tools) {
    const piName = sanitizeToolName(tool.name);
    if (!piName) {
      console.warn(`[CodeGraph MCP] Skipping tool with unsupported name: ${tool.name}`);
      continue;
    }

    if (usedPiNames.has(piName)) {
      console.warn(
        `[CodeGraph MCP] Skipping tool ${tool.name}; sanitized name ${piName} conflicts with another tool.`
      );
      continue;
    }

    usedPiNames.add(piName);
    registrations.push({
      piName,
      mcpName: tool.name,
      definition: tool,
      metadata: metadataFor(tool),
    });
  }

  return registrations;
}

export default function codegraphExtension(pi: ExtensionAPI) {
  const registry = new CodeGraphMCPRegistry();
  const registeredToolNames = new Set<string>();

  function registerDiscoveredTools(tools: MCPToolDefinition[]): string[] {
    const registered: string[] = [];

    for (const registration of buildToolRegistrations(tools)) {
      if (registeredToolNames.has(registration.piName)) continue;

      const parameters = normalizeInputSchema(registration.mcpName, registration.definition.inputSchema);
      const description =
        registration.definition.description ?? `Call ${registration.mcpName} via CodeGraph MCP`;

      pi.registerTool({
        name: registration.piName,
        label: registration.metadata.label,
        description,
        promptSnippet: registration.metadata.promptSnippet,
        promptGuidelines: registration.metadata.promptGuidelines,
        parameters: parameters as any,
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          try {
            const rawParams = isObject(params) ? params : {};
            const projectRoot = resolveProjectRoot(ctx.cwd, rawParams.projectPath);
            const args = prepareToolArguments(registration.mcpName, rawParams, projectRoot);
            const result = await registry.callTool(projectRoot, registration.mcpName, args, signal);

            return {
              content: result.content,
              isError: result.isError,
              details: { tool: registration.metadata.detailsName, mcpTool: registration.mcpName, args },
            };
          } catch (err) {
            return handleError(err, registration.metadata.detailsName, ctx.cwd);
          }
        },
      });

      registeredToolNames.add(registration.piName);
      registered.push(registration.piName);
    }

    return registered;
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      const tools = await registry.discoverTools(ctx.cwd);
      const registered = registerDiscoveredTools(tools);
      // 注册成功，静默处理
    } catch (err) {
      const message = createDiagnosticMessage(err, ctx.cwd);
      console.error(`[CodeGraph MCP] Tool discovery failed. No CodeGraph tools were registered.\n${message}`);
      if (ctx.hasUI) {
        ctx.ui.notify(`CodeGraph MCP tool discovery failed. No CodeGraph tools were registered.\n${message}`, "error");
      }
    }
  });

  pi.on("session_shutdown", () => {
    registry.closeAll();
    registeredToolNames.clear();
  });

  pi.registerCommand("codegraph-status", {
    description: "Check CodeGraph MCP server connectivity and discovered tools",
    handler: async (_args, ctx) => {
      try {
        const projectRoot = resolveProjectRoot(ctx.cwd);
        const tools = await registry.discoverTools(projectRoot);
        const registered = registerDiscoveredTools(tools);
        const status = await registry.callTool(
          projectRoot,
          "codegraph_status",
          { projectPath: projectRoot },
          undefined
        );
        const text = status.content.map((c) => c.text).join("\n");
        const toolNames = tools.map((tool) => tool.name).join(", ");
        const registrationText = registered.length
          ? `Newly registered Pi tools: ${registered.join(", ")}`
          : "Pi tools were already registered for the discovered MCP tools.";
        ctx.ui.notify(
          `CodeGraph MCP connected.\nDiscovered tools: ${toolNames}\n${registrationText}\n\n${text}`,
          "info"
        );
      } catch (err) {
        const handled = handleError(err, "status", ctx.cwd);
        ctx.ui.notify(handled.content[0]?.text ?? "CodeGraph MCP connection failed", "error");
      }
    },
  });
}
