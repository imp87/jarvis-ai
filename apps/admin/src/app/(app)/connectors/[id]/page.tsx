import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Anchor, Badge, Card, Group, Stack, Text, Title } from "@mantine/core";
import { EndpointForm } from "@/components/endpoint-form";
import { DeleteConnectorButton, EndpointList } from "@/components/endpoint-list";
import { ApiError, getConnectors, type Connector } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function ConnectorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let connectors: Connector[];
  try {
    // There is no single-connector read endpoint; the list already carries the
    // endpoints, so filtering here beats adding a route for one page.
    connectors = (await getConnectors()).connectors;
  } catch (err) {
    return (
      <Alert color="red" title="Could not reach the orchestrator">
        {err instanceof ApiError ? err.message : String(err)}
      </Alert>
    );
  }

  const connector = connectors.find((c) => c.id === id);
  if (!connector) notFound();

  return (
    <Stack gap="xl">
      <div>
        <Anchor component={Link} href="/connectors" size="sm" c="dimmed">
          ← Connectors
        </Anchor>
        <Group justify="space-between" align="flex-start" mt="xs" wrap="nowrap">
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Group gap="xs">
              <Title order={4}>{connector.name}</Title>
              {!connector.enabled && <Badge variant="default">disabled</Badge>}
            </Group>
            <Text size="sm" c="dimmed">
              {connector.description}
            </Text>
            <Text className="mono" c="dimmed">
              {connector.baseUrl} · auth: {connector.authType}
              {connector.authParamName ? ` (${connector.authParamName})` : ""}
            </Text>
          </Stack>
          <DeleteConnectorButton connector={connector} />
        </Group>
      </div>

      <Card withBorder padding="lg">
        <Stack gap="sm">
          <div>
            <Text fw={500}>Endpoints ({connector.endpoints.length})</Text>
            <Text size="sm" c="dimmed">
              One endpoint, one tool.
            </Text>
          </div>
          <EndpointList connector={connector} />
        </Stack>
      </Card>

      <Card withBorder padding="lg">
        <Stack gap="md">
          <Title order={5}>Add an endpoint</Title>
          <EndpointForm connectorId={connector.id} />
        </Stack>
      </Card>
    </Stack>
  );
}
