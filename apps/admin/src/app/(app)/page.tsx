import Link from "next/link";
import { ApiError, getStatus, type Status } from "@/lib/api";
import { Badge, Card, Empty, ErrorBox, Mono } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  let status: Status;
  try {
    status = await getStatus();
  } catch (err) {
    return (
      <ErrorBox title="Could not reach the orchestrator">
        {err instanceof ApiError ? err.message : String(err)}
      </ErrorBox>
    );
  }

  const bySource = {
    builtin: status.tools.filter((t) => t.source === "builtin"),
    mcp: status.tools.filter((t) => t.source === "mcp"),
    connector: status.tools.filter((t) => t.source === "connector"),
  };

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Tools available" value={status.tools.length} />
        <Stat
          label="MCP servers connected"
          value={status.mcpServers.length}
          href="/mcp"
        />
        <Stat
          label="Calls today"
          value={`${status.callBudgetUsage.lastDay} / ${status.policy.maxCallsPerDay || "∞"}`}
          note={`${status.callBudgetUsage.lastHour} in the last hour, limit ${
            status.policy.maxCallsPerHour || "none"
          }`}
        />
      </div>

      <Card title="Tools the agent can call" subtitle="What the model sees on every turn">
        {status.tools.length === 0 ? (
          <Empty>No tools registered yet.</Empty>
        ) : (
          <div className="space-y-5">
            {(["builtin", "mcp", "connector"] as const).map((source) =>
              bySource[source].length === 0 ? null : (
                <div key={source}>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                    {source} · {bySource[source].length}
                  </h3>
                  <ul className="flex flex-wrap gap-1.5">
                    {bySource[source].map((tool) => (
                      <li
                        key={tool.name}
                        className="flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1"
                        title={tool.sideEffects ? "May change state" : "Read-only"}
                      >
                        <Mono>{tool.name}</Mono>
                        {tool.sideEffects && (
                          <span className="text-[0.625rem] uppercase text-amber-500/70">write</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ),
            )}
          </div>
        )}
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="LLM profiles" subtitle="From config/llm-routing.json — not environment">
          {status.profiles.length === 0 ? (
            <Empty>No profiles configured.</Empty>
          ) : (
            <dl className="space-y-2 text-sm">
              {status.profiles.map((profile) => (
                <div key={profile.name} className="flex items-baseline justify-between gap-3">
                  <dt className="text-zinc-300">{profile.name}</dt>
                  <dd className="truncate text-right">
                    <Mono>
                      {profile.provider}/{profile.model}
                    </Mono>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Card>

        <Card title="Policy" subtitle="Hard ceilings on anything that costs money or rings a phone">
          <dl className="space-y-2 text-sm">
            <Row label="Quiet hours">
              {status.policy.quietHours.start}–{status.policy.quietHours.end}{" "}
              <span className="text-zinc-500">({status.policy.quietHours.timezone})</span>
            </Row>
            <Row label="Calls per hour">
              {status.policy.maxCallsPerHour || <Badge tone="warn">unlimited</Badge>}
            </Row>
            <Row label="Calls per day">
              {status.policy.maxCallsPerDay || <Badge tone="warn">unlimited</Badge>}
            </Row>
            <Row label="Agent steps per turn">{status.policy.maxAgentSteps}</Row>
          </dl>
        </Card>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  note,
  href,
}: {
  label: string;
  value: string | number;
  note?: string;
  href?: string;
}) {
  const body = (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-5 py-4 transition-colors hover:border-zinc-700">
      <p className="text-xs uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-zinc-100">{value}</p>
      {note && <p className="mt-1 text-xs text-zinc-500">{note}</p>}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-zinc-400">{label}</dt>
      <dd className="text-right text-zinc-200">{children}</dd>
    </div>
  );
}
