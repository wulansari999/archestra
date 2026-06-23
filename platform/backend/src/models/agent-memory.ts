import { and, eq } from "drizzle-orm";
import { getDb } from "@/database";
import { agentMemoriesTable } from "@/database/schemas";
import type { AgentMemoryScope, InsertAgentMemory, UpdateAgentMemory } from "@/types/agent-memory";

export async function createAgentMemory(data: InsertAgentMemory) {
  const db = getDb();
  const [memory] = await db
    .insert(agentMemoriesTable)
    .values(data)
    .returning();
  return memory;
}

export async function getAgentMemoriesByScope(
  scope: AgentMemoryScope,
  scopeId: string,
  agentId?: string | null
) {
  const db = getDb();
  const conditions = [
    eq(agentMemoriesTable.scope, scope),
    eq(agentMemoriesTable.scopeId, scopeId),
  ];

  if (agentId !== undefined) {
    if (agentId === null) {
      // In Drizzle, we might want to check for isNull if explicitly looking for global memories
      // but typically we can just match agentId directly
    } else {
      conditions.push(eq(agentMemoriesTable.agentId, agentId));
    }
  }

  return db
    .select()
    .from(agentMemoriesTable)
    .where(and(...conditions))
    .orderBy(agentMemoriesTable.createdAt);
}

export async function updateAgentMemory(id: string, data: UpdateAgentMemory) {
  const db = getDb();
  const [memory] = await db
    .update(agentMemoriesTable)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(agentMemoriesTable.id, id))
    .returning();
  return memory;
}

export async function deleteAgentMemory(id: string) {
  const db = getDb();
  const [memory] = await db
    .delete(agentMemoriesTable)
    .where(eq(agentMemoriesTable.id, id))
    .returning();
  return memory;
}
