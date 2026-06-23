import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const memoryScopeEnum = ["user", "team", "org"] as const;

export const agentMemoryTable = pgTable("agent_memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  scope: text("scope", { enum: memoryScopeEnum }).notNull(),
  scopeId: uuid("scope_id").notNull(),
  agentId: uuid("agent_id"),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
