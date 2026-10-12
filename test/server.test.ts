import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { SpeedianceAPI } from "../src/api.js";
import { createServer } from "../src/server.js";
import { fakeSpeediance, loginRoutes } from "./fake.js";

const ok = (data: unknown) => ({ code: 0, data });

function backend() {
  const templates: any[] = [];
  const stored = new Map<string, any>();
  const library = [
    { id: 1, title: "Bench Press", accessories: "1", isLeftRight: 0, actionLibraryList: [{ id: 101 }] },
    { id: 2, title: "Single Arm Row", accessories: "5", isLeftRight: 1, actionLibraryList: [{ id: 201 }] },
    { id: 3, title: "Plank", completionMethod: 2, actionLibraryList: [{ id: 301 }] },
  ];
  const fake = fakeSpeediance({
    ...loginRoutes(),
    "GET /api/app/actionLibraryTab/list": () => ok([{ id: 9, name: "Strength" }]),
    "GET /api/app/actionLibraryGroup/trainingPartGroup": () => ok([{ actionLibraryGroupList: library.map((l) => ({ id: l.id })) }]),
    "GET /api/app/actionLibraryGroup/list": (c) => ok(library.filter((l) => c.query.getAll("ids").includes(String(l.id)))),
    "GET /api/app/accessories/list": () => ok([{ id: 1, name: "Flat Bench" }, { id: 5, name: "Handles" }]),
    "GET /api/app/v4/customTrainingTemplate/appPage": () => ok(templates),
    "GET /api/app/v3/customTrainingTemplate/detailByCode": (c) => ok(stored.get(c.query.get("code")!) ?? null),
    "POST /api/app/v2/customTrainingTemplate": (c) => {
      const code = `T${templates.length + 1}`;
      const id = 500 + templates.length;
      templates.push({ id, code, name: c.body.name, actionNum: c.body.actionLibraryList.length });
      stored.set(code, { id, code, name: c.body.name, actionLibraryList: c.body.actionLibraryList.map((a: any, i: number) => ({ ...a, sort: i })) });
      return ok(null);
    },
    "POST /api/app/templateReservation": () => ok(null),
    "GET /api/mobile/v2/report/userTrainingDataRecord": () => ok([{ trainingId: 77, type: 5, title: "Push", leftWeights: Array.from({ length: 30 }, (_, i) => i) }]),
  });
  return { ...fake, templates, stored };
}

async function connect() {
  const be = backend();
  const server = createServer(new SpeedianceAPI(be.client, be.home), "test");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content[0].text as string;
    return { isError: Boolean(res.isError), text, json: res.isError ? undefined : JSON.parse(text) };
  };
  return { ...be, client, call };
}

describe("MCP server", () => {
  it("exposes the expected tools", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "check_connection", "create_workout", "delete_workout", "get_calendar", "get_exercise", "get_exercise_history",
      "get_session_detail", "get_training_history", "get_training_stats", "get_workout", "list_exercises",
      "list_my_workouts", "schedule_workout", "unschedule_workout", "update_workout",
    ]);
  });

  it("searches the exercise library", async () => {
    const { call } = await connect();
    const res = await call("list_exercises", { query: "row" });
    expect(res.json.exercises).toEqual([expect.objectContaining({ groupId: 2, name: "Single Arm Row", unilateral: true, equipment: ["Handles"] })]);
  });

  it("creates, verifies, reads, renames and schedules a workout", async () => {
    const { call, calls, stored } = await connect();
    const created = await call("create_workout", {
      name: "Upper A",
      exercises: [
        { name: "bench press", sets: [{ reps: 10, weight: 95 }, { reps: 8, weight: 105 }] },
        { group_id: 2, rest_seconds: 45, sets: [{ reps: 12, weight: 30 }, { reps: 12, weight: 30 }] },
        { name: "plank", sets: [{ seconds: 60 }] },
      ],
    });
    expect(created.isError).toBe(false);
    expect(created.json).toMatchObject({ code: "T1", verified: true, exercises: ["Bench Press", "Single Arm Row", "Plank"] });
    const body = calls.find((c) => c.path === "/api/app/v2/customTrainingTemplate")!.body;
    expect(body.actionLibraryList[1]).toMatchObject({ actionLibraryId: 201, leftRight: "1,2", breakTime2: "45,45" });

    const got = await call("get_workout", { code: "T1" });
    expect(got.json.exercises[0].sets[1]).toMatchObject({ reps: 8, weight: 105 });

    const renamed = await call("update_workout", { code: "T1", name: "Upper A v2" });
    expect(renamed.json).toMatchObject({ name: "Upper A v2", verified: true });
    expect(stored.size).toBeGreaterThan(0);

    const sched = await call("schedule_workout", { code: "T1", date: "2026-10-14" });
    expect(sched.json.scheduled).toBe(true);
    expect(calls.at(-1)!.body).toMatchObject({ status: 1, thatDay: "2026-10-14", templateCode: "T1", deviceType: 1 });
  });

  it("returns helpful tool errors", async () => {
    const { call } = await connect();
    const ambiguous = await call("create_workout", { name: "X", exercises: [{ name: "a", sets: [{ reps: 5, weight: 10 }] }] });
    expect(ambiguous.isError).toBe(true);
    const timed = await call("create_workout", { name: "X", exercises: [{ name: "plank", sets: [{ reps: 5 }] }] });
    expect(timed.text).toMatch(/Plank \(timed\).*seconds/);
    const missing = await call("get_workout", { code: "nope" });
    expect(missing.text).toMatch(/list_my_workouts/);
  });

  it("compacts telemetry in training history", async () => {
    const { call } = await connect();
    const res = await call("get_training_history", { days: 7 });
    expect(res.json.sessions[0].leftWeights).toEqual({ count: 30, min: 0, max: 29 });
  });
});
