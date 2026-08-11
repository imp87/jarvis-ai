import assert from "node:assert/strict";
import test from "node:test";
import type { ToolContext } from "@jarvis/shared";
import type { TaskRepository } from "@jarvis/db";
import { buildTaskTools, parseWallClock } from "../src/agent/tools/tasks.js";
import type { CreateTaskInput, TaskService } from "../src/services/tasks.js";
import type { NotificationService } from "../src/services/notify.js";

const BERLIN = "Europe/Berlin";
const ctx: ToolContext = { conversationId: "conv-1", userId: "user-1", channel: "telegram" };

test("a local day and clock time become the instant they denote", () => {
  // The regression: "morgen um 07:45" on the night of 2026-08-10.
  assert.equal(parseWallClock("2026-08-11", "07:45", BERLIN)?.toISOString(), "2026-08-11T05:45:00.000Z");
  assert.equal(parseWallClock("2026-01-15", "07:45", BERLIN)?.toISOString(), "2026-01-15T06:45:00.000Z");
  assert.equal(parseWallClock("2026-08-11", "7:45", BERLIN)?.toISOString(), "2026-08-11T05:45:00.000Z");
});

test("a date that does not exist is rejected instead of rolling into next month", () => {
  // Date.UTC turns 31 April into 1 May without complaint, which would schedule
  // a reminder for a day the user never named.
  assert.equal(parseWallClock("2026-04-31", "07:45", BERLIN), undefined);
  assert.equal(parseWallClock("2026-02-30", "07:45", BERLIN), undefined);
  assert.equal(parseWallClock("2026-13-01", "07:45", BERLIN), undefined);
  // 2028 is a leap year, 2026 is not.
  assert.equal(parseWallClock("2026-02-29", "07:45", BERLIN), undefined);
  assert.ok(parseWallClock("2028-02-29", "07:45", BERLIN));
});

test("malformed input is rejected rather than guessed at", () => {
  for (const [day, clock] of [
    ["11.08.2026", "07:45"],
    ["2026-08-11", "quarter to eight"],
    ["2026-08-11", "25:00"],
    ["2026-08-11", "07:60"],
    ["", "07:45"],
  ] as const) {
    assert.equal(parseWallClock(day, clock, BERLIN), undefined, `${day} ${clock}`);
  }
});

/** Captures what the tool asked the service to create, without a database. */
function harness(timezone: string) {
  const created: CreateTaskInput[] = [];
  const taskService = {
    create: async (input: CreateTaskInput) => {
      created.push(input);
      return { id: "task-1", title: input.title, nextRunAt: input.runAt ?? null };
    },
  } as unknown as TaskService;
  const notifications = {
    availableChannels: () => ["telegram"],
  } as unknown as NotificationService;

  const tools = buildTaskTools({
    tasks: {} as unknown as TaskRepository,
    taskService,
    notifications,
    timezone,
  });
  const create = tools.find((tool) => tool.name === "task_create");
  assert.ok(create);
  return { create, created };
}

test("task_create schedules the wall-clock time in the owner's zone", async () => {
  const { create, created } = harness(BERLIN);
  const result = await create.execute(
    {
      title: "Morgen um 07:45 anrufen",
      instruction: "Ruf Steven an und erinnere ihn an den Termin.",
      run_on: "2026-08-11",
      run_at: "07:45",
    },
    ctx,
  );

  assert.equal(created.length, 1);
  assert.equal(created[0]?.schedule.kind, "once");
  assert.equal(created[0]?.schedule.timezone, BERLIN);
  assert.equal(created[0]?.runAt?.toISOString(), "2026-08-11T05:45:00.000Z");
  // The confirmation reads back in local time, so a wrong slot is visible.
  assert.match(String(result.content), /2026-08-11 07:45:00 Europe\/Berlin/);
});

test("a broken timezone setting falls back to Berlin rather than drifting to UTC", async () => {
  const { create, created } = harness("Nonsense/Zone");
  await create.execute(
    { title: "Wecken", instruction: "Ruf an.", run_on: "2026-08-11", run_at: "07:45" },
    ctx,
  );
  assert.equal(created[0]?.schedule.timezone, BERLIN);
  assert.equal(created[0]?.runAt?.toISOString(), "2026-08-11T05:45:00.000Z");
});

test("run_on and run_at must be given together", async () => {
  const { create, created } = harness(BERLIN);
  for (const args of [
    { title: "T", instruction: "I", run_on: "2026-08-11" },
    { title: "T", instruction: "I", run_at: "07:45" },
  ]) {
    const result = await create.execute(args, ctx);
    assert.equal(result.isError, true);
    assert.match(String(result.content), /go together/);
  }
  assert.equal(created.length, 0);
});

test("exactly one schedule form is accepted", async () => {
  const { create, created } = harness(BERLIN);
  const both = await create.execute(
    { title: "T", instruction: "I", run_on: "2026-08-11", run_at: "07:45", delay_seconds: 3600 },
    ctx,
  );
  assert.equal(both.isError, true);
  assert.match(String(both.content), /exactly one schedule/);

  const none = await create.execute({ title: "T", instruction: "I" }, ctx);
  assert.equal(none.isError, true);
  assert.equal(created.length, 0);
});

test("an invalid wall-clock time is reported, not silently dropped", async () => {
  const { create, created } = harness(BERLIN);
  const result = await create.execute(
    { title: "T", instruction: "I", run_on: "2026-04-31", run_at: "07:45" },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(String(result.content), /not a valid date and time/);
  assert.equal(created.length, 0);
});

test("the relative and recurring forms still work", async () => {
  const { create, created } = harness(BERLIN);
  await create.execute({ title: "T", instruction: "I", delay_seconds: 3600 }, ctx);
  assert.equal(created[0]?.schedule.kind, "once");

  await create.execute({ title: "T", instruction: "I", cron: "0 8 * * 1-5" }, ctx);
  assert.equal(created[1]?.schedule.kind, "cron");
  assert.equal(created[1]?.schedule.timezone, BERLIN);
});
