import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createAgentMemory,
  deleteAgentMemory,
  getAgentMemoriesByScope,
  updateAgentMemory,
} from "@/models/agent-memory";
import {
  InsertAgentMemorySchema,
  UpdateAgentMemorySchema,
} from "@/types/agent-memory";

import { RouteId } from "@archestra/shared";

export default async function agentMemoryRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/",
    {
      schema: {
        operationId: RouteId.CreateAgentMemory,
        body: InsertAgentMemorySchema,

        response: {
          200: z.object({ id: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const memory = await createAgentMemory(request.body);
      return reply.send({ id: memory.id });
    },
  );

  fastify.get(
    "/",
    {
      schema: {
        operationId: RouteId.GetAgentMemories,
        querystring: z.object({
          scope: z.enum(["user", "team", "org"]),
          scopeId: z.string().uuid(),
          agentId: z.string().uuid().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { scope, scopeId, agentId } = request.query;
      const memories = await getAgentMemoriesByScope(scope, scopeId, agentId);
      return reply.send({ data: memories });
    },
  );

  fastify.put(
    "/:id",
    {
      schema: {
        operationId: RouteId.UpdateAgentMemory,
        params: z.object({ id: z.string().uuid() }),
        body: UpdateAgentMemorySchema,
      },
    },
    async (request, reply) => {
      const memory = await updateAgentMemory(request.params.id, request.body);
      if (!memory) {
        return reply.status(404).send({ error: "Memory not found" });
      }
      return reply.send({ data: memory });
    },
  );

  fastify.delete(
    "/:id",
    {
      schema: {
        operationId: RouteId.DeleteAgentMemory,
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const memory = await deleteAgentMemory(request.params.id);
      if (!memory) {
        return reply.status(404).send({ error: "Memory not found" });
      }
      return reply.send({ success: true });
    },
  );
}
