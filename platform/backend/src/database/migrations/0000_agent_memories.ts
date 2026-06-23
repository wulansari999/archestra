import { sql } from "drizzle-orm";

export async function up(db) {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "agent_memories" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "scope" text NOT NULL,
        "scope_id" uuid NOT NULL,
        "agent_id" uuid,
        "content" text NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
}

export async function down(db) {
  await db.execute(sql`
    DROP TABLE IF EXISTS "agent_memories";
  `);
}
