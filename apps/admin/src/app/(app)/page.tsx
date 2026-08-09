import Link from "next/link";
import {
  Alert,
  Badge,
  Card,
  Code,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { ApiError, getStatus, type Status } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  let status: Status;
  try {
    status = await getStatus();
  } catch (err) {
    return (
      <Alert color="red" title="Could not reach the orchestrator">
        {err instanceof ApiError ? err.message : String(err)}
      </Alert>
    );
  }

  const sources = ["builtin", "mcp", "connector"] as const;

  return (
    <Stack gap="xl">
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Stat label="Tools available" value={status.tools.length} />
        <Stat label="MCP servers connected" value={status.mcpServers.length} href="/mcp" />
        <Stat
          label="Calls today"
          value={`${status.callBudgetUsage.lastDay} / ${status.policy.maxCallsPerDay || "∞"}`}
          note={`${status.callBudgetUsage.lastHour} in the last hour`}
        />
      </SimpleGrid>

      <Card withBorder padding="lg">
        <Stack gap="md">
          <div>
            <Title order={5}>Tools the agent can call</Title>
            <Text size="sm" c="dimmed">
              What the model sees on every turn.
            </Text>
          </div>
          {status.tools.length === 0 ? (
            <Text c="dimmed" size="sm" ta="center" py="lg">
              No tools registered yet.
            </Text>
          ) : (
            sources.map((source) => {
              const tools = status.tools.filter((t) => t.source === source);
              if (tools.length === 0) return null;
              return (
                <Stack key={source} gap="xs">
                  <Text size="xs" tt="uppercase" c="dimmed" fw={500}>
                    {source} · {tools.length}
                  </Text>
                  <Group gap={4}>
                    {tools.map((tool) => (
                      <Code key={tool.name} c={tool.sideEffects ? "yellow" : undefined}>
                        {tool.name}
                        {tool.sideEffects ? " ✎" : ""}
                      </Code>
                    ))}
                  </Group>
                </Stack>
              );
            })
          )}
        </Stack>
      </Card>

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card withBorder padding="lg">
          <Stack gap="sm">
            <div>
              <Title order={5}>LLM profiles</Title>
              <Text size="sm" c="dimmed">
                From config/llm-routing.json — not environment.
              </Text>
            </div>
            {status.profiles.map((profile) => (
              <Group key={profile.name} justify="space-between" wrap="nowrap">
                <Text size="sm">{profile.name}</Text>
                <Text className="mono">
                  {profile.provider}/{profile.model}
                </Text>
              </Group>
            ))}
          </Stack>
        </Card>

        <Card withBorder padding="lg">
          <Stack gap="sm">
            <div>
              <Title order={5}>Policy</Title>
              <Text size="sm" c="dimmed">
                Hard ceilings on anything that costs money or rings a phone.
              </Text>
            </div>
            <Row label="Quiet hours">
              {status.policy.quietHours.start}–{status.policy.quietHours.end}{" "}
              <Text span c="dimmed" size="sm">
                ({status.policy.quietHours.timezone})
              </Text>
            </Row>
            <Row label="Calls per hour">
              {status.policy.maxCallsPerHour || (
                <Badge color="yellow" variant="light" size="sm">
                  unlimited
                </Badge>
              )}
            </Row>
            <Row label="Calls per day">
              {status.policy.maxCallsPerDay || (
                <Badge color="yellow" variant="light" size="sm">
                  unlimited
                </Badge>
              )}
            </Row>
            <Row label="Agent steps per turn">{status.policy.maxAgentSteps}</Row>
          </Stack>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}

function Stat({
  label,
  value,
  note,
  href,
}: {
  label: string;
  value: string | number;
  note?: string;
  href?: string;
}) {
  const body = (
    <Card withBorder padding="lg" h="100%">
      <Text size="xs" tt="uppercase" c="dimmed" fw={500}>
        {label}
      </Text>
      <Text fz={28} fw={600} mt={4}>
        {value}
      </Text>
      {note && (
        <Text size="xs" c="dimmed">
          {note}
        </Text>
      )}
    </Card>
  );
  return href ? (
    <UnstyledButton component={Link} href={href}>
      {body}
    </UnstyledButton>
  ) : (
    body
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Group justify="space-between" wrap="nowrap">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="sm">{children}</Text>
    </Group>
  );
}
