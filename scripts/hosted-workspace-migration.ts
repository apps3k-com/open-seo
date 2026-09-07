#!/usr/bin/env tsx
/**
 * Move explicit legacy Better Auth workspaces into Cloudflare Access's shared
 * workspace without rewriting user ids. This is intentionally an operator
 * command rather than a deploy hook: a change of auth mode must never infer
 * which organizations are safe to move.
 *
 * Example (preview first):
 *   pnpm tsx scripts/hosted-workspace-migration.ts \
 *     --database open-seo-db-selfhost --source-org <organization-id>
 *
 * Apply the reviewed plan:
 *   pnpm tsx scripts/hosted-workspace-migration.ts \
 *     --database open-seo-db-selfhost --source-org <organization-id> --apply
 *
 * Roll back the exact recorded rows before restoring AUTH_MODE=hosted:
 *   pnpm tsx scripts/hosted-workspace-migration.ts \
 *     --database open-seo-db-selfhost --rollback --apply
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";

const runFile = promisify(execFile);
const SHARED_WORKSPACE_ID = "shared-workspace";
const MIGRATION_ID = "hosted-to-cloudflare-access-v1";

type Row = Record<string, unknown>;
type ProjectRow = Row & {
  id: string;
  organization_id: string;
  name: string;
  domain: string | null;
  archived_at: string | null;
  organization_name: string;
};

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    database: { type: "string" },
    "migration-id": { type: "string", default: MIGRATION_ID },
    rollback: { type: "boolean", default: false },
    "source-org": { type: "string", multiple: true },
  },
  strict: true,
});

const migrationId = values["migration-id"];
const sourceOrgIds = values["source-org"] ?? [];

if (!values.database) {
  throw new Error("Pass --database <D1 database name>.");
}
const database = values.database;
if (values.rollback && sourceOrgIds.length > 0) {
  throw new Error("--rollback uses the journal; do not pass --source-org.");
}
if (!values.rollback && sourceOrgIds.length === 0) {
  throw new Error("Pass at least one reviewed --source-org <organization-id>.");
}

function quote(value: string | null) {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

function list(values: string[]) {
  return values.map(quote).join(", ");
}

function rowsFromWrangler(stdout: string): Row[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed))
    throw new Error("Unexpected Wrangler JSON output.");
  const first = parsed[0] as { results?: Row[]; success?: boolean } | undefined;
  if (!first?.success) throw new Error("D1 rejected the SQL command.");
  return first.results ?? [];
}

async function query(sql: string) {
  const { stdout } = await runFile(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      database,
      "--remote",
      "--json",
      "--command",
      sql,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return rowsFromWrangler(stdout);
}

async function execute(sql: string) {
  await query(sql);
}

async function describeForwardMigration() {
  const organizations = await query(
    `SELECT id, name FROM organization WHERE id IN (${list(sourceOrgIds)}) ORDER BY id`,
  );
  if (organizations.length !== sourceOrgIds.length) {
    throw new Error(
      `Refusing to migrate: expected ${sourceOrgIds.length} source organizations, found ${organizations.length}.`,
    );
  }

  const projects = (await query(`
    SELECT p.id, p.organization_id, p.name, p.domain, p.archived_at,
           o.name AS organization_name
    FROM projects p
    JOIN organization o ON o.id = p.organization_id
    WHERE p.organization_id IN (${list(sourceOrgIds)})
    ORDER BY p.organization_id, p.id
  `)) as ProjectRow[];
  const gsc = await query(
    `SELECT id, organization_id FROM gsc_connections WHERE organization_id IN (${list(sourceOrgIds)})`,
  );
  const ga4 = await query(
    `SELECT id, organization_id FROM ga4_connections WHERE organization_id IN (${list(sourceOrgIds)})`,
  );
  const onboarding = await query(
    `SELECT user_id, organization_id FROM user_onboarding_answers WHERE organization_id IN (${list(sourceOrgIds)})`,
  );
  const activation = await query(`
    SELECT organization_id, first_mcp_authorized_at, first_mcp_tool_call_at
    FROM organization_activation_state
    WHERE organization_id IN (${list([SHARED_WORKSPACE_ID, ...sourceOrgIds])})
  `);
  const sharedDefault = await query(`
    SELECT id FROM projects
    WHERE organization_id = ${quote(SHARED_WORKSPACE_ID)}
      AND name = 'Default' AND domain IS NULL AND archived_at IS NULL
    LIMIT 1
  `);

  let targetHasDefault = sharedDefault.length > 0;
  const renamedProjects = new Map<string, string>();
  for (const project of projects) {
    const isDefault =
      project.name === "Default" &&
      project.domain === null &&
      project.archived_at === null;
    if (!isDefault) continue;
    if (!targetHasDefault) {
      targetHasDefault = true;
      continue;
    }
    renamedProjects.set(
      project.id,
      `Default (${project.organization_name || project.organization_id} ${project.organization_id})`,
    );
  }

  return {
    activation,
    ga4,
    gsc,
    onboarding,
    organizations,
    projects,
    renamedProjects,
  };
}

function earliest(rows: Row[], field: string) {
  const values = rows
    .map((row) => row[field])
    .filter((value): value is string => typeof value === "string")
    .sort();
  return values[0] ?? null;
}

function journalStatements(
  migration: Awaited<ReturnType<typeof describeForwardMigration>>,
) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS hosted_workspace_migration_items (
      migration_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      source_organization_id TEXT NOT NULL,
      previous_name TEXT,
      PRIMARY KEY (migration_id, table_name, row_id)
    )`,
    `CREATE TABLE IF NOT EXISTS hosted_workspace_migration_metadata (
      migration_id TEXT PRIMARY KEY,
      previous_shared_activation TEXT
    )`,
    `INSERT OR IGNORE INTO organization (id, name, slug, created_at)
      VALUES (${quote(SHARED_WORKSPACE_ID)}, 'Shared workspace', ${quote(SHARED_WORKSPACE_ID)}, CAST(unixepoch('subsecond') * 1000 AS INTEGER))`,
  ];

  for (const project of migration.projects) {
    statements.push(
      `INSERT OR IGNORE INTO hosted_workspace_migration_items
        (migration_id, table_name, row_id, source_organization_id, previous_name)
       VALUES (${quote(migrationId)}, 'projects', ${quote(project.id)}, ${quote(project.organization_id)}, ${quote(project.name)})`,
    );
    const renamed = migration.renamedProjects.get(project.id);
    if (renamed) {
      statements.push(
        `UPDATE projects SET name = ${quote(renamed)} WHERE id = ${quote(project.id)} AND organization_id = ${quote(project.organization_id)}`,
      );
    }
    statements.push(
      `UPDATE projects SET organization_id = ${quote(SHARED_WORKSPACE_ID)} WHERE id = ${quote(project.id)} AND organization_id = ${quote(project.organization_id)}`,
    );
  }

  for (const [table, rows, idColumn] of [
    ["gsc_connections", migration.gsc, "id"],
    ["ga4_connections", migration.ga4, "id"],
    ["user_onboarding_answers", migration.onboarding, "user_id"],
  ] as const) {
    for (const row of rows) {
      const id = String(row[idColumn]);
      const sourceOrgId = String(row.organization_id);
      statements.push(
        `INSERT OR IGNORE INTO hosted_workspace_migration_items
          (migration_id, table_name, row_id, source_organization_id)
         VALUES (${quote(migrationId)}, ${quote(table)}, ${quote(id)}, ${quote(sourceOrgId)})`,
        `UPDATE ${table} SET organization_id = ${quote(SHARED_WORKSPACE_ID)}
         WHERE ${idColumn} = ${quote(id)} AND organization_id = ${quote(sourceOrgId)}`,
      );
    }
  }

  const previousActivation = migration.activation.find(
    (row) => row.organization_id === SHARED_WORKSPACE_ID,
  );
  statements.push(
    `INSERT OR IGNORE INTO hosted_workspace_migration_metadata (migration_id, previous_shared_activation)
     VALUES (${quote(migrationId)}, ${quote(previousActivation ? JSON.stringify(previousActivation) : null)})`,
  );
  const authorizedAt = earliest(
    migration.activation,
    "first_mcp_authorized_at",
  );
  const toolCallAt = earliest(migration.activation, "first_mcp_tool_call_at");
  if (authorizedAt || toolCallAt) {
    statements.push(`
      INSERT INTO organization_activation_state
        (organization_id, first_mcp_authorized_at, first_mcp_tool_call_at)
      VALUES (${quote(SHARED_WORKSPACE_ID)}, ${quote(authorizedAt)}, ${quote(toolCallAt)})
      ON CONFLICT(organization_id) DO UPDATE SET
        first_mcp_authorized_at = excluded.first_mcp_authorized_at,
        first_mcp_tool_call_at = excluded.first_mcp_tool_call_at)
    `);
  }
  return statements;
}

async function rollback() {
  const items = await query(`
    SELECT table_name, row_id, source_organization_id, previous_name
    FROM hosted_workspace_migration_items
    WHERE migration_id = ${quote(migrationId)}
    ORDER BY table_name, row_id
  `);
  if (items.length === 0) {
    throw new Error(`No journal entries found for migration ${migrationId}.`);
  }
  console.log(
    `Rollback plan: ${items.length} recorded rows for ${migrationId}.`,
  );
  if (!values.apply) return;

  const metadata = await query(`
    SELECT previous_shared_activation FROM hosted_workspace_migration_metadata
    WHERE migration_id = ${quote(migrationId)}
  `);
  const statements = items.flatMap((item) => {
    const table = String(item.table_name);
    const rowId = String(item.row_id);
    const sourceOrgId = String(item.source_organization_id);
    if (table === "projects") {
      return [
        `UPDATE projects SET organization_id = ${quote(sourceOrgId)}, name = ${quote(item.previous_name as string)}
         WHERE id = ${quote(rowId)} AND organization_id = ${quote(SHARED_WORKSPACE_ID)}`,
      ];
    }
    const idColumn = table === "user_onboarding_answers" ? "user_id" : "id";
    return [
      `UPDATE ${table} SET organization_id = ${quote(sourceOrgId)}
       WHERE ${idColumn} = ${quote(rowId)} AND organization_id = ${quote(SHARED_WORKSPACE_ID)}`,
    ];
  });
  const previous = metadata[0]?.previous_shared_activation;
  if (previous === null || previous === undefined) {
    statements.push(
      `DELETE FROM organization_activation_state WHERE organization_id = ${quote(SHARED_WORKSPACE_ID)}`,
    );
  } else {
    const activation = JSON.parse(String(previous)) as Row;
    statements.push(`
      INSERT INTO organization_activation_state
        (organization_id, first_mcp_authorized_at, first_mcp_tool_call_at)
      VALUES (${quote(SHARED_WORKSPACE_ID)}, ${quote(activation.first_mcp_authorized_at as string | null)}, ${quote(activation.first_mcp_tool_call_at as string | null)})
      ON CONFLICT(organization_id) DO UPDATE SET
        first_mcp_authorized_at = excluded.first_mcp_authorized_at,
        first_mcp_tool_call_at = excluded.first_mcp_tool_call_at
    `);
  }
  await execute(`BEGIN IMMEDIATE; ${statements.join(";\n")}; COMMIT;`);
  console.log(
    "Rollback applied. Keep the journal until hosted authentication is verified.",
  );
}

async function main() {
  if (values.rollback) {
    await rollback();
    return;
  }
  const migration = await describeForwardMigration();
  console.log(
    JSON.stringify(
      {
        migrationId,
        sourceOrganizations: migration.organizations,
        projects: migration.projects.length,
        gscConnections: migration.gsc.length,
        ga4Connections: migration.ga4.length,
        onboardingRows: migration.onboarding.length,
        renamedProjects: Object.fromEntries(migration.renamedProjects),
      },
      null,
      2,
    ),
  );
  if (!values.apply) {
    console.log("Dry run only. Re-run with --apply after reviewing this plan.");
    return;
  }
  await execute(
    `BEGIN IMMEDIATE; ${journalStatements(migration).join(";\n")}; COMMIT;`,
  );
  console.log(
    "Migration applied. Re-run without --apply to verify there are no remaining source rows.",
  );
}

await main();
