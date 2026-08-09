import { createHash, randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, type Logger } from "@jarvis/shared";
import type { McpServerRow, RegistryRepository, SettingsRepository } from "@jarvis/db";

interface OAuthClientConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
}

interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenEndpoint: string;
}

interface ProtectedResourceMetadata {
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface AuthorizationServerMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
}

/**
 * OAuth 2.1 + PKCE for HTTP MCP servers.  The provider login happens in the
 * operator's browser, while tokens and the PKCE verifier remain encrypted in
 * the database.  This deliberately stays independent of a particular MCP
 * vendor: discovery starts at the MCP resource and follows its advertised
 * authorization server.
 */
export class McpOAuthService {
  constructor(
    private readonly registry: RegistryRepository,
    private readonly settings: SettingsRepository,
    private readonly masterKey: Buffer,
    private readonly logger: Logger,
    private readonly defaultCallbackBaseUrl: string,
  ) {}

  async callbackSettings(): Promise<{ callbackBaseUrl: string; callbackUrl: string; overridden: boolean }> {
    const settings = await this.settings.getRuntimePolicy();
    const callbackBaseUrl = normaliseBaseUrl(
      settings.mcpOauthCallbackBaseUrl ?? this.defaultCallbackBaseUrl,
    );
    return {
      callbackBaseUrl,
      callbackUrl: `${callbackBaseUrl}/oauth/mcp/callback`,
      overridden: settings.mcpOauthCallbackBaseUrl !== null,
    };
  }

  async updateCallbackBaseUrl(value: string | null): Promise<{ callbackBaseUrl: string; callbackUrl: string; overridden: boolean }> {
    if (value !== null) normaliseBaseUrl(value);
    await this.settings.updateRuntimePolicy({ mcpOauthCallbackBaseUrl: value });
    return this.callbackSettings();
  }

  async start(server: McpServerRow): Promise<{ authorizationUrl: string }> {
    if (server.transport !== "http" || !server.url || server.authMode !== "oauth") {
      throw new Error("OAuth is available only for HTTP MCP servers configured for OAuth.");
    }

    const callback = await this.callbackSettings();
    const resource = new URL(server.url);
    const resourceMetadata = await this.discoverProtectedResource(resource);
    const authorizationServer = resourceMetadata.authorization_servers?.[0];
    if (!authorizationServer) {
      throw new Error("The MCP server did not advertise an OAuth authorization server.");
    }
    const provider = await this.discoverAuthorizationServer(new URL(authorizationServer));
    if (!provider.authorization_endpoint || !provider.token_endpoint) {
      throw new Error("The OAuth provider metadata has no authorization or token endpoint.");
    }

    let config = this.readConfig(server);
    if (!config.clientId) {
      if (!provider.registration_endpoint) {
        throw new Error("This provider requires a client ID. Add it in the MCP server settings, then try again.");
      }
      config = await this.registerClient(provider.registration_endpoint, callback.callbackUrl, server.name, config);
      await this.registry.updateMcpServer(server.id, {
        oauthConfigEnc: encryptSecret(JSON.stringify(config), this.masterKey),
      });
    }
    const clientId = config.clientId;
    if (!clientId) throw new Error("OAuth provider did not supply a client ID.");

    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");
    const scope = config.scope?.trim() || resourceMetadata.scopes_supported?.join(" ") || undefined;
    await this.registry.createMcpOAuthSession({
      state,
      mcpServerId: server.id,
      codeVerifierEnc: encryptSecret(verifier, this.masterKey),
      authorizationServer,
      authorizationEndpoint: provider.authorization_endpoint,
      tokenEndpoint: provider.token_endpoint,
      clientId,
      clientSecretEnc: config.clientSecret ? encryptSecret(config.clientSecret, this.masterKey) : null,
      redirectUri: callback.callbackUrl,
      resourceUri: resource.toString(),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    await this.registry.setMcpOAuthState(server.id, { status: "pending", error: null });

    const url = new URL(provider.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", callback.callbackUrl);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    // RFC 8707 resource indicator is required by MCP OAuth discovery.
    url.searchParams.set("resource", resource.toString());
    if (scope) url.searchParams.set("scope", scope);
    return { authorizationUrl: url.toString() };
  }

  async complete(input: { state: string; code?: string; error?: string; errorDescription?: string }): Promise<{ serverId: string; serverName: string }> {
    const session = await this.registry.consumeMcpOAuthSession(input.state);
    if (!session) throw new Error("This OAuth sign-in link is expired, already used, or invalid. Start the connection again.");
    const server = await this.registry.getMcpServer(session.mcpServerId);
    if (!server) throw new Error("The MCP server was removed while OAuth was in progress.");
    if (input.error || !input.code) {
      const message = input.errorDescription || input.error || "OAuth authorization was cancelled.";
      await this.registry.setMcpOAuthState(server.id, { status: "error", error: message });
      throw new Error(message);
    }

    try {
      const verifier = decryptSecret(session.codeVerifierEnc, this.masterKey);
      const clientSecret = session.clientSecretEnc
        ? decryptSecret(session.clientSecretEnc, this.masterKey)
        : undefined;
      const tokens = await this.requestToken(session.tokenEndpoint, {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: session.redirectUri,
        client_id: session.clientId,
        code_verifier: verifier,
        resource: session.resourceUri,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      });
      const stored: OAuthTokens = {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(typeof tokens.expires_in === "number"
          ? { expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString() }
          : {}),
        tokenEndpoint: session.tokenEndpoint,
      };
      await this.registry.setMcpOAuthState(server.id, {
        tokensEnc: encryptSecret(JSON.stringify(stored), this.masterKey),
        status: "connected",
        error: null,
        connectedAt: new Date(),
      });
      return { serverId: server.id, serverName: server.name };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.registry.setMcpOAuthState(server.id, { status: "error", error: message });
      throw err;
    }
  }

  /** Returns an Authorization header, refreshing an expiring access token first. */
  async headersFor(server: McpServerRow): Promise<Record<string, string>> {
    if (server.authMode !== "oauth") return {};
    if (!server.oauthTokensEnc) throw new Error("OAuth is not connected yet. Connect the account in the MCP settings.");
    let tokens: OAuthTokens;
    try {
      tokens = JSON.parse(decryptSecret(server.oauthTokensEnc, this.masterKey)) as OAuthTokens;
    } catch {
      throw new Error("Saved OAuth credentials cannot be read. Connect the account again.");
    }
    if (tokens.expiresAt && Date.parse(tokens.expiresAt) <= Date.now() + 60_000) {
      if (!tokens.refreshToken) throw new Error("The OAuth session has expired. Connect the account again.");
      const config = this.readConfig(server);
      const refreshed = await this.requestToken(tokens.tokenEndpoint, {
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: config.clientId ?? "",
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      });
      tokens = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || tokens.refreshToken,
        ...(typeof refreshed.expires_in === "number"
          ? { expiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString() }
          : {}),
        tokenEndpoint: tokens.tokenEndpoint,
      };
      await this.registry.setMcpOAuthState(server.id, {
        tokensEnc: encryptSecret(JSON.stringify(tokens), this.masterKey),
        status: "connected",
        error: null,
        connectedAt: new Date(),
      });
    }
    return { Authorization: `Bearer ${tokens.accessToken}` };
  }

  private readConfig(server: McpServerRow): OAuthClientConfig {
    if (!server.oauthConfigEnc) return {};
    try {
      return JSON.parse(decryptSecret(server.oauthConfigEnc, this.masterKey)) as OAuthClientConfig;
    } catch (err) {
      this.logger.warn({ server: server.name, err: String(err) }, "could not decrypt MCP OAuth client config");
      return {};
    }
  }

  private async discoverProtectedResource(resource: URL): Promise<ProtectedResourceMetadata> {
    const candidates = [
      new URL(`/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`, resource.origin),
      new URL("/.well-known/oauth-protected-resource", resource.origin),
    ];
    for (const url of candidates) {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      const metadata = (await response.json()) as ProtectedResourceMetadata;
      if (metadata.authorization_servers?.length) return metadata;
    }
    throw new Error("Could not discover OAuth metadata from this MCP server. Check the MCP URL or use static headers.");
  }

  private async discoverAuthorizationServer(issuer: URL): Promise<AuthorizationServerMetadata> {
    const path = issuer.pathname.replace(/\/$/, "");
    const candidates = [
      new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin),
      new URL("/.well-known/oauth-authorization-server", issuer.origin),
      new URL(`/.well-known/openid-configuration${path}`, issuer.origin),
      new URL("/.well-known/openid-configuration", issuer.origin),
    ];
    for (const url of candidates) {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      const metadata = (await response.json()) as AuthorizationServerMetadata;
      if (metadata.authorization_endpoint && metadata.token_endpoint) return metadata;
    }
    throw new Error("Could not discover OAuth provider metadata.");
  }

  private async registerClient(
    endpoint: string,
    redirectUri: string,
    name: string,
    previous: OAuthClientConfig,
  ): Promise<OAuthClientConfig> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: `Jarvis AI (${name})`,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // Dynamic MCP clients are normally public clients. A provider that
        // assigns a secret returns it in this response and we use it on the
        // subsequent token exchange; asking for one up front rejects providers
        // that correctly support only PKCE public clients.
        token_endpoint_auth_method: "none",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as { client_id?: string; client_secret?: string; error_description?: string };
    if (!response.ok || !body.client_id) {
      throw new Error(body.error_description || `OAuth dynamic client registration failed (${response.status}).`);
    }
    return { ...previous, clientId: body.client_id, ...(body.client_secret ? { clientSecret: body.client_secret } : {}) };
  }

  private async requestToken(endpoint: string, values: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(values),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!response.ok || !body.access_token) {
      throw new Error(body.error_description || body.error || `OAuth token request failed (${response.status}).`);
    }
    return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in };
  }
}

function normaliseBaseUrl(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("The OAuth callback base URL must use http or https.");
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
