import { Alert, Stack, Text, Title } from "@mantine/core";
import { UserList } from "@/components/user-list";
import { ApiError, getUsers, type AdminUser } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  let users: AdminUser[];
  try {
    users = (await getUsers()).users;
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
        <Title order={4}>Users</Title>
        <Text size="sm" c="dimmed" mt={4}>
          Who may talk to the agent, on which channels, and how it answers them.
        </Text>
      </div>
      <UserList users={users} />
    </Stack>
  );
}
