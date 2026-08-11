"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { createContact, deleteContact, setContactAllowCalls } from "@/app/actions";
import { emptyContact, type ContactInput } from "@/lib/schemas";
import type { ActionResult } from "@/lib/action-result";
import type { AdminUser, Contact } from "@/lib/api";

/**
 * Contacts, and the one switch that lets Jarvis phone somebody who is not you.
 *
 * The switch is deliberately not part of the create form. Saving a number and
 * granting permission to dial it are different decisions, and putting them in
 * one click is how a number the agent picked up somewhere becomes a call.
 */
export function ContactList({
  contacts,
  users,
  outboundCallsEnabled,
}: {
  contacts: Contact[];
  users: AdminUser[];
  outboundCallsEnabled: boolean;
}) {
  const [form, setForm] = useState<ContactInput | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  const run = (action: () => Promise<ActionResult>) =>
    start(async () => setResult(await action()));

  return (
    <Stack gap="md">
      {!outboundCallsEnabled && contacts.some((c) => c.allowCalls) && (
        <Alert color="yellow" title="Outbound calling is switched off">
          Contacts are approved below, but <code>OUTBOUND_CALLS_ENABLED</code> is not set, so Jarvis
          will refuse to dial anyone except you. Both switches have to be on.
        </Alert>
      )}

      {result && (
        <Alert
          color={result.status === "success" ? "green" : result.status === "warning" ? "yellow" : "red"}
        >
          {result.message}
        </Alert>
      )}

      {contacts.length === 0 ? (
        <Text size="sm" c="dimmed">
          No contacts yet. Jarvis can only call you until one is added and approved.
        </Text>
      ) : (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Number</Table.Th>
              <Table.Th>Added by</Table.Th>
              <Table.Th>Jarvis may call</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {contacts.map((contact) => (
              <Table.Tr key={contact.id}>
                <Table.Td>
                  <Text fw={500}>{contact.name}</Text>
                  {contact.note && (
                    <Text size="xs" c="dimmed">
                      {contact.note}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text ff="monospace" size="sm">
                    {contact.phoneE164}
                  </Text>
                </Table.Td>
                <Table.Td>
                  {contact.createdBy === "agent" ? (
                    // Worth flagging: Jarvis cannot tell your words from a mail
                    // body it read, so a number it saved deserves a second look
                    // before it is ever dialled.
                    <Badge color="yellow" variant="light">
                      Jarvis — check it
                    </Badge>
                  ) : (
                    <Badge color="gray" variant="light">
                      You
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  <Switch
                    checked={contact.allowCalls}
                    disabled={pending}
                    onChange={(event) =>
                      run(() =>
                        setContactAllowCalls(
                          contact.id,
                          contact.userId,
                          event.currentTarget.checked,
                        ),
                      )
                    }
                  />
                </Table.Td>
                <Table.Td align="right">
                  <Button
                    variant="subtle"
                    color="red"
                    size="compact-sm"
                    disabled={pending}
                    onClick={() => run(() => deleteContact(contact.id, contact.userId))}
                  >
                    Remove
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <Group>
        <Button
          variant="light"
          disabled={users.length === 0}
          onClick={() => setForm(emptyContact(users[0]?.id ?? ""))}
        >
          Add contact
        </Button>
      </Group>

      <Modal opened={form !== null} onClose={() => setForm(null)} title="New contact" centered>
        {form && (
          <Stack gap="sm">
            {users.length > 1 && (
              <Select
                label="User"
                data={users.map((user) => ({ value: user.id, label: user.displayName }))}
                value={form.userId}
                onChange={(value) => setForm({ ...form, userId: value ?? "" })}
              />
            )}
            <TextInput
              label="Name"
              description="What you call them. This is what you say to Jarvis."
              placeholder="Friseur"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.currentTarget.value })}
            />
            <TextInput
              label="Phone number"
              description="Any notation — it is normalised to +49… when saved."
              placeholder="0155 6104 9738"
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.currentTarget.value })}
            />
            <Textarea
              label="Note"
              autosize
              minRows={2}
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.currentTarget.value })}
            />
            <Text size="xs" c="dimmed">
              Saved contacts cannot be called until you switch that on in the list. That is a
              separate step on purpose.
            </Text>
            <Group justify="flex-end">
              <Button variant="subtle" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button
                loading={pending}
                onClick={() =>
                  start(async () => {
                    const outcome = await createContact(form);
                    setResult(outcome);
                    if (outcome.status === "success") setForm(null);
                  })
                }
              >
                Save
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
