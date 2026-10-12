import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isoDate, type SpeedianceAPI } from "./api.js";
import { SpeedianceError } from "./client.js";
import { accessoryNames, filterExercises, resolveByName, summarize, type ExerciseSummary } from "./library.js";
import { MAX_SETS, SPORT_MODES, buildTemplate, readTemplate, validateSets, verifyTemplate, type ExerciseSpec } from "./templates.js";

const INSTRUCTIONS = `Tools for the user's Speediance Gym Monster (via the unofficial Speediance app API).
- Weights are always in the account's display unit (see check_connection.unit). Never convert silently.
- Before creating a workout, look movements up with list_exercises so names resolve to real library items.
- Base loads on the user's recent history (get_training_history, get_session_detail, get_exercise_history), not guesses.
- create_workout/update_workout read the template back; if verified is false, tell the user to check the app before training.
- delete_workout is permanent: only use it when the user explicitly asks.`;

type Row = Record<string, any>;

/** Shrinks session payloads: long numeric telemetry series become {count,min,max}; nulls/empties drop. */
export function compact(value: unknown, depth = 0): unknown {
  const series = (nums: number[]) => ({ count: nums.length, min: Math.min(...nums), max: Math.max(...nums) });
  if (typeof value === "string" && /^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){20,}$/.test(value)) {
    return series(value.split(",").map(Number));
  }
  if (Array.isArray(value)) {
    if (value.length > 20 && value.every((v) => typeof v === "number")) return series(value as number[]);
    return depth > 8 ? `[${value.length} items]` : value.map((v) => compact(v, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Row = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
      out[k] = depth > 8 ? "…" : compact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/** Runs a tool body, turning thrown errors into readable tool errors. */
async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof SpeedianceError || err instanceof ToolError) return fail(err.message);
    return fail(`Unexpected error: ${(err as Error).message ?? String(err)}`);
  }
}

class ToolError extends Error {}

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return isoDate(d);
}

function tomorrow(): string {
  return daysAgo(-1);
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

const setSchema = z
  .object({
    reps: z.number().int().optional().describe("Reps, for rep-based movements."),
    weight: z.number().optional().describe("Load per set in the account's display unit (lb or kg)."),
    seconds: z.number().int().optional().describe("Duration, for timed or Vita (level) movements."),
    level: z.number().int().optional().describe("Vita level, for level-based movements."),
    rest: z.number().int().optional().describe("Rest after this set in seconds (default: the exercise's rest_seconds)."),
    side: z.enum(["left", "right"]).optional().describe("Pin a side. Unilateral moves alternate automatically."),
    mode: z
      .enum(Object.keys(SPORT_MODES) as [keyof typeof SPORT_MODES, ...(keyof typeof SPORT_MODES)[]])
      .optional()
      .describe("Machine training mode (default standard). Experimental: confirm in the app."),
  })
  .describe("One set. Rep moves: {reps, weight}. Timed: {seconds}. Vita: {seconds, level}.");

const exerciseSchema = z.object({
  name: z.string().optional().describe("Exercise name from list_exercises (exact or unambiguous)."),
  group_id: z.number().int().optional().describe("Exercise groupId from list_exercises (wins over name)."),
  rest_seconds: z.number().int().optional().describe("Default rest between sets (default 60)."),
  sets: z.array(setSchema).min(1).max(MAX_SETS),
});

export function createServer(api: SpeedianceAPI, version: string): McpServer {
  const server = new McpServer({ name: "eau-gm-manager-mcp", version }, { instructions: INSTRUCTIONS });

  let accessoryCache: Map<number, string> | undefined;
  async function catalog(): Promise<ExerciseSummary[]> {
    const [raw, acc] = await Promise.all([
      api.library(),
      accessoryCache ? Promise.resolve(accessoryCache) : api.accessories().then(accessoryNames),
    ]);
    accessoryCache = acc;
    return raw.map((r) => summarize(r, acc));
  }

  async function findExercise(name?: string, groupId?: number): Promise<ExerciseSummary> {
    const items = await catalog();
    if (groupId) {
      const hit = items.find((i) => i.groupId === groupId);
      if (!hit) throw new ToolError(`No exercise with group_id ${groupId}. Use list_exercises.`);
      return hit;
    }
    const { match, candidates } = resolveByName(items, name ?? "");
    if (match) return match;
    if (candidates.length) {
      throw new ToolError(
        `"${name}" is ambiguous. Candidates: ${candidates.map((c) => `${c.name} (group_id ${c.groupId})`).join("; ")}`,
      );
    }
    throw new ToolError(`No exercise matches "${name}". Use list_exercises to search.`);
  }

  async function templateRow(handle: string): Promise<Row> {
    const key = String(handle).trim();
    const row = (await api.templates()).find((r) => r.code === key || String(r.id) === key);
    if (!row) throw new ToolError(`No workout template "${key}". Call list_my_workouts for current codes.`);
    return row;
  }

  async function resolveSpecs(exercises: z.infer<typeof exerciseSchema>[]): Promise<ExerciseSpec[]> {
    const specs: ExerciseSpec[] = [];
    for (const ex of exercises) {
      const item = await findExercise(ex.name, ex.group_id);
      if (item.variantId == null) throw new ToolError(`${item.name} has no playable variant in the library.`);
      try {
        specs.push({
          groupId: item.groupId,
          variantId: item.variantId,
          name: item.name,
          kind: item.kind,
          unilateral: item.unilateral,
          sets: validateSets(item.kind, ex.sets, ex.rest_seconds ?? 60),
        });
      } catch (err) {
        throw new ToolError(`${item.name} (${item.kind}): ${(err as Error).message}.`);
      }
    }
    return specs;
  }

  async function verified(body: Row, code: string) {
    const mismatches = verifyTemplate(body, await api.template(code));
    return {
      verified: mismatches.length === 0,
      ...(mismatches.length
        ? { mismatches, warning: "The saved template doesn't match what was sent. Check it in the Speediance app before training." }
        : {}),
    };
  }

  const cleanName = (name: string) => {
    const n = name.trim();
    if (!n || n.length > 60) throw new ToolError("name must be 1-60 characters.");
    return n;
  };

  // ---------------------------------------------------------------- account
  server.registerTool(
    "check_connection",
    {
      title: "Check Speediance connection",
      description: "Confirm the Speediance login works. Returns the account's display unit, region and device type.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const profile = await api.profile();
        return {
          connected: true,
          nickname: profile.nickName ?? profile.nickname ?? profile.name,
          unit: api.unit,
          region: api.client.region,
          deviceType: api.deviceType,
        };
      }),
  );

  // ---------------------------------------------------------------- history
  server.registerTool(
    "get_training_history",
    {
      title: "Training history",
      description:
        "List completed sessions (any type: custom workouts, courses, Free Lift, cardio). Use a session's trainingId and type with get_session_detail.",
      inputSchema: {
        days: z.number().int().min(1).max(730).optional().describe("Look back this many days (default 30)."),
        start_date: dateSchema.optional().describe("Explicit start date (overrides days)."),
        end_date: dateSchema.optional().describe("Explicit end date, inclusive (default today)."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ days, start_date, end_date }) =>
      run(async () => {
        const start = start_date ?? daysAgo((days ?? 30) - 1);
        // The endpoint's end date is exclusive.
        const end = end_date ? isoDate(new Date(new Date(`${end_date}T12:00:00`).getTime() + 86400000)) : tomorrow();
        const rows = await api.history(start, end);
        return { unit: api.unit, start, end: end_date ?? isoDate(new Date()), count: rows.length, sessions: compact(rows) };
      }),
  );

  server.registerTool(
    "get_session_detail",
    {
      title: "Session detail",
      description:
        "Per-exercise, per-set detail for one completed session: reps, load, time, sides. Long telemetry series are summarized as {count,min,max}.",
      inputSchema: {
        training_id: z.union([z.number().int(), z.string()]).describe("trainingId from get_training_history."),
        type: z.number().int().optional().describe("The session's `type` from get_training_history (speeds up lookup)."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ training_id, type }) =>
      run(async () => {
        const { route, data } = await api.sessionDetail(training_id, type);
        if (!data) throw new ToolError(`No detail found for session ${training_id}.`);
        return { unit: api.unit, trainingId: training_id, source: route, detail: compact(data) };
      }),
  );

  server.registerTool(
    "get_training_stats",
    {
      title: "Training stats",
      description: "Aggregate totals (sessions, time, volume, calories) for a date range.",
      inputSchema: {
        start_date: dateSchema.describe("Start date."),
        end_date: dateSchema.describe("End date."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ start_date, end_date }) => run(async () => ({ unit: api.unit, ...compact(await api.stats(start_date, end_date)) as Row })),
  );

  server.registerTool(
    "get_calendar",
    {
      title: "Training calendar",
      description: "Completed and scheduled workouts for a month.",
      inputSchema: {
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/, "use YYYY-MM")
          .optional()
          .describe("Month as YYYY-MM (default this month)."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ month }) => run(async () => compact(await api.calendar(month ?? isoDate(new Date()).slice(0, 7)))),
  );

  server.registerTool(
    "get_exercise_history",
    {
      title: "Exercise history",
      description:
        "Weekly stats for one movement over time (each row is one week, keyed by its Monday). Good for progression and load suggestions.",
      inputSchema: {
        name: z.string().optional().describe("Exercise name."),
        group_id: z.number().int().optional().describe("Exercise groupId (wins over name)."),
        weeks: z.number().int().min(1).max(260).optional().describe("Max weeks to return (default 26)."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ name, group_id, weeks }) =>
      run(async () => {
        const item = await findExercise(name, group_id);
        const rows = await api.exerciseStats(item.groupId, weeks ?? 26);
        return { exercise: item.name, groupId: item.groupId, unit: api.unit, weeks: compact(rows) };
      }),
  );

  // ---------------------------------------------------------------- exercises
  server.registerTool(
    "list_exercises",
    {
      title: "Search exercise library",
      description:
        "Search the Gym Monster exercise library. Returns groupId, name, muscles, equipment, kind (reps | timed | level) and whether it's unilateral. The first call can take a minute while the library downloads; it's cached for 24h.",
      inputSchema: {
        query: z.string().optional().describe("Words that must appear in the name, e.g. 'row' or 'bench press'."),
        muscle: z.string().optional().describe("Body part or muscle, e.g. 'chest', 'glutes'."),
        category: z.string().optional().describe("Library tab/category."),
        equipment: z.string().optional().describe("Accessory, e.g. 'bench', 'barbell', 'handles'."),
        kind: z.enum(["reps", "timed", "level"]).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(async () => {
        const items = filterExercises(await catalog(), args);
        return { count: items.length, exercises: items.map(({ variantId: _v, ...rest }) => rest) };
      }),
  );

  server.registerTool(
    "get_exercise",
    {
      title: "Exercise detail",
      description: "Full library entry for one movement: description, muscles, equipment, variants.",
      inputSchema: {
        name: z.string().optional(),
        group_id: z.number().int().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ name, group_id }) =>
      run(async () => {
        const item = await findExercise(name, group_id);
        return { ...item, detail: compact(await api.exercise(item.groupId)) };
      }),
  );

  // ---------------------------------------------------------------- workouts
  server.registerTool(
    "list_my_workouts",
    {
      title: "List custom workouts",
      description: "The user's saved custom workout templates. Use a template's `code` with the other workout tools.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => ({
        workouts: (await api.templates()).map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          exercises: r.actionNum,
          durationMinute: r.durationMinute,
        })),
      })),
  );

  server.registerTool(
    "get_workout",
    {
      title: "Get custom workout",
      description: "A template's full prescription: exercises in order with each set's reps/seconds, weight, level, side and rest.",
      inputSchema: { code: z.string().describe("Template code (or numeric id) from list_my_workouts.") },
      annotations: { readOnlyHint: true },
    },
    ({ code }) =>
      run(async () => {
        const row = await templateRow(code);
        const detail = await api.template(row.code);
        if (!detail) throw new ToolError(`Speediance returned no detail for template ${code}.`);
        return { unit: api.unit, ...readTemplate(detail) };
      }),
  );

  server.registerTool(
    "create_workout",
    {
      title: "Create custom workout",
      description:
        "Create a custom workout template that shows up on the Gym Monster. Weights are in the account's display unit. The template is read back after saving; verified:false means Speediance stored something different.",
      inputSchema: {
        name: z.string().describe("Workout name (1-60 chars)."),
        exercises: z.array(exerciseSchema).min(1).max(40).describe("Exercises in order."),
      },
    },
    ({ name, exercises }) =>
      run(async () => {
        const cleaned = cleanName(name);
        const specs = await resolveSpecs(exercises);
        const before = new Set((await api.templates()).map((r) => r.code));
        const body = buildTemplate(cleaned, specs, { unit: api.unit, deviceType: api.deviceType });
        await api.saveTemplate(body);
        const created = (await api.templates()).filter((r) => !before.has(r.code) && r.name === cleaned);
        if (!created.length) {
          throw new ToolError(
            "Speediance accepted the workout but it isn't listed yet. Check list_my_workouts before retrying to avoid a duplicate.",
          );
        }
        const row = created.reduce((a, b) => ((a.id ?? 0) > (b.id ?? 0) ? a : b));
        return { id: row.id, code: row.code, name: row.name, exercises: specs.map((s) => s.name), ...(await verified(body, row.code)) };
      }),
  );

  server.registerTool(
    "update_workout",
    {
      title: "Update custom workout",
      description:
        "Edit a template in place. `exercises` replaces the whole list (same format as create_workout); start from get_workout. Omit it to only rename.",
      inputSchema: {
        code: z.string().describe("Template code (or numeric id)."),
        name: z.string().optional().describe("New name."),
        exercises: z.array(exerciseSchema).min(1).max(40).optional(),
      },
    },
    ({ code, name, exercises }) =>
      run(async () => {
        const row = await templateRow(code);
        let specs: ExerciseSpec[];
        if (exercises) {
          specs = await resolveSpecs(exercises);
        } else {
          // Rename only: rebuild the existing prescription from the stored template.
          const detail = await api.template(row.code);
          if (!detail) throw new ToolError(`Speediance returned no detail for template ${code}.`);
          const stored = readTemplate(detail);
          specs = await resolveSpecs(
            stored.exercises.map((e) => ({
              group_id: e.groupId,
              sets: e.sets.map((s) => {
                if (!(s.mode in SPORT_MODES)) {
                  throw new ToolError(`${e.name} uses a training mode this server doesn't know; pass the full exercises list instead.`);
                }
                return { ...s, mode: s.mode as keyof typeof SPORT_MODES };
              }),
            })),
          );
        }
        const newName = name !== undefined ? cleanName(name) : String(row.name ?? "");
        const body = buildTemplate(newName, specs, { unit: api.unit, deviceType: api.deviceType, templateId: row.id });
        await api.saveTemplate(body);
        return { code: row.code, name: newName, exercises: specs.map((s) => s.name), ...(await verified(body, row.code)) };
      }),
  );

  server.registerTool(
    "delete_workout",
    {
      title: "Delete custom workout",
      description: "Permanently delete a custom template. Not reversible: only when the user explicitly asked.",
      inputSchema: { code: z.string().describe("Template code (or numeric id).") },
      annotations: { destructiveHint: true },
    },
    ({ code }) =>
      run(async () => {
        const row = await templateRow(code);
        await api.deleteTemplate(Number(row.id));
        return { deleted: true, code: row.code, name: row.name };
      }),
  );

  server.registerTool(
    "schedule_workout",
    {
      title: "Schedule workout",
      description: "Put a custom workout on the training calendar for a date (it appears on the machine that day).",
      inputSchema: { code: z.string(), date: dateSchema },
    },
    ({ code, date }) =>
      run(async () => {
        const row = await templateRow(code);
        await api.reserve(date, row.code, 1);
        return { scheduled: true, code: row.code, name: row.name, date };
      }),
  );

  server.registerTool(
    "unschedule_workout",
    {
      title: "Unschedule workout",
      description: "Remove a scheduled custom workout from a date.",
      inputSchema: { code: z.string(), date: dateSchema },
    },
    ({ code, date }) =>
      run(async () => {
        const row = await templateRow(code);
        await api.reserve(date, row.code, 0);
        return { unscheduled: true, code: row.code, name: row.name, date };
      }),
  );

  return server;
}
