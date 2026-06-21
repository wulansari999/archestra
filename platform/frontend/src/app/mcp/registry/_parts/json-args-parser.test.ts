import { describe, it, expect } from "vitest";
import { parseArgumentsInput, parseConfigInput } from "./json-args-parser";

describe("parseArgumentsInput", () => {
  it("returns null for empty input", () => {
    expect(parseArgumentsInput("")).toBeNull();
    expect(parseArgumentsInput("   ")).toBeNull();
  });

  it("returns null for plain newline-separated text (backward compat)", () => {
    expect(parseArgumentsInput("--verbose")).toBeNull();
    expect(parseArgumentsInput("/path/to/server\n--port 8080")).toBeNull();
  });

  it("parses JSON array of strings", () => {
    expect(parseArgumentsInput('["--port", "8080"]')).toEqual(["--port", "8080"]);
  });

  it("filters non-string items from JSON array", () => {
    expect(parseArgumentsInput('["--port", 8080, true]')).toEqual(["--port"]);
  });

  it("parses JSON object with args key", () => {
    expect(parseArgumentsInput('{"args": ["-y", "server-name"]}')).toEqual(["-y", "server-name"]);
  });

  it("parses JSON object with arguments key", () => {
    expect(parseArgumentsInput('{"arguments": ["--verbose", "--debug"]}')).toEqual(["--verbose", "--debug"]);
  });

  it("returns null for JSON object with command but no args (fallback to newline)", () => {
    expect(parseArgumentsInput('{"command": "npx"}')).toBeNull();
  });

  it("returns empty array for JSON config with command and empty args", () => {
    expect(parseArgumentsInput('{"command": "npx", "args": []}')).toEqual([]);
  });

  it("handles servers wrapper format (single server)", () => {
    const input = JSON.stringify({
      servers: {
        "my-server": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server"],
        },
      },
    });
    expect(parseArgumentsInput(input)).toEqual(["-y", "@modelcontextprotocol/server"]);
  });

  it("returns null for servers wrapper with multiple servers", () => {
    const input = JSON.stringify({
      servers: {
        "server-a": { command: "npx", args: ["-y", "a"] },
        "server-b": { command: "npx", args: ["-y", "b"] },
      },
    });
    expect(parseArgumentsInput(input)).toBeNull();
  });
});

describe("parseConfigInput", () => {
  it("returns null for plain text", () => {
    expect(parseConfigInput("--verbose")).toBeNull();
  });

  it("extracts full config from JSON object", () => {
    const result = parseConfigInput(
      JSON.stringify({ command: "npx", args: ["-y", "server"], env: { KEY: "val" } }),
    );
    expect(result).not.toBeNull();
    expect(result!.command).toBe("npx");
    expect(result!.arguments).toEqual(["-y", "server"]);
    expect(result!.env).toEqual({ KEY: "val" });
  });

  it("returns args-only for JSON array", () => {
    const result = parseConfigInput('["--port", "9090"]');
    expect(result).not.toBeNull();
    expect(result!.arguments).toEqual(["--port", "9090"]);
    expect(result!.command).toBeUndefined();
  });

  it("extracts docker image", () => {
    const result = parseConfigInput(
      JSON.stringify({
        command: "docker",
        args: ["run", "-i", "--rm", "pulumi/mcp-server:latest", "npx", "-y", "pulumi-mcp"],
        dockerImage: "pulumi/mcp-server:latest",
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.dockerImage).toBe("pulumi/mcp-server:latest");
    expect(result!.arguments).toEqual([
      "run", "-i", "--rm", "pulumi/mcp-server:latest", "npx", "-y", "pulumi-mcp",
    ]);
  });

  it("extracts transport type and port", () => {
    const result = parseConfigInput(
      JSON.stringify({ command: "node", args: ["--port", "3000"], transportType: "streamable-http" }),
    );
    expect(result).not.toBeNull();
    expect(result!.transportType).toBe("streamable-http");
  });

  it("handles environment variables from env key", () => {
    const result = parseConfigInput(
      JSON.stringify({ command: "my-server", env: { TOKEN: "abc", ORG: "test" } }),
    );
    expect(result).not.toBeNull();
    expect(result!.env).toEqual({ TOKEN: "abc", ORG: "test" });
  });

  it("handles environment variables from environment key", () => {
    const result = parseConfigInput(
      JSON.stringify({ command: "my-server", environment: { KEY: "value" } }),
    );
    expect(result).not.toBeNull();
    expect(result!.env).toEqual({ KEY: "value" });
  });
});
