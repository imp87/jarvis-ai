"use client";

import { useState } from "react";
import {
  Alert,
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { createTask } from "@/app/actions";
import { notifyResult, zodValidate } from "@/lib/form";
import { emptyTask, taskSchema, type TaskInput } from "@/lib/schemas";
import type { AdminUser } from "@/lib/api";

/** Ready-made expressions, because this is the syntax that gets typed wrong. */
const CRON_PRESETS = [
  { value: "0 8 * * 1-5", label: "Weekdays at 08:00" },
  { value: "0 8 * * *", label: "Every day at 08:00" },
  { value: "0 18 * * 5", label: "Fridays at 18:00" },
  { value: "0 * * * *", label: "Every hour, on the hour" },
  { value: "*/15 * * * *", label: "Every 15 minutes" },
];

const INTERVALS = [
  { value: "300", label: "Every 5 minutes" },
  { value: "900", label: "Every 15 minutes" },
  { value: "1800", label: "Every 30 minutes" },
  { value: "3600", label: "Every hour" },
  { value: "21600", label: "Every 6 hours" },
  { value: "86400", label: "Every 24 hours" },
];

export function TaskForm({ users }: { users: AdminUser[] }) {
  const [pending, setPending] = useState(false);
  const form = useForm<TaskInput>({
    initialValues: emptyTask(users[0]?.id ?? ""),
    validate: zodValidate(taskSchema),
    validateInputOnBlur: true,
  });

  const { kind, scheduleKind } = form.values;

  async function submit(values: TaskInput) {
    setPending(true);
    try {
      const result = await createTask(values);
      notifyResult(result);
      if (result.fieldErrors) form.setErrors(result.fieldErrors);
      if (result.status === "success") {
        form.setValues({ ...emptyTask(values.userId), kind: values.kind });
      }
    } finally {
      setPending(false);
    }
  }

  if (users.length === 0) {
    return (
      <Alert color="yellow" variant="light">
        No users registered yet — a task needs an owner to run as. Add one on the Users page first.
      </Alert>
    );
  }

  return (
    <form onSubmit={form.onSubmit(submit)}>
      <Stack gap="md">
        <SegmentedControl
          fullWidth
          data={[
            { value: "agent", label: "Agent — thinks and uses tools" },
            { value: "notify", label: "Reminder — sends fixed text" },
          ]}
          {...form.getInputProps("kind")}
        />
        <Text size="xs" c="dimmed" mt={-8}>
          {kind === "agent"
            ? "Runs the full agent loop with every tool available. Costs an LLM request per run."
            : "Delivers the message below verbatim. No model involved, so it costs nothing."}
        </Text>

        <Group grow align="flex-start">
          <TextInput label="Title" placeholder="Mail check" {...form.getInputProps("title")} />
          <Select
            label="Runs as"
            data={users.map((u) => ({ value: u.id, label: u.displayName }))}
            allowDeselect={false}
            {...form.getInputProps("userId")}
          />
        </Group>

        <Textarea
          label={kind === "agent" ? "Standing order" : "Message"}
          description={
            kind === "agent"
              ? "Runs later with nobody watching. Say what to check AND what to do about each outcome — including when to stay silent."
              : "Sent exactly as written."
          }
          placeholder={
            kind === "agent"
              ? "Check my inbox. If anything needs an answer today, send me a short summary. If something is genuinely urgent, call me. Otherwise say nothing."
              : "Zeit für die Tabletten."
          }
          autosize
          minRows={3}
          {...form.getInputProps("prompt")}
        />

        <SegmentedControl
          fullWidth
          data={[
            { value: "interval", label: "Every N minutes" },
            { value: "cron", label: "At clock times" },
            { value: "once", label: "Once" },
          ]}
          {...form.getInputProps("scheduleKind")}
        />

        {scheduleKind === "interval" && (
          <Group grow align="flex-start">
            <Select
              label="How often"
              data={INTERVALS}
              allowDeselect={false}
              value={String(form.values.intervalSeconds ?? 300)}
              onChange={(value) => form.setFieldValue("intervalSeconds", Number(value ?? 300))}
            />
            <NumberInput
              label="…or in seconds"
              min={60}
              step={60}
              description="At least 60"
              {...form.getInputProps("intervalSeconds")}
            />
          </Group>
        )}

        {scheduleKind === "cron" && (
          <Group grow align="flex-start">
            <Select
              label="Common schedules"
              placeholder="Pick one to fill the field"
              data={CRON_PRESETS}
              onChange={(value) => value && form.setFieldValue("cron", value)}
            />
            <TextInput
              label="Cron expression"
              placeholder="0 8 * * 1-5"
              description="Minute hour day month weekday"
              styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
              {...form.getInputProps("cron")}
            />
            <TextInput
              label="Timezone"
              description="Cron is read in this zone"
              {...form.getInputProps("timezone")}
            />
          </Group>
        )}

        {scheduleKind === "once" && (
          <TextInput
            type="datetime-local"
            label="When"
            description="Runs once, then the task switches itself off."
            {...form.getInputProps("runAt")}
          />
        )}

        <Group>
          <Button type="submit" loading={pending}>
            Create task
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
