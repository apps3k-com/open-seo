/** @param {Record<string, string | undefined>} env */
export function validateGoogleOAuthDeployment(env) {
  const missing = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "BETTER_AUTH_SECRET",
  ].filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new Error(`Google OAuth deployment requires ${missing.join(", ")}.`);
  }
  if ((env.BETTER_AUTH_SECRET?.trim().length ?? 0) < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters.");
  }
}

/**
 * Google redirects the signed-in browser to these paths. The callback handler
 * verifies its Access JWT before consuming the user-bound OAuth state, so a
 * path-specific bypass breaks reconnect even when /api/health is healthy.
 * @param {string} domain
 * @param {typeof fetch} [request]
 */
export async function verifyGoogleCallbackAccess(domain, request = fetch) {
  for (const provider of ["gsc", "ga4"]) {
    const url = new URL(`https://${domain}/api/${provider}/oauth/callback`);
    const response = await request(url, {
      redirect: "manual",
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(10_000),
    });
    const location = response.headers.get("location");
    const accessLogin =
      response.status === 302 &&
      location !== null &&
      new URL(location, url).hostname.endsWith(".cloudflareaccess.com");
    // Managed OAuth returns an RFC 9728 challenge instead of browser login.
    const metadata = `${url.origin}/.well-known/cloudflare-access-protected-resource${url.pathname}`;
    const accessChallenge =
      response.status === 401 &&
      response.headers
        .get("www-authenticate")
        ?.includes(`resource_metadata="${metadata}"`);
    if (!accessLogin && !accessChallenge) {
      throw new Error(
        `Google ${provider} callback is not protected by Cloudflare Access (HTTP ${response.status}). Remove any callback path bypass; the handler requires the same Access identity as the connect request.`,
      );
    }
  }
}
