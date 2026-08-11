import { Alert, Card, Stack, Text, Title } from "@mantine/core";
import { ContactList } from "@/components/contact-list";
import {
  ApiError,
  getContacts,
  getStatus,
  getUsers,
  type AdminUser,
  type Contact,
} from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  let users: AdminUser[];
  let outboundCallsEnabled = false;
  let contacts: Contact[] = [];
  try {
    const [usersResult, status] = await Promise.all([getUsers(), getStatus()]);
    users = usersResult.users ?? [];
    // An orchestrator that predates this feature has no such field, and an
    // admin container is easy to rebuild without its counterpart. Treat the
    // absence as "off" rather than letting undefined reach the client.
    outboundCallsEnabled = status.policy?.outboundCallsEnabled === true;
    // One owner in practice; the table is per user, so the lists are merged.
    const perUser = await Promise.all(users.map((user) => getContacts(user.id)));
    contacts = perUser.flatMap((result) => result.contacts ?? []);
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
            <Title order={5}>Contacts</Title>
            <Text size="sm" c="dimmed">
              Who Jarvis may phone on your behalf. Without an approved contact it can only ever call
              you.
            </Text>
          </div>

          <Alert variant="light" title="Two switches, both required">
            {/*
              Plain ul/li rather than Mantine's List and its Item. This file
              is a Server Component, where an imported client component is only a
              reference proxy — reading a compound sub-component off it
              (`List.Item`, `Table.Td`, …) yields undefined and React fails with
              "Element type is invalid". Compound Mantine components are usable
              only inside a "use client" file, which is why the same pattern is
              fine in contact-list.tsx.
            */}
            <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.25rem" }}>
              <li>
                <Text size="sm" component="span">
                  <b>Per contact</b> — the toggle in this table. Off for anything Jarvis saved
                  itself.
                </Text>
              </li>
              <li>
                <Text size="sm" component="span">
                  <b>Globally</b> — <code>OUTBOUND_CALLS_ENABLED</code> in the environment.
                  Currently <b>{outboundCallsEnabled ? "on" : "off"}</b>.
                </Text>
              </li>
            </ul>
            <Text size="sm" mt="xs">
              A phone number never comes from the model. Jarvis passes a <i>name</i>, and the number
              is looked up here — or taken from a number you typed in that very message. Anything it
              read in an email or on a web page is refused.
            </Text>
          </Alert>

          <ContactList
            contacts={contacts}
            users={users}
            outboundCallsEnabled={outboundCallsEnabled}
          />
        </Stack>
      </Card>
    </Stack>
  );
}
