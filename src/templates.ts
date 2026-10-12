/**
 * Build, read back and verify custom workout template bodies. Pure.
 *
 * A template stores each exercise's sets as parallel CSV strings (reps, weights, rest,
 * sides, ...). Weights are in the account's display unit. Rules learned the hard way by
 * the community projects credited in the README:
 *  - templatePresetId is -1 for lb accounts and 1 for kg accounts (explicit loads);
 *  - totalCapacity is never null; kg accounts store it x2.2;
 *  - unilateral movements alternate left/right per set unless a side is given;
 *  - every write should be verified by reading the template back.
 */
import type { Unit } from "./config.js";
import type { ExerciseKind } from "./library.js";

const KG_LB_SCALE = 2.2;
const MAX_WEIGHT = 1000;
export const MAX_SETS = 20;

/** Training modes as numbered by the app (per stozo04/speediance-cli). */
export const SPORT_MODES = { standard: 1, eccentric: 2, isokinetic: 3, constant: 4, spotter: 5 } as const;
export type SportMode = keyof typeof SPORT_MODES;

export interface SetInput {
  reps?: number;
  weight?: number;
  seconds?: number;
  level?: number;
  rest?: number;
  side?: "left" | "right";
  mode?: SportMode;
}

export interface ValidSet {
  /** reps for reps movements, seconds for timed/level movements. */
  count: number;
  weight: number;
  level: number;
  rest: number;
  side: 0 | 1 | 2;
  mode: number;
}

export interface ExerciseSpec {
  groupId: number;
  variantId: number;
  name: string;
  kind: ExerciseKind;
  unilateral: boolean;
  sets: ValidSet[];
}

const isWhole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

export function validateSets(kind: ExerciseKind, sets: SetInput[], defaultRest = 60): ValidSet[] {
  if (!Array.isArray(sets) || sets.length === 0) throw new Error("needs at least one set");
  if (sets.length > MAX_SETS) throw new Error(`at most ${MAX_SETS} sets per exercise`);
  return sets.map((raw, i) => {
    const n = i + 1;
    const rest = raw.rest ?? defaultRest;
    if (!isWhole(rest) || rest < 0 || rest > 600) throw new Error(`set ${n}: rest must be 0-600 seconds`);
    const side = raw.side === "left" ? 1 : raw.side === "right" ? 2 : 0;
    const mode = SPORT_MODES[raw.mode ?? "standard"];
    if (mode === undefined) throw new Error(`set ${n}: unknown mode "${raw.mode}"`);
    if (kind === "reps") {
      if (!isWhole(raw.reps) || raw.reps < 1 || raw.reps > 100) throw new Error(`set ${n}: reps must be a whole number 1-100`);
      const w = raw.weight;
      if (typeof w !== "number" || !Number.isFinite(w) || w < 0 || w > MAX_WEIGHT) {
        throw new Error(`set ${n}: weight must be a number 0-${MAX_WEIGHT}`);
      }
      if (Math.abs(w * 10 - Math.round(w * 10)) > 1e-9) throw new Error(`set ${n}: weight has at most one decimal place`);
      return { count: raw.reps, weight: w, level: 0, rest, side, mode };
    }
    if (!isWhole(raw.seconds) || raw.seconds < 1 || raw.seconds > 3600) {
      throw new Error(`set ${n}: this movement is timed, so give seconds (1-3600) instead of reps`);
    }
    let level = 0;
    if (kind === "level") {
      if (!isWhole(raw.level) || raw.level < 1) throw new Error(`set ${n}: this movement needs a level of 1 or more`);
      level = raw.level;
    }
    return { count: raw.seconds, weight: 0, level, rest, side, mode };
  });
}

export function buildTemplate(
  name: string,
  specs: ExerciseSpec[],
  opts: { unit: Unit; deviceType: number; templateId?: number },
): Record<string, any> {
  const preset = opts.unit === "lb" ? -1 : 1;
  let total = 0;
  const actions = specs.map((spec) => {
    const timed = spec.kind !== "reps";
    const capacity = timed ? 0 : spec.sets.reduce((sum, s) => sum + s.count * s.weight, 0);
    total += capacity;
    const csv = (f: (s: ValidSet, i: number) => string | number) => spec.sets.map(f).join(",");
    const rests = csv((s) => s.rest);
    return {
      groupId: spec.groupId,
      actionLibraryId: spec.variantId,
      templatePresetId: preset,
      setsAndReps: csv((s) => s.count),
      breakTime: rests,
      breakTime2: rests,
      sportMode: csv((s) => s.mode),
      leftRight: csv((s, i) => (s.side ? s.side : spec.unilateral ? (i % 2 === 0 ? 1 : 2) : 0)),
      selectCompletionMethod: csv(() => 1),
      completionMethod: csv(() => (timed ? 2 : 1)),
      countType: csv(() => (timed ? 2 : 1)),
      weights: csv((s) => (timed ? "0" : s.weight.toFixed(1))),
      counterweight: "",
      counterweight2: "",
      level: csv((s) => (spec.kind === "level" ? s.level : 0)),
      capacity: round1(capacity),
    };
  });
  const body: Record<string, any> = {
    name,
    actionLibraryList: actions,
    totalCapacity: round1(total * (opts.unit === "kg" ? KG_LB_SCALE : 1)),
    deviceType: opts.deviceType,
    bgColor: 0,
  };
  if (opts.templateId !== undefined) body.id = opts.templateId;
  return body;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const csvList = (v: unknown) => {
  const s = String(v ?? "").trim();
  return s ? s.split(",").map((p) => p.trim()) : [];
};
const num = (v: unknown) => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** A set as stored, in create_workout's input shape; `mode` is a raw number string if unrecognized. */
export type StoredSet = Omit<SetInput, "mode"> & { mode: string };

const MODE_NAMES: Record<number, string> = Object.fromEntries(Object.entries(SPORT_MODES).map(([k, v]) => [v, k]));

/** A stored template, decoded into a readable per-set prescription. */
export function readTemplate(detail: Record<string, any>) {
  const actions = [...(detail?.actionLibraryList ?? [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  return {
    id: detail?.id,
    code: detail?.code,
    name: detail?.name,
    durationMinute: detail?.durationMinute,
    exercises: actions.map((a) => {
      const counts = csvList(a.setsAndReps);
      const weights = csvList(a.weights);
      const levels = csvList(a.level);
      const sides = csvList(a.leftRight);
      const rests = csvList(a.breakTime2 || a.breakTime);
      const modes = csvList(a.sportMode);
      const timed = csvList(a.countType)[0] === "2";
      return {
        name: a.title ?? "",
        groupId: a.groupId,
        variantId: a.actionLibraryId,
        sets: counts.map((c, i): StoredSet => {
          const side = num(sides[i]);
          const level = num(levels[i]) ?? 0;
          return {
            ...(timed ? { seconds: num(c) } : { reps: num(c), weight: num(weights[i]) }),
            ...(level ? { level } : {}),
            ...(side === 1 ? { side: "left" as const } : side === 2 ? { side: "right" as const } : {}),
            rest: num(rests[i]),
            mode: MODE_NAMES[num(modes[i]) ?? 1] ?? String(modes[i]),
          };
        }),
      };
    }),
  };
}

/** Compare what was sent with what Speediance stored. An empty list means verified. */
export function verifyTemplate(body: Record<string, any>, stored: Record<string, any> | null | undefined): string[] {
  const sent: any[] = body.actionLibraryList;
  const got: any[] = [...(stored?.actionLibraryList ?? [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  if (sent.length !== got.length) return [`sent ${sent.length} exercises, Speediance stored ${got.length}`];
  const problems: string[] = [];
  sent.forEach((s, i) => {
    const g = got[i];
    const label = g.title || `exercise ${i + 1}`;
    if (Number(s.actionLibraryId) !== Number(g.actionLibraryId)) {
      problems.push(`${label}: exercise sent ${s.actionLibraryId} but stored ${g.actionLibraryId}`);
    }
    if (csvList(s.setsAndReps).join() !== csvList(g.setsAndReps).join()) {
      problems.push(`${label}: reps/seconds sent ${s.setsAndReps} but stored ${g.setsAndReps}`);
    }
    const sw = csvList(s.weights).map((x) => num(x) ?? 0);
    const gw = csvList(g.weights).map((x) => num(x) ?? 0);
    if ((gw.length || sw.some(Boolean)) && (sw.length !== gw.length || sw.some((w, j) => Math.abs(w - gw[j]) > 0.05))) {
      problems.push(`${label}: weights sent ${s.weights} but stored ${g.weights}`);
    }
    if (csvList(s.breakTime2).join() !== csvList(g.breakTime2).join()) {
      problems.push(`${label}: rest sent ${s.breakTime2} but stored ${g.breakTime2}`);
    }
  });
  return problems;
}
