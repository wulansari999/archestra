import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { LimitCleanupInterval } from "@/types";
import environmentsTable from "./environment";
import organizationsTable from "./organization";

/**
 * Per-environment default token-cost limit applied to every organization member
 * for usage within a single environment. This specializes the organization-wide
 * default user limit (organizations.default_user_limit_*): when a row exists for
 * the request's environment it overrides the org-wide default for that
 * environment; environments without a row fall back to the org-wide default.
 *
 * Usage is computed per user from interactions snapshotted to the environment
 * (interactions.environment_id), so this is the per-user-within-an-environment
 * cap — distinct from an environment-scoped row in the `limits` table, which
 * caps total (all-user) usage in the environment.
 */
const environmentDefaultUserLimitsTable = pgTable(
  "environment_default_user_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environmentsTable.id, { onDelete: "cascade" }),
    /** Token-cost limit value in dollars. */
    limitValue: integer("limit_value").notNull(),
    /** Models covered by the limit. Null means all models. */
    model: jsonb("model").$type<string[] | null>(),
    cleanupInterval: varchar("cleanup_interval")
      .$type<LimitCleanupInterval>()
      .notNull()
      .default("calendar_month"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One default per environment.
    unique("environment_default_user_limits_environment_unique").on(
      table.environmentId,
    ),
    index("environment_default_user_limits_org_idx").on(table.organizationId),
  ],
);

export default environmentDefaultUserLimitsTable;
