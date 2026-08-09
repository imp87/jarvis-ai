"use client";

import { useState } from "react";
import { createConnector } from "@/app/actions";
import { ActionForm, SubmitButton } from "@/components/form";
import { Field, Input, Select, Textarea } from "@/components/ui";

const AUTH_TYPES = [
  { value: "none", label: "none — public API" },
  { value: "bearer", label: "bearer — Authorization: Bearer <token>" },
  { value: "api_key_header", label: "api_key_header — a named header" },
  { value: "query_param", label: "query_param — a named query parameter" },
  { value: "basic", label: "basic — HTTP basic auth" },
] as const;

/** Only two of the five auth types need a parameter name; the rest imply it. */
const NEEDS_PARAM_NAME = new Set(["api_key_header", "query_param"]);

export function ConnectorForm() {
  const [authType, setAuthType] = useState<string>("none");

  return (
    <ActionForm action={createConnector} className="space-y-4">
      {(state) => (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input
                name="name"
                placeholder="Wetter"
                defaultValue={state.values?.["name"] ?? ""}
                required
              />
            </Field>
            <Field label="Base URL">
              <Input
                name="baseUrl"
                type="url"
                placeholder="https://api.example.com/v1"
                defaultValue={state.values?.["baseUrl"] ?? ""}
                required
              />
            </Field>
          </div>

          <Field
            label="What it is for"
            hint="This is what the model matches a request against. Describe capability, not branding."
          >
            <Textarea
              name="description"
              rows={2}
              placeholder="Current weather and forecasts for any location, by city name or coordinates."
              defaultValue={state.values?.["description"] ?? ""}
              required
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Authentication">
              <Select
                name="authType"
                value={authType}
                onChange={(e) => setAuthType(e.target.value)}
              >
                {AUTH_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </Select>
            </Field>

            {NEEDS_PARAM_NAME.has(authType) && (
              <Field
                label={authType === "api_key_header" ? "Header name" : "Query parameter name"}
                hint={authType === "api_key_header" ? "e.g. X-API-Key" : "e.g. apikey"}
              >
                <Input
                  name="authParamName"
                  defaultValue={state.values?.["authParamName"] ?? ""}
                  required
                />
              </Field>
            )}
          </div>

          {authType !== "none" && (
            <Field
              label="Credential"
              hint="AES-256-GCM encrypted with MASTER_KEY before it reaches the database, decrypted only at call time, and never returned by any API — including this one."
            >
              {/* Never echoed back on failure — see attempt.ts. */}
              <Input name="credential" type="password" autoComplete="off" required />
            </Field>
          )}

          <SubmitButton>Create connector</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
