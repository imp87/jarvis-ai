"use client";

import { useState } from "react";
import { Button, Group, PasswordInput, SegmentedControl, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { createMcpServer } from "@/app/actions";
import { AuthFields } from "@/components/auth-fields";
import { notifyResult, zodValidate } from "@/lib/form";
import { emptyMcpServer, mcpServerSchema, type McpServerInput } from "@/lib/schemas";

export function McpServerForm() {
  const [pending, setPending] = useState(false);
  const form = useForm<McpServerInput>({
    initialValues: emptyMcpServer,
    validate: zodValidate(mcpServerSchema),
    validateInputOnBlur: true,
  });

  const transport = form.values.transport;
  const usesOAuth = transport === "http" && form.values.authMode === "oauth";

  async function submit(values: McpServerInput) {
    setPending(true);
    try {
      const result = await createMcpServer(values);
      notifyResult(result);
      if (result.fieldErrors) form.setErrors(result.fieldErrors);
      // Only a clean success clears the form. A server that saved but would not
      // connect leaves everything on screen, because the next thing you do is
      // correct the credential — not type the whole thing again.
      if (result.status === "success") form.reset();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={form.onSubmit(submit)}>
      <Stack gap="md">
        <SegmentedControl
          fullWidth
          data={[
            { value: "stdio", label: "Local process (stdio)" },
            { value: "http", label: "Remote server (http)" },
          ]}
          {...form.getInputProps("transport")}
        />

        <TextInput
          label="Name"
          placeholder="filesystem"
          description="Becomes part of every tool name: mcp_<name>__<tool>"
          {...form.getInputProps("name")}
        />

        <TextInput
          label="What it is for"
          placeholder="Access to my local notes and project files"
          description="Appended to every tool description. Write the purpose, not the mechanism — it is how the model tells two similar tools apart."
          {...form.getInputProps("description")}
        />

        {transport === "http" ? (
          <>
            <TextInput
              label="URL"
              placeholder="https://mcp.example.com/mcp"
              {...form.getInputProps("url")}
            />
            <SegmentedControl
              fullWidth
              data={[
                { value: "static", label: "Static credentials" },
                { value: "oauth", label: "Sign in with OAuth" },
              ]}
              {...form.getInputProps("authMode")}
            />
            {usesOAuth ? (
              <Stack gap="xs">
                <Text size="sm" c="dimmed">
                  Jarvis discovers the provider and opens its normal account sign-in after this server is saved.
                  A client ID is only needed when the provider does not support automatic registration.
                </Text>
                <TextInput label="OAuth client ID (optional)" {...form.getInputProps("oauth.clientId")} />
                <PasswordInput
                  label="OAuth client secret (optional)"
                  autoComplete="new-password"
                  {...form.getInputProps("oauth.clientSecret")}
                />
                <TextInput
                  label="Scopes (optional)"
                  placeholder="read write"
                  {...form.getInputProps("oauth.scope")}
                />
              </Stack>
            ) : (
              <AuthFields form={form} exclude={["query"]} />
            )}
          </>
        ) : (
          <>
            <Group grow align="flex-start">
              <TextInput label="Command" placeholder="npx" {...form.getInputProps("command")} />
              <TextInput
                label="Arguments"
                placeholder="-y @modelcontextprotocol/server-filesystem ${MCP_WORKSPACE_DIR}"
                description="Quote anything containing spaces. ${VAR} is expanded on the host."
                {...form.getInputProps("args")}
              />
            </Group>
            <Textarea
              label="Environment variables"
              description="One KEY=value per line. Only these reach the process — not the orchestrator's own keys. Encrypted at rest."
              placeholder="API_TOKEN=..."
              autosize
              minRows={2}
              maxRows={6}
              styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
              {...form.getInputProps("env")}
            />
          </>
        )}

        <Group gap="sm">
          <Button type="submit" loading={pending}>
            Register and connect
          </Button>
          <Text size="xs" c="dimmed">
            {usesOAuth
              ? "Saves first; then use “Connect account” on the server to sign in with the provider."
              : "Connects immediately — the tools are usable without a restart."}
          </Text>
        </Group>
      </Stack>
    </form>
  );
}
