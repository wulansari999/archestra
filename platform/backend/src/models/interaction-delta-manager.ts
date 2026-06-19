import { createHash } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { LRUCacheManager } from "@/cache-manager";
import db, { schema } from "@/database";
import type { InsertInteraction } from "@/types";

/**
 * Delta-encoding for Claude Code / Claude Desktop LLM-proxy interactions.
 *
 * Every agentic request re-sends the whole conversation, so storing the full
 * `request`/`processedRequest` on every row is Θ(N²) per session. This manager
 * stores only the suffix of `messages` that is new versus the row's parent and
 * rebuilds the full request on read by walking the parent chain — Θ(N).
 *
 * It is the single source of truth for the delta format and is used on BOTH the
 * write path (`encodeOnWrite` from `InteractionModel.create`) and the read path
 * (`reconstructRow` / `reconstructMany`). A per-pod LRU is the fast path; the DB
 * (recursive CTE up `parent_id`) is the source of truth, so results are identical
 * with a cold cache or across pods.
 *
 * Non-Claude / non-Anthropic interactions are returned untouched (full storage),
 * preserving existing behavior.
 */

/** Minimal view of an Anthropic-style messages request. */
interface MessagesRequest {
  messages?: unknown[];
  [key: string]: unknown;
}

interface FullRequest {
  request: unknown;
  processedRequest: unknown;
}

/** Cached tip of a (sessionId, threadId) branch — the most recent row. */
interface CachedTip {
  id: string;
  requestLastMessageIdx: number;
  requestLastMessageHash: string;
  fullRequestMessages: unknown[];
  fullProcessedMessages: unknown[] | null;
}

/** Cache entry returned by encodeOnWrite to commit once the new row id is known. */
interface DeltaTipUpdate {
  key: string;
  requestLastMessageIdx: number;
  requestLastMessageHash: string;
  fullRequest: unknown;
  fullProcessed: unknown;
  fullRequestMessages: unknown[];
  fullProcessedMessages: unknown[] | null;
}

interface EncodedInteraction {
  values: InsertInteraction;
  tip: DeltaTipUpdate | null;
}

/** Row shape loaded for reconstruction (camelCase mapping of the chain CTE). */
interface ChainRow {
  id: string;
  parentId: string | null;
  threadId: string | null;
  requestSharedPrefix: number | null;
  processedRequestSharedPrefix: number | null;
  request: unknown;
  processedRequest: unknown;
}

/** Subset of an interaction row the read path passes to reconstructMany. */
interface ReconstructableRow {
  id: string;
  threadId: string | null;
  request: unknown;
  processedRequest?: unknown;
}

const CACHE_MAX_SIZE = 5000;

class InteractionDeltaManager {
  /** Branch tip per (sessionId, threadId) — write-path parent fast path. */
  private static tipCache = new LRUCacheManager<CachedTip>({
    maxSize: CACHE_MAX_SIZE,
    defaultTtl: TimeInMs.Hour,
  });

  /** Reconstructed full request/processedRequest per interaction id — read-path memo. */
  private static reconstructCache = new LRUCacheManager<FullRequest>({
    maxSize: CACHE_MAX_SIZE,
    defaultTtl: TimeInMs.Hour,
  });

  /**
   * Delta-encode an interaction before insert. Returns the row to persist and a
   * tip update to commit (via `commitTip`) once the inserted id is known.
   * Returns the row unchanged (tip null) when not delta-eligible.
   */
  static async encodeOnWrite(
    data: InsertInteraction,
  ): Promise<EncodedInteraction> {
    if (!InteractionDeltaManager.isEligible(data)) {
      return { values: data, tip: null };
    }

    const request = data.request as MessagesRequest;
    const messages = request.messages as unknown[];
    const threadId = hashMessage(messages[0]);
    const lastIdx = messages.length - 1;
    const lastHash = hashMessage(messages[lastIdx]);
    const key = tipKey(data.sessionId as string, threadId);

    const parent = await InteractionDeltaManager.resolveParent(key, {
      sessionId: data.sessionId as string,
      threadId,
      messages,
    });

    let requestSharedPrefix: number;
    let parentId: string | null;
    let deltaMessages: unknown[];
    if (parent) {
      requestSharedPrefix = parent.requestLastMessageIdx + 1;
      parentId = parent.id;
      deltaMessages = messages.slice(requestSharedPrefix);
    } else {
      // No parent (first request / sub-agent / post-compaction / aged-out branch):
      // persist a complete-request "head" row. Still delta-format (threadId + last
      // message metadata set) so the next request resolves it as parent.
      requestSharedPrefix = 0;
      parentId = null;
      deltaMessages = messages;
    }

    // processedRequest is delta-encoded independently against the parent's
    // reconstructed processedRequest (its message array can differ from request).
    const processedRequest = data.processedRequest as MessagesRequest | null;
    const processedMessages = getMessages(processedRequest);
    let processedRequestSharedPrefix: number | null;
    let processedToStore: unknown;
    if (processedMessages) {
      const parentProcessed = parent?.fullProcessedMessages ?? null;
      const prefix = parentProcessed
        ? longestCommonPrefixLen(parentProcessed, processedMessages)
        : 0;
      processedRequestSharedPrefix = prefix;
      processedToStore = {
        ...(processedRequest as MessagesRequest),
        messages: processedMessages.slice(prefix),
      };
    } else {
      // processedRequest null or non-message-shaped — store as-is, no reconstruction.
      processedRequestSharedPrefix = null;
      processedToStore = data.processedRequest;
    }

    const values: InsertInteraction = {
      ...data,
      request: {
        ...request,
        messages: deltaMessages,
      } as InsertInteraction["request"],
      processedRequest:
        processedToStore as InsertInteraction["processedRequest"],
      threadId,
      parentId,
      requestSharedPrefix,
      processedRequestSharedPrefix,
      requestLastMessageIdx: lastIdx,
    };

    const tip: DeltaTipUpdate = {
      key,
      requestLastMessageIdx: lastIdx,
      requestLastMessageHash: lastHash,
      fullRequest: { ...request, messages },
      fullProcessed: processedMessages
        ? {
            ...(processedRequest as MessagesRequest),
            messages: processedMessages,
          }
        : null,
      fullRequestMessages: messages,
      fullProcessedMessages: processedMessages,
    };

    return { values, tip };
  }

  /**
   * Populate the caches after the row is inserted and its id is known. Makes the
   * next request on the branch O(1) and an immediate read of this row a cache hit.
   */
  static commitTip(id: string, tip: DeltaTipUpdate): void {
    InteractionDeltaManager.tipCache.set(tip.key, {
      id,
      requestLastMessageIdx: tip.requestLastMessageIdx,
      requestLastMessageHash: tip.requestLastMessageHash,
      fullRequestMessages: tip.fullRequestMessages,
      fullProcessedMessages: tip.fullProcessedMessages,
    });
    InteractionDeltaManager.reconstructCache.set(id, {
      request: tip.fullRequest,
      processedRequest: tip.fullProcessed,
    });
  }

  /** Reconstruct the full request/processedRequest for a single interaction row. */
  static async reconstructRow(row: ReconstructableRow): Promise<FullRequest> {
    if (row.threadId === null) {
      // Legacy / non-delta row stores full request already.
      return { request: row.request, processedRequest: row.processedRequest };
    }
    const cached = InteractionDeltaManager.reconstructCache.get(row.id);
    if (cached) {
      return cached;
    }
    const map = await InteractionDeltaManager.loadChain([row.id]);
    return (
      InteractionDeltaManager.foldFor(row.id, map) ?? {
        request: row.request,
        processedRequest: row.processedRequest,
      }
    );
  }

  /**
   * Batch-reconstruct many rows (e.g. a paginated page). Loads every needed
   * ancestor in one recursive CTE; legacy rows and cache hits issue no DB work.
   */
  static async reconstructMany(
    rows: ReconstructableRow[],
  ): Promise<Map<string, FullRequest>> {
    const result = new Map<string, FullRequest>();
    const needLoad: string[] = [];

    for (const row of rows) {
      if (row.threadId === null) {
        result.set(row.id, {
          request: row.request,
          processedRequest: row.processedRequest,
        });
        continue;
      }
      const cached = InteractionDeltaManager.reconstructCache.get(row.id);
      if (cached) {
        result.set(row.id, cached);
        continue;
      }
      needLoad.push(row.id);
    }

    if (needLoad.length > 0) {
      const map = await InteractionDeltaManager.loadChain(needLoad);
      for (const id of needLoad) {
        const folded = InteractionDeltaManager.foldFor(id, map);
        if (folded) {
          result.set(id, folded);
        }
      }
    }

    return result;
  }

  /** Clear both caches. Intended for tests that exercise the cold-cache DB path. */
  static reset(): void {
    InteractionDeltaManager.tipCache.clear();
    InteractionDeltaManager.reconstructCache.clear();
  }

  private static isEligible(data: InsertInteraction): boolean {
    if (data.sessionId == null) return false;
    if (
      data.sessionSource !== "claude_code" &&
      data.sessionSource !== "claude_desktop"
    ) {
      return false;
    }
    if (data.type !== "anthropic:messages") return false;
    const messages = getMessages(data.request);
    return messages !== null && messages.length >= 1;
  }

  private static async resolveParent(
    key: string,
    params: { sessionId: string; threadId: string; messages: unknown[] },
  ): Promise<{
    id: string;
    requestLastMessageIdx: number;
    fullProcessedMessages: unknown[] | null;
  } | null> {
    const { sessionId, threadId, messages } = params;

    const cached = InteractionDeltaManager.tipCache.get(key);
    if (cached && InteractionDeltaManager.isValidParent(cached, messages)) {
      return {
        id: cached.id,
        requestLastMessageIdx: cached.requestLastMessageIdx,
        fullProcessedMessages: cached.fullProcessedMessages,
      };
    }

    // DB fallback. Fetch a small candidate set (NOT limit 1): under forking,
    // concurrent branches share the threadId and reach the same message index, so
    // the most recent candidate can belong to a different branch. We require a
    // strict prefix (`request_last_message_idx < length - 1`) and then pick the
    // most recent candidate whose stored last message actually matches the
    // incoming request at that index. The candidate's delta always ends at the
    // full request's last message, so `request -> 'messages' -> -1` is exactly the
    // message at request_last_message_idx — no separate stored hash needed.
    const candidates = await db
      .select({
        id: schema.interactionsTable.id,
        requestLastMessageIdx: schema.interactionsTable.requestLastMessageIdx,
        lastMessage: sql<unknown>`${schema.interactionsTable.request} -> 'messages' -> -1`,
      })
      .from(schema.interactionsTable)
      .where(
        and(
          eq(schema.interactionsTable.sessionId, sessionId),
          eq(schema.interactionsTable.threadId, threadId),
          lt(
            schema.interactionsTable.requestLastMessageIdx,
            messages.length - 1,
          ),
        ),
      )
      .orderBy(desc(schema.interactionsTable.createdAt))
      .limit(16);

    const chosen = candidates.find(
      (c) =>
        c.requestLastMessageIdx !== null &&
        hashMessage(c.lastMessage) ===
          hashMessage(messages[c.requestLastMessageIdx]),
    );
    if (!chosen || chosen.requestLastMessageIdx === null) {
      return null;
    }

    const full = await InteractionDeltaManager.reconstructById(chosen.id);
    return {
      id: chosen.id,
      requestLastMessageIdx: chosen.requestLastMessageIdx,
      fullProcessedMessages: full ? getMessages(full.processedRequest) : null,
    };
  }

  private static isValidParent(
    cached: CachedTip,
    messages: unknown[],
  ): boolean {
    return (
      cached.requestLastMessageIdx < messages.length - 1 &&
      hashMessage(messages[cached.requestLastMessageIdx]) ===
        cached.requestLastMessageHash
    );
  }

  private static async reconstructById(
    id: string,
  ): Promise<FullRequest | null> {
    const cached = InteractionDeltaManager.reconstructCache.get(id);
    if (cached) return cached;
    const map = await InteractionDeltaManager.loadChain([id]);
    return InteractionDeltaManager.foldFor(id, map);
  }

  /** Load each seed row plus all of its ancestors (deduped) in one query. */
  private static async loadChain(
    seedIds: string[],
  ): Promise<Map<string, ChainRow>> {
    const seedList = sql.join(
      seedIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const rows = await db.execute<{
      id: string;
      parent_id: string | null;
      thread_id: string | null;
      request_shared_prefix: number | null;
      processed_request_shared_prefix: number | null;
      request: unknown;
      processed_request: unknown;
    }>(sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, thread_id, request_shared_prefix,
               processed_request_shared_prefix, request, processed_request
        FROM interactions
        WHERE id IN (${seedList})
        UNION
        SELECT i.id, i.parent_id, i.thread_id, i.request_shared_prefix,
               i.processed_request_shared_prefix, i.request, i.processed_request
        FROM interactions i
        JOIN chain c ON i.id = c.parent_id
      )
      SELECT id, parent_id, thread_id, request_shared_prefix,
             processed_request_shared_prefix, request, processed_request
      FROM chain
    `);

    const map = new Map<string, ChainRow>();
    for (const row of rows.rows) {
      map.set(row.id, {
        id: row.id,
        parentId: row.parent_id,
        threadId: row.thread_id,
        requestSharedPrefix: row.request_shared_prefix,
        processedRequestSharedPrefix: row.processed_request_shared_prefix,
        request: row.request,
        processedRequest: row.processed_request,
      });
    }
    return map;
  }

  /** Fold a row's parent chain into its full request, memoizing each ancestor. */
  private static foldFor(
    id: string,
    map: Map<string, ChainRow>,
  ): FullRequest | null {
    const target = map.get(id);
    if (!target) return null;

    if (target.threadId === null) {
      const full = {
        request: target.request,
        processedRequest: target.processedRequest,
      };
      InteractionDeltaManager.reconstructCache.set(id, full);
      return full;
    }

    // Walk head -> target.
    const chain: ChainRow[] = [];
    let cursor: ChainRow | undefined = target;
    while (cursor) {
      chain.push(cursor);
      if (cursor.parentId === null) break;
      cursor = map.get(cursor.parentId);
    }
    chain.reverse();

    let requestMessages: unknown[] | null = null;
    let processedMessages: unknown[] | null = null;

    for (const row of chain) {
      const cached = InteractionDeltaManager.reconstructCache.get(row.id);
      if (cached) {
        requestMessages = getMessages(cached.request) ?? [];
        processedMessages = getMessages(cached.processedRequest);
        continue;
      }

      if (requestMessages === null) {
        // Head row stores full messages.
        requestMessages = [...(getMessages(row.request) ?? [])];
        processedMessages = getMessages(row.processedRequest);
      } else {
        requestMessages = requestMessages
          .slice(0, row.requestSharedPrefix ?? 0)
          .concat(getMessages(row.request) ?? []);
        if (row.processedRequestSharedPrefix === null) {
          processedMessages = getMessages(row.processedRequest);
        } else {
          processedMessages = (processedMessages ?? [])
            .slice(0, row.processedRequestSharedPrefix)
            .concat(getMessages(row.processedRequest) ?? []);
        }
      }

      InteractionDeltaManager.reconstructCache.set(
        row.id,
        buildFull(row, requestMessages, processedMessages),
      );
    }

    return InteractionDeltaManager.reconstructCache.get(id) ?? null;
  }
}

function tipKey(sessionId: string, threadId: string): string {
  return `${sessionId}::${threadId}`;
}

function getMessages(request: unknown): unknown[] | null {
  if (request && typeof request === "object") {
    const messages = (request as MessagesRequest).messages;
    if (Array.isArray(messages)) return messages;
  }
  return null;
}

function buildFull(
  row: ChainRow,
  requestMessages: unknown[],
  processedMessages: unknown[] | null,
): FullRequest {
  const request = {
    ...(row.request as MessagesRequest),
    messages: requestMessages,
  };
  const rawProcessed = row.processedRequest;
  let processedRequest: unknown;
  if (rawProcessed == null) {
    processedRequest = null;
  } else if (Array.isArray((rawProcessed as MessagesRequest).messages)) {
    processedRequest = {
      ...(rawProcessed as MessagesRequest),
      messages: processedMessages ?? [],
    };
  } else {
    processedRequest = rawProcessed;
  }
  return { request, processedRequest };
}

function longestCommonPrefixLen(a: unknown[], b: unknown[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  for (; i < n; i++) {
    if (hashMessage(a[i]) !== hashMessage(b[i])) break;
  }
  return i;
}

/** Stable (key-sorted) sha256 so equal messages hash equal regardless of key order. */
function hashMessage(message: unknown): string {
  return createHash("sha256").update(stableStringify(message)).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export default InteractionDeltaManager;
