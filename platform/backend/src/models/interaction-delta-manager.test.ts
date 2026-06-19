import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { beforeEach, describe, expect, test } from "@/test";
import type { InsertInteraction } from "@/types";
import InteractionModel from "./interaction";
import InteractionDeltaManager from "./interaction-delta-manager";

// Minimal Anthropic-style response (only needs to be valid JSONB).
const RESPONSE = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-3-5-sonnet",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

function userMsg(text: string) {
  return { role: "user", content: text };
}
function assistantMsg(text: string) {
  return { role: "assistant", content: text };
}

function anthropicRequest(messages: unknown[]) {
  return {
    model: "claude-3-5-sonnet",
    max_tokens: 1024,
    system: "You are a helpful assistant.",
    messages,
  };
}

describe("InteractionDeltaManager", () => {
  let profileId: string;

  beforeEach(async ({ makeAgent }) => {
    const agent = await makeAgent();
    profileId = agent.id;
    // Start every test with cold caches so cross-test in-memory state never leaks.
    InteractionDeltaManager.reset();
  });

  function createClaude(
    messages: unknown[],
    opts: {
      sessionId: string;
      sessionSource?: string;
      processedMessages?: unknown[] | null;
      createdAt?: Date;
    },
  ) {
    const data: InsertInteraction = {
      profileId,
      sessionId: opts.sessionId,
      sessionSource: opts.sessionSource ?? "claude_code",
      type: "anthropic:messages",
      request: anthropicRequest(messages) as InsertInteraction["request"],
      response: RESPONSE as unknown as InsertInteraction["response"],
    };
    if (opts.processedMessages !== undefined) {
      data.processedRequest = (
        opts.processedMessages === null
          ? null
          : anthropicRequest(opts.processedMessages)
      ) as InsertInteraction["processedRequest"];
    }
    if (opts.createdAt) {
      data.createdAt = opts.createdAt;
    }
    return InteractionModel.create(data);
  }

  async function rawRow(id: string) {
    const [row] = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, id));
    return row;
  }

  // Insert a row the way the OLD (pre-feature) code did: full request stored, no
  // delta metadata (thread_id / parent_id NULL). Bypasses encodeOnWrite on purpose.
  async function insertLegacyRow(sessionId: string, messages: unknown[]) {
    const [row] = await db
      .insert(schema.interactionsTable)
      .values({
        profileId,
        sessionId,
        sessionSource: "claude_code",
        type: "anthropic:messages",
        request: anthropicRequest(messages) as InsertInteraction["request"],
        response: RESPONSE as unknown as InsertInteraction["response"],
      })
      .returning();
    return row;
  }

  function reconstructedMessages(request: unknown): unknown[] {
    return (request as { messages: unknown[] }).messages;
  }

  test("happy path: stores deltas and reconstructs the full request", async () => {
    const sessionId = "sess-happy";
    const m0 = userMsg("first user message");
    const msgs1 = [m0];
    const msgs2 = [m0, assistantMsg("a0"), userMsg("m1")];
    const msgs3 = [...msgs2, assistantMsg("a1"), userMsg("m2")];

    const r1 = await createClaude(msgs1, { sessionId });
    const r2 = await createClaude(msgs2, { sessionId });
    const r3 = await createClaude(msgs3, { sessionId });

    // Head row stores full messages, no parent.
    expect(r1.parentId).toBeNull();
    expect(r1.threadId).not.toBeNull();
    expect(r1.requestSharedPrefix).toBe(0);
    expect(r1.requestLastMessageIdx).toBe(0);

    // Children chain to their predecessor and store only the suffix.
    expect(r2.parentId).toBe(r1.id);
    expect(r2.requestSharedPrefix).toBe(1);
    expect(r3.parentId).toBe(r2.id);
    expect(r3.requestSharedPrefix).toBe(3);

    // All three share the same thread.
    expect(r2.threadId).toBe(r1.threadId);
    expect(r3.threadId).toBe(r1.threadId);

    // Raw stored request is the delta (only the 2 new messages), not all 5.
    const raw3 = await rawRow(r3.id);
    expect(reconstructedMessages(raw3.request)).toHaveLength(2);

    // findById reconstructs the full request.
    const full3 = await InteractionModel.findById(r3.id);
    expect(reconstructedMessages(full3?.request)).toEqual(msgs3);
    // Non-message envelope (system) is preserved.
    expect((full3?.request as { system?: string }).system).toBe(
      "You are a helpful assistant.",
    );
  });

  test("case 2: sub-agent thread is isolated from the main thread", async () => {
    const sessionId = "sess-subagent";
    const mainMsgs1 = [userMsg("main-0")];
    const mainMsgs2 = [
      userMsg("main-0"),
      assistantMsg("ma0"),
      userMsg("main-1"),
    ];

    await createClaude(mainMsgs1, { sessionId });
    const main2 = await createClaude(mainMsgs2, { sessionId });

    // Sub-agent request: brand new context (different messages[0]).
    const subMsgs = [userMsg("sub-agent task")];
    const sub = await createClaude(subMsgs, { sessionId });

    // Continue the main thread.
    const mainMsgs3 = [...mainMsgs2, assistantMsg("ma1"), userMsg("main-2")];
    const main3 = await createClaude(mainMsgs3, { sessionId });

    // Sub-agent is its own head (different thread, no parent, shared prefix 0).
    expect(sub.threadId).not.toBe(main2.threadId);
    expect(sub.parentId).toBeNull();
    expect(sub.requestSharedPrefix).toBe(0);

    // Main thread keeps chaining despite the sub-agent interleaving.
    expect(main3.parentId).toBe(main2.id);
    expect(main3.threadId).toBe(main2.threadId);

    // The full reconstructed main thread excludes sub-agent messages and vice versa.
    const fullMain = await InteractionModel.findById(main3.id);
    expect(reconstructedMessages(fullMain?.request)).toEqual(mainMsgs3);
    const fullSub = await InteractionModel.findById(sub.id);
    expect(reconstructedMessages(fullSub?.request)).toEqual(subMsgs);

    // Both the main-thread and the sub-agent interactions are listed in the
    // session logs for this sessionId (web UI session logs page).
    const listed = await InteractionModel.findAllPaginated(
      { limit: 100, offset: 0 },
      undefined,
      undefined,
      true,
      { sessionId },
    );
    const listedThreadIds = new Set(
      // threadId is internal plumbing (omitted from the public API type) but is
      // still present at the model layer; read it through `unknown` for the assert.
      listed.data.map(
        (i) => (i as unknown as { threadId: string | null }).threadId,
      ),
    );
    expect(listedThreadIds.has(main2.threadId)).toBe(true);
    expect(listedThreadIds.has(sub.threadId)).toBe(true);
    expect(listed.data.map((i) => i.id)).toEqual(
      expect.arrayContaining([main2.id, sub.id, main3.id]),
    );
  });

  test("case 3: concurrent branches share the first K messages", async () => {
    const sessionId = "sess-branches";
    const u0 = userMsg("u0");
    const rootMsgs = [u0, assistantMsg("a0"), userMsg("u1")]; // K = 3

    const root = await createClaude(rootMsgs, { sessionId });

    // Branch B (app B) extends the session by M messages.
    const bMsgs1 = [...rootMsgs, assistantMsg("bA"), userMsg("bU1")];
    const bMsgs2 = [...bMsgs1, assistantMsg("bA2"), userMsg("bU2")];
    const b1 = await createClaude(bMsgs1, { sessionId });
    const b2 = await createClaude(bMsgs2, { sessionId });

    // Branch A (app A) returns and continues from the Kth message.
    const aMsgs1 = [...rootMsgs, assistantMsg("aA"), userMsg("aU1")];
    const a1 = await createClaude(aMsgs1, { sessionId });

    // The K+1 request from A picks the root (idx 2) as parent, not B's longer rows.
    expect(a1.parentId).toBe(root.id);
    expect(a1.requestSharedPrefix).toBe(3);
    expect(b1.parentId).toBe(root.id);

    // Each branch reconstructs its own chain.
    const fullA = await InteractionModel.findById(a1.id);
    expect(reconstructedMessages(fullA?.request)).toEqual(aMsgs1);
    const fullB = await InteractionModel.findById(b2.id);
    expect(reconstructedMessages(fullB?.request)).toEqual(bMsgs2);
  });

  test("case 4: forks reaching the same index resolve the correct parent, not the most-recent one", async () => {
    const sessionId = "sess-fork-repro";
    const base = new Date("2020-02-02T00:00:00.000Z").getTime();
    const m0 = userMsg("m0 — shared opening with enough text");
    const m1 = assistantMsg("m1");
    const m2 = userMsg("m2");

    // root: [m0, m1, m2]  (last index 2)
    const root = await createClaude([m0, m1, m2], {
      sessionId,
      createdAt: new Date(base),
    });

    // App A continues: [m0, m1, m2, a3]  (last index 3)
    const a3 = assistantMsg("a3");
    const appA1 = await createClaude([m0, m1, m2, a3], {
      sessionId,
      createdAt: new Date(base + 1000),
    });

    // App B continues from the SAME root: [m0, m1, m2, b3]  (last index 3),
    // written LATER so it is the most-recent row — a naive LIMIT 1 would pick it.
    const b3 = assistantMsg("b3");
    const appB1 = await createClaude([m0, m1, m2, b3], {
      sessionId,
      createdAt: new Date(base + 2000),
    });

    // App A sends [m0, m1, m2, a3, a4]  (length 5).
    const a4 = userMsg("a4");
    const appA2 = await createClaude([m0, m1, m2, a3, a4], {
      sessionId,
      createdAt: new Date(base + 3000),
    });

    // Both A and B forked from root, sharing the first 3 messages.
    expect(appA1.parentId).toBe(root.id);
    expect(appA1.requestSharedPrefix).toBe(3);
    expect(appB1.parentId).toBe(root.id);
    expect(appB1.requestSharedPrefix).toBe(3);

    // B's row is the most-recent candidate at index 3, but its last message (b3)
    // doesn't match A's message at index 3 (a3). The candidate scan must skip the
    // most-recent row and pick App A's index-3 row as the parent.
    expect(appB1.createdAt.getTime()).toBeGreaterThan(
      appA1.createdAt.getTime(),
    );
    expect(appA2.parentId).toBe(appA1.id);
    expect(appA2.parentId).not.toBe(appB1.id);
    expect(appA2.requestSharedPrefix).toBe(4);

    // Each branch reconstructs its own chain; A's does not pull in b3 and vice versa.
    expect(
      reconstructedMessages(
        (await InteractionModel.findById(appA2.id))?.request,
      ),
    ).toEqual([m0, m1, m2, a3, a4]);
    expect(
      reconstructedMessages(
        (await InteractionModel.findById(appB1.id))?.request,
      ),
    ).toEqual([m0, m1, m2, b3]);
  });

  test("case 5: compaction starts a fresh chain that keeps growing", async () => {
    const sessionId = "sess-compaction";
    const preMsgs = [
      userMsg("pre-0 with enough text"),
      assistantMsg("pa0"),
      userMsg("pre-1"),
    ];
    const pre = await createClaude(preMsgs, { sessionId });

    // Compaction replaces history with a summary => new messages[0] => new thread.
    const compactedMsgs = [
      userMsg("[summary of the prior conversation so far]"),
    ];
    const compacted = await createClaude(compactedMsgs, { sessionId });

    // The compacted thread continues with several more turns.
    const postMsgs = [
      ...compactedMsgs,
      assistantMsg("ca0"),
      userMsg("post-1"),
      assistantMsg("ca1"),
      userMsg("post-2"),
    ];
    const post = await createClaude(postMsgs, { sessionId });

    expect(compacted.threadId).not.toBe(pre.threadId);
    expect(compacted.parentId).toBeNull();
    expect(compacted.requestSharedPrefix).toBe(0);
    // The post-compaction turns chain from the compaction head, not the old chain.
    expect(post.parentId).toBe(compacted.id);
    expect(post.threadId).toBe(compacted.threadId);

    // The 5-message post-compaction request reconstructs from its deltas...
    const fullPost = await InteractionModel.findById(post.id);
    expect(reconstructedMessages(fullPost?.request)).toEqual(postMsgs);
    // ...and the pre-compaction thread still reconstructs independently.
    const fullPre = await InteractionModel.findById(pre.id);
    expect(reconstructedMessages(fullPre?.request)).toEqual(preMsgs);
  });

  test("delta-encodes and reconstructs processedRequest independently", async () => {
    const sessionId = "sess-processed";
    const m0 = userMsg("p0");
    const reqMsgs1 = [m0];
    const reqMsgs2 = [m0, assistantMsg("pa0"), userMsg("p1")];
    // processed messages mirror the request messages (TOON/trusted-data rewrite content).
    const procMsgs1 = [userMsg("p0-processed")];
    const procMsgs2 = [
      userMsg("p0-processed"),
      assistantMsg("pa0"),
      userMsg("p1"),
    ];

    await createClaude(reqMsgs1, { sessionId, processedMessages: procMsgs1 });
    const r2 = await createClaude(reqMsgs2, {
      sessionId,
      processedMessages: procMsgs2,
    });

    expect(r2.processedRequestSharedPrefix).not.toBeNull();
    const full = await InteractionModel.findById(r2.id);
    expect(
      reconstructedMessages(
        (full as { processedRequest: unknown }).processedRequest,
      ),
    ).toEqual(procMsgs2);
  });

  test("null-safe when the parent has no processedRequest", async () => {
    const sessionId = "sess-processed-null";
    const m0 = userMsg("n0");
    // Parent has null processedRequest.
    await createClaude([m0], { sessionId, processedMessages: null });
    const procMsgs = [m0, assistantMsg("na0"), userMsg("n1")];
    const r2 = await createClaude([m0, assistantMsg("na0"), userMsg("n1")], {
      sessionId,
      processedMessages: procMsgs,
    });

    // No parent processed => store full, prefix 0.
    expect(r2.processedRequestSharedPrefix).toBe(0);
    const full = await InteractionModel.findById(r2.id);
    expect(
      reconstructedMessages(
        (full as { processedRequest: unknown }).processedRequest,
      ),
    ).toEqual(procMsgs);
  });

  test("legacy / non-Claude rows are stored and read verbatim", async ({
    makeInteraction,
  }) => {
    const legacy = await makeInteraction(profileId, {
      request: {
        model: "gpt-4",
        messages: [{ role: "user", content: "legacy hello" }],
      },
      type: "openai:chatCompletions",
    });

    const raw = await rawRow(legacy.id);
    expect(raw.threadId).toBeNull();
    expect(raw.parentId).toBeNull();

    const full = await InteractionModel.findById(legacy.id);
    expect(full?.request).toEqual(legacy.request);
  });

  test("reconstructs from a cold cache via the DB fallback", async () => {
    const sessionId = "sess-cold";
    const msgs = [userMsg("c0")];
    const msgs2 = [userMsg("c0"), assistantMsg("ca0"), userMsg("c1")];
    const msgs3 = [...msgs2, assistantMsg("ca1"), userMsg("c2")];
    const msgs4 = [...msgs3, assistantMsg("ca2"), userMsg("c3")];
    await createClaude(msgs, { sessionId });
    await createClaude(msgs2, { sessionId });
    await createClaude(msgs3, { sessionId });
    const tip = await createClaude(msgs4, { sessionId });

    // Drop all in-memory state — reconstruction must rebuild purely from the DB.
    InteractionDeltaManager.reset();

    const full = await InteractionDeltaManager.reconstructRow({
      id: tip.id,
      threadId: tip.threadId,
      request: tip.request,
      processedRequest: tip.processedRequest,
    });
    expect(reconstructedMessages(full.request)).toEqual(msgs4);
  });

  test("reconstructMany rebuilds tips across multiple sessions", async () => {
    const aMsgs = [userMsg("A0"), assistantMsg("Aa0"), userMsg("A1")];
    const bMsgs = [userMsg("B0"), assistantMsg("Ba0"), userMsg("B1")];
    await createClaude([userMsg("A0")], { sessionId: "sess-A" });
    const aTip = await createClaude(aMsgs, { sessionId: "sess-A" });
    await createClaude([userMsg("B0")], { sessionId: "sess-B" });
    const bTip = await createClaude(bMsgs, { sessionId: "sess-B" });

    InteractionDeltaManager.reset();

    const map = await InteractionDeltaManager.reconstructMany([
      { id: aTip.id, threadId: aTip.threadId, request: aTip.request },
      { id: bTip.id, threadId: bTip.threadId, request: bTip.request },
    ]);

    expect(reconstructedMessages(map.get(aTip.id)?.request)).toEqual(aMsgs);
    expect(reconstructedMessages(map.get(bTip.id)?.request)).toEqual(bMsgs);
  });

  test("claude_desktop interactions are delta-encoded too", async () => {
    const sessionId = "sess-desktop";
    const m0 = userMsg("desktop-0");
    const msgs2 = [m0, assistantMsg("da0"), userMsg("desktop-1")];
    const r1 = await createClaude([m0], {
      sessionId,
      sessionSource: "claude_desktop",
    });
    const r2 = await createClaude(msgs2, {
      sessionId,
      sessionSource: "claude_desktop",
    });

    expect(r1.threadId).not.toBeNull();
    expect(r2.parentId).toBe(r1.id);
    const full = await InteractionModel.findById(r2.id);
    expect(reconstructedMessages(full?.request)).toEqual(msgs2);
  });

  test("reconstructs a long multi-turn conversation from small deltas", async () => {
    const sessionId = "sess-deep";
    // 9 requests: turn 0, then each request appends an assistant reply + a user turn.
    const messages: unknown[] = [
      userMsg("turn 0 — opening question with text"),
    ];
    const rows = [await createClaude([...messages], { sessionId })];
    for (let t = 1; t <= 8; t++) {
      messages.push(
        assistantMsg(`assistant reply ${t}`),
        userMsg(`user turn ${t}`),
      );
      rows.push(await createClaude([...messages], { sessionId }));
    }
    expect(messages).toHaveLength(17); // 1 + 8*2

    // The head stored its single message; every other row stored only its 2-message
    // delta — never the whole growing history.
    expect(
      reconstructedMessages((await rawRow(rows[0].id)).request),
    ).toHaveLength(1);
    for (let i = 1; i < rows.length; i++) {
      expect(
        reconstructedMessages((await rawRow(rows[i].id)).request),
      ).toHaveLength(2);
      expect(rows[i].parentId).toBe(rows[i - 1].id);
    }

    // The tip reconstructs the entire 17-message conversation from those deltas.
    const tip = await InteractionModel.findById(rows[rows.length - 1].id);
    expect(reconstructedMessages(tip?.request)).toEqual(messages);

    // A mid-chain row reconstructs the conversation as it stood at that point.
    const mid = await InteractionModel.findById(rows[4].id);
    expect(reconstructedMessages(mid?.request)).toHaveLength(1 + 4 * 2); // 9
  });

  test("a session opened before the feature delta-encodes and reconstructs its next messages", async () => {
    const sessionId = "sess-legacy-then-delta";
    // Pre-feature rows: full request stored, no delta metadata.
    const legacyMsgs1 = [userMsg("legacy turn 0 with sufficient length")];
    const legacyMsgs2 = [
      ...legacyMsgs1,
      assistantMsg("legacy reply"),
      userMsg("legacy turn 1"),
    ];
    await insertLegacyRow(sessionId, legacyMsgs1);
    const legacy2 = await insertLegacyRow(sessionId, legacyMsgs2);

    // Legacy rows carry no delta metadata and read back verbatim.
    expect(legacy2.threadId).toBeNull();
    expect(legacy2.parentId).toBeNull();
    const fullLegacy = await InteractionModel.findById(legacy2.id);
    expect(reconstructedMessages(fullLegacy?.request)).toEqual(legacyMsgs2);

    // First request after the release continues the same conversation. It cannot
    // delta against a legacy row (those have no thread_id), so it becomes a full
    // head that starts a fresh delta chain.
    const next1Msgs = [
      ...legacyMsgs2,
      assistantMsg("reply 2"),
      userMsg("turn 2"),
    ];
    const next1 = await createClaude(next1Msgs, { sessionId });
    expect(next1.threadId).not.toBeNull();
    expect(next1.parentId).toBeNull();
    expect(next1.requestSharedPrefix).toBe(0);

    // The following request delta-encodes against next1 and reconstructs in full.
    const next2Msgs = [
      ...next1Msgs,
      assistantMsg("reply 3"),
      userMsg("turn 3"),
    ];
    const next2 = await createClaude(next2Msgs, { sessionId });
    expect(next2.parentId).toBe(next1.id);
    expect(
      reconstructedMessages((await rawRow(next2.id)).request),
    ).toHaveLength(2);
    const fullNext2 = await InteractionModel.findById(next2.id);
    expect(reconstructedMessages(fullNext2?.request)).toEqual(next2Msgs);
  });

  test("reconstructs correctly with a warm cache and with a partially warm cache", async () => {
    const sessionId = "sess-warm";
    const messages: unknown[] = [userMsg("warm turn 0 with enough text")];
    const rows = [await createClaude([...messages], { sessionId })];
    for (let t = 1; t <= 5; t++) {
      messages.push(assistantMsg(`a${t}`), userMsg(`u${t}`));
      rows.push(await createClaude([...messages], { sessionId }));
    }
    const tip = rows[rows.length - 1];

    // (1) Fully warm: caches were populated on every write; reconstruct without reset.
    const warm = await InteractionDeltaManager.reconstructRow({
      id: tip.id,
      threadId: tip.threadId,
      request: tip.request,
      processedRequest: tip.processedRequest,
    });
    expect(reconstructedMessages(warm.request)).toEqual(messages);

    // (2) Warm tip-cache parent resolution: a new write resolves its parent from the
    // in-memory tip cache (no reset) and chains correctly.
    messages.push(assistantMsg("a6"), userMsg("u6"));
    const next = await createClaude([...messages], { sessionId });
    expect(next.parentId).toBe(tip.id);
    expect(
      reconstructedMessages(
        (await InteractionModel.findById(next.id))?.request,
      ),
    ).toEqual(messages);

    // (3) Partially warm: clear caches, warm only a mid ancestor, then reconstruct the
    // tip — the fold reuses the cached ancestor and loads the rest from the DB.
    InteractionDeltaManager.reset();
    await InteractionDeltaManager.reconstructRow({
      id: rows[2].id,
      threadId: rows[2].threadId,
      request: rows[2].request,
      processedRequest: rows[2].processedRequest,
    });
    const partial = await InteractionDeltaManager.reconstructRow({
      id: next.id,
      threadId: next.threadId,
      request: next.request,
      processedRequest: next.processedRequest,
    });
    expect(reconstructedMessages(partial.request)).toEqual(messages);
  });
});
