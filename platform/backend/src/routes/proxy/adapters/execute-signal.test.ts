import { vi } from "vitest";
import { describe, expect, test } from "@/test";
import { anthropicAdapterFactory } from "./anthropic";
import { cohereAdapterFactory } from "./cohere";
import { geminiAdapterFactory } from "./gemini";
import { openaiAdapterFactory } from "./openai";
import { openAiResponsesAdapterFactory } from "./openai-responses";

/**
 * Each LLM adapter's `execute`/`executeStream` must forward the `AbortSignal`
 * threaded by the proxy handler (commit `fix(llm): abort upstream call on
 * client disconnect`) down to the underlying SDK / fetch call — otherwise an
 * inbound disconnect can't cancel the upstream request. The 20+ providers
 * collapse into a handful of call-shapes; we cover one representative of each.
 */

// An async iterable that yields nothing — stand-in for an SDK stream so the
// wrapping `for await` in executeStream completes immediately.
function emptyStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: true, value: undefined }),
      };
    },
  };
}

describe("adapter execute/executeStream forward the AbortSignal", () => {
  test("OpenAI SDK chat shape (openai) forwards signal via request options", async () => {
    const signal = new AbortController().signal;
    const create = vi
      .fn()
      .mockResolvedValueOnce({ id: "resp" }) // execute
      .mockResolvedValueOnce(emptyStream()); // executeStream
    const client = { chat: { completions: { create } } };

    await openaiAdapterFactory.execute(
      client,
      { model: "gpt-4o", messages: [] } as never,
      signal,
    );
    expect(create.mock.calls[0][1]).toEqual({ signal });

    await openaiAdapterFactory.executeStream(
      client,
      { model: "gpt-4o", messages: [] } as never,
      signal,
    );
    expect(create.mock.calls[1][1]).toEqual({ signal });
  });

  test("Responses API shape (openai-responses) forwards signal via request options", async () => {
    const signal = new AbortController().signal;
    const create = vi
      .fn()
      .mockResolvedValueOnce({ id: "resp" })
      .mockResolvedValueOnce(emptyStream());
    const client = { responses: { create } };

    await openAiResponsesAdapterFactory.execute(
      client,
      { model: "gpt-4o", input: [] } as never,
      signal,
    );
    expect(create.mock.calls[0][1]).toEqual({ signal });

    await openAiResponsesAdapterFactory.executeStream(
      client,
      { model: "gpt-4o", input: [] } as never,
      signal,
    );
    expect(create.mock.calls[1][1]).toEqual({ signal });
  });

  test("Anthropic SDK shape forwards signal via request options", async () => {
    const signal = new AbortController().signal;
    const create = vi
      .fn()
      .mockResolvedValueOnce({ content: [] })
      .mockResolvedValueOnce(emptyStream());
    const client = { messages: { create } };

    await anthropicAdapterFactory.execute(
      client,
      { model: "claude-3-5-sonnet-20241022", messages: [], max_tokens: 16 },
      signal,
    );
    expect(create.mock.calls[0][1]).toEqual({ signal });

    await anthropicAdapterFactory.executeStream(
      client,
      { model: "claude-3-5-sonnet-20241022", messages: [], max_tokens: 16 },
      signal,
    );
    expect(create.mock.calls[1][1]).toEqual({ signal });
  });

  test("Gemini SDK shape forwards signal via config.abortSignal", async () => {
    const signal = new AbortController().signal;
    const sdkResponse = {
      candidates: [
        { content: { role: "model", parts: [{ text: "hi" }] }, index: 0 },
      ],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        totalTokenCount: 2,
      },
      modelVersion: "gemini-2.5-pro",
      responseId: "r",
    };
    const generateContent = vi.fn().mockResolvedValue(sdkResponse);
    const generateContentStream = vi.fn().mockResolvedValue(emptyStream());
    const client = { models: { generateContent, generateContentStream } };
    const request = {
      contents: [],
      _model: "gemini-2.5-pro",
      _isStreaming: false,
    } as never;

    await geminiAdapterFactory.execute(client, request, signal);
    expect(generateContent.mock.calls[0][0].config.abortSignal).toBe(signal);

    await geminiAdapterFactory.executeStream(client, request, signal);
    expect(generateContentStream.mock.calls[0][0].config.abortSignal).toBe(
      signal,
    );
  });

  test("raw-fetch shape (cohere) forwards signal to fetch", async () => {
    const signal = new AbortController().signal;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "c" })));

    // No `agent` option => the client uses the global fetch directly (no
    // observability wrapper), so the spy sees the call.
    const client = cohereAdapterFactory.createClient("test-key", {
      source: "api",
    });

    try {
      await cohereAdapterFactory.execute(
        client,
        { model: "command-r", messages: [] } as never,
        signal,
      );
      expect(fetchSpy.mock.calls[0][1]?.signal).toBe(signal);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
