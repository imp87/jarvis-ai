"use client";

import { useState } from "react";
import { Button, Center, Paper, PasswordInput, Stack, Text, Title } from "@mantine/core";
import { login } from "@/app/actions";

export function LoginForm({ next }: { next: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      // A successful login redirects, so anything returned here is a failure.
      const result = await login(password, next);
      setError(result.message);
      setPassword("");
    } finally {
      setPending(false);
    }
  }

  return (
    <Center mih="100vh" px="md">
      <Paper w={380} p="xl" withBorder>
        <form onSubmit={submit}>
          <Stack gap="md">
            <div>
              <Title order={4}>Jarvis admin</Title>
              <Text size="sm" c="dimmed" mt={4}>
                The service token stays on the server. This password only decides whether the
                server acts on your behalf.
              </Text>
            </div>
            <PasswordInput
              label="Password"
              autoComplete="current-password"
              data-autofocus
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              {...(error ? { error } : {})}
            />
            <Button type="submit" loading={pending} fullWidth>
              Log in
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
