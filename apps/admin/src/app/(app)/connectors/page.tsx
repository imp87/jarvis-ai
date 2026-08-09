import Link from "next/link";
import { setConnectorEnabled } from "../../actions";
import { ActionButton } from "@/components/form";
import { ConnectorForm } from "@/components/connector-form";
import { ApiError, getConnectors, type Connector } from "@/lib/api";
import { Badge, Card, Empty, ErrorBox, Mono } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ConnectorsPage() {
  let connectors: Connector[];
  try {
    connectors = (await getConnectors()).connectors;
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
        title="Add an HTTP connector"
        subtitle="For plain REST APIs that have no MCP server. Each endpoint you then define becomes one tool."
      >
        <ConnectorForm />
      </Card>

      <Card title={`Connectors (${connectors.length})`}>
        {connectors.length === 0 ? (
          <Empty>Nothing registered yet.</Empty>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {connectors.map((connector) => (
              <li key={connector.id} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/connectors/${connector.id}`}
                        className="font-medium text-zinc-100 underline-offset-4 hover:underline"
                      >
                        {connector.name}
                      </Link>
                      {!connector.enabled && <Badge>disabled</Badge>}
                      <Badge tone={connector.endpoints.length === 0 ? "warn" : "good"}>
                        {connector.endpoints.length} endpoint
                        {connector.endpoints.length === 1 ? "" : "s"}
                      </Badge>
                      <Badge>{connector.authType}</Badge>
                      {connector.hasCredential && <Badge>credential stored</Badge>}
                    </div>
                    <p className="mt-1 text-sm text-zinc-400">{connector.description}</p>
                    <p className="mt-1 truncate">
                      <Mono>{connector.baseUrl}</Mono>
                    </p>
                    {connector.endpoints.length === 0 && (
                      <p className="mt-2 text-sm text-amber-400/80">
                        No endpoints — this connector contributes no tools yet.{" "}
                        <Link href={`/connectors/${connector.id}`} className="underline">
                          Add one
                        </Link>
                        .
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-start gap-2">
                    <ActionButton
                      action={setConnectorEnabled}
                      fields={{ id: connector.id, enabled: String(!connector.enabled) }}
                    >
                      {connector.enabled ? "Disable" : "Enable"}
                    </ActionButton>
                    <Link
                      href={`/connectors/${connector.id}`}
                      className="inline-flex items-center rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
                    >
                      Endpoints
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
