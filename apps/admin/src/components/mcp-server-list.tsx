"use client";

import { useState, useTransition } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Collapse,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
  PasswordInput,
  SegmentedControl,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useForm } from "@mantine/form";
import {
  deleteMcpServer,
  reloadMcpServers,
  setMcpServerEnabled,
  startMcpOAuth,
  updateMcpServer,
} from "@/app/actions";
import { AuthFields } from "@/components/auth-fields";
import { ConfirmButton } from "@/components/confirm-button";
import { notifyResult, zodValidate } from "@/lib/form";
import { emptyAuth, mcpServerSchema, type McpServerInput } from "@/lib/schemas";
import type { McpServer } from "@/lib/api";

export function McpServerList({ servers }: { servers: McpServer[] }) {
  const [pending, start] = useTransition();

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Text fw={500}>
          Registered servers ({servers.length})
        </Text>
        <Button
          variant="default"
          size="xs"
          loading={pending}
          onClick={() => start(async () => notifyResult(await reloadMcpServers()))}
        >
          Reconnect all
        </Button>
      </Group>

      {servers.length === 0 ? (
        <Text c="dimmed" size="sm" ta="center" py="lg">
          Nothing registered yet.
        </Text>
      ) : (
        servers.map((server) => <ServerRow key={server.id} server={server} />)
      )}
    </Stack>
  );
}

function ServerRow({ server }: { server: McpServer }) {
  const [pending, start] = useTransition();
  const [toolsOpen, tools] = useDisclosure(false);
  const [editOpen, edit] = useDisclosure(false);

  async function connectOAuth() {
    const result = await startMcpOAuth(server.id);
    notifyResult(result);
    if (result.authorizationUrl) window.location.assign(result.authorizationUrl);
  }

  const status = !server.enabled
    ? { colour: "gray", label: "disabled" }
    : server.connected
      ? { colour: "teal", label: `connected · ${server.toolCount} tools` }
      : { colour: "red", label: "not connected" };

  return (
    <>
      <Stack
        gap="xs"
        p="sm"
        style={{
          border: "1px solid var(--mantine-color-default-border)",
          borderRadius: "var(--mantine-radius-md)",
        }}
      >
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Group gap="xs">
              <Text fw={500}>{server.name}</Text>
              <Badge variant="default" size="sm">
                {server.transport}
              </Badge>
              {server.authMode === "oauth" && (
                <Badge color={server.oauthStatus === "connected" ? "teal" : "yellow"} variant="light" size="sm">
                  OAuth · {server.oauthStatus.replace("_", " ")}
                </Badge>
              )}
              <Badge color={status.colour} variant="light" size="sm">
                {status.label}
              </Badge>
              {server.hasSecrets && (
                <Badge variant="default" size="sm">
                  credential stored
                </Badge>
              )}
            </Group>
            {server.description && (
              <Text size="sm" c="dimmed">
                {server.description}
              </Text>
            )}
            <Text className="mono" c="dimmed">
              {server.transport === "http"
                ? server.url
                : [server.command, ...server.args].filter(Boolean).join(" ")}
            </Text>
          </Stack>

          <Group gap="xs" wrap="nowrap">
            {server.authMode === "oauth" && server.transport === "http" && (
              <Button size="xs" variant="light" loading={pending} onClick={() => start(() => connectOAuth())}>
                {server.oauthStatus === "connected" ? "Reconnect account" : "Connect account"}
              </Button>
            )}
            <Button size="xs" variant="default" onClick={edit.open}>
              Edit
            </Button>
            <Menu position="bottom-end">
              <Menu.Target>
                <ActionIcon variant="default" size="lg" loading={pending} aria-label="More">
                  ⋯
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  onClick={() =>
                    start(async () =>
                      notifyResult(await setMcpServerEnabled(server.id, !server.enabled)),
                    )
                  }
                >
                  {server.enabled ? "Disable" : "Enable"}
                </Menu.Item>
                {server.enabled && !server.connected && (
                  <Menu.Item
                    onClick={() =>
                      start(async () => notifyResult(await setMcpServerEnabled(server.id, true)))
                    }
                  >
                    Retry connection
                  </Menu.Item>
                )}
                <Menu.Divider />
                <ConfirmButton
                  as="menu-item"
                  colour="red"
                  label="Remove"
                  title={`Remove "${server.name}"?`}
                  body="Its stored credential goes with it. The tools disappear from the agent immediately."
                  onConfirm={async () => notifyResult(await deleteMcpServer(server.id))}
                />
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>

        {/* The reason a server is not connected used to reach the log only,
            which is what made attaching one a guessing game. */}
        {server.enabled && !server.connected && server.lastError && (
          <Alert color="red" variant="light" p="xs">
            <Text size="sm" style={{ overflowWrap: "anywhere" }}>
              {server.lastError}
            </Text>
          </Alert>
        )}
        {server.authMode === "oauth" && server.oauthError && (
          <Alert color="red" variant="light" p="xs">
            <Text size="sm" style={{ overflowWrap: "anywhere" }}>
              OAuth: {server.oauthError}
            </Text>
          </Alert>
        )}

        {server.toolNames.length > 0 && (
          <>
            <Text
              size="xs"
              c="dimmed"
              style={{ cursor: "pointer", width: "fit-content" }}
              onClick={tools.toggle}
            >
              {toolsOpen ? "Hide" : "Show"} {server.toolNames.length} tool names
            </Text>
            <Collapse in={toolsOpen}>
              <Group gap={4}>
                {server.toolNames.map((name) => (
                  <Code key={name}>{name}</Code>
                ))}
              </Group>
            </Collapse>
          </>
        )}
      </Stack>

      <EditModal server={server} opened={editOpen} onClose={edit.close} />
    </>
  );
}

function EditModal({
  server,
  opened,
  onClose,
}: {
  server: McpServer;
  opened: boolean;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const form = useForm<McpServerInput>({
    initialValues: {
      name: server.name,
      description: server.description,
      transport: server.transport,
      url: server.url ?? "",
      command: server.command ?? "",
      args: server.args.join(" "),
      env: "",
      auth: emptyAuth,
      authMode: server.authMode,
      oauth: { clientId: "", clientSecret: "", scope: "" },
    },
    validate: zodValidate(mcpServerSchema),
  });

  // A stored credential is never readable, so an untouched form must not be
  // able to erase it. Only an explicit choice here replaces it.
  const replaceSecret = form.values.auth.mode !== "none" || form.values.env.trim().length > 0;
  const replaceOAuth =
    form.values.oauth.clientId.trim().length > 0 ||
    form.values.oauth.clientSecret.length > 0 ||
    form.values.oauth.scope.trim().length > 0;

  async function submit(values: McpServerInput) {
    setPending(true);
    try {
      const result = await updateMcpServer(server.id, values, { replaceSecret, replaceOAuth });
      notifyResult(result);
      if (result.fieldErrors) form.setErrors(result.fieldErrors);
      if (result.status === "success") onClose();
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={`Edit ${server.name}`} size="lg">
      <form onSubmit={form.onSubmit(submit)}>
        <Stack gap="md">
          <Text size="xs" c="dimmed">
            The name and transport are fixed — both are baked into the tool names the model has
            already seen, so changing them would be a new server.
          </Text>

          <TextInput label="What it is for" {...form.getInputProps("description")} />

          {server.transport === "http" ? (
            <>
              <TextInput label="URL" {...form.getInputProps("url")} />
              <SegmentedControl
                fullWidth
                data={[
                  { value: "static", label: "Static credentials" },
                  { value: "oauth", label: "Sign in with OAuth" },
                ]}
                {...form.getInputProps("authMode")}
              />
              {form.values.authMode === "oauth" ? (
                <Stack gap="xs">
                  <Text size="sm" c="dimmed">
                    Leave these blank to keep the saved OAuth client. Enter only values you want to change.
                  </Text>
                  <TextInput label="OAuth client ID" {...form.getInputProps("oauth.clientId")} />
                  <PasswordInput
                    label="OAuth client secret"
                    autoComplete="new-password"
                    {...form.getInputProps("oauth.clientSecret")}
                  />
                  <TextInput label="Scopes" placeholder="read write" {...form.getInputProps("oauth.scope")} />
                </Stack>
              ) : (
                <AuthFields form={form} exclude={["query"]} />
              )}
            </>
          ) : (
            <>
              <Group grow align="flex-start">
                <TextInput label="Command" {...form.getInputProps("command")} />
                <TextInput label="Arguments" {...form.getInputProps("args")} />
              </Group>
              <Textarea
                label="Environment variables"
                autosize
                minRows={2}
                maxRows={6}
                styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
                {...form.getInputProps("env")}
              />
            </>
          )}

          <Text size="xs" c={replaceSecret ? "yellow" : "dimmed"}>
            {server.hasSecrets
              ? replaceSecret
                ? "The stored credential will be replaced by what you entered above."
                : "A credential is stored. Leave this untouched to keep it."
              : "No credential is stored for this server."}
          </Text>

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Tooltip label="Saves and reconnects" position="top">
              <Button type="submit" loading={pending}>
                Save and reconnect
              </Button>
            </Tooltip>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
