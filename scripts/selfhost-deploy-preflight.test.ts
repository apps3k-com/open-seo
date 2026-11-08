import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/selfhost-deploy-preflight.mjs");

function preflight(overrides: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), "openseo-preflight-"));
  try {
    writeFileSync(
      join(cwd, ".env.selfhost"),
      Object.entries({
        AUTH_MODE: "password",
        SELFHOST_DOMAIN: "seo.example.com",
        DATAFORSEO_API_KEY: "test-provider-key",
        GOOGLE_CLIENT_ID: "existing-client",
        GOOGLE_CLIENT_SECRET: "existing-client-secret",
        BETTER_AUTH_SECRET: "existing-encryption-secret-at-least-32-characters",
        ...overrides,
      })
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
    return spawnSync(process.execPath, [script], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_API_TOKEN: "test-deployment-token" },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("custom-domain auth deployment preflight", () => {
  it("allows native password auth without Access configuration or callback probes", () => {
    const result = preflight({});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("retains the existing Google encryption guard in password mode", () => {
    const result = preflight({ BETTER_AUTH_SECRET: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BETTER_AUTH_SECRET");
  });

  it("refuses to create a replacement Access application on a custom domain", () => {
    const result = preflight({ AUTH_MODE: "cloudflare_access" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Refusing to provision a new Access application",
    );
  });
});
