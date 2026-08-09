import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteConnector, deleteEndpoint } from "../../../actions";
import { ActionButton } from "@/components/form";
import { EndpointForm } from "@/components/endpoint-form";
import { ApiError, getConnectors, type Connector } from "@/lib/api";
import { Badge, Card, Empty, ErrorBox, Mono } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ConnectorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let connectors: Connector[];
  try {
    // There is no single-connector read endpoint; the list already carries the
    // endpoints, so filtering here beats adding a route for one page.
    connectors = (await getConnectors()).connectors;
  } catch (err) {
    return (
      <ErrorBox title="Could not reach the orchestrator">
        {err instanceof ApiError ? err.message : String(err)}
      </ErrorBox>
    );
  }

  const connector = connectors.find((c) => c.id === id);
  if (!connector) notFound();

  return (
    <>
      <div>
        <Link href="/connectors" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← Connectors
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-zinc-100">
              {connector.name}
              {!connector.enabled && <Badge>disabled</Badge>}
            </h1>
            <p className="mt-1 text-sm text-zinc-400">{connector.description}</p>
            <p className="mt-1">
              <Mono>{connector.baseUrl}</Mono>{" "}
              <span className="text-xs text-zinc-500">
                · auth: {connector.authType}
                {connector.authParamName ? ` (${connector.authParamName})` : ""}
              </span>
            </p>
          </div>
          <ActionButton
            action={deleteConnector}
            tone="danger"
            fields={{ id: connector.id }}
            confirm={`Delete "${connector.name}"? Its ${connector.endpoints.length} endpoint(s) and stored credential go with it.`}
          >
            Delete connector
          </ActionButton>
        </div>
      </div>

      <Card title={`Endpoints (${connector.endpoints.length})`} subtitle="One endpoint, one tool">
        {connector.endpoints.length === 0 ? (
          <Empty>No endpoints yet — this connector contributes no tools.</Empty>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {connector.endpoints.map((endpoint) => (
              <li
                key={endpoint.id}
                className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-zinc-100">{endpoint.name}</span>
                    <Badge>{endpoint.method}</Badge>
                    {endpoint.sideEffects && <Badge tone="warn">side effects</Badge>}
                    {!endpoint.enabled && <Badge>disabled</Badge>}
                  </div>
                  <p className="mt-1 truncate">
                    <Mono>{endpoint.path}</Mono>
                  </p>
                  <p className="mt-1 text-sm text-zinc-400">{endpoint.description}</p>
                </div>
                <ActionButton
                  action={deleteEndpoint}
                  tone="danger"
                  fields={{ id: endpoint.id, connectorId: connector.id }}
                  confirm={`Remove endpoint "${endpoint.name}"?`}
                >
                  Remove
                </ActionButton>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Add an endpoint">
        <EndpointForm connectorId={connector.id} />
      </Card>
    </>
  );
}
