import { deleteMcpServer, reloadMcpServers, setMcpServerEnabled } from "../../actions";
import { ActionButton } from "@/components/form";
import { McpServerForm } from "@/components/mcp-form";
import { ApiError, getMcpServers, type McpServer } from "@/lib/api";
import { Badge, Card, Empty, ErrorBox, Mono } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function McpPage() {
  let servers: McpServer[];
  try {
    servers = (await getMcpServers()).servers;
  } catch (err) {
    return (
      <ErrorBox title="Could not reach the orchestrator">
        {err instanceof ApiError ? err.message : String(err)}
      </ErrorBox>
    );
  }

  return (
    <>
      <Card
        title="Attach an MCP server"
        subtitle="Any MCP server becomes agent tools — no code, no restart."
      >
        <McpServerForm />
      </Card>

      <Card
        title={`Registered servers (${servers.length})`}
        actions={
          <ActionButton action={reloadMcpServers}>Reconnect all</ActionButton>
        }
      >
        {servers.length === 0 ? (
          <Empty>Nothing registered yet.</Empty>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {servers.map((server) => (
              <ServerRow key={server.id} server={server} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function ServerRow({ server }: { server: McpServer }) {
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-zinc-100">{server.name}</span>
            <Badge>{server.transport}</Badge>
            {!server.enabled ? (
              <Badge>disabled</Badge>
            ) : server.connected ? (
              <Badge tone="good">
                connected · {server.toolCount} tool{server.toolCount === 1 ? "" : "s"}
              </Badge>
            ) : (
              <Badge tone="bad">not connected</Badge>
            )}
            {server.hasSecrets && <Badge>secrets stored</Badge>}
          </div>

          {server.description && (
            <p className="mt-1 text-sm text-zinc-400">{server.description}</p>
          )}

          <p className="mt-1 truncate">
            <Mono>
              {server.transport === "http"
                ? server.url
                : [server.command, ...server.args].filter(Boolean).join(" ")}
            </Mono>
          </p>

          {/*
            The reason a server is not connected used to reach the log only,
            which is what made attaching one a guessing game.
          */}
          {server.enabled && !server.connected && server.lastError && (
            <p className="mt-2 rounded border border-red-900/70 bg-red-950/30 px-3 py-2 text-sm text-red-300">
              {server.lastError}
            </p>
          )}

          {server.toolNames.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-zinc-500 hover:text-zinc-300">
                Show {server.toolNames.length} tool name
                {server.toolNames.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {server.toolNames.map((name) => (
                  <li
                    key={name}
                    className="rounded border border-zinc-800 bg-zinc-900/60 px-2 py-0.5"
                  >
                    <Mono>{name}</Mono>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <div className="flex shrink-0 items-start gap-2">
          <ActionButton
            action={setMcpServerEnabled}
            fields={{ id: server.id, enabled: String(!server.enabled) }}
          >
            {server.enabled ? "Disable" : "Enable"}
          </ActionButton>
          <ActionButton
            action={deleteMcpServer}
            tone="danger"
            fields={{ id: server.id }}
            confirm={`Remove "${server.name}"? Its stored secrets go with it.`}
          >
            Remove
          </ActionButton>
        </div>
      </div>
    </li>
  );
}
