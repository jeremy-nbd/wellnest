import { z } from "zod";

export const agentIds = [
  "nutrition",
  "sports",
  "general",
  "sleep",
  "tcm",
] as const;
export type AgentId = (typeof agentIds)[number];
export const experts: Record<
  AgentId,
  { name: string; subtitle: string; color: string; scope: string }
> = {
  nutrition: {
    name: "营养师",
    subtitle: "饮食与营养",
    color: "#bd8348",
    scope: "饮食记录、营养摄入、饮食偏好与过敏，结合健康约束提出饮食建议",
  },
  sports: {
    name: "运动医师",
    subtitle: "运动与恢复",
    color: "#64897b",
    scope: "运动记录、运动强度、恢复、运动中的心率，结合身体状况评估运动安排",
  },
  general: {
    name: "全科医师",
    subtitle: "综合健康",
    color: "#56869a",
    scope: "综合健康咨询、症状梳理、心率血压与检查报告、多领域约束及就医建议",
  },
  sleep: {
    name: "睡眠师",
    subtitle: "睡眠与作息",
    color: "#8980b0",
    scope: "睡眠时长、作息、夜间觉醒、白天困倦与影响睡眠的生活习惯",
  },
  tcm: {
    name: "中医师",
    subtitle: "体质与调养",
    color: "#9d8961",
    scope: "中医健康知识、体质问卷信息与生活调养，区分用户自述和临床辨证",
  },
};

export const profileSchema = z.object({
  name: z.string().max(40),
  age: z.number().int().min(1).max(120).nullable(),
  goals: z.string().max(600),
  conditions: z.string().max(1000),
  medications: z.string().max(600),
  allergies: z.string().max(600),
  sleep: z.string().max(2000),
  diet: z.string().max(2000),
  exercise: z.string().max(2000),
  vitals: z.string().max(2000),
  source: z.enum(["demo", "user"]),
});
export type Profile = z.infer<typeof profileSchema>;
export const demoProfile: Profile = {
  name: "体验用户",
  age: 32,
  goals: "规律作息，改善白天精力，建立可持续的饮食与运动习惯",
  conditions: "未提供",
  medications: "未提供",
  allergies: "未提供",
  source: "demo",
  sleep:
    "虚构的最近一晚记录：00:40 入睡，07:10 起床，夜间清醒约 20 分钟，估计睡眠约 6 小时 10 分钟。最近七晚睡眠时长分别为 6.2、6.8、6.5、7.1、5.9、6.4、6.2 小时。",
  diet: "虚构的昨日饮食：早餐鸡蛋、全麦面包和牛奶；午餐米饭、鸡肉和蔬菜；晚餐面条。下午 16:00 喝一杯咖啡。未记录食物重量。",
  exercise:
    "虚构的昨日运动：20:30 至 21:05 快走，共 35 分钟，约 4200 步。最近一周有三次快走。",
  vitals:
    "虚构的今日静息心率 68 次/分钟；血压未提供。设备数据用于展示查询流程。",
};
export const blankProfile: Profile = {
  name: "",
  age: null,
  goals: "",
  conditions: "",
  medications: "",
  allergies: "",
  sleep: "",
  diet: "",
  exercise: "",
  vitals: "",
  source: "user",
};
export const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(12000),
      }),
    )
    .min(1)
    .max(30),
  profile: profileSchema,
  preferred: z.enum(["auto", ...agentIds]).default("auto"),
  mode: z.enum(["demo", "live"]),
  previousAgent: z.enum(agentIds).optional(),
  image: z
    .string()
    .max(5700000)
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/)
    .optional(),
});
export type ChatInput = z.infer<typeof chatSchema>;
export const routeSchema = z.object({
  primary: z.enum(agentIds),
  tasks: z
    .array(
      z.object({
        agent: z.enum(agentIds),
        task: z.string().min(1).max(1000),
        dependsOn: z.array(z.enum(agentIds)).max(4),
      }),
    )
    .min(1)
    .max(5),
  summary: z.string().max(500),
  clarification: z.string().max(600).nullable(),
  urgent: z.boolean(),
});
export type Route = z.infer<typeof routeSchema>;
export const reportSchema = z.object({
  findings: z.array(z.string()).max(8),
  recommendations: z.array(z.string()).max(8),
  constraints: z.array(z.string()).max(8),
  missing: z.array(z.string()).max(8),
});
export type Report = z.infer<typeof reportSchema> & {
  agent: AgentId;
  status: "complete" | "failed";
  sources: Source[];
};
export type Source = {
  id: string;
  title: string;
  url?: string;
  detail: string;
  filename?: string;
  page?: number;
  excerpt?: string;
};
export type TraceEvent = {
  id: string;
  type: "route" | "agent" | "tool" | "review" | "status" | "error";
  title: string;
  detail: string;
  agent?: AgentId;
  at: string;
};
export type RunMetrics = {
  path: "fast" | "single" | "multi" | "demo" | "clarification";
  totalMs: number;
  firstTextMs: number | null;
  modelCalls: number | null;
  stages: { stage: string; durationMs: number }[];
  modelTimings: { kind: string; durationMs: number }[];
};
export type Result = {
  metrics?: RunMetrics;
  answer: string;
  route: Route;
  reports: Report[];
  sources: Source[];
  mode: "demo" | "live";
  dataSource: "demo" | "user";
  partial: boolean;
};
export type StreamEvent =
  | { type: "trace"; data: TraceEvent }
  | { type: "route"; data: Route }
  | { type: "answer_delta"; data: { text: string } }
  | { type: "result"; data: Result }
  | { type: "error"; data: { message: string } };
