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
  Text,
  TextInput,
  PasswordInput,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useForm } from "@mantine/form";
import {
  createCalDavAccount,
  deleteCalDavAccount,
  refreshCalDavAccount,
  setCalDavAccountEnabled,
  setCalendarEnabled,
  updateCalDavAccount,
} from "@/app/actions";
import { ConfirmButton } from "@/components/confirm-button";
import { notifyResult, zodValidate } from "@/lib/form";
import { caldavAccountSchema, emptyCalDavAccount, type CalDavAccountInput } from "@/lib/schemas";
import type { AdminUser, CalDavAccount, CalDavCalendar } from "@/lib/api";

export function CalDavAccounts({ accounts, users }: { accounts: CalDavAccount[]; users: AdminUser[] }) {
  const defaultUserId = users.find((user) => user.isOwner)?.id ?? users[0]?.id ?? "";
  return (
    <Stack gap="xl">
      <CalDavAccountForm users={users} defaultUserId={defaultUserId} />
      <Stack gap="sm">
        <Text fw={500}>Configured accounts ({accounts.length})</Text>
        {accounts.length === 0 ? (
          <Text c="dimmed" size="sm" ta="center" py="lg">
            No calendar accounts configured yet.
          </Text>
        ) : (
          accounts.map((account) => <AccountRow key={account.id} account={account} users={users} />)
        )}
      </Stack>
    </Stack>
  );
}

function CalDavAccountForm({ users, defaultUserId }: { users: AdminUser[]; defaultUserId: string }) {
  const [pending, setPending] = useState(false);
  const form = useForm<CalDavAccountInput>({
    initialValues: emptyCalDavAccount(defaultUserId),
    validate: zodValidate(caldavAccountSchema),
    validateInputOnBlur: true,
  });

  async function submit(values: CalDavAccountInput) {
    if (!values.password.trim()) {
      form.setFieldError("password", "required for a new account");
      return;
    }
    setPending(true);
    try {
      const result = await createCalDavAccount(values);
      notifyResult(result);
      if (result.fieldErrors) form.setErrors(result.fieldErrors);
      if (result.status === "success") form.setValues(emptyCalDavAccount(defaultUserId));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={form.onSubmit(submit)}>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Calendars are read live over CalDAV; nothing is copied into the database except the list of
          calendars found. Credentials are encrypted with the same envelope as the mail accounts.
        </Text>
        <AccountFields form={form} users={users} allowUserChoice />
        <Group>
          <Button type="submit" loading={pending}>Add and discover calendars</Button>
          <Text size="xs" c="dimmed">
            iCloud requires an app-specific password from appleid.apple.com, not the Apple ID password.
          </Text>
        </Group>
      </Stack>
    </form>
  );
}

function AccountRow({ account, users }: { account: CalDavAccount; users: AdminUser[] }) {
  const [pending, start] = useTransition();
  const [opened, modal] = useDisclosure(false);
  const status = account.enabled
    ? account.state === "ready"
      ? { color: "teal", label: `${account.calendars.length} calendars` }
      : account.state === "discovering"
        ? { color: "yellow", label: "discovering" }
        : { color: "red", label: account.state }
    : { color: "gray", label: "disabled" };
  const user = users.find((item) => item.id === account.userId);

  return (
    <>
      <Stack
        gap="xs"
        p="sm"
        style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)" }}
      >
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={3} style={{ minWidth: 0 }}>
            <Group gap="xs">
              <Text fw={500}>{account.name}</Text>
              <Badge size="sm" variant="light" color={status.color}>{status.label}</Badge>
              <Badge size="sm" variant="default">{account.timezone}</Badge>
            </Group>
            <Text size="sm" c="dimmed">{account.username} · {account.baseUrl}</Text>
            <Text size="xs" c="dimmed">
              {user?.displayName ?? account.userId}
              {account.lastCheckedAt ? ` · checked ${new Date(account.lastCheckedAt).toLocaleString()}` : ""}
            </Text>
          </Stack>
          <Group gap="xs" wrap="nowrap">
            <Button size="xs" variant="default" onClick={modal.open}>Edit</Button>
            <Button
              size="xs"
              variant="default"
              loading={pending}
              onClick={() => start(async () => notifyResult(await refreshCalDavAccount(account.id)))}
            >
              Rediscover
            </Button>
            <Button
              size="xs"
              variant="default"
              loading={pending}
              onClick={() => start(async () => notifyResult(await setCalDavAccountEnabled(account.id, !account.enabled)))}
            >
              {account.enabled ? "Disable" : "Enable"}
            </Button>
            <ConfirmButton
              colour="red"
              label="Remove"
              title={`Remove “${account.name}”?`}
              body="Its encrypted credential and the cached calendar list are deleted. Nothing on the server changes."
              onConfirm={async () => notifyResult(await deleteCalDavAccount(account.id))}
            />
          </Group>
        </Group>
        {account.lastError && (
          <Alert color="red" variant="light" p="xs"><Text size="sm">{account.lastError}</Text></Alert>
        )}
        {account.calendars.length > 0 && <CalendarList calendars={account.calendars} />}
      </Stack>
      <EditAccountModal account={account} users={users} opened={opened} onClose={modal.close} />
    </>
  );
}

function CalendarList({ calendars }: { calendars: CalDavCalendar[] }) {
  const [pending, start] = useTransition();
  return (
    <Stack gap={4} pt="xs">
      {calendars.map((calendar) => (
        <Group key={calendar.id} justify="space-between" wrap="nowrap">
          <Group gap="xs" style={{ minWidth: 0 }}>
            {calendar.color && (
              <div
                aria-hidden
                style={{ width: 10, height: 10, borderRadius: 999, background: calendar.color, flexShrink: 0 }}
              />
            )}
            <Text size="sm">{calendar.displayName}</Text>
            {!calendar.supportsEvents && <Badge size="xs" variant="default">tasks only</Badge>}
            {calendar.readOnly && <Badge size="xs" variant="default">read-only</Badge>}
          </Group>
          <Switch
            size="xs"
            checked={calendar.enabled}
            disabled={pending || !calendar.supportsEvents}
            label={calendar.enabled ? "visible" : "hidden"}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              start(async () => notifyResult(await setCalendarEnabled(calendar.id, enabled)));
            }}
          />
        </Group>
      ))}
    </Stack>
  );
}

function EditAccountModal({
  account,
  users,
  opened,
  onClose,
}: {
  account: CalDavAccount;
  users: AdminUser[];
  opened: boolean;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const form = useForm<CalDavAccountInput>({
    initialValues: {
      userId: account.userId,
      name: account.name,
      baseUrl: account.baseUrl,
      username: account.username,
      password: "",
      timezone: account.timezone,
    },
    validate: zodValidate(caldavAccountSchema),
  });

  async function submit(values: CalDavAccountInput) {
    setPending(true);
    try {
      const result = await updateCalDavAccount(account.id, values);
      notifyResult(result);
      if (result.fieldErrors) form.setErrors(result.fieldErrors);
      if (result.status === "success") onClose();
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={`Edit ${account.name}`} size="lg">
      <form onSubmit={form.onSubmit(submit)}>
        <Stack gap="md">
          <AccountFields form={form} users={users} allowUserChoice={false} />
          <Text size="xs" c="dimmed">Leave password empty to retain the encrypted stored password.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={pending}>Save and rediscover</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function AccountFields({
  form,
  users,
  allowUserChoice,
}: {
  form: ReturnType<typeof useForm<CalDavAccountInput>>;
  users: AdminUser[];
  allowUserChoice: boolean;
}) {
  return (
    <>
      {allowUserChoice ? (
        <Select
          label="Owner"
          data={users.map((user) => ({
            value: user.id,
            label: user.displayName + (user.isOwner ? " (owner)" : ""),
          }))}
          {...form.getInputProps("userId")}
        />
      ) : null}
      <Group grow align="flex-start">
        <TextInput label="Name" placeholder="iCloud" {...form.getInputProps("name")} />
        <TextInput
          label="Server URL"
          placeholder="https://caldav.icloud.com"
          description="Server root, principal, or calendar home — discovery follows whichever you give it."
          {...form.getInputProps("baseUrl")}
        />
      </Group>
      <Group grow align="flex-start">
        <TextInput label="Username" placeholder="you@icloud.com" {...form.getInputProps("username")} />
        <PasswordInput label="Password" placeholder="app-specific password" {...form.getInputProps("password")} />
      </Group>
      <TextInput
        label="Timezone"
        placeholder="Europe/Berlin"
        description="IANA name. Days and times are rendered in this zone."
        {...form.getInputProps("timezone")}
      />
    </>
  );
}
