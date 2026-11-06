import { z } from "zod";
import { blankProfile, demoProfile, Profile } from "./domain";

const duration = z.number().int().min(0).max(1440).nullable();
export const intakeSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sleepMinutes: duration,
    deepMinutes: duration,
    lightMinutes: duration,
    diet: z.string().max(1500),
    exercise: z.string().max(1500),
    source: z.enum(["demo", "user"]),
    status: z.enum(["pending", "saved", "skipped"]),
  })
  .superRefine((data, ctx) => {
    if (
      data.sleepMinutes !== null &&
      (data.deepMinutes ?? 0) + (data.lightMinutes ?? 0) > data.sleepMinutes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "深睡与浅睡的总时长应小于或等于睡眠总时长。",
        path: ["sleepMinutes"],
      });
    }
  });
export type DailyIntake = z.infer<typeof intakeSchema>;
export function todayDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export function emptyIntake(): DailyIntake {
  return {
    date: todayDate(),
    sleepMinutes: null,
    deepMinutes: null,
    lightMinutes: null,
    diet: "",
    exercise: "",
    source: "user",
    status: "pending",
  };
}
export function sampleIntake(date = todayDate()): DailyIntake {
  return {
    date,
    sleepMinutes: 430,
    deepMinutes: 90,
    lightMinutes: 280,
    diet: "早餐：鸡蛋、全麦面包、牛奶。午餐：米饭、鸡肉和蔬菜。下午 16:00 一杯咖啡。晚餐：番茄鸡蛋面。",
    exercise: "今天 18:30 快走 35 分钟，约 4200 步，运动后感觉轻松。",
    source: "demo",
    status: "pending",
  };
}
export function formatMinutes(value: number | null): string {
  if (value === null) return "未填写";
  return `${Math.floor(value / 60)} 小时 ${value % 60} 分钟`;
}
export function consultationProfile(
  base: Profile,
  intake?: DailyIntake,
): Profile {
  // Older conversations keep their existing profile-based data path.
  if (!intake) return base;
  const current =
    intake.source === "demo"
      ? demoProfile
      : base.source === "user"
        ? base
        : blankProfile;
  const origin =
    intake.source === "demo" ? "虚构演示资料" : "用户本次录入，未经临床核验";
  const prefix = `${intake.date} · ${origin}。`;
  const hasSleep = [
    intake.sleepMinutes,
    intake.deepMinutes,
    intake.lightMinutes,
  ].some((value) => value !== null);
  return {
    ...current,
    source: intake.source,
    sleep: hasSleep
      ? `${prefix}今天醒来前一晚的睡眠：总时长 ${formatMinutes(intake.sleepMinutes)}；深睡 ${formatMinutes(intake.deepMinutes)}；浅睡 ${formatMinutes(intake.lightMinutes)}。其他阶段未记录，设备分期仅供参考。`
      : "",
    diet: intake.diet.trim() ? prefix + intake.diet.trim() : "",
    exercise: intake.exercise.trim() ? prefix + intake.exercise.trim() : "",
    vitals: intake.source === "demo" ? "" : current.vitals,
  };
}
