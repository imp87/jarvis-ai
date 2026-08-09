"use client";

import { useState } from "react";
import { Button, Checkbox, Group, JsonInput, Select, Stack, Textarea, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { createEndpoint } from "@/app/actions";
import { notifyResult, zodValidate } from "@/lib/form";
import { HTTP_METHODS, emptyEndpoint, endpointSchema, type EndpointInput } from "@/lib/schemas";

const EXAMPLE_SCHEMA = `{
  "type": "object",
  "properties": {
    "city": { "type": "string", "description": "City name" }
  },
  "required": ["city"]
}`;

export function EndpointForm({ connectorId }: { connectorId: string }) {
  const [pending, setPending] = useState(false);
  const form = useForm<EndpointInput>({
    initialValues: emptyEndpoint(connectorId),
    validate: zodValidate(endpointSchema),
    validateInputOnBlur: true,
  });

  async function submit(values: EndpointInput) {
    setPending(true);
    try {
      const result = await createEndpoint(values);
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
          <TextInput
            label="Name"
            placeholder="current_weather"
            description="Becomes the tool name"
            {...form.getInputProps("name")}
          />
          <Select
            label="Method"
            data={[...HTTP_METHODS]}
            allowDeselect={false}
            {...form.getInputProps("method")}
          />
          <TextInput
            label="Path"
            placeholder="/weather/current"
            description="Appended to the connector's base URL"
            {...form.getInputProps("path")}
          />
        </Group>

        <Textarea
          label="What it does"
          description="The model reads this to decide when to call it."
          placeholder="Returns the current temperature, conditions and wind for one city."
          autosize
          minRows={2}
          {...form.getInputProps("description")}
        />

        {/* Validates and formats in place, so a missing brace is caught here
            rather than coming back as a server error after a round trip. */}
        <JsonInput
          label="Input schema"
          description="JSON Schema for the arguments. Leave empty for an endpoint that takes none."
          placeholder={EXAMPLE_SCHEMA}
          validationError="Not valid JSON"
          formatOnBlur
          autosize
          minRows={6}
          {...form.getInputProps("inputSchema")}
        />

        <Checkbox
          label="Has side effects"
          description="Tick for anything that writes, sends or costs money. Read-only endpoints are cheaper for the agent to try."
          {...form.getInputProps("sideEffects", { type: "checkbox" })}
        />

        <Group>
          <Button type="submit" loading={pending}>
            Add endpoint
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
