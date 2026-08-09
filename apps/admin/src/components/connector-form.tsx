"use client";

import { useState } from "react";
import { Button, Group, Stack, Textarea, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { createConnector } from "@/app/actions";
import { AuthFields } from "@/components/auth-fields";
import { notifyResult, zodValidate } from "@/lib/form";
import { connectorSchema, emptyConnector, type ConnectorInput } from "@/lib/schemas";

export function ConnectorForm() {
  const [pending, setPending] = useState(false);
  const form = useForm<ConnectorInput>({
    initialValues: emptyConnector,
    validate: zodValidate(connectorSchema),
    validateInputOnBlur: true,
  });

  async function submit(values: ConnectorInput) {
    setPending(true);
    try {
      const result = await createConnector(values);
      notifyResult(result);
      if (result.fieldErrors) form.setErrors(result.fieldErrors);
      if (result.status === "success") form.reset();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={form.onSubmit(submit)}>
      <Stack gap="md">
        <Group grow align="flex-start">
          <TextInput label="Name" placeholder="Wetter" {...form.getInputProps("name")} />
          <TextInput
            label="Base URL"
            placeholder="https://api.example.com/v1"
            {...form.getInputProps("baseUrl")}
          />
        </Group>

        <Textarea
          label="What it is for"
          description="What the model matches a request against. Describe capability, not branding."
          placeholder="Current weather and forecasts for any location, by city name or coordinates."
          autosize
          minRows={2}
          {...form.getInputProps("description")}
        />

        <AuthFields form={form} secretLabel="Key" />

        <Group>
          <Button type="submit" loading={pending}>
            Create connector
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
