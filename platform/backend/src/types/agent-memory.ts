import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-zod";
import type { z } from "zod";
import { agentMemoryTable } from "@/database/schemas/agent-memory";

export const SelectAgentMemorySchema = createSelectSchema(agentMemoryTable);
export const InsertAgentMemorySchema = createInsertSchema(agentMemoryTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const UpdateAgentMemorySchema = createUpdateSchema(agentMemoryTable).pick({
  content: true,
});

export type AgentMemory = z.infer<typeof SelectAgentMemorySchema>;
export type InsertAgentMemory = z.infer<typeof InsertAgentMemorySchema>;
export type UpdateAgentMemory = z.infer<typeof UpdateAgentMemorySchema>;
export type AgentMemoryScope = AgentMemory["scope"];
