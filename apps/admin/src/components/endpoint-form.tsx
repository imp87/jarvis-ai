"use client";

import { createEndpoint } from "@/app/actions";
import { ActionForm, SubmitButton } from "@/components/form";
import { Field, Input, Select, Textarea } from "@/components/ui";

const EXAMPLE_SCHEMA = `{
  "type": "object",
  "properties": {
    "city": { "type": "string", "description": "City name" }
  },
  "required": ["city"]
}`;

export function EndpointForm({ connectorId }: { connectorId: string }) {
  return (
    <ActionForm action={createEndpoint} className="space-y-4">
      {(state) => (
        <>
          <input type="hidden" name="connectorId" value={connectorId} />

          <div className="grid gap-4 sm:grid-cols-[1fr_auto_2fr]">
            <Field label="Name" hint="Becomes the tool name">
              <Input
                name="name"
                placeholder="current_weather"
                defaultValue={state.values?.["name"] ?? ""}
                required
              />
            </Field>
            <Field label="Method">
              <Select name="method" defaultValue={state.values?.["method"] ?? "GET"}>
                {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Path" hint="Appended to the connector's base URL">
              <Input
                name="path"
                placeholder="/weather/current"
                defaultValue={state.values?.["path"] ?? ""}
                required
              />
            </Field>
          </div>

          <Field label="What it does" hint="The model reads this to decide when to call it.">
            <Textarea
              name="description"
              rows={2}
              placeholder="Returns the current temperature, conditions and wind for one city."
              defaultValue={state.values?.["description"] ?? ""}
              required
            />
          </Field>

          <Field
            label="Input schema (optional)"
            hint="JSON Schema for the arguments. Leave empty for an endpoint that takes none."
          >
            <Textarea
              name="inputSchema"
              rows={6}
              placeholder={EXAMPLE_SCHEMA}
              defaultValue={state.values?.["inputSchema"] ?? ""}
              spellCheck={false}
            />
          </Field>

          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              name="sideEffects"
              defaultChecked={state.values?.["sideEffects"] === "on"}
              className="mt-0.5 size-4 rounded border-zinc-700 bg-zinc-950 accent-teal-600"
            />
            <span className="text-sm text-zinc-300">
              Has side effects
              <span className="block text-xs text-zinc-500">
                Tick for anything that writes, sends or costs money. Read-only endpoints are cheaper
                for the agent to try.
              </span>
            </span>
          </label>

          <SubmitButton>Add endpoint</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
