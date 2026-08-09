"use client";

import { useState } from "react";
import { createMcpServer } from "@/app/actions";
import { ActionForm, SubmitButton } from "@/components/form";
import { Field, Input, Select, Textarea } from "@/components/ui";

/**
 * The transport decides which half of this form applies, and showing both at
 * once is how you end up with a stdio server that has a URL and no command.
 */
export function McpServerForm() {
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");

  return (
    <ActionForm action={createMcpServer} className="space-y-4">
      {(state) => (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="Becomes part of every tool name: mcp_<name>__<tool>">
              <Input
                name="name"
                placeholder="filesystem"
                defaultValue={state.values?.["name"] ?? ""}
                required
              />
            </Field>
            <Field label="Transport">
              <Select
                name="transport"
                value={transport}
                onChange={(e) => setTransport(e.target.value as "stdio" | "http")}
              >
                <option value="stdio">stdio — a local process</option>
                <option value="http">http — a remote server</option>
              </Select>
            </Field>
          </div>

          <Field
            label="What it is for"
            hint="Appended to every tool description. Write the purpose ('my notes live here'), not the mechanism ('reads files') — it is how the model tells two similar tools apart."
          >
            <Input
              name="description"
              placeholder="Access to my local notes and project files"
              defaultValue={state.values?.["description"] ?? ""}
            />
          </Field>

          {transport === "http" ? (
            <Field label="URL">
              <Input
                name="url"
                type="url"
                placeholder="https://mcp.example.com/mcp"
                defaultValue={state.values?.["url"] ?? ""}
                required
              />
            </Field>
          ) : (
            <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
              <Field label="Command">
                <Input
                  name="command"
                  placeholder="npx"
                  defaultValue={state.values?.["command"] ?? ""}
                  required
                />
              </Field>
              <Field
                label="Arguments"
                hint={
                  'Space-separated; quote anything containing spaces. ${VAR} is expanded on the host.'
                }
              >
                <Input
                  name="args"
                  placeholder="-y @modelcontextprotocol/server-filesystem ${MCP_WORKSPACE_DIR}"
                  defaultValue={state.values?.["args"] ?? ""}
                />
              </Field>
            </div>
          )}

          <Field
            label={transport === "http" ? "Headers" : "Environment variables"}
            hint={
              transport === "http"
                ? "One KEY=value per line. Encrypted with MASTER_KEY before it touches the database and never shown again."
                : "One KEY=value per line — only these reach the process, not the orchestrator's own keys. Encrypted at rest."
            }
          >
            {/* Never echoed back on failure: it holds the credential. */}
            <Textarea
              name="secrets"
              rows={3}
              placeholder={transport === "http" ? "Authorization=Bearer sk-..." : "API_TOKEN=..."}
            />
          </Field>

          <div className="flex items-center gap-3 pt-1">
            <SubmitButton>Register and connect</SubmitButton>
            <span className="text-xs text-zinc-500">
              Connects immediately — the tools are usable without a restart.
            </span>
          </div>
        </>
      )}
    </ActionForm>
  );
}
