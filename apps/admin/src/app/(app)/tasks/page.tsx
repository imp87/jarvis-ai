import { Alert, Card, Stack, Text, Title } from "@mantine/core";
import { TaskForm } from "@/components/task-form";
import { TaskList } from "@/components/task-list";
import { ApiError, getTaskRuns, getTasks, getUsers, type Task, type TaskRun } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  let tasks: Task[];
  let users: Awaited<ReturnType<typeof getUsers>>["users"];
  try {
    [tasks, users] = await Promise.all([
      getTasks().then((r) => r.tasks),
      getUsers().then((r) => r.users),
    ]);
  } catch (err) {
    return (
      <Alert color="red" title="Could not reach the orchestrator">
        {err instanceof ApiError ? err.message : String(err)}
      </Alert>
    );
  }

  // Run history is only worth fetching for tasks that have actually run.
  const runsByTask: Record<string, TaskRun[]> = {};
  await Promise.all(
    tasks
      .filter((task) => task.runCount > 0)
      .map(async (task) => {
        runsByTask[task.id] = await getTaskRuns(task.id)
          .then((r) => r.runs)
          .catch(() => []);
      }),
  );

  return (
    <Stack gap="xl">
      <div>
        <Title order={4}>Scheduled tasks</Title>
        <Text size="sm" c="dimmed" mt={4}>
          Work that happens without you asking. An <strong>agent</strong> task runs the full loop
          with every tool available and can decide to message or call you; a{" "}
          <strong>reminder</strong> just delivers a fixed text and never touches the model. Each
          agent task keeps its own conversation across runs, so it can tell what it already
          reported.
        </Text>
      </div>

      <Card withBorder padding="lg">
        <Stack gap="md">
          <Title order={5}>New task</Title>
          <TaskForm users={users} />
        </Stack>
      </Card>

      <Stack gap="sm">
        <Text fw={500}>Tasks ({tasks.length})</Text>
        <TaskList tasks={tasks} runsByTask={runsByTask} />
      </Stack>
    </Stack>
  );
}
