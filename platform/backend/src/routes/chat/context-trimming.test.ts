import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";
import {
  parseMaxInputTokens,
  shouldProbeTextStreamForContextTrimRetry,
  trimMessagesToTokenLimit,
} from "./context-trimming";

const msg = (role: ModelMessage["role"], content: string): ModelMessage =>
  ({ role, content }) as ModelMessage;

const msgWithContent = (
  role: ModelMessage["role"],
  content: unknown,
): ModelMessage => ({ role, content }) as ModelMessage;

describe("parseMaxInputTokens", () => {
  test("parses limit from LiteLLM error message", () => {
    const error = new Error(
      'litellm.BadRequestError: Hosted_vllmException - {"error":{"message":"You passed 8193 input tokens and requested 0 output tokens. However, the model\'s context length is only 8192 tokens, resulting in a maximum input length of 8192 tokens.","type":"BadRequestError","param":"input_tokens","code":400}}',
    );
    expect(parseMaxInputTokens(error)).toBe(8192);
  });

  test("returns null for unrelated errors", () => {
    expect(parseMaxInputTokens(new Error("rate limit exceeded"))).toBeNull();
  });

  test("returns null for non-error values", () => {
    expect(parseMaxInputTokens(null)).toBeNull();
    expect(parseMaxInputTokens(undefined)).toBeNull();
    expect(parseMaxInputTokens(42)).toBeNull();
  });
});

describe("shouldProbeTextStreamForContextTrimRetry", () => {
  test("skips the textStream probe for Gemini", () => {
    expect(shouldProbeTextStreamForContextTrimRetry("gemini")).toBe(false);
  });

  test("keeps the textStream probe enabled for OpenAI-compatible flows", () => {
    expect(shouldProbeTextStreamForContextTrimRetry("openai")).toBe(true);
    expect(shouldProbeTextStreamForContextTrimRetry("vllm")).toBe(true);
  });
});

describe("trimMessagesToTokenLimit", () => {
  test("returns messages unchanged if within budget", () => {
    const messages = [msg("user", "hi")];
    expect(trimMessagesToTokenLimit(messages, 10000)).toBe(messages);
  });

  test("returns empty array unchanged", () => {
    expect(trimMessagesToTokenLimit([], 100)).toEqual([]);
  });

  test("drops middle messages first (oldest)", () => {
    const messages = [
      msg("user", "a".repeat(100)),
      msg("assistant", "b".repeat(100)),
      msg("user", "c".repeat(100)),
    ];
    // Budget fits ~2 messages worth + trim note
    const result = trimMessagesToTokenLimit(messages, 60);
    // Should have dropped the first message, kept last
    expect(result.some((m) => m.content === "a".repeat(100))).toBe(false);
    expect(result[result.length - 1].content).toBe("c".repeat(100));
  });

  test("drops system messages after middle messages", () => {
    const messages = [
      msg("system", "x".repeat(200)),
      msg("user", "a".repeat(200)),
      msg("user", "b".repeat(200)),
    ];
    // Very tight budget — only last message fits
    const result = trimMessagesToTokenLimit(messages, 60);
    expect(
      result.some((m) => m.role === "system" && m.content === "x".repeat(200)),
    ).toBe(false);
  });

  test("truncates last message if still over budget", () => {
    const messages = [msg("user", "a".repeat(1000))];
    const result = trimMessagesToTokenLimit(messages, 10);
    const lastContent = result[result.length - 1].content as string;
    expect(lastContent.length).toBeLessThan(1000);
  });

  test("adds trim note only when trimmed", () => {
    const small = [msg("user", "hi")];
    expect(trimMessagesToTokenLimit(small, 10000)[0].content).toBe("hi");

    const big = [
      msg("user", "a".repeat(200)),
      msg("assistant", "b".repeat(200)),
      msg("user", "c".repeat(200)),
    ];
    const result = trimMessagesToTokenLimit(big, 60);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("trimmed");
  });

  test("keeps last message even with single message", () => {
    const messages = [msg("user", "hello")];
    const result = trimMessagesToTokenLimit(messages, 1);
    expect(result.some((m) => m.role === "user")).toBe(true);
  });

  test("drops tool_use and tool_result messages together", () => {
    const messages: ModelMessage[] = [
      msgWithContent("assistant", [
        { type: "text", text: "I'll search for that." },
        { type: "tool-call", toolCallId: "call_1", name: "search" },
      ]),
      msgWithContent("user", [
        { type: "tool-result", toolCallId: "call_1", result: "search results" },
      ]),
      msg("assistant", "b".repeat(100)),
      msg("user", "c".repeat(100)),
    ];
    // Budget that would normally only drop the first message, but tool pairing
    // should cause both tool_use and tool_result messages to be dropped together
    const result = trimMessagesToTokenLimit(messages, 70);

    // Both the assistant with tool_use and user with tool_result should be dropped
    const hasToolCall = result.some(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as { type: string }[]).some((c) => c.type === "tool-call"),
    );
    const hasToolResult = result.some(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as { type: string }[]).some((c) => c.type === "tool-result"),
    );

    expect(hasToolCall).toBe(false);
    expect(hasToolResult).toBe(false);
  });

  test("preserves tool pairs at the end of conversation", () => {
    const messages: ModelMessage[] = [
      msg("user", "a".repeat(100)),
      msg("assistant", "b".repeat(100)),
      msgWithContent("user", "c".repeat(100)),
      msgWithContent("assistant", [
        { type: "tool-call", toolCallId: "call_2", name: "search" },
      ]),
      msgWithContent("user", [
        { type: "tool-result", toolCallId: "call_2", result: "results" },
      ]),
    ];
    // Budget that only needs to drop older messages
    const result = trimMessagesToTokenLimit(messages, 90);

    // The last message should still be present
    const lastMsg = result[result.length - 1];
    expect(lastMsg.role).toBe("user");
  });

  test("does not create orphaned tool_use when dropping tool_result", () => {
    const messages: ModelMessage[] = [
      msgWithContent("assistant", [
        { type: "text", text: "Let me help" },
        { type: "tool-call", toolCallId: "call_1", name: "tool1" },
      ]),
      msgWithContent("user", [
        { type: "tool-result", toolCallId: "call_1", result: "result1" },
      ]),
      msgWithContent("assistant", [
        { type: "tool-call", toolCallId: "call_2", name: "tool2" },
      ]),
      msgWithContent("user", [
        { type: "tool-result", toolCallId: "call_2", result: "result2" },
      ]),
      msg("assistant", "Final answer"),
      msg("user", "Thanks!"),
    ];

    // Tight budget - should drop some messages
    const result = trimMessagesToTokenLimit(messages, 50);

    // Verify no orphaned tool_use blocks exist
    for (let i = 0; i < result.length; i++) {
      const curr = result[i];
      if (
        curr.role === "assistant" &&
        Array.isArray(curr.content) &&
        (curr.content as { type: string }[]).some((c) => c.type === "tool-call")
      ) {
        // Next message must be a user message with matching tool_result
        const next = result[i + 1];
        expect(next).toBeDefined();
        expect(next?.role).toBe("user");
        expect(Array.isArray(next?.content)).toBe(true);
        expect(
          (next?.content as { type: string }[]).some(
            (c) => c.type === "tool-result",
          ),
        ).toBe(true);
      }
    }
  });

  test("handles tool_use type from AI SDK format", () => {
    const messages: ModelMessage[] = [
      msgWithContent("assistant", [
        { type: "tool_use", id: "toolu_abc123", name: "search" },
      ]),
      msgWithContent("user", [
        { type: "tool_result", toolUseId: "toolu_abc123", content: "results" },
      ]),
      msg("assistant", "z".repeat(100)),
      msg("user", "final message"),
    ];

    const result = trimMessagesToTokenLimit(messages, 70);

    // Both tool messages should be dropped together
    const hasToolUse = result.some(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as { type: string }[]).some((c) => c.type === "tool_use"),
    );
    const hasToolResultBlock = result.some(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as { type: string }[]).some((c) => c.type === "tool_result"),
    );

    expect(hasToolUse).toBe(false);
    expect(hasToolResultBlock).toBe(false);
  });
});
