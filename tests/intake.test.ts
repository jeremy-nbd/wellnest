import test from "node:test";
import assert from "node:assert/strict";
import { blankProfile } from "../lib/domain";
const input = {
  profile: { ...blankProfile, sleep: "昨夜睡眠 6 小时，用户自述。" },
};
test("daily intake keeps deep and light sleep, and does not borrow previous records", async () => {
  const { consultationProfile, sampleIntake, emptyIntake } =
    await import("../lib/intake");
  const first = consultationProfile(input.profile, {
    ...sampleIntake(),
    status: "saved",
  });
  assert.match(first.sleep, /深睡 1 小时 30 分钟/);
  assert.match(first.sleep, /浅睡 4 小时 40 分钟/);
  const second = consultationProfile(input.profile, emptyIntake());
  assert.equal(second.sleep, "");
  assert.equal(second.diet, "");
  assert.equal(second.exercise, "");
});
test("daily intake validates totals and keeps unknown duration values", async () => {
  const { intakeSchema, emptyIntake, consultationProfile } =
    await import("../lib/intake");
  assert.equal(
    intakeSchema.safeParse({
      ...emptyIntake(),
      sleepMinutes: 300,
      deepMinutes: 200,
      lightMinutes: 200,
    }).success,
    false,
  );
  const current = consultationProfile(input.profile, {
    ...emptyIntake(),
    sleepMinutes: 400,
    status: "saved",
  });
  assert.match(current.sleep, /深睡 未填写/);
  assert.match(current.sleep, /浅睡 未填写/);
});
test("legacy conversations preserve their existing profile path", async () => {
  const { consultationProfile } = await import("../lib/intake");
  assert.deepEqual(consultationProfile(input.profile), input.profile);
});

test("meal drafts and demo records stay out of real shared context", async () => {
  const { confirmedMeals, mealTotals, mealSchema } = await import("../lib/meals");
  const food = { name: "熟米饭", portion: "一碗", grams: 150, per100g: { kcal: 116, protein: 2.6, carbs: 25.9, fat: 0.3 }, note: "估算" };
  const meal = { id: "one", title: "午餐", date: "2026-11-10", slot: "午餐" as const, mode: "live" as const, status: "confirmed" as const, items: [food], notes: [], question: "" };
  assert.equal(confirmedMeals([meal, { ...meal, status: "draft" }, { ...meal, mode: "demo" }], "live").length, 1);
  assert.equal(mealTotals([food]).kcal, 174);
  assert.equal(mealTotals([{ ...food, grams: 75 }]).kcal, 87);
  assert.equal(mealSchema.safeParse({ ...meal, items: [{ ...food, grams: null }] }).success, false);
  assert.equal(mealSchema.safeParse({ ...meal, date: "2026-02-30" }).success, false);
  assert.equal(mealSchema.safeParse({ ...meal, items: [] }).success, false);
});
