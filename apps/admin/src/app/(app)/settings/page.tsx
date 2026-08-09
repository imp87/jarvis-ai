import { Alert, Card, Stack, Text, Title } from "@mantine/core";
import { PolicyForm } from "@/components/policy-form";
import { ApiError, getPolicy } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  let data: Awaited<ReturnType<typeof getPolicy>>;
  try {
    data = await getPolicy();
  } catch (err) {
    return (
      <Alert color="red" title="Could not reach the orchestrator">
        {err instanceof ApiError ? err.message : String(err)}
      </Alert>
    );
  }

  return (
    <Stack gap="xl">
      <div>
        <Title order={4}>Call policy</Title>
        <Text size="sm" c="dimmed" mt={4}>
          Everything else in this system is configured by environment variable and read once at
          startup. These are not: they are decisions about your evening, they change more often
          than the code does, and they take effect on the next call rather than the next deploy.
          A setting you have not touched still comes from the environment.
        </Text>
      </div>

      <Card withBorder padding="lg">
        <PolicyForm policy={data.policy} defaults={data.environmentDefaults} />
      </Card>

      {data.policy.updatedAt && (
        <Text size="xs" c="dimmed">
          Last changed {new Date(data.policy.updatedAt).toLocaleString("de-DE")}
        </Text>
      )}
    </Stack>
  );
}
