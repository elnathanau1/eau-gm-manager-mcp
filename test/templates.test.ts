import { describe, expect, it } from "vitest";
import { buildTemplate, readTemplate, validateSets, verifyTemplate, type ExerciseSpec } from "../src/templates.js";

const spec = (over: Partial<ExerciseSpec> = {}): ExerciseSpec => ({
  groupId: 10,
  variantId: 100,
  name: "Bench Press",
  kind: "reps",
  unilateral: false,
  sets: validateSets("reps", [
    { reps: 10, weight: 50 },
    { reps: 8, weight: 55.5, rest: 90 },
  ]),
  ...over,
});

describe("validateSets", () => {
  it("applies default rest and standard mode", () => {
    expect(validateSets("reps", [{ reps: 5, weight: 20 }], 75)[0]).toEqual({
      count: 5, weight: 20, level: 0, rest: 75, side: 0, mode: 1,
    });
  });
  it("rejects bad reps, weight precision and missing seconds", () => {
    expect(() => validateSets("reps", [{ reps: 0, weight: 10 }])).toThrow(/reps/);
    expect(() => validateSets("reps", [{ reps: 5, weight: 10.25 }])).toThrow(/decimal/);
    expect(() => validateSets("reps", [{ reps: 5 }])).toThrow(/weight/);
    expect(() => validateSets("timed", [{ reps: 5 }])).toThrow(/seconds/);
    expect(() => validateSets("level", [{ seconds: 30 }])).toThrow(/level/);
  });
});

describe("buildTemplate", () => {
  it("builds an lb body with CSV fields and raw capacity", () => {
    const body = buildTemplate("Push", [spec()], { unit: "lb", deviceType: 1 });
    const a = body.actionLibraryList[0];
    expect(a).toMatchObject({
      groupId: 10, actionLibraryId: 100, templatePresetId: -1,
      setsAndReps: "10,8", weights: "50.0,55.5", breakTime2: "60,90", leftRight: "0,0",
      sportMode: "1,1", completionMethod: "1,1", counterweight2: "",
    });
    expect(body.totalCapacity).toBe(944);
    expect(body).not.toHaveProperty("id");
  });
  it("scales kg capacity, alternates unilateral sides, handles timed moves", () => {
    const uni = spec({ unilateral: true });
    const timed = spec({ kind: "timed", sets: validateSets("timed", [{ seconds: 45 }]) });
    const body = buildTemplate("Mix", [uni, timed], { unit: "kg", deviceType: 1, templateId: 7 });
    expect(body.actionLibraryList[0].leftRight).toBe("1,2");
    expect(body.actionLibraryList[0].templatePresetId).toBe(1);
    expect(body.actionLibraryList[1]).toMatchObject({ setsAndReps: "45", weights: "0", countType: "2" });
    expect(body.totalCapacity).toBeCloseTo(944 * 2.2, 1);
    expect(body.id).toBe(7);
  });
});

describe("readTemplate / verifyTemplate", () => {
  const body = buildTemplate("Push", [spec()], { unit: "lb", deviceType: 1 });
  const stored = { id: 1, code: "ABC", name: "Push", actionLibraryList: [{ ...body.actionLibraryList[0], title: "Bench Press", sort: 1 }] };

  it("round-trips into create_workout's set shape", () => {
    expect(readTemplate(stored).exercises[0]).toMatchObject({
      name: "Bench Press", groupId: 10,
      sets: [{ reps: 10, weight: 50, rest: 60, mode: "standard" }, { reps: 8, weight: 55.5, rest: 90 }],
    });
  });
  it("verifies matches and reports mismatches", () => {
    expect(verifyTemplate(body, stored)).toEqual([]);
    const bad = { actionLibraryList: [{ ...stored.actionLibraryList[0], weights: "50.0,60.0" }] };
    expect(verifyTemplate(body, bad)[0]).toMatch(/weights/);
    expect(verifyTemplate(body, { actionLibraryList: [] })[0]).toMatch(/stored 0/);
  });
});
