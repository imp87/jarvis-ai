import Link from "next/link";
import { Alert, Anchor, Badge, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { ConnectorForm } from "@/components/connector-form";
import { ApiError, getConnectors, type Connector } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function ConnectorsPage() {
  let connectors: Connector[];
  try {
    connectors = (await getConnectors()).connectors;
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
            <Title order={5}>Add an HTTP connector</Title>
            <Text size="sm" c="dimmed">
              For plain REST APIs with no MCP server. Each endpoint you define becomes one tool.
            </Text>
          </div>
          <ConnectorForm />
        </Stack>
      </Card>

      <Card withBorder padding="lg">
        <Stack gap="sm">
          <Text fw={500}>Connectors ({connectors.length})</Text>
          {connectors.length === 0 ? (
            <Text c="dimmed" size="sm" ta="center" py="lg">
              Nothing registered yet.
            </Text>
          ) : (
            connectors.map((connector) => (
              <Group
                key={connector.id}
                justify="space-between"
                wrap="nowrap"
                align="flex-start"
                p="sm"
                style={{
                  border: "1px solid var(--mantine-color-default-border)",
                  borderRadius: "var(--mantine-radius-md)",
                }}
              >
                <Stack gap={4} style={{ minWidth: 0 }}>
                  <Group gap="xs">
                    <Anchor component={Link} href={`/connectors/${connector.id}`} fw={500}>
                      {connector.name}
                    </Anchor>
                    {!connector.enabled && (
                      <Badge variant="default" size="sm">
                        disabled
                      </Badge>
                    )}
                    <Badge
                      color={connector.endpoints.length === 0 ? "yellow" : "teal"}
                      variant="light"
                      size="sm"
                    >
                      {connector.endpoints.length} endpoint
                      {connector.endpoints.length === 1 ? "" : "s"}
                    </Badge>
                    <Badge variant="default" size="sm">
                      {connector.authType}
                    </Badge>
                  </Group>
                  <Text size="sm" c="dimmed">
                    {connector.description}
                  </Text>
                  <Text className="mono" c="dimmed">
                    {connector.baseUrl}
                  </Text>
                </Stack>
                <Button component={Link} href={`/connectors/${connector.id}`} size="xs" variant="default">
                  Endpoints
                </Button>
              </Group>
            ))
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
