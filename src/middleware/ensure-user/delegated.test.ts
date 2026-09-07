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
import type * as DelegatedModule from "./delegated";

const mockEnv = vi.hoisted(() => ({ DATABASE_PROVIDER: "d1" }));

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));

const delegatedOrganization = vi.hoisted(() => ({
  ensureDelegatedOrganizationForUser: vi.fn(),
  ensureSharedWorkspaceOrganization: vi.fn(),
}));

vi.mock("@/server/auth/delegated-organization", () => delegatedOrganization);

let client: Client;
let Delegated: typeof DelegatedModule;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client, { schema: { user } });
  await client.executeMultiple(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL,
      image TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      analytics_opted_out INTEGER,
      last_active_organization_id TEXT
    );
  `);

  // The production module binds its provider-aware db at import time. A real
  // in-memory SQLite database verifies the email-unique collision behavior.
  vi.doMock("@/db", () => ({ db: testDb }));
  Delegated = await import("./delegated");
});

afterAll(() => client.close());

beforeEach(async () => {
  await client.execute("DELETE FROM user");
  delegatedOrganization.ensureSharedWorkspaceOrganization.mockResolvedValue(
    "shared-workspace",
  );
});

describe("resolveSharedWorkspaceContext", () => {
  it("keeps a hosted user's id when Cloudflare Access presents the same verified email", async () => {
    await client.execute({
      sql: "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: ["better-auth-user", "Bjorn", "bjoern@apps3k.com", 1, 1, 1],
    });

    await expect(
      Delegated.resolveSharedWorkspaceContext(
        "cloudflare-access-subject",
        "bjoern@apps3k.com",
      ),
    ).resolves.toMatchObject({
      userId: "better-auth-user",
      userEmail: "bjoern@apps3k.com",
      organizationId: "shared-workspace",
    });

    expect((await client.execute("SELECT id FROM user")).rows).toEqual([
      expect.objectContaining({ id: "better-auth-user" }),
    ]);
  });

  it("creates a Cloudflare Access identity when the verified email is new", async () => {
    await expect(
      Delegated.resolveSharedWorkspaceContext(
        "cloudflare-access-subject",
        "new-user@apps3k.com",
      ),
    ).resolves.toMatchObject({
      userId: "cloudflare-access-subject",
      userEmail: "new-user@apps3k.com",
    });
  });
});
