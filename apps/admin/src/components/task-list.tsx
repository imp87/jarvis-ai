"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Collapse,
  Group,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { deleteTask, runTaskNow, setTaskEnabled } from "@/app/actions";
import { ConfirmButton } from "@/components/confirm-button";
import { notifyResult } from "@/lib/form";
import type { Task, TaskRun } from "@/lib/api";

export function TaskList({
  tasks,
  runsByTask,
}: {
  tasks: Task[];
  runsByTask: Record<string, TaskRun[]>;
}) {
  if (tasks.length === 0) {
    return (
      <Text c="dimmed" size="sm" ta="center" py="lg">
        Nothing scheduled yet.
      </Text>
    );
  }
  return (
    <Stack gap="md">
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} runs={runsByTask[task.id] ?? []} />
      ))}
    </Stack>
  );
}

function TaskCard({ task, runs }: { task: Task; runs: TaskRun[] }) {
  const [pending, start] = useTransition();
  const [showRuns, setShowRuns] = useState(false);

  return (
    <Card withBorder padding="lg">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Group gap="xs">
              <Text fw={500}>{task.title}</Text>
              <Badge variant="light" color={task.kind === "agent" ? "teal" : "gray"} size="sm">
                {task.kind === "agent" ? "agent" : "reminder"}
              </Badge>
              <Badge variant="default" size="sm">
                {task.scheduleDescription}
              </Badge>
              {/* Worth showing apart: a task the model scheduled for itself is
                  spend nobody explicitly approved. */}
              {task.createdBy === "agent" && (
                <Badge variant="light" color="grape" size="sm">
                  self-scheduled
                </Badge>
              )}
              {task.failureCount > 0 && (
                <Badge variant="light" color="red" size="sm">
                  {task.failureCount} failed in a row
                </Badge>
              )}
            </Group>
            <Text size="sm" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
              {task.prompt}
            </Text>
            <Text size="xs" c="dimmed">
              {task.enabled && task.nextRunAt
                ? `next ${new Date(task.nextRunAt).toLocaleString("de-DE")}`
                : "not scheduled"}
              {task.lastRunAt
                ? ` · last ${new Date(task.lastRunAt).toLocaleString("de-DE")}`
                : " · never run"}
              {` · ${task.runCount} run(s)`}
            </Text>
          </Stack>

          <Switch
            checked={task.enabled}
            disabled={pending}
            label={task.enabled ? "on" : "off"}
            onChange={(event) => {
              const next = event.currentTarget.checked;
              start(async () => notifyResult(await setTaskEnabled(task.id, next)));
            }}
          />
        </Group>

        {task.lastError && (
          <Alert color="red" variant="light" p="xs">
            <Text size="sm" style={{ overflowWrap: "anywhere" }}>
              {task.lastError}
            </Text>
          </Alert>
        )}

        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            loading={pending}
            onClick={() => start(async () => notifyResult(await runTaskNow(task.id)))}
          >
            Run now
          </Button>
          {runs.length > 0 && (
            <Button size="xs" variant="subtle" onClick={() => setShowRuns((v) => !v)}>
              {showRuns ? "Hide" : "Show"} last {runs.length} run(s)
            </Button>
          )}
          <ConfirmButton
            label="Delete"
            title={`Delete "${task.title}"?`}
            body="The task and its run history go with it. Pausing keeps both."
            onConfirm={async () => notifyResult(await deleteTask(task.id))}
          />
        </Group>

        <Collapse in={showRuns}>
          <Stack gap={6} pt="xs">
            {runs.map((run) => (
              <Group key={run.id} gap="xs" align="flex-start" wrap="nowrap">
                <Badge
                  size="xs"
                  variant="light"
                  color={run.status === "ok" ? "teal" : "red"}
                  style={{ flexShrink: 0 }}
                >
                  {run.status}
                </Badge>
                <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                  {new Date(run.startedAt).toLocaleString("de-DE")}
                  {run.durationMs !== null ? ` · ${Math.round(run.durationMs / 100) / 10}s` : ""}
                </Text>
                <Text size="xs" style={{ overflowWrap: "anywhere" }}>
                  {run.error ?? run.summary ?? "—"}
                </Text>
              </Group>
            ))}
          </Stack>
        </Collapse>
      </Stack>
    </Card>
  );
}
