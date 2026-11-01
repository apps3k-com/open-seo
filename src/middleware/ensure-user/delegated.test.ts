import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { user } from "@/db/better-auth-schema";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let resolveSharedWorkspaceContext: typeof import("./delegated").resolveSharedWorkspaceContext;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client, { schema: { user } });
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/server/auth/delegated-organization", () => ({
    ensureSharedWorkspaceOrganization: async () => "shared-workspace",
    ensureDelegatedOrganizationForUser: async () => "delegated-local-admin",
  }));

  await client.executeMultiple(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
      updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
      analytics_opted_out INTEGER,
      terms_accepted_version TEXT,
      terms_accepted_at INTEGER,
      product_updates_opt_in INTEGER,
      product_updates_changed_at INTEGER,
      last_active_organization_id TEXT
    );
  `);

  ({ resolveSharedWorkspaceContext } = await import("./delegated"));
});

afterAll(() => client.close());
beforeEach(async () => {
  await client.execute("DELETE FROM user");
});

describe("Cloudflare Access user resolution", () => {
  it("keeps the existing user id when a verified email has a different Access subject", async () => {
    await client.execute({
      sql: "INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, ?)",
      args: ["legacy-better-auth-id", "Existing user", "owner@example.com", 1],
    });

    const context = await resolveSharedWorkspaceContext(
      "new-access-subject",
      "owner@example.com",
    );

    expect(context.userId).toBe("legacy-better-auth-id");
    expect(context.organizationId).toBe("shared-workspace");
    expect(
      (await client.execute("SELECT id FROM user")).rows.map((row) => row.id),
    ).toEqual(["legacy-better-auth-id"]);
  });

  it("creates an Access user when the verified email is new", async () => {
    const context = await resolveSharedWorkspaceContext(
      "new-access-subject",
      "new@example.com",
    );

    expect(context.userId).toBe("new-access-subject");
    expect(
      (await client.execute("SELECT id FROM user")).rows.map((row) => row.id),
    ).toEqual(["new-access-subject"]);
  });
});
