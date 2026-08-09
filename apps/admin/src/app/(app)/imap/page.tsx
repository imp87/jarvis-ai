import { Alert, Card, Stack, Text, Title } from "@mantine/core";
import { ImapAccounts } from "@/components/imap-accounts";
import { ApiError, getImapAccounts, getUsers, type AdminUser, type ImapAccount } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function ImapPage() {
  let accounts: ImapAccount[];
  let users: AdminUser[];
  try {
    [{ accounts }, { users }] = await Promise.all([getImapAccounts(), getUsers()]);
  } catch (err) {
    return <Alert color="red" title="Could not reach the orchestrator">{err instanceof ApiError ? err.message : String(err)}</Alert>;
  }
  return (
    <Stack gap="xl">
      <Card withBorder padding="lg">
        <Stack gap="md">
          <div>
            <Title order={5}>IMAP accounts</Title>
            <Text size="sm" c="dimmed">Mailbox accounts managed by Jarvis. They use IMAP IDLE, not a scheduled inbox poll.</Text>
          </div>
          <ImapAccounts accounts={accounts} users={users} />
        </Stack>
      </Card>
    </Stack>
  );
}
