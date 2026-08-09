"use client";

import { Badge, Group, Stack, Text } from "@mantine/core";
import { deleteConnector, deleteEndpoint } from "@/app/actions";
import { ConfirmButton } from "@/components/confirm-button";
import { notifyResult } from "@/lib/form";
import type { Connector } from "@/lib/api";

export function DeleteConnectorButton({ connector }: { connector: Connector }) {
  return (
    <ConfirmButton
      label="Delete connector"
      title={`Delete "${connector.name}"?`}
      body={`Its ${connector.endpoints.length} endpoint(s) and its stored credential go with it. The tools disappear from the agent immediately.`}
      onConfirm={async () => notifyResult(await deleteConnector(connector.id))}
    />
  );
}

export function EndpointList({ connector }: { connector: Connector }) {
  if (connector.endpoints.length === 0) {
    return (
      <Text c="dimmed" size="sm" ta="center" py="lg">
        No endpoints yet — this connector contributes no tools.
      </Text>
    );
  }

  return (
    <Stack gap="sm">
      {connector.endpoints.map((endpoint) => (
        <Group
          key={endpoint.id}
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
              <Text fw={500}>{endpoint.name}</Text>
              <Badge variant="default" size="sm">
                {endpoint.method}
              </Badge>
              {endpoint.sideEffects && (
                <Badge color="yellow" variant="light" size="sm">
                  side effects
                </Badge>
              )}
            </Group>
            <Text className="mono" c="dimmed">
              {endpoint.path}
            </Text>
            <Text size="sm" c="dimmed">
              {endpoint.description}
            </Text>
          </Stack>
          <ConfirmButton
            label="Remove"
            title={`Remove "${endpoint.name}"?`}
            body="The agent loses this tool immediately. The connector and its other endpoints stay."
            onConfirm={async () =>
              notifyResult(await deleteEndpoint(endpoint.id, connector.id))
            }
          />
        </Group>
      ))}
    </Stack>
  );
}
