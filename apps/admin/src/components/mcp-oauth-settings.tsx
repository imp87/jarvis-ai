"use client";

import { useState } from "react";
import { Anchor, Badge, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { updateMcpOAuthCallbackBaseUrl } from "@/app/actions";
import { notifyResult } from "@/lib/form";
import type { McpOAuthSettings } from "@/lib/api";

export function McpOAuthSettingsForm({ settings }: { settings: McpOAuthSettings }) {
  const [pending, setPending] = useState(false);
  const form = useForm({ initialValues: { callbackBaseUrl: settings.callbackBaseUrl } });

  async function save() {
    setPending(true);
    try {
      const result = await updateMcpOAuthCallbackBaseUrl(form.values.callbackBaseUrl);
      notifyResult(result);
    } finally {
      setPending(false);
    }
  }

  async function reset() {
    setPending(true);
    try {
      const result = await updateMcpOAuthCallbackBaseUrl(null);
      notifyResult(result);
      if (result.status !== "error") form.setFieldValue("callbackBaseUrl", settings.callbackBaseUrl);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={form.onSubmit(save)}>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          OAuth providers return to this public address after sign-in. The exact callback is <code>{settings.callbackUrl}</code>.
        </Text>
        <Group align="flex-end" grow>
          <TextInput
            label="Public callback base URL"
            placeholder="https://jarvis.example.com"
            {...form.getInputProps("callbackBaseUrl")}
          />
          <Button type="submit" loading={pending}>Save</Button>
        </Group>
        <Group gap="xs">
          <Badge color={settings.overridden ? "teal" : "gray"} variant="light">
            {settings.overridden ? "custom setting" : "deployment default"}
          </Badge>
          {settings.overridden && (
            <Anchor component="button" type="button" size="sm" onClick={() => void reset()}>
              reset to deployed default
            </Anchor>
          )}
        </Group>
      </Stack>
    </form>
  );
}
