import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/server/lib/runtime-env", () => ({
  // AUTH_MODE unset: the deployment holds the DataForSEO key.
  getOptionalEnvValue: vi.fn(async () => undefined),
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
}));

import { DataforseoChargedTaskError } from "@/server/lib/dataforseo/envelope";
import { fetchLighthouseResult } from "@/server/lib/dataforseo/lighthouse";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLighthouseResult", () => {
  it.each(["mobile", "desktop"] as const)(
    "requests a device-appropriate Lighthouse browser identity for %s",
    async (strategy) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          status_code: 20000,
          tasks: [
            {
              status_code: 20000,
              cost: 0.005,
              path: ["v3", "on_page", "lighthouse", "live", "json"],
              result: [
                {
                  categories: { performance: { score: 0.47 } },
                  audits: { "http-status-code": { score: 1 } },
                },
              ],
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await fetchLighthouseResult({ url: "https://example.com/", strategy });
      const body = fetchMock.mock.calls[0]?.[1]?.body;
      if (typeof body !== "string")
        throw new Error("Expected a JSON request body");
      const [request] = z
        .array(
          z.object({ for_mobile: z.boolean(), custom_user_agent: z.string() }),
        )
        .parse(JSON.parse(body));
      expect(request.for_mobile).toBe(strategy === "mobile");
      expect(request.custom_user_agent).toContain(
        strategy === "mobile" ? "Android" : "Macintosh",
      );
      expect(request.custom_user_agent).toContain("Chrome-Lighthouse");
    },
  );

  it("carries billing metadata when parsing fails after a billed success", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        status_message: "Ok.",
        tasks: [
          {
            id: "task-1",
            status_code: 20000,
            status_message: "Ok.",
            path: ["v3", "on_page", "lighthouse", "live", "json"],
            cost: 0.00425,
            result: [
              {
                requestedUrl: "https://example.com/",
                finalUrl: "https://example.com/",
                categories: {},
                audits: {},
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const rejection = fetchLighthouseResult({
      url: "https://example.com/",
      strategy: "mobile",
    });

    await expect(rejection).rejects.toBeInstanceOf(DataforseoChargedTaskError);
    await expect(rejection).rejects.toMatchObject({
      billing: {
        path: ["v3", "on_page", "lighthouse", "live", "json"],
        costUsd: 0.00425,
      },
    });
  });

  it("does not retry an HTTP 5xx (the provider may have charged the task)", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("upstream failure", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLighthouseResult({
        url: "https://example.com/",
        strategy: "mobile",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
