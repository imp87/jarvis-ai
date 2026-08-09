import { NextResponse, type NextRequest } from "next/server";
import { api } from "@/lib/api";

/**
 * Keeps the public OAuth callback on the admin hostname. Nginx therefore does
 * not need a special route to the private orchestrator port; the server-side
 * API client forwards the one-time code with the service token.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const state = searchParams.get("state");
  // `request.url` is the Docker listener (0.0.0.0:3000) behind Nginx, not
  // necessarily the public hostname. Reuse the persisted public OAuth base so
  // the browser is always returned to the actual admin domain.
  let result: URL;
  try {
    const settings = await api.get<{ callbackBaseUrl: string }>("/v1/mcp/oauth/settings");
    result = new URL("/mcp", settings.callbackBaseUrl);
  } catch {
    // The callback will report the actual orchestrator failure below; this is
    // merely the best possible return location if the settings lookup is down.
    result = new URL("/mcp", request.url);
  }
  if (!state) {
    result.searchParams.set("oauth", "error");
    result.searchParams.set("message", "OAuth callback had no state value.");
    return NextResponse.redirect(result);
  }

  const params = new URLSearchParams({ state });
  for (const key of ["code", "error", "error_description"]) {
    const value = searchParams.get(key);
    if (value) params.set(key, value);
  }
  try {
    const completed = await api.get<{ serverName: string }>(`/v1/mcp/oauth/callback?${params}`);
    result.searchParams.set("oauth", "connected");
    result.searchParams.set("server", completed.serverName);
  } catch (err) {
    result.searchParams.set("oauth", "error");
    result.searchParams.set("message", err instanceof Error ? err.message.slice(0, 500) : "OAuth connection failed.");
  }
  return NextResponse.redirect(result);
}
