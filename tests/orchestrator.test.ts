import test from "node:test";
import assert from "node:assert/strict";
import { runConsultation, validateRoute } from "../lib/orchestrator";
import { blankProfile, ChatInput, Route, StreamEvent } from "../lib/domain";
import { executeTool } from "../lib/tools";
import { Provider, runtimeConfig } from "../lib/provider";

const config = { ...runtimeConfig({}), apiKey: "test-only-key" };
const input: ChatInput = {
  messages: [{ role: "user", content: "看看我的睡眠" }],
  profile: { ...blankProfile, sleep: "昨夜睡眠 6 小时，用户自述。" },
  preferred: "auto",
  mode: "live",
};
const route: Route = {
  primary: "sleep",
  summary: "睡眠咨询",
  tasks: [{ agent: "sleep", task: "查看睡眠记录", dependsOn: [] }],
  urgent: false,
  clarification: null,
};
const report = {
  findings: ["用户自述昨夜睡眠 6 小时。"],
  recommendations: ["补充近期记录。"],
  constraints: ["记录未经核验。"],
  missing: ["连续日期记录"],
};
function modelResponse(content: unknown, tool_calls?: unknown[]) {
  return Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content:
            typeof content === "string" ? content : JSON.stringify(content),
          ...(tool_calls ? { tool_calls } : {}),
        },
      },
    ],
  });
}

test("rejects cycles, missing dependencies, duplicate experts and missing primary", () => {
  assert.throws(() =>
    validateRoute({
      ...route,
      tasks: [{ agent: "sleep", task: "x", dependsOn: ["sleep"] }],
    }),
  );
  assert.throws(() =>
    validateRoute({
      ...route,
      tasks: [{ agent: "sleep", task: "x", dependsOn: ["general"] }],
    }),
  );
  assert.throws(() =>
    validateRoute({ ...route, tasks: [...route.tasks, ...route.tasks] }),
  );
  assert.throws(() => validateRoute({ ...route, primary: "general" }));
});
test("accepts a dependency graph regardless of source array order", () => {
  assert.equal(
    validateRoute({
      ...route,
      tasks: [
        { agent: "sleep", task: "x", dependsOn: ["general"] },
        { agent: "general", task: "y", dependsOn: [] },
      ],
    }).tasks.length,
    2,
  );
});
test("tool permissions and missing records are enforced by code", () => {
  assert.throws(() =>
    executeTool(
      "nutrition",
      "read_health_records",
      '{"kind":"vitals"}',
      blankProfile,
    ),
  );
  assert.throws(() => executeTool("sleep", "unknown", "{}", blankProfile));
  const result = executeTool(
    "sleep",
    "read_health_records",
    '{"kind":"sleep"}',
    blankProfile,
  );
  assert.equal((result.data as { available: boolean }).available, false);
  assert.equal((result.data as { record: null }).record, null);
});
test("live route, tool call, feedback and synthesis run end to end", async (t) => {
  const events: StreamEvent[] = [];
  const requests: Record<string, any>[] = [];
  const replies = [
    modelResponse(route),
    modelResponse(null, [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "read_health_records",
          arguments: '{"kind":"sleep"}',
        },
      },
    ]),
    modelResponse(report),
    modelResponse("已结合睡眠记录整理建议。"),
  ];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return replies.shift()!;
    },
  );
  const result = await runConsultation(
    input,
    config,
    (e) => events.push(e),
    new AbortController().signal,
  );
  assert.equal(result.answer, "已结合睡眠记录整理建议。");
  assert.equal(result.sources[0].id, "sleep");
  assert.equal(requests.length, 4);
  const routingInput = JSON.parse(requests[0].messages[1].content);
  assert.equal(routingInput.profile.recordAvailability.sleep, true);
  assert.equal(requests[2].messages.at(-1).role, "tool");
  assert.ok(
    events.some((e) => e.type === "trace" && e.data.title === "查询睡眠记录"),
  );
});
test("failed upstream after one repair prevents dependent specialist from generating advice", async (t) => {
  const dependencyRoute = {
    ...route,
    primary: "general",
    tasks: [
      { agent: "general", task: "评估约束", dependsOn: [] },
      { agent: "sleep", task: "作息建议", dependsOn: ["general"] },
    ],
  };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    ++calls === 1
      ? modelResponse(dependencyRoute)
      : modelResponse("invalid-json"),
  );
  const events: StreamEvent[] = [];
  await assert.rejects(
    runConsultation(
      input,
      config,
      (e) => events.push(e),
      new AbortController().signal,
    ),
  );
  assert.equal(calls, 3);
  assert.ok(
    events.some((e) => e.type === "trace" && e.data.title === "睡眠师暂停"),
  );
});
test("clarification returns before expert execution", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    modelResponse({ ...route, clarification: "你想了解哪一天的睡眠？" }),
  );
  const result = await runConsultation(
    input,
    config,
    () => {},
    new AbortController().signal,
  );
  assert.equal(result.reports.length, 0);
  assert.equal(result.answer, "你想了解哪一天的睡眠？");
});
test("urgent route pauses ordinary consultation", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    modelResponse({ ...route, urgent: true }),
  );
  const result = await runConsultation(
    input,
    config,
    () => {},
    new AbortController().signal,
  );
  assert.equal(result.reports.length, 0);
  assert.match(result.answer, /急救/);
});
test("provider error does not reveal API key or upstream error body", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("sensitive-upstream-body", { status: 401 }),
  );
  const provider = new Provider(config, new AbortController().signal);
  await assert.rejects(
    provider.complete([]),
    (error) =>
      error instanceof Error &&
      error.message.includes("验证失败") &&
      !error.message.includes("test-only-key") &&
      !error.message.includes("sensitive-upstream-body"),
  );
});
test("demo routes sleep, nutrition and sports without a model call", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("demo must not call model");
  });
  const result = await runConsultation(
    {
      ...input,
      mode: "demo",
      messages: [{ role: "user", content: "睡眠、饮食和运动一起看看" }],
    },
    config,
    () => {},
    new AbortController().signal,
  );
  assert.deepEqual(
    result.route.tasks.map((t) => t.agent),
    ["sleep", "nutrition", "sports"],
  );
  assert.match(result.answer, /尚未提供相关记录/);
  assert.equal(result.mode, "demo");
});
test("cancellation stops execution", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runConsultation(
      { ...input, mode: "demo" },
      config,
      () => {},
      controller.signal,
    ),
  );
});

test("repairs a model route whose primary expert is absent from tasks", async (t) => {
  const replies = [
    modelResponse({ ...route, primary: "general" }),
    modelResponse(route),
    modelResponse(report),
    modelResponse("校验后完成。"),
  ];
  t.mock.method(globalThis, "fetch", async () => replies.shift()!);
  const events: StreamEvent[] = [];
  const result = await runConsultation(
    input,
    config,
    (e) => events.push(e),
    new AbortController().signal,
  );
  assert.equal(result.route.primary, "sleep");
  assert.ok(
    events.some(
      (e) => e.type === "trace" && e.data.title === "修正任务分配格式",
    ),
  );
});

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

test("nutrition retrieves PDF evidence before its first model answer", async () => {
  const original = globalThis.fetch;
  const events: StreamEvent[] = [];
  const calls: string[] = [];
  const nutritionRoute: Route = {
    ...route,
    primary: "nutrition",
    tasks: [{ agent: "nutrition", task: "成年人蔬菜摄入", dependsOn: [] }],
  };
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("/search")) {
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer rag-test",
      );
      return Response.json({
        mode: "hybrid",
        warning: null,
        hits: [
          {
            id: "page-1",
            documentId: "0123456789abcdef",
            filename: "营养资料.pdf",
            page: 12,
            text: "蔬菜摄入相关证据",
            confidence: 0.95,
            kind: "reference",
          },
        ],
      });
    }
    const modelCalls = calls.filter((url) =>
      url.endsWith("/chat/completions"),
    ).length;
    if (modelCalls === 1) {
      const body = JSON.parse(String(init?.body));
      const routingInput = JSON.parse(body.messages[1].content);
      assert.equal(routingInput.knowledgeCapabilities.nutrition.configured, true);
      assert.equal(routingInput.knowledgeCapabilities.nutrition.searchTool, "search_nutrition_knowledge");
      return modelResponse(nutritionRoute);
    }
    if (modelCalls === 2) {
      const body = JSON.parse(String(init?.body));
      assert.match(body.messages.at(-1).content, /蔬菜摄入相关证据/);
      assert.ok(
        body.tools.some(
          (tool: { function: { name: string } }) =>
            tool.function.name === "search_nutrition_knowledge",
        ),
      );
      return modelResponse(report);
    }
    return modelResponse("根据营养资料回答。");
  };
  try {
    const result = await runConsultation(
      { ...input, preferred: "nutrition" },
      { ...config, ragUrl: "http://rag.test", ragToken: "rag-test" },
      (event) => events.push(event),
      new AbortController().signal,
    );
    assert.equal(result.sources[0].page, 12);
    assert.equal(result.sources[0].excerpt, "蔬菜摄入相关证据");
    assert.equal(
      result.sources[0].url,
      "/api/rag/page?document=0123456789abcdef&page=12",
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "trace" && event.data.title.includes("营养 PDF 检索"),
      ),
    );
    assert.equal(calls[1], "http://rag.test/search");
  } finally {
    globalThis.fetch = original;
  }
});

test("nutrition reports unavailable evidence when the RAG service is down", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (String(url).endsWith("/search"))
      throw new Error("private connection details");
    return modelResponse({
      ...route,
      primary: "nutrition",
      tasks: [{ agent: "nutrition", task: "营养建议", dependsOn: [] }],
    });
  };
  try {
    await assert.rejects(
      runConsultation(
        input,
        { ...config, ragUrl: "http://rag.test", ragToken: "rag-test" },
        () => {},
        new AbortController().signal,
      ),
      /知识库连接失败/,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("PDF verification only accepts a source retrieved in the current expert task", async () => {
  const { verifyNutritionPage } = await import("../lib/rag");
  const signal = new AbortController().signal;
  await assert.rejects(
    verifyNutritionPage(
      '{"sourceId":"unknown","question":"核对表格"}',
      config,
      signal,
      new Provider(config, signal),
      [],
    ),
    /先检索/,
  );
});
test("PDF verification uses the vision model and preserves source identity", async () => {
  const { verifyNutritionPage } = await import("../lib/rag");
  const original = globalThis.fetch;
  const signal = new AbortController().signal;
  const source = {
    id: "source",
    title: "文献 · PDF 第 12 页",
    filename: "文献.pdf",
    page: 12,
    url: "/api/rag/page?document=0123456789abcdef&page=12",
    detail: "OCR",
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/page?"))
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "Content-Type": "image/png" },
      });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, config.visionModel);
    assert.match(body.messages[0].content, /文件页序/);
    assert.match(
      body.messages[1].content[1].image_url.url,
      /^data:image\/png;base64,/,
    );
    return modelResponse("原页已读取，表格单位需要人工核验。");
  };
  try {
    const result = await verifyNutritionPage(
      '{"sourceId":"source","question":"核对单位"}',
      { ...config, ragUrl: "http://rag.test", ragToken: "test" },
      signal,
      new Provider(config, signal),
      [source],
    );
    assert.equal(result.sources[0].id, source.id);
    assert.equal(result.sources[0].url, source.url);
    assert.match(result.sources[0].detail, /人工核验/);
  } finally {
    globalThis.fetch = original;
  }
});

test("repairs a free-text expert report and renders readable grounded PDF citations", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const sourceUrl = "/api/rag/page?document=0123456789abcdef&page=12";
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/search"))
      return Response.json({
        mode: "hybrid",
        warning: null,
        hits: [
          {
            id: "source-id",
            documentId: "0123456789abcdef",
            filename: "营养资料.pdf",
            page: 12,
            text: "相关证据",
            confidence: 0.95,
            kind: "reference",
          },
        ],
      });
    calls++;
    if (calls === 1)
      return modelResponse({
        ...route,
        primary: "nutrition",
        tasks: [{ agent: "nutrition", task: "饮食知识", dependsOn: [] }],
      });
    if (calls === 2) return modelResponse("这是一段未按JSON输出的专家说明。");
    if (calls === 3) {
      assert.equal(
        JSON.parse(String(init?.body)).response_format.type,
        "json_object",
      );
      return modelResponse(report);
    }
    return modelResponse(
      `[source-id](${sourceUrl}) [unknown](/api/rag/page?document=0123456789abcdef&page=99)`,
    );
  };
  try {
    const result = await runConsultation(
      input,
      { ...config, ragUrl: "http://rag.test", ragToken: "test" },
      () => {},
      new AbortController().signal,
    );
    assert.equal(result.reports[0].status, "complete");
    assert.match(result.answer, /\[营养资料.pdf · PDF 第 12 页\]/);
    assert.match(result.answer, /unknown（引用待核对）/);
    assert.ok(!result.answer.includes("page=99"));
  } finally {
    globalThis.fetch = original;
  }
});
