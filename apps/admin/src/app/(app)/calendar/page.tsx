import { Alert, Card, Stack, Text, Title } from "@mantine/core";
import { CalDavAccounts } from "@/components/caldav-accounts";
import { ApiError, getCalDavAccounts, getUsers, type AdminUser, type CalDavAccount } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  let accounts: CalDavAccount[];
  let users: AdminUser[];
  try {
    [{ accounts }, { users }] = await Promise.all([getCalDavAccounts(), getUsers()]);
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
            <Title order={5}>Calendar accounts</Title>
            <Text size="sm" c="dimmed">
              CalDAV accounts Jarvis can read. Appointments are queried live for the date range asked
              about, so nothing goes stale and no events are stored locally.
            </Text>
          </div>
          <CalDavAccounts accounts={accounts} users={users} />
        </Stack>
      </Card>
    </Stack>
  );
}
