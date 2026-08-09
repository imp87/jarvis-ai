import assert from "node:assert/strict";
import test from "node:test";
import { TaskService } from "../src/services/tasks.js";

test("TaskService rejects a one-off scheduled even slightly in the past", async () => {
  const service = new TaskService(
    { create: async () => undefined, countForCreator: async () => 0 } as never,
  );
  await assert.rejects(
    service.create({
      userId: "user",
      title: "past reminder",
      kind: "agent",
      prompt: "do not run",
      channel: "telegram",
      schedule: { kind: "once", timezone: "Europe/Berlin" },
      runAt: new Date(Date.now() - 1),
      createdBy: "agent",
    }),
    /time is in the past/,
  );
});
