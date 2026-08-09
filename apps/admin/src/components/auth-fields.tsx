"use client";

import { PasswordInput, Select, Stack, Textarea, TextInput } from "@mantine/core";
import type { UseFormReturnType } from "@mantine/form";
import type { AuthInput, AuthMode } from "@/lib/schemas";

/**
 * The authentication picker, shared by the MCP and connector forms.
 *
 * Choosing a method and pasting one value covers essentially every API worth
 * attaching. The raw-headers escape hatch is still there, but it is no longer
 * the only way in — which it was, and which meant knowing that a bearer token
 * belongs in an `Authorization` header behind the literal word `Bearer`.
 */

interface Option {
  value: AuthMode;
  label: string;
  description: string;
}

const ALL_OPTIONS: Option[] = [
  { value: "none", label: "None", description: "Public — no credential" },
  { value: "bearer", label: "Bearer token", description: "Authorization: Bearer <token>" },
  { value: "header", label: "API key in a header", description: "A named header, e.g. X-API-Key" },
  { value: "query", label: "API key in the URL", description: "A named query parameter" },
  { value: "basic", label: "Username and password", description: "HTTP basic auth" },
  { value: "custom", label: "Custom headers", description: "Anything else, typed by hand" },
];

export function AuthFields<T extends { auth: AuthInput }>({
  form,
  /**
   * Query-parameter auth is offered for connectors but not for MCP servers: an
   * MCP endpoint URL carries its own query string, and merging a secret into it
   * silently is worse than not offering the option.
   */
  exclude = [],
  secretLabel = "Token",
}: {
  form: UseFormReturnType<T>;
  exclude?: AuthMode[];
  secretLabel?: string;
}) {
  // Casts: Mantine types nested paths as literal strings, which it cannot infer
  // through a generic parameter.
  const field = (name: string) => form.getInputProps(`auth.${name}` as never);
  const mode = (form.values as { auth: AuthInput }).auth.mode;
  const options = ALL_OPTIONS.filter((option) => !exclude.includes(option.value));

  return (
    <Stack gap="sm">
      <Select
        label="Authentication"
        data={options.map((o) => ({ value: o.value, label: o.label }))}
        renderOption={({ option }) => {
          const meta = options.find((o) => o.value === option.value);
          return (
            <div>
              <div>{option.label}</div>
              <div style={{ fontSize: "var(--mantine-font-size-xs)", opacity: 0.6 }}>
                {meta?.description}
              </div>
            </div>
          );
        }}
        allowDeselect={false}
        {...field("mode")}
      />

      {mode === "bearer" && (
        <PasswordInput
          label={secretLabel}
          placeholder="sk-..."
          description="Pasted as-is. The 'Bearer' prefix is added for you."
          {...field("token")}
        />
      )}

      {mode === "header" && (
        <>
          <TextInput label="Header name" placeholder="X-API-Key" {...field("headerName")} />
          <PasswordInput label={secretLabel} {...field("token")} />
        </>
      )}

      {mode === "query" && (
        <>
          <TextInput label="Parameter name" placeholder="api_key" {...field("paramName")} />
          <PasswordInput label={secretLabel} {...field("token")} />
        </>
      )}

      {mode === "basic" && (
        <>
          <TextInput label="Username" autoComplete="off" {...field("username")} />
          <PasswordInput label="Password" autoComplete="new-password" {...field("password")} />
        </>
      )}

      {mode === "custom" && (
        <Textarea
          label="Headers"
          description="One per line, as 'Name: value' or 'Name=value'."
          placeholder={"Authorization: Bearer sk-...\nX-Account: 42"}
          autosize
          minRows={2}
          maxRows={6}
          styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
          {...field("raw")}
        />
      )}
    </Stack>
  );
}
