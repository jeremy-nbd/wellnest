import { z } from "zod";
import { AgentId, Profile, Source } from "./domain";
import { ToolDefinition } from "./provider";

const records = ["sleep", "diet", "exercise", "vitals"] as const;
const access: Record<AgentId, readonly string[]> = {
  nutrition: ["diet", "sleep"],
  sports: ["exercise", "sleep", "vitals"],
  general: records,
  sleep: ["sleep", "diet", "exercise", "vitals"],
  tcm: ["sleep", "diet", "exercise"],
};
const recordNames = {
  sleep: "睡眠记录",
  diet: "饮食记录",
  exercise: "运动记录",
  vitals: "体征记录",
};
export const knowledge = [
  {
    id: "cdc-sleep",
    topics: ["sleep", "general", "sports"],
    title: "CDC · About Sleep",
    url: "https://www.cdc.gov/sleep/about/",
    detail:
      "18–60 岁成年人一般建议每晚至少睡眠 7 小时。睡眠质量同样重要。持续睡眠困扰应与医疗专业人员讨论。",
  },
  {
    id: "who-diet",
    topics: ["nutrition", "general"],
    title: "WHO · Healthy diet",
    url: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
    detail:
      "多样化的水果、蔬菜、豆类、全谷物和适当蛋白质来源有助于健康饮食。具体饮食方案需要考虑个体需求。",
  },
];
export function definitions(agent: AgentId): ToolDefinition[] {
  return [
    ...(agent === "nutrition"
      ? [
          {
            type: "function" as const,
            function: {
              name: "verify_nutrition_page",
              description:
                "使用视觉模型核对已检索到的 PDF 原页。引用食物成分表具体数值前必须核对行列、单位及计量基准。sourceId 使用检索返回的 id，question 写清需要核对的食物和营养素。",
              parameters: {
                type: "object",
                properties: {
                  sourceId: { type: "string" },
                  question: { type: "string" },
                },
                required: ["sourceId", "question"],
                additionalProperties: false,
              },
            },
          },
        ]
      : []),
    {
      type: "function",
      function: {
        name: "read_health_profile",
        description:
          "读取用户提供的基础档案、目标、用药和过敏信息，空字段代表未知。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_health_records",
        description:
          "读取用户录入或虚构演示的健康记录。记录内日期为原始描述，工具不会创造缺失日期和数据。",
        parameters: {
          type: "object",
          properties: { kind: { type: "string", enum: access[agent] } },
          required: ["kind"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name:
          agent === "nutrition"
            ? "search_nutrition_knowledge"
            : "search_knowledge",
        description:
          agent === "nutrition"
            ? "检索用户提供的膳食指南2022、营养素参考摄入量2023、食物成分表第6版两册。通过向量与关键词查找原文，返回文件名、PDF页码和OCR片段。查询应聚焦主题、食物、人群、营养素。"
            : "检索内置小型参考库。覆盖睡眠及饮食基础知识，其他主题可能无匹配。",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
  ];
}
export function executeTool(
  agent: AgentId,
  name: string,
  rawArgs: string,
  profile: Profile,
): { data: unknown; sources: Source[]; label: string } {
  const args = JSON.parse(rawArgs || "{}");
  const origin =
    profile.source === "demo" ? "虚构演示数据" : "用户录入，未经临床核验";
  if (name === "read_health_profile") {
    z.object({}).strict().parse(args);
    const { sleep, diet, exercise, vitals, ...basic } = profile;
    return {
      data: { ...basic, origin },
      sources: [{ id: "profile", title: "共享健康档案", detail: origin }],
      label: "读取共享健康档案",
    };
  }
  if (name === "read_health_records") {
    const { kind } = z
      .object({ kind: z.enum(records) })
      .strict()
      .parse(args);
    if (!access[agent].includes(kind))
      throw new Error("该专家没有访问这类记录的权限。");
    return {
      data: {
        kind,
        origin,
        record: profile[kind] || null,
        available: Boolean(profile[kind]),
      },
      sources: [
        {
          id: kind,
          title: recordNames[kind],
          detail: profile[kind] ? origin : "尚未提供记录",
        },
      ],
      label: `查询${recordNames[kind]}`,
    };
  }
  if (name === "search_knowledge") {
    const { query } = z
      .object({ query: z.string().min(1).max(500) })
      .strict()
      .parse(args);
    const matches = knowledge.filter(
      (k) =>
        k.topics.includes(agent) &&
        ((k.id.includes("sleep") && /睡|作息|sleep|觉|咖啡/i.test(query)) ||
          (k.id.includes("diet") && /饮食|营养|diet|食|减重/i.test(query))),
    );
    return {
      data: {
        entries: matches,
        coverage: "小型人工整理参考库；无结果表示该主题尚未收录",
      },
      sources: matches,
      label: `检索参考知识 · ${matches.length} 条`,
    };
  }
  throw new Error("未知工具。");
}
