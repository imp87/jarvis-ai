import { Alert, Card, Stack, Text, Title } from "@mantine/core";
import { McpServerForm } from "@/components/mcp-form";
import { McpServerList } from "@/components/mcp-server-list";
import { McpOAuthSettingsForm } from "@/components/mcp-oauth-settings";
import { ApiError, getMcpOAuthSettings, getMcpServers, type McpOAuthSettings, type McpServer } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function McpPage() {
  let servers: McpServer[];
  let oauthSettings: McpOAuthSettings;
  try {
    const result = await Promise.all([getMcpServers(), getMcpOAuthSettings()]);
    servers = result[0].servers;
    oauthSettings = result[1];
  } catch (err) {
    return (
      <Alert color="red" title="Could not reach the orchestrator">
        {err instanceof ApiError ? err.message : String(err)}
      </Alert>
    );
  }

  return (
    <Stack gap="xl">
      <Card withBorder padding="lg">
        <Stack gap="md">
          <div>
            <Title order={5}>OAuth callback</Title>
            <Text size="sm" c="dimmed">
              Configure once for all OAuth-capable remote MCP servers.
            </Text>
          </div>
          <McpOAuthSettingsForm settings={oauthSettings} />
        </Stack>
      </Card>
      <Card withBorder padding="lg">
        <Stack gap="md">
          <div>
            <Title order={5}>Attach an MCP server</Title>
            <Text size="sm" c="dimmed">
              Any MCP server becomes agent tools — no code, no restart.
            </Text>
          </div>
          <McpServerForm />
        </Stack>
      </Card>

      <Card withBorder padding="lg">
        <McpServerList servers={servers} />
      </Card>
    </Stack>
  );
}
