/**
 * Parses MCP server configuration from textarea input that can be either:
 * - Newline-separated arguments (existing format: one arg per line)
 * - JSON array of strings: ["arg1", "arg2"]
 * - JSON object with "args" or "arguments" property
 * - Full MCP server config JSON (with "command", "args", "env", etc.)
 *
 * The goal: be able to copy-paste MCP server configurations from the internet
 * and create MCP servers out of them without too much friction.
 */

export type ParsedMcpConfig = {
  command?: string;
  arguments?: string[];
  dockerImage?: string;
  transportType?: "stdio" | "streamable-http";
  httpPort?: number;
  env?: Record<string, string>;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Try to extract a config from known MCP registry formats found in the wild.
 *
 * Format 1: Official registry / raw JSON server config
 *   { "command": "npx", "args": ["-y", "server-name"], "env": { "KEY": "val" } }
 *
 * Format 2: Our own format (subset of above)
 *   { "command": "npx", "arguments": ["-y", "server-name"] }
 *
 * Format 3: Wrapper with "servers" block (VS Code / CLine style)
 *   { "servers": { "my-server": { "type": "http", "command": "npx", ... } } }
 *
 * Format 4: Docker-style
 *   { "command": "docker", "args": ["run", "-i", "--rm", "image:tag"] }
 */
function extractFromMcpJson(json: Record<string, unknown>): ParsedMcpConfig | null {
  const config: ParsedMcpConfig = {};

  // Format 3: Check for "servers" wrapper
  if (json.servers && isJsonObject(json.servers)) {
    const keys = Object.keys(json.servers);
    if (keys.length === 1) {
      // Single server definition — use it
      return extractFromMcpJson(json.servers[keys[0]] as Record<string, unknown>);
    }
    // Multiple servers — can't pick one, return null to fall back to line-per-arg
    return null;
  }

  // Extract command
  if (typeof json.command === "string") {
    config.command = json.command;
  }

  // Extract args / arguments (both common MCP key names)
  const args = json.args ?? json.arguments;
  if (Array.isArray(args)) {
    config.arguments = args
      .map((a: unknown) => (typeof a === "string" ? a : String(a)))
      .filter((a: string) => a.length > 0);
  }

  // Extract docker image
  if (typeof json.dockerImage === "string") {
    config.dockerImage = json.dockerImage;
  }
  // Also check common docker_image keys
  if (!config.dockerImage && typeof json.docker_image === "string") {
    config.dockerImage = json.docker_image;
  }

  // Extract transport type
  if (json.transportType === "streamable-http" || json.transport === "streamable-http") {
    config.transportType = "streamable-http";
  }

  // Extract port
  const port = json.httpPort ?? json.port ?? json.http_port;
  if (typeof port === "number" && Number.isFinite(port)) {
    config.httpPort = port;
  }

  // Extract environment variables
  if (json.env && isJsonObject(json.env)) {
    config.env = json.env as Record<string, string>;
  }
  if (!config.env && json.environment && isJsonObject(json.environment)) {
    config.env = json.environment as Record<string, string>;
  }
  if (!config.env && json.envs && isJsonObject(json.envs)) {
    config.env = json.envs as Record<string, string>;
  }

  // If we got at least something useful, return it
  if (config.command || config.arguments || config.dockerImage) {
    return config;
  }

  return null;
}

/**
 * Parse the Arguments textarea input, supporting both:
 * - Newline-separated (one arg per line) — existing behaviour
 * - JSON array: ["arg1", "arg2"]
 * - Full MCP config JSON: { "command": "...", "args": [...], ... }
 *
 * @param input - Raw text from the Arguments textarea
 * @returns Parsed arguments array, or null if parsing fails (caller falls back to newline-split)
 */
export function parseArgumentsInput(input: string): string[] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Try to parse as JSON
  try {
    const parsed: unknown = JSON.parse(trimmed);

    // Case 1: JSON array of strings
    if (Array.isArray(parsed)) {
      const args = parsed.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      );
      return args.length > 0 ? args : null;
    }

    // Case 2: JSON object — try to extract MCP config
    if (isJsonObject(parsed)) {
      const mcpConfig = extractFromMcpJson(parsed);
      if (mcpConfig?.arguments && mcpConfig.arguments.length > 0) {
        return mcpConfig.arguments;
      }
      // If we got a command but no args, return empty array (valid config, just no args)
      if (mcpConfig?.command || mcpConfig?.dockerImage) {
        return [];
      }
      // JSON object but didn't match known formats — let caller use newline-split fallback
      return null;
    }
  } catch {
    // Not valid JSON — fall through to newline-split below
  }

  // Not JSON — fall back to legacy newline-separated format
  return null;
}

/**
 * Parse the full textarea input and return a complete or partial MCP config.
 * Returns null if the input is plain newline-separated text (not JSON).
 */
export function parseConfigInput(input: string): ParsedMcpConfig | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);

    if (isJsonObject(parsed)) {
      return extractFromMcpJson(parsed);
    }

    // JSON array — treat as arguments only
    if (Array.isArray(parsed)) {
      const args = parsed.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      );
      return args.length > 0 ? { arguments: args } : null;
    }
  } catch {
    // Not JSON
    return null;
  }

  return null;
}

/**
 * Get placeholder text for the Arguments textarea that hints at supported formats.
 */
export function getArgumentsPlaceholder(): string {
  return [
    "/path/to/server.js",
    "--verbose",
    "",
    "Also supports JSON:",
    `  ["arg1", "arg2"]`,
    `  {"command":"npx","args":["-y","server"]}`,
  ].join("\n");
}
