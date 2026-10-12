/** Exercise catalog helpers: summarize raw library items, search them, resolve names. Pure. */

type Row = Record<string, any>;

export type ExerciseKind = "reps" | "timed" | "level";

export interface ExerciseSummary {
  groupId: number;
  name: string;
  category: string;
  bodyParts: string[];
  muscles: string[];
  secondaryMuscles: string[];
  equipment: string[];
  unilateral: boolean;
  kind: ExerciseKind;
  /** First playable variant; this is the id a template references. */
  variantId: number | null;
}

/** Decides what a set's numbers mean: reps+weight, seconds, or seconds+level (Vita). */
export function kindOf(item: Row): ExerciseKind {
  const method = item.completionMethod;
  if (method === 5 || item.dataStatType === 6) return "level";
  if (method === 0 || method === 2) return "timed";
  return "reps";
}

export function accessoryNames(catalog: Row[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const item of catalog ?? []) {
    const id = Number(item?.id);
    if (Number.isInteger(id)) out.set(id, String(item.name ?? "").trim());
  }
  return out;
}

function ids(csv: unknown): number[] {
  return String(csv ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^\d+$/.test(x))
    .map(Number);
}

export function summarize(raw: Row, accessories: Map<number, string> = new Map()): ExerciseSummary {
  const main: Row[] = raw.mainMuscleGroupList ?? [];
  const aux: Row[] = raw.auxiliaryMuscleGroupList ?? [];
  const variants: Row[] = raw.actionLibraryList ?? [];
  return {
    groupId: raw.id,
    name: raw.title ?? "",
    category: raw.tabName ?? "",
    bodyParts: [...new Set(main.map((m) => m.categoryName).filter(Boolean))].sort(),
    muscles: main.map((m) => m.muscleGroupName).filter(Boolean),
    secondaryMuscles: aux.map((m) => m.muscleGroupName).filter(Boolean),
    equipment: ids(raw.accessories).map((i) => accessories.get(i) ?? `accessory ${i}`),
    unilateral: raw.isLeftRight === 1,
    kind: kindOf(raw),
    variantId: variants[0]?.id ?? null,
  };
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");

/** Exact name, then a unique prefix match, then a unique all-words match. Ambiguity returns candidates. */
export function resolveByName(
  items: ExerciseSummary[],
  name: string,
): { match?: ExerciseSummary; candidates: ExerciseSummary[] } {
  const q = norm(name);
  if (!q) return { candidates: [] };
  const exact = items.find((i) => norm(i.name) === q);
  if (exact) return { match: exact, candidates: [] };
  const words = q.split(" ");
  for (const group of [
    items.filter((i) => norm(i.name).startsWith(q)),
    items.filter((i) => words.every((w) => norm(i.name).includes(w))),
  ]) {
    if (group.length === 1) return { match: group[0], candidates: [] };
    if (group.length > 1) return { candidates: group.slice(0, 10) };
  }
  return { candidates: [] };
}

export interface ExerciseFilter {
  query?: string;
  muscle?: string;
  category?: string;
  equipment?: string;
  kind?: string;
  limit?: number;
}

export function filterExercises(items: ExerciseSummary[], f: ExerciseFilter): ExerciseSummary[] {
  const words = norm(f.query).split(" ").filter(Boolean);
  const has = (hay: string[], needle?: string) => !needle || hay.some((h) => norm(h).includes(norm(needle)));
  return items
    .filter((i) => words.every((w) => norm(i.name).includes(w)))
    .filter((i) => has([...i.bodyParts, ...i.muscles], f.muscle))
    .filter((i) => has([i.category], f.category))
    .filter((i) => has(i.equipment, f.equipment))
    .filter((i) => !f.kind || norm(f.kind) === i.kind)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, f.limit ?? 50);
}
