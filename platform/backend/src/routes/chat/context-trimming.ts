/**
 * Workaround for LiteLLM/vLLM context length errors.
 * When these proxies return a 400 with "maximum input length of N tokens",
 * we parse the limit, trim messages, and retry the request.
 */
import type { SupportedProvider } from "@shared";
import { APICallError, type ModelMessage } from "ai";

const CHARS_PER_TOKEN = 4;

type ContentBlock = {
  type: string;
  toolCallId?: string;
  toolUseId?: string;
  id?: string;
};

/**
 * Gemini can emit tool-call chunks before any text. Probing textStream to detect
 * context errors can consume that first tool-call event, which hides the
 * in-progress tool indicator in chat. Skip the probe there.
 */
export function shouldProbeTextStreamForContextTrimRetry(
  provider: SupportedProvider,
): boolean {
  return provider !== "gemini";
}

/**
 * Parse max input token limit from vLLM/LiteLLM error responses.
 * Matches: "maximum input length of 8192 tokens"
 */
export function parseMaxInputTokens(error: unknown): number | null {
  let body: string | undefined;

  if (APICallError.isInstance(error)) {
    body = (error as InstanceType<typeof APICallError>).responseBody;
  }
  if (!body) {
    body = error instanceof Error ? error.message : undefined;
  }
  if (!body) return null;

  const match = body.match(/maximum input length of (\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Trim messages to fit within a token limit.
 * Drop order: middle messages (oldest first) → system → last message.
 * Preserves tool_use/tool_result pairs to avoid Anthropic API validation errors.
 */
export function trimMessagesToTokenLimit(
  messages: ModelMessage[],
  maxTokens: number,
): ModelMessage[] {
  const charBudget = maxTokens * CHARS_PER_TOKEN;
  const chars = (m: ModelMessage) => JSON.stringify(m.content).length;
  let total = messages.reduce((s, m) => s + chars(m), 0);
  if (total <= charBudget || messages.length === 0) return messages;

  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  const last = nonSystem[nonSystem.length - 1];
  const middle = nonSystem.slice(0, -1);

  // Track which messages should be dropped together to preserve tool_use/tool_result pairing.
  // For each message in 'middle', calculate the corresponding pair index.
  const dropPairs = buildToolPairIndices(middle);

  // 1. Drop middle messages from oldest, respecting tool pairs
  const dropped = new Set<number>();
  let i = 0;
  while (total > charBudget && i < middle.length) {
    if (dropped.has(i)) {
      i++;
      continue;
    }

    // Drop this message and its pair (if any)
    const pairIndex = dropPairs.get(i);
    const messagesToDrop = [i];
    if (pairIndex !== undefined && !dropped.has(pairIndex)) {
      messagesToDrop.push(pairIndex);
    }

    for (const idx of messagesToDrop) {
      dropped.add(idx);
      total -= chars(middle[idx]);
    }
    i++;
  }

  const remainingMiddle = middle.filter((_, idx) => !dropped.has(idx));

  // 2. Drop system messages from oldest
  const remainingSystem = [...system];
  while (total > charBudget && remainingSystem.length > 0) {
    const droppedSys = remainingSystem.shift();
    if (droppedSys) total -= chars(droppedSys);
  }

  // 3. Truncate last message if still over budget
  let trimmedLast: ModelMessage | undefined = last;
  if (last && total > charBudget) {
    const lastStr = JSON.stringify(last.content);
    const excess = total - charBudget;
    trimmedLast = {
      role: last.role,
      content: lastStr.slice(0, Math.max(lastStr.length - excess, 0)),
    } as ModelMessage;
  }

  const result: ModelMessage[] = [
    ...remainingSystem,
    ...remainingMiddle,
    trimmedLast,
  ];

  if (result.length < messages.length || trimmedLast !== last) {
    result.unshift({
      role: "system",
      content:
        "[Earlier context was trimmed to fit the model's context window.]",
    });
  }

  return result;
}

/**
 * Build a map of message indices to their tool pair indices.
 * An assistant message with tool_use should be paired with the following user message
 * containing tool_result. When dropping one, we must drop both.
 */
function buildToolPairIndices(messages: ModelMessage[]): Map<number, number> {
  const pairs = new Map<number, number>();

  for (let i = 0; i < messages.length - 1; i++) {
    const curr = messages[i];
    const next = messages[i + 1];

    if (curr.role !== "assistant" || next.role !== "user") {
      continue;
    }

    // Check if current assistant message has tool_use blocks
    const toolUseIds = extractToolUseIds(curr.content);
    if (toolUseIds.size === 0) {
      continue;
    }

    // Check if next user message has corresponding tool_result blocks
    const toolResultIds = extractToolResultIds(next.content);
    const hasMatchingResult = [...toolUseIds].some((id) =>
      toolResultIds.has(id),
    );

    if (hasMatchingResult) {
      // Pair them together - if either is dropped, both should be dropped
      pairs.set(i, i + 1);
      pairs.set(i + 1, i);
    }
  }

  return pairs;
}

function extractToolUseIds(content: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(content)) return ids;

  for (const block of content as ContentBlock[]) {
    if (block.type === "tool-call" || block.type === "tool_use") {
      const id = block.toolCallId || block.id;
      if (id) ids.add(id);
    }
  }
  return ids;
}

function extractToolResultIds(content: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(content)) return ids;

  for (const block of content as ContentBlock[]) {
    if (block.type === "tool-result" || block.type === "tool_result") {
      const id = block.toolCallId || block.toolUseId;
      if (id) ids.add(id);
    }
  }
  return ids;
}
