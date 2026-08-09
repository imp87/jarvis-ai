"use client";

import { useState, useTransition } from "react";
import {
  Badge,
  Button,
  Card,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { setIdentityEnabled, updateChannelSettings } from "@/app/actions";
import { notifyResult } from "@/lib/form";
import type { AdminUser, ChannelSettings } from "@/lib/api";

/** Channels the orchestrator knows about, in the order they were built. */
const CHANNELS = ["telegram", "discord", "voice_call", "wake_word", "email", "api"] as const;

export function UserList({ users }: { users: AdminUser[] }) {
  if (users.length === 0) {
    return (
      <Text c="dimmed" size="sm" ta="center" py="lg">
        No users yet. Nothing can talk to the agent until an identity is registered — that is by
        design.
      </Text>
    );
  }
  return (
    <Stack gap="lg">
      {users.map((user) => (
        <UserCard key={user.id} user={user} />
      ))}
    </Stack>
  );
}

function UserCard({ user }: { user: AdminUser }) {
  return (
    <Card withBorder padding="lg">
      <Stack gap="md">
        <Group gap="xs">
          <Title order={5}>{user.displayName}</Title>
          {user.isOwner && (
            <Badge color="teal" variant="light" size="sm">
              owner
            </Badge>
          )}
        </Group>

        <Stack gap="xs">
          <Text fw={500} size="sm">
            Identities
          </Text>
          <Text size="xs" c="dimmed">
            Only registered, enabled identities can reach the agent. Disabling one rejects its
            messages without deleting anything.
          </Text>
          {user.identities.length === 0 ? (
            <Text size="sm" c="dimmed">
              None — this user cannot reach the agent on any channel.
            </Text>
          ) : (
            user.identities.map((identity) => (
              <IdentityRow
                key={`${identity.channel}:${identity.channelUserId}`}
                channel={identity.channel}
                channelUserId={identity.channelUserId}
                enabled={identity.enabled}
              />
            ))
          )}
        </Stack>

        <Stack gap="xs">
          <Text fw={500} size="sm">
            Per-channel replies
          </Text>
          <Text size="xs" c="dimmed">
            Deliberately not mirrored from the incoming message — sending a voice note does not
            imply wanting one back.
          </Text>
          {CHANNELS.filter((channel) =>
            user.identities.some((i) => i.channel === channel),
          ).map((channel) => (
            <ChannelSettingsRow
              key={channel}
              userId={user.id}
              channel={channel}
              current={user.settings.find((s) => s.channel === channel)}
            />
          ))}
        </Stack>
      </Stack>
    </Card>
  );
}

function IdentityRow({
  channel,
  channelUserId,
  enabled,
}: {
  channel: string;
  channelUserId: string;
  enabled: boolean;
}) {
  const [pending, start] = useTransition();
  return (
    <Group justify="space-between" wrap="nowrap">
      <Group gap="xs" style={{ minWidth: 0 }}>
        <Badge variant="default" size="sm">
          {channel}
        </Badge>
        <Text className="mono">{channelUserId}</Text>
      </Group>
      <Switch
        checked={enabled}
        disabled={pending}
        label={enabled ? "enabled" : "disabled"}
        onChange={(event) => {
          const next = event.currentTarget.checked;
          start(async () => notifyResult(await setIdentityEnabled(channel, channelUserId, next)));
        }}
      />
    </Group>
  );
}

function ChannelSettingsRow({
  userId,
  channel,
  current,
}: {
  userId: string;
  channel: string;
  current: ChannelSettings | undefined;
}) {
  const [pending, setPending] = useState(false);
  // Absent means the defaults are in force; showing them is more useful than
  // showing an empty row you cannot act on.
  const [replyFormat, setReplyFormat] = useState<"text" | "voice">(current?.replyFormat ?? "text");
  const [language, setLanguage] = useState(current?.language ?? "de");
  const [voiceId, setVoiceId] = useState(current?.voiceId ?? "");

  async function save() {
    setPending(true);
    try {
      notifyResult(
        await updateChannelSettings(userId, channel, {
          replyFormat,
          language,
          voiceId: voiceId.trim() === "" ? null : voiceId.trim(),
        }),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Group align="flex-end" gap="sm" wrap="wrap">
      <Badge variant="default" size="sm" mb={8}>
        {channel}
      </Badge>
      <Select
        label="Reply as"
        size="xs"
        w={110}
        data={[
          { value: "text", label: "Text" },
          { value: "voice", label: "Voice" },
        ]}
        allowDeselect={false}
        value={replyFormat}
        onChange={(value) => setReplyFormat((value as "text" | "voice") ?? "text")}
      />
      <TextInput
        label="Language"
        size="xs"
        w={90}
        placeholder="de"
        value={language}
        onChange={(event) => setLanguage(event.currentTarget.value)}
      />
      <TextInput
        label="Voice"
        size="xs"
        w={180}
        placeholder="provider default"
        value={voiceId}
        onChange={(event) => setVoiceId(event.currentTarget.value)}
      />
      <Button size="xs" variant="default" loading={pending} onClick={() => void save()}>
        Save
      </Button>
    </Group>
  );
}
