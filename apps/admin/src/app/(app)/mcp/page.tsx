import { Alert, Card, Stack, Text, Title } from "@mantine/core";
import { McpServerForm } from "@/components/mcp-form";
import { McpServerList } from "@/components/mcp-server-list";
import { ApiError, getMcpServers, type McpServer } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function McpPage() {
  let servers: McpServer[];
  try {
    servers = (await getMcpServers()).servers;
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
