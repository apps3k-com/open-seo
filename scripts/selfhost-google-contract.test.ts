import { describe, expect, it, vi } from "vitest";
import {
  validateGoogleOAuthDeployment,
  verifyGoogleCallbackAccess,
} from "./selfhost-google-contract.mjs";

describe("selfhost Google deployment contract", () => {
  const env = {
    GOOGLE_CLIENT_ID: "existing-client",
    GOOGLE_CLIENT_SECRET: "existing-client-secret",
    BETTER_AUTH_SECRET: "existing-token-encryption-secret-32-characters",
  };

  it("rejects an incomplete render before optional bindings can be cleared", () => {
    expect(() =>
      validateGoogleOAuthDeployment({ ...env, GOOGLE_CLIENT_SECRET: "" }),
    ).toThrow("GOOGLE_CLIENT_SECRET");
    expect(() =>
      validateGoogleOAuthDeployment({ ...env, BETTER_AUTH_SECRET: "short" }),
    ).toThrow("at least 32");
    expect(() => validateGoogleOAuthDeployment(env)).not.toThrow();
  });

  it("checks both callbacks against Access rather than following redirects", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "https://team.cloudflareaccess.com/login" },
      }),
    );
    await verifyGoogleCallbackAccess("openseo.example.com", request);
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "https://openseo.example.com/api/gsc/oauth/callback",
      "https://openseo.example.com/api/ga4/oauth/callback",
    ]);
    expect(request.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("accepts the Managed OAuth resource challenge", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="https://openseo.example.com/.well-known/cloudflare-access-protected-resource${path}"`,
        },
      });
    });
    await expect(
      verifyGoogleCallbackAccess("openseo.example.com", request),
    ).resolves.toBeUndefined();
  });

  it("blocks the regression where a bypass reaches the app's auth error", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 303,
        headers: { Location: "/auth-error?error=auth_config_missing" },
      }),
    );
    await expect(
      verifyGoogleCallbackAccess("openseo.example.com", request),
    ).rejects.toThrow("Remove any callback path bypass");
  });
});
