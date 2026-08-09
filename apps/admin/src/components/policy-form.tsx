"use client";

import { useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { updatePolicy, type PolicyPatch } from "@/app/actions";
import { notifyResult } from "@/lib/form";
import type { PolicyDefaults, ResolvedPolicy } from "@/lib/api";

/** Common enough to be worth a list; anything else can be typed. */
const TIMEZONES = [
  "Europe/Berlin",
  "Europe/Vienna",
  "Europe/Zurich",
  "Europe/London",
  "UTC",
];

type Field = keyof ResolvedPolicy["overridden"];

export function PolicyForm({
  policy,
  defaults,
}: {
  policy: ResolvedPolicy;
  defaults: PolicyDefaults;
}) {
  const [pending, setPending] = useState(false);
  const form = useForm<PolicyPatch>({
    initialValues: {
      quietHoursStart: policy.quietHours.start,
      quietHoursEnd: policy.quietHours.end,
      quietHoursTimezone: policy.quietHours.timezone,
      maxCallsPerHour: policy.maxCallsPerHour,
      maxCallsPerDay: policy.maxCallsPerDay,
    },
  });

  async function submit(values: PolicyPatch) {
    setPending(true);
    try {
      const result = await updatePolicy(values);
      notifyResult(result);
      if (result.fieldErrors) form.setErrors(result.fieldErrors);
    } finally {
      setPending(false);
    }
  }

  /** Hands one setting back to the deployed environment value. */
  async function reset(field: Field, formKey: keyof PolicyPatch) {
    setPending(true);
    try {
      const result = await updatePolicy({ ...form.values, [formKey]: null });
      notifyResult(result);
      if (result.status !== "error") {
        form.setFieldValue(formKey, envValueFor(field, defaults) as never);
      }
    } finally {
      setPending(false);
    }
  }

  const source = (field: Field, formKey: keyof PolicyPatch) =>
    policy.overridden[field] ? (
      <Group gap={6} mt={4}>
        <Badge size="xs" variant="light" color="teal">
          set here
        </Badge>
        <Anchor
          component="button"
          type="button"
          size="xs"
          c="dimmed"
          onClick={() => void reset(field, formKey)}
        >
          reset to {String(envValueFor(field, defaults))}
        </Anchor>
      </Group>
    ) : (
      <Text size="xs" c="dimmed" mt={4}>
        from the environment
      </Text>
    );

  return (
    <form onSubmit={form.onSubmit(submit)}>
      <Stack gap="lg">
        <Stack gap="xs">
          <Text fw={500}>Quiet hours</Text>
          <Text size="sm" c="dimmed">
            The agent will not ring your phone inside this window. A start after the end wraps
            midnight, which is the normal case.
          </Text>
          <Group grow align="flex-start">
            <div>
              <TextInput label="From" placeholder="22:00" {...form.getInputProps("quietHoursStart")} />
              {source("quietHoursStart", "quietHoursStart")}
            </div>
            <div>
              <TextInput label="Until" placeholder="07:00" {...form.getInputProps("quietHoursEnd")} />
              {source("quietHoursEnd", "quietHoursEnd")}
            </div>
            <div>
              <Select
                label="Timezone"
                data={TIMEZONES}
                searchable
                allowDeselect={false}
                {...form.getInputProps("quietHoursTimezone")}
              />
              {source("quietHoursTimezone", "quietHoursTimezone")}
            </div>
          </Group>
        </Stack>

        <Stack gap="xs">
          <Text fw={500}>How often it may call</Text>
          <Text size="sm" c="dimmed">
            A hard ceiling, counted against calls actually placed. Blocked attempts cost nothing.
          </Text>
          <Group grow align="flex-start">
            <div>
              <NumberInput
                label="Calls per hour"
                min={0}
                max={100}
                description="0 means unlimited"
                {...form.getInputProps("maxCallsPerHour")}
              />
              {source("maxCallsPerHour", "maxCallsPerHour")}
            </div>
            <div>
              <NumberInput
                label="Calls per day"
                min={0}
                max={500}
                description="0 means unlimited"
                {...form.getInputProps("maxCallsPerDay")}
              />
              {source("maxCallsPerDay", "maxCallsPerDay")}
            </div>
          </Group>
        </Stack>

        {(form.values.maxCallsPerHour === 0 || form.values.maxCallsPerDay === 0) && (
          <Alert color="yellow" variant="light">
            A limit of 0 means <strong>unlimited</strong>, not "never". To stop the agent calling at
            all, disable the voice_call identity on the Users page.
          </Alert>
        )}

        <Group>
          <Button type="submit" loading={pending}>
            Save
          </Button>
          <Text size="xs" c="dimmed">
            Applies to the next call — no restart.
          </Text>
        </Group>
      </Stack>
    </form>
  );
}

function envValueFor(field: Field, defaults: PolicyDefaults): string | number {
  switch (field) {
    case "quietHoursStart":
      return defaults.quietHours.start;
    case "quietHoursEnd":
      return defaults.quietHours.end;
    case "quietHoursTimezone":
      return defaults.quietHours.timezone;
    case "maxCallsPerHour":
      return defaults.maxCallsPerHour;
    case "maxCallsPerDay":
      return defaults.maxCallsPerDay;
  }
}
