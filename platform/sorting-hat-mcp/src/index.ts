import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sortTool } from "./sorting-hat.js";
import { castPatronus } from "./patronus.js";
import { travel, registerFlooServer } from "./floo.js";
import { getStreamEvent } from "./quidditch.js";

// Register some default MCP servers on the Floo Network
registerFlooServer("filesystem");
registerFlooServer("github");
registerFlooServer("postgres");
registerFlooServer("brave-search");
registerFlooServer("slack");
registerFlooServer("notion");
registerFlooServer("jira");

const server = new Server(
  {
    name: "sorting-hat-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Schema definitions
const SortSchema = z.object({
  tool_name: z.string().describe("The name of the tool to sort."),
  tool_description: z.string().describe("A description of what the tool does."),
  please_not_slytherin: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, the Sorting Hat will avoid Slytherin if possible."),
});

const PatronusSchema = z.object({
  user_id: z.string().describe("The user ID to cast a Patronus for."),
  charm: z
    .string()
    .default("expecto_patronum")
    .describe("The Patronus charm to cast."),
});

const FlooSchema = z.object({
  from_server: z.string().describe("The source MCP server name."),
  to_server: z.string().describe("The destination MCP server name."),
  payload: z
    .record(z.unknown())
    .default({})
    .describe("The tool call payload to route."),
});

const QuidditchSchema = z.object({
  tool_call_id: z.string().describe("The tool call ID to stream progress for."),
  elapsed_ms: z
    .number()
    .describe("Milliseconds elapsed since the tool call started."),
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "sorting_hat.sort",
        description:
          "Sorts a tool into a Hogwarts house based on its risk profile and intent. " +
          "The Sorting Hat streams rhyming reasoning. " +
          "Respects the 'please_not_slytherin' header.",
        inputSchema: {
          type: "object",
          properties: {
            tool_name: { type: "string", description: "Name of the tool" },
            tool_description: {
              type: "string",
              description: "Description of the tool",
            },
            please_not_slytherin: {
              type: "boolean",
              description: "Avoid Slytherin if possible",
              default: false,
            },
          },
          required: ["tool_name", "tool_description"],
        },
      },
      {
        name: "patronus.cast",
        description:
          "Casts a Patronus charm for a user. " +
          "Returns the user's deterministic Patronus form. " +
          "Non-corporeal Patronuses fail authorization for Slytherin-sorted tools.",
        inputSchema: {
          type: "object",
          properties: {
            user_id: {
              type: "string",
              description: "The user ID to cast a Patronus for",
            },
            charm: {
              type: "string",
              description: "The charm to cast",
              default: "expecto_patronum",
            },
          },
          required: ["user_id"],
        },
      },
      {
        name: "floo.travel",
        description:
          "Routes a tool call from one MCP server to another via the Floo Network. " +
          "Emits green flame particles in the streaming UI on success.",
        inputSchema: {
          type: "object",
          properties: {
            from_server: {
              type: "string",
              description: "Source MCP server name",
            },
            to_server: {
              type: "string",
              description: "Destination MCP server name",
            },
            payload: {
              type: "object",
              description: "Tool call payload to route",
            },
          },
          required: ["from_server", "to_server"],
        },
      },
      {
        name: "quidditch.stream",
        description:
          "Emits Snitch-shaped progress events for an in-flight tool call. " +
          "Replaces the default spinner with the Golden Snitch loader for Gryffindor-sorted tools.",
        inputSchema: {
          type: "object",
          properties: {
            tool_call_id: {
              type: "string",
              description: "Tool call ID to stream progress for",
            },
            elapsed_ms: {
              type: "number",
              description: "Milliseconds since tool call started",
            },
          },
          required: ["tool_call_id", "elapsed_ms"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "sorting_hat.sort": {
      const parsed = SortSchema.parse(args);
      const result = sortTool(
        parsed.tool_name,
        parsed.tool_description,
        parsed.please_not_slytherin,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "patronus.cast": {
      const parsed = PatronusSchema.parse(args);
      const result = castPatronus(parsed.user_id, parsed.charm);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "floo.travel": {
      const parsed = FlooSchema.parse(args);
      const result = travel(
        parsed.from_server,
        parsed.to_server,
        parsed.payload,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "quidditch.stream": {
      const parsed = QuidditchSchema.parse(args);
      const event = getStreamEvent(parsed.tool_call_id, parsed.elapsed_ms);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(event, null, 2),
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Sorting Hat MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
