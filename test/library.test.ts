import { describe, expect, it } from "vitest";
import { filterExercises, kindOf, resolveByName, summarize } from "../src/library.js";

const raw = (id: number, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, tabName: "Strength", accessories: "5", actionLibraryList: [{ id: id * 10 }],
  mainMuscleGroupList: [{ categoryName: "Chest", muscleGroupName: "Pectoralis" }], ...extra,
});
const acc = new Map([[5, "Handles"]]);
const items = [raw(1, "Bench Press"), raw(2, "Incline Bench Press"), raw(3, "Plank", { completionMethod: 2 })].map((r) =>
  summarize(r, acc),
);

describe("library", () => {
  it("summarizes and classifies", () => {
    expect(items[0]).toMatchObject({ groupId: 1, variantId: 10, equipment: ["Handles"], bodyParts: ["Chest"], kind: "reps" });
    expect(items[2].kind).toBe("timed");
    expect(kindOf({ completionMethod: 5 })).toBe("level");
  });
  it("resolves exact, prefix and ambiguous names", () => {
    expect(resolveByName(items, "bench press").match?.groupId).toBe(1);
    expect(resolveByName(items, "incl").match?.groupId).toBe(2);
    expect(resolveByName(items, "press").candidates).toHaveLength(2);
    expect(resolveByName(items, "squat")).toEqual({ candidates: [] });
  });
  it("filters", () => {
    expect(filterExercises(items, { query: "bench", muscle: "chest" })).toHaveLength(2);
    expect(filterExercises(items, { kind: "timed" }).map((i) => i.name)).toEqual(["Plank"]);
  });
});
