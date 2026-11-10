import { z } from "zod";

export const foodSchema = z.object({
  name: z.string().min(1).max(80),
  portion: z.string().max(100),
  grams: z.number().finite().min(1).max(5000).nullable(),
  per100g: z.object({
    kcal: z.number().finite().min(0).max(1000),
    protein: z.number().finite().min(0).max(100),
    carbs: z.number().finite().min(0).max(100),
    fat: z.number().finite().min(0).max(100),
  }),
  note: z.string().max(300),
});
export const mealSchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
    const parsed = new Date(v);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
  }),
  slot: z.enum(["早餐", "午餐", "晚餐", "加餐"]),
  mode: z.enum(["demo", "live"]),
  status: z.enum(["draft", "confirmed", "discarded"]),
  items: z.array(foodSchema).max(20),
  notes: z.array(z.string()),
  question: z.string(),
}).refine((meal) => meal.status !== "confirmed" ||
  (meal.items.length > 0 && meal.items.every((food) => food.grams !== null)));
export type Meal = z.infer<typeof mealSchema>;
export type Food = z.infer<typeof foodSchema>;

export function mealTotals(items: Food[]) {
  const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const food of items) {
    if (food.grams === null || !Number.isFinite(food.grams) || food.grams < 1 || food.grams > 5000) continue;
    for (const key of Object.keys(totals) as (keyof typeof totals)[])
      totals[key] += food.per100g[key] * food.grams / 100;
  }
  return totals;
}

export function confirmedMeals(meals: (Meal | undefined)[], mode: Meal["mode"]) {
  return meals.filter((m): m is Meal => !!m && m.status === "confirmed" && m.mode === mode)
    .slice(-30).map(({ id, date, slot, mode, items }) => ({
      id, date, slot, mode, items, status: "confirmed" as const,
    }));
}
