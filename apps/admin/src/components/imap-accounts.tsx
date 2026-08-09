"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useForm } from "@mantine/form";
import {
  createImapAccount,
  deleteImapAccount,
  setImapAccountEnabled,
  updateImapAccount,
} from "@/app/actions";
import { ConfirmButton } from "@/components/confirm-button";
import { notifyResult, zodValidate } from "@/lib/form";
import { emptyImapAccount, imapAccountSchema, type ImapAccountInput } from "@/lib/schemas";
import type { AdminUser, ImapAccount } from "@/lib/api";

export function ImapAccounts({ accounts, users }: { accounts: ImapAccount[]; users: AdminUser[] }) {
  const defaultUserId = users.find((user) => user.isOwner)?.id ?? users[0]?.id ?? "";
  return (
    <Stack gap="xl">
      <ImapAccountForm users={users} defaultUserId={defaultUserId} />
      <Stack gap="sm">
        <Text fw={500}>Configured accounts ({accounts.length})</Text>
        {accounts.length === 0 ? (
          <Text c="dimmed" size="sm" ta="center" py="lg">
            No IMAP accounts configured yet.
          </Text>
        ) : (
          accounts.map((account) => <AccountRow key={account.id} account={account} users={users} />)
        )}
      </Stack>
    </Stack>
  );
}

function ImapAccountForm({ users, defaultUserId }: { users: AdminUser[]; defaultUserId: string }) {
  const [pending, setPending] = useState(false);
  const form = useForm<ImapAccountInput>({
    initialValues: emptyImapAccount(defaultUserId),
    validate: zodValidate(imapAccountSchema),
    validateInputOnBlur: true,
  });

  async function submit(values: ImapAccountInput) {
    if (!values.password.trim()) {
      form.setFieldError("password", "required for a new account");
      return;
    }
    setPending(true);
    try {
      const result = await createImapAccount(values);
      notifyResult(result);
      if (result.fieldErrors) form.setErrors(result.fieldErrors);
      if (result.status === "success") form.setValues(emptyImapAccount(defaultUserId));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={form.onSubmit(submit)}>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Credentials are encrypted in the database. Each account gets its own IMAP-IDLE connection and only processes mail received after its first successful connection.
        </Text>
        <AccountFields form={form} users={users} allowUserChoice />
        <Group>
          <Button type="submit" loading={pending}>Add and connect account</Button>
          <Text size="xs" c="dimmed">Use an app password when your provider supports it.</Text>
        </Group>
      </Stack>
    </form>
  );
}

function AccountRow({ account, users }: { account: ImapAccount; users: AdminUser[] }) {
  const [pending, start] = useTransition();
  const [opened, modal] = useDisclosure(false);
  const status = account.enabled
    ? account.state === "connected"
      ? { color: "teal", label: "connected" }
      : account.state === "connecting"
        ? { color: "yellow", label: "connecting" }
        : { color: "red", label: account.state }
    : { color: "gray", label: "disabled" };
  const user = users.find((item) => item.id === account.userId);

  return (
    <>
      <Stack gap="xs" p="sm" style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)" }}>
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={3} style={{ minWidth: 0 }}>
            <Group gap="xs">
              <Text fw={500}>{account.name}</Text>
              <Badge size="sm" variant="light" color={status.color}>{status.label}</Badge>
              <Badge size="sm" variant="default">{account.secure ? "TLS" : "STARTTLS"}</Badge>
            </Group>
            <Text size="sm" c="dimmed">{account.username} · {account.host}:{account.port} · {account.mailbox}</Text>
            <Text size="xs" c="dimmed">
              {user?.displayName ?? account.userId} · low: {account.deliveryPolicy.low} · normal: {account.deliveryPolicy.normal} · urgent: {account.deliveryPolicy.urgent}
            </Text>
          </Stack>
          <Group gap="xs" wrap="nowrap">
            <Button size="xs" variant="default" onClick={modal.open}>Edit</Button>
            <Button
              size="xs"
              variant="default"
              loading={pending}
              onClick={() => start(async () => notifyResult(await setImapAccountEnabled(account.id, !account.enabled)))}
            >
              {account.enabled ? "Disable" : "Enable"}
            </Button>
            <ConfirmButton
              colour="red"
              label="Remove"
              title={`Remove “${account.name}”?`}
              body="Its encrypted credential, cursor, and locally mirrored emails are deleted."
              onConfirm={async () => notifyResult(await deleteImapAccount(account.id))}
            />
          </Group>
        </Group>
        {account.lastError && <Alert color="red" variant="light" p="xs"><Text size="sm">{account.lastError}</Text></Alert>}
      </Stack>
      <EditAccountModal account={account} users={users} opened={opened} onClose={modal.close} />
    </>
  );
}

function EditAccountModal({ account, users, opened, onClose }: { account: ImapAccount; users: AdminUser[]; opened: boolean; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  const form = useForm<ImapAccountInput>({
    initialValues: {
      userId: account.userId, name: account.name, host: account.host, port: account.port, secure: account.secure,
      username: account.username, password: "", mailbox: account.mailbox, notifyChannel: account.notifyChannel,
      deliveryPolicy: account.deliveryPolicy,
      maxBodyChars: account.maxBodyChars,
    },
    validate: zodValidate(imapAccountSchema),
  });
  async function submit(values: ImapAccountInput) {
    setPending(true);
    try {
      const result = await updateImapAccount(account.id, values);
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
            <Button type="submit" loading={pending}>Save and reconnect</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function AccountFields({ form, users, allowUserChoice }: {
  form: ReturnType<typeof useForm<ImapAccountInput>>;
  users: AdminUser[];
  allowUserChoice: boolean;
}) {
  return (
    <>
      {allowUserChoice ? (
        <Select label="Owner" data={users.map((user) => ({ value: user.id, label: user.displayName + (user.isOwner ? " (owner)" : "") }))} {...form.getInputProps("userId")} />
      ) : null}
      <Group grow align="flex-start">
        <TextInput label="Account name" placeholder="Private mailbox" {...form.getInputProps("name")} />
        <TextInput label="IMAP host" placeholder="imap.example.com" {...form.getInputProps("host")} />
      </Group>
      <Group grow align="flex-start">
        <NumberInput label="Port" min={1} max={65535} {...form.getInputProps("port")} />
        <TextInput label="Username" placeholder="you@example.com" {...form.getInputProps("username")} />
      </Group>
      <PasswordInput label="Password / app password" {...form.getInputProps("password")} />
      <Group grow align="flex-start">
        <TextInput label="Mailbox" {...form.getInputProps("mailbox")} />
        <Select label="When low priority" data={deliveryRoutes} {...form.getInputProps("deliveryPolicy.low")} />
      </Group>
      <Group grow align="flex-start">
        <Select label="When normal priority" data={deliveryRoutes} {...form.getInputProps("deliveryPolicy.normal")} />
        <Select label="When urgent" data={deliveryRoutes} {...form.getInputProps("deliveryPolicy.urgent")} />
      </Group>
      <Group grow align="flex-start">
        <Select label="If a call is missed" data={fallbackRoutes} {...form.getInputProps("deliveryPolicy.callFallback")} />
        <Select label="Response handling" data={replyModes} {...form.getInputProps("deliveryPolicy.replyMode")} />
      </Group>
      <Group grow align="flex-start">
        <NumberInput label="Call retries" min={0} max={4} {...form.getInputProps("deliveryPolicy.callRetryCount")} />
        <NumberInput label="Retry delay (minutes)" min={1} max={1440} {...form.getInputProps("deliveryPolicy.callRetryDelayMinutes")} />
      </Group>
      <Textarea
        label="Mailbox rules for Jarvis"
        description="Optional: e.g. ‘Invoices are always urgent; newsletters are low.’ Mail text never executes instructions."
        minRows={2}
        {...form.getInputProps("deliveryPolicy.instructions")}
      />
      <Group grow align="flex-start">
        <NumberInput label="Maximum mirrored body characters" min={500} max={100000} {...form.getInputProps("maxBodyChars")} />
        <Checkbox mt={30} label="Use direct TLS" {...form.getInputProps("secure", { type: "checkbox" })} />
      </Group>
    </>
  );
}

const deliveryRoutes = [
  { value: "none", label: "Do not notify" },
  { value: "telegram", label: "Telegram message" },
  { value: "discord", label: "Discord message" },
  { value: "call", label: "Phone call" },
];
const fallbackRoutes = deliveryRoutes.filter((route) => route.value !== "call");
const replyModes = [
  { value: "draft", label: "Include a reply draft" },
  { value: "ask", label: "Ask me what to reply" },
  { value: "none", label: "Do not discuss a reply" },
];
