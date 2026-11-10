"use client";

import { useEffect, useRef, useState } from "react";
import { answerForDisplay } from "../lib/answer-display";
import {
  Activity,
  Camera,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Database,
  FileText,
  GitBranch,
  Leaf,
  LoaderCircle,
  MessageSquare,
  Moon,
  Network,
  Paperclip,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Stethoscope,
  Utensils,
  Users,
  Workflow,
  X,
} from "lucide-react";
import {
  agentIds,
  AgentId,
  blankProfile,
  demoProfile,
  experts,
  Profile,
  profileSchema,
  Result,
  Route,
  StreamEvent,
  TraceEvent,
} from "../lib/domain";

import { MealCard } from "./components/meal-card";
import { Meal, mealSchema, mealTotals, confirmedMeals } from "../lib/meals";
import { todayDate } from "../lib/intake";

import { DailyIntakeCard } from "./components/daily-intake";
import { NutritionLibrary } from "./components/nutrition-library";
import {
  consultationProfile,
  DailyIntake,
  emptyIntake,
  intakeSchema,
} from "../lib/intake";

const icons = {
  nutrition: Utensils,
  sports: Activity,
  general: Stethoscope,
  sleep: Moon,
  tcm: Leaf,
};
type Turn = {
  id: string;
  question: string;
  mode?: "demo" | "live";
  answer: string;
  trace: TraceEvent[];
  route?: Route;
  result?: Result;
  error?: string;
  status: "running" | "done" | "error" | "stopped";
  hasImage?: boolean;
  meal?: Meal;
  mealRequest?: boolean;
};
type Conversation = {
  id: string;
  title: string;
  turns: Turn[];
  intake?: DailyIntake;
};
type ModelConfig = {
  configured: boolean;
  model: string;
  visionModel: string;
  temperature: number;
  timeoutSeconds: number;
  visionTimeoutSeconds: number;
};
const starterQuestions = [
  {
    icon: Moon,
    title: "看看我的睡眠",
    text: "结合我的睡眠记录，帮我看看最近的睡眠和作息。",
    label: "睡眠师",
  },
  {
    icon: Utensils,
    title: "饮食可以怎么调整",
    text: "看看我的饮食记录，可以从哪些地方开始调整？",
    label: "营养师",
  },
  {
    icon: Users,
    title: "让多位专家一起看看",
    text: "最近睡不好，想通过饮食和运动改善，请几位专家一起看看。",
    label: "多师协作",
  },
];
const initialConversation = (): Conversation => ({
  id: crypto.randomUUID(),
  title: "新的健康咨询",
  turns: [],
  intake: emptyIntake(),
});
function Avatar({ agent, small = false }: { agent: AgentId; small?: boolean }) {
  const Icon = icons[agent];
  return (
    <span
      className={`avatar ${small ? "small" : ""}`}
      style={{ "--expert-color": experts[agent].color } as React.CSSProperties}
    >
      <Icon size={small ? 16 : 20} strokeWidth={1.6} />
    </span>
  );
}
function Markdown({ text }: { text: string }) {
  return (
    <div className="answer-text">
      {text.split("\n").map((line, i) => {
        if (/^#{1,4} /.test(line))
          return <h4 key={i}>{line.replace(/^#{1,4} /, "")}</h4>;
        if (!line.trim()) return <div className="paragraph-gap" key={i} />;
        const pieces = line.split(
          /(\*\*.*?\*\*|\[[^\]]+\]\((?:https?:\/\/[^\s)]+|\/api\/rag\/page\?[^\s)]+)\))/g,
        );
        return (
          <p key={i}>
            {pieces.map((piece, j) => {
              if (piece.startsWith("**") && piece.endsWith("**"))
                return <strong key={j}>{piece.slice(2, -2)}</strong>;
              const link = piece.match(
                /^\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/api\/rag\/page\?[^\s)]+)\)$/,
              );
              return link ? (
                <a key={j} href={link[2]} target="_blank" rel="noreferrer">
                  {link[1]}
                </a>
              ) : (
                piece
              );
            })}
          </p>
        );
      })}
    </div>
  );
}

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [profile, setProfile] = useState<Profile>(demoProfile);
  const [draftProfile, setDraftProfile] = useState<Profile>(demoProfile);
  const [hydrated, setHydrated] = useState(false);
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [preferred, setPreferred] = useState<"auto" | AgentId>("auto");
  const [input, setInput] = useState("");
  const [image, setImage] = useState<string>();
  const [mealIntent, setMealIntent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [config, setConfig] = useState<ModelConfig>();
  const [modal, setModal] = useState<"profile" | "settings" | "about" | null>(
    null,
  );
  const [selectedAgent, setSelectedAgent] = useState<AgentId | null>(null);
  const [selectedTurn, setSelectedTurn] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<"flow" | "logs">("flow");
  const [mobilePanel, setMobilePanel] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const foodFileRef = useRef<HTMLInputElement>(null);
  const active = conversations.find((c) => c.id === activeId);
  const turns = active?.turns ?? [];
  const meals = turns.flatMap((t) => t.meal ? [t.meal] : []);
  const todaysMeals = meals.filter((m) => m.status === "confirmed" && m.mode === mode && m.date === todayDate());
  const todayTotals = mealTotals(todaysMeals.flatMap((m) => m.items));
  const currentProfile = consultationProfile(profile, active?.intake);
  const turn = turns.find((t) => t.id === selectedTurn) ?? turns.at(-1);
  const route = turn?.route;
  const trace = turn?.trace ?? [];
  const lastEvent = trace.at(-1);
  const report = turn?.result?.reports.find((r) => r.agent === selectedAgent);
  const selectedEvents = selectedAgent
    ? trace.filter((e) => e.agent === selectedAgent)
    : trace;
  const running = turn?.status === "running";

  async function refreshConfig() {
    try {
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error();
      setConfig(await res.json());
    } catch {
      setNotice("模型配置状态读取失败，请稍后刷新。");
    }
  }
  useEffect(() => {
    let restored: Conversation[] = [];
    try {
      const stored = JSON.parse(localStorage.getItem("wellnest-v1") || "{}");
      const parsed = profileSchema.safeParse(stored.profile);
      if (parsed.success) setProfile(parsed.data);
      if (stored.mode === "demo" || stored.mode === "live")
        setMode(stored.mode);
      if (Array.isArray(stored.conversations))
        restored = stored.conversations
          .filter(
            (c: Conversation) =>
              typeof c?.id === "string" &&
              typeof c.title === "string" &&
              Array.isArray(c.turns),
          )
          .slice(0, 12)
          .map((c: Conversation) => ({
            ...c,
            intake: c.intake
              ? intakeSchema.safeParse(c.intake).success
                ? c.intake
                : emptyIntake()
              : undefined,
            turns: c.turns
              .filter(
                (t) =>
                  typeof t.question === "string" &&
                  typeof t.answer === "string" &&
                  Array.isArray(t.trace),
              )
              .map((t) => ({ ...t, meal: mealSchema.safeParse(t.meal).success ? t.meal : undefined }))
              .map((t) =>
                t.status === "running"
                  ? {
                      ...t,
                      status: "stopped" as const,
                      error: "上次咨询已中断，请重试。",
                    }
                  : t,
              ),
          }));
    } catch {
      setNotice("本地历史读取失败，已开启新的会话。");
    }
    if (!restored.length) restored = [initialConversation()];
    setConversations(restored);
    setActiveId(restored[0].id);
    setHydrated(true);
    refreshConfig();
    return () => abortRef.current?.abort();
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        "wellnest-v1",
        JSON.stringify({ conversations, profile, mode }),
      );
    } catch {
      setNotice("浏览器存储空间不足，本次修改仅保留在当前页面。");
    }
  }, [conversations, profile, mode, hydrated]);
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: turns.length ? scrollRef.current.scrollHeight : 0,
      behavior: "smooth",
    });
  }, [activeId, turns.length, turns.at(-1)?.answer, busy]);
  useEffect(() => {
    if (modal) dialog.current?.showModal();
    else dialog.current?.close();
  }, [modal]);
  function updateTurn(
    conversationId: string,
    id: string,
    update: Partial<Turn> | ((t: Turn) => Turn),
  ) {
    setConversations((all) =>
      all.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              turns: c.turns.map((t) =>
                t.id === id
                  ? typeof update === "function"
                    ? update(t)
                    : { ...t, ...update }
                  : t,
              ),
            }
          : c,
      ),
    );
  }
  function newChat() {
    if (busy) return;
    const conversation = initialConversation();
    setConversations((all) => [conversation, ...all].slice(0, 12));
    setActiveId(conversation.id);
    setSelectedTurn(null);
    setSelectedAgent(null);
    setInput("");
    setImage(undefined);
    setMealIntent(false);
    setNotice("");
  }
  async function send(question = input, retryId?: string, nutritionOnly = false) {
    if (!retryId && mealIntent && !nutritionOnly) { await analyzeMeal(); return; }
    if (busy || !active || (!question.trim() && !image)) return;
    question = question.trim() || "请分析这张图片中的信息。";
    if (active.intake && !intakeSchema.safeParse(active.intake).success) {
      setNotice("请先检查今日资料中的日期和睡眠时长。");
      return;
    }
    if (mode === "live" && !config?.configured) {
      setModal("settings");
      return;
    }
    setBusy(true);
    setNotice("");
    setSelectedAgent(null);
    const id = retryId ?? crypto.randomUUID();
    const conversationId = active.id;
    const upload = retryId || nutritionOnly ? undefined : image;
    const previous = turns
      .filter((t) => t.status === "done" && t.id !== retryId && !t.mealRequest && (!t.mode || t.mode === mode))
      .slice(-8);
    const messages = previous.flatMap((t) => [
      { role: "user", content: t.question },
      { role: "assistant", content: t.answer },
    ]);
    messages.push({ role: "user", content: question.trim() });
    const fresh: Turn = {
      id,
      question: question.trim(),
      mode,
      answer: "",
      trace: [],
      status: "running",
      hasImage: Boolean(upload),
    };
    setConversations((all) =>
      all.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              title: c.turns.length ? c.title : question.slice(0, 24),
              turns: retryId
                ? c.turns.map((t) => (t.id === retryId ? fresh : t))
                : [...c.turns, fresh],
            }
          : c,
      ),
    );
    setSelectedTurn(id);
    setInput("");
    setImage(undefined);
    const abort = new AbortController();
    abortRef.current = abort;
    let receivedResult = false;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          profile: currentProfile,
          preferred: nutritionOnly ? "nutrition" : preferred,
          meals: confirmedMeals(meals, mode),
          mode,
          previousAgent: previous.at(-1)?.route?.primary,
          image: upload,
        }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error || "请求未完成。");
      }
      if (!response.body) throw new Error("浏览器无法读取响应流。");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const handle = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as StreamEvent;
        if (event.type === "trace")
          updateTurn(conversationId, id, (t) => ({
            ...t,
            trace: [...t.trace, event.data],
          }));
        if (event.type === "route")
          updateTurn(conversationId, id, { route: event.data });
        if (event.type === "answer_delta")
          updateTurn(conversationId, id, (t) => ({ ...t, answer: t.answer + event.data.text }));
        if (event.type === "result") {
          receivedResult = true;
          updateTurn(conversationId, id, {
            result: event.data,
            answer: event.data.answer,
            route: event.data.route,
            status: "done",
          });
        }
        if (event.type === "error") throw new Error(event.data.message);
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        lines.forEach(handle);
      }
      buffer += decoder.decode();
      if (buffer.trim()) handle(buffer);
      if (!receivedResult)
        throw new Error("连接已结束，但咨询未完成。请重试。");
    } catch (error) {
      updateTurn(conversationId, id, {
        status: abort.signal.aborted ? "stopped" : "error",
        error: abort.signal.aborted
          ? "咨询已停止，可重新发送。"
          : error instanceof Error
            ? error.message
            : "请求失败，请重试。",
      });
    } finally {
      abort.abort();
      setBusy(false);
      abortRef.current = null;
    }
  }
  async function analyzeMeal(example = false) {
    if (busy || !active) return;
    if (!example && mode !== "live") {
      setNotice("真实食物识别请切换真实模型；也可以先体验示例餐食。");
      return;
    }
    if (!example && !config?.configured) { setModal("settings"); return; }
    if (!example && !image && !input.trim()) { setNotice("请上传食物照片或描述这餐食物。"); return; }
    const id = crypto.randomUUID();
    const conversationId = active.id;
    const requestMode = example ? "demo" : "live";
    const question = example ? "体验拍照记餐（虚构示例）" : input.trim() || "帮我识别这餐食物、分量和营养。";
    const mealRoute: Route = { primary: "nutrition", tasks: [{ agent: "nutrition", task: "识别食物与分量，等待用户确认", dependsOn: [] }], summary: "由营养师处理餐食识别", clarification: null, urgent: false };
    const fresh: Turn = { id, question, mode: requestMode, answer: "", status: "running", mealRequest: true, hasImage: !example && !!image, route: mealRoute, trace: [{ id: crypto.randomUUID(), type: "tool", title: example ? "载入示例餐食" : "识别食物与估算分量", detail: "结果将作为草稿，确认前不计入摄入。", agent: "nutrition", at: new Date().toISOString() }] };
    setConversations((all) => all.map((c) => c.id === conversationId ? { ...c, title: c.turns.length ? c.title : "拍照记餐与营养咨询", turns: [...c.turns, fresh] } : c));
    setSelectedTurn(id);
    setBusy(true);
    setNotice("");
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const response = await fetch("/api/meals/analyze", {
        method: "POST", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(250000)]),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: requestMode, text: example ? "" : input, image: example ? undefined : image }),
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(body.error || "餐食识别失败，请重试。"));
      const meal = mealSchema.parse({ ...body, id, date: todayDate(), slot: "午餐", mode: requestMode, status: "draft" });
      updateTurn(conversationId, id, (t) => ({ ...t, meal, status: "done", trace: [...t.trace, { id: crypto.randomUUID(), type: "agent", title: "餐食草稿待确认", detail: "请核对实际食用分量，尚未进入共享记录。", agent: "nutrition", at: new Date().toISOString() }] }));
      setInput(""); setImage(undefined); setMealIntent(false);
    } catch (error) {
      updateTurn(conversationId, id, { status: abort.signal.aborted ? "stopped" : "error", error: abort.signal.aborted ? "已停止识别，照片和描述仍保留在输入框。" : error instanceof Error ? error.message : "识别失败，请重试。" });
    } finally { setBusy(false); abortRef.current = null; }
  }
  function chooseFile(file?: File, food = false) {
    if (!file) return;
    if (mode !== "live") {
      setNotice("图片识别需要切换到真实模型模式。");
      return;
    }
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 4 * 1024 * 1024
    ) {
      setNotice("请选择 4 MB 以内的 JPG、PNG 或 WebP 图片。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { setImage(String(reader.result)); setMealIntent(food); };
    reader.onerror = () => setNotice("图片读取失败，请重新选择。");
    reader.readAsDataURL(file);
  }
  function agentState(id: AgentId) {
    if (!route?.tasks.some((t) => t.agent === id)) return "idle";
    const events = trace.filter(
      (t) => t.agent === id && ["agent", "error"].includes(t.type),
    );
    if (turn?.status === "done" && !turn.result?.reports.length)
      return "skipped";
    if (events.some((e) => e.type === "error")) return "failed";
    if (events.some((e) => e.title.endsWith("完成"))) return "done";
    if (running && events.length) return "active";
    return running ? "waiting" : "stopped";
  }
  const stage =
    turn?.status === "done"
      ? 4
      : lastEvent?.type === "review"
        ? 3
        : trace.some((e) => e.type === "agent")
          ? 2
          : trace.length
            ? 1
            : 0;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="/" className="brand">
          <span className="brand-mark">
            <Leaf size={23} />
          </span>
          <span>
            共养<span className="brand-en">WELLNEST</span>
          </span>
        </a>
        <button className="new-chat" onClick={newChat} disabled={busy}>
          <Plus size={17} /> 开始新的咨询 <span>↗</span>
        </button>
        <div className="nav-label">工作空间</div>
        <button
          className="nav-item selected"
          onClick={() => inputRef.current?.focus()}
        >
          <MessageSquare size={17} /> 健康咨询
        </button>
        <button
          className="nav-item"
          onClick={() => {
            setDraftProfile(profile);
            setModal("profile");
          }}
        >
          <ClipboardList size={17} /> 健康档案 <span className="nav-dot" />
        </button>
        <div className="nav-label team-label">
          你的 AI 专家团队 <span>5</span>
        </div>
        <button
          className={`expert-nav auto ${preferred === "auto" ? "chosen" : ""}`}
          onClick={() => setPreferred("auto")}
          disabled={busy}
        >
          <span className="auto-icon">
            <Sparkles size={17} />
          </span>
          <span>
            智能协作<small>按问题自动安排专家</small>
          </span>
          {preferred === "auto" && <Check size={14} />}
        </button>
        {agentIds.map((id) => (
          <button
            disabled={busy}
            key={id}
            className={`expert-nav ${preferred === id ? "chosen" : ""}`}
            onClick={() => setPreferred(id)}
          >
            <Avatar agent={id} small />
            <span>
              {experts[id].name}
              <small>{experts[id].subtitle}</small>
            </span>
            {preferred === id && <Check size={14} />}
          </button>
        ))}
        <div className="nav-label history-label">最近咨询</div>
        <div className="history-list">
          {conversations
            .filter((c) => c.turns.length)
            .map((c) => (
              <button
                disabled={busy}
                className={`history-item ${c.id === activeId ? "current" : ""}`}
                key={c.id}
                onClick={() => {
                  setActiveId(c.id);
                  setSelectedTurn(null);
                  setSelectedAgent(null);
                }}
              >
                <MessageSquare size={13} />
                <span>{c.title}</span>
              </button>
            ))}
          {!conversations.some((c) => c.turns.length) && (
            <p className="history-empty">咨询记录会保存在此浏览器</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <button onClick={() => setModal("settings")}>
            <Settings2 size={17} /> 模型连接{" "}
            <span
              className={`connection-dot ${config?.configured ? "connected" : ""}`}
            />
          </button>
          <button onClick={() => setModal("about")}>
            <CircleHelp size={17} /> 关于这个工作台
          </button>
          <div className="user-card">
            <span>{profile.name?.[0] || "访"}</span>
            <div>
              {profile.name || "我的健康空间"}
              <small>
                {profile.source === "demo"
                  ? "正在使用演示档案"
                  : "个人健康档案"}
              </small>
            </div>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="breadcrumb">工作空间</span>
            <ChevronRight size={14} />
            <strong>多师共管</strong>
          </div>
          <div className="top-actions">
            <span className="private-label">
              <ShieldCheck size={14} /> 本地会话
            </span>
            <button
              className="mobile-new-chat icon-button"
              aria-label="新建对话"
              disabled={busy}
              onClick={newChat}
            >
              <Plus size={18} />
            </button>
            <select
              aria-label="运行模式"
              disabled={busy}
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as "demo" | "live");
                setImage(undefined);
              }}
            >
              <option value="demo">演示模式</option>
              <option value="live">真实模型</option>
            </select>
            <button
              className="mobile-flow-toggle icon-button"
              aria-label="查看架构流程"
              onClick={() => setMobilePanel(!mobilePanel)}
            >
              <Workflow size={20} />
            </button>
          </div>
        </header>
        <main className="main-grid">
          <section
            className={`chat-pane ${mobilePanel ? "mobile-hidden" : ""}`}
          >
            <div className="chat-heading">
              <div>
                <span className="eyebrow">YOUR CARE TEAM</span>
                <h1>健康咨询</h1>
              </div>
              <span className="subtle-chip">
                <span className="green-dot" />{" "}
                {preferred === "auto" ? "智能协作" : experts[preferred].name}
              </span>
            </div>
            <div
              className="chat-scroll"
              ref={scrollRef}
              role="region"
              aria-label="咨询内容区域"
              tabIndex={0}
            >
              {active?.intake && (
                <div className="intake-container">
                  <DailyIntakeCard
                    key={active.id}
                    intake={active.intake}
                    disabled={busy}
                    onChange={(intake) =>
                      setConversations((all) =>
                        all.map((c) =>
                          c.id === active.id ? { ...c, intake } : c,
                        ),
                      )
                    }
                  />
                </div>
              )}
              {!turns.length ? (
                active?.intake?.status === "pending" ? null : (
                  <div className="welcome">
                    <div className="welcome-symbol">
                      <Leaf size={33} strokeWidth={1.3} />
                      <span className="symbol-orbit">
                        <Sparkles size={12} />
                      </span>
                    </div>
                    <h2>一起，照顾好每一个你。</h2>
                    <p>
                      从睡眠、饮食到运动，
                      <br />
                      让合适的专家，陪你找到下一步。
                    </p>
                    <div className="team-avatars">
                      {agentIds.map((id) => (
                        <Avatar key={id} agent={id} />
                      ))}
                      <span>五位 AI 专家 · 按需协作</span>
                    </div>
                    <div className="suggestions">
                      {starterQuestions.map(
                        ({ icon: Icon, title, text, label }) => (
                          <button
                            disabled={!hydrated}
                            key={title}
                            onClick={() => send(text)}
                          >
                            <span className="suggestion-icon">
                              <Icon size={19} />
                            </span>
                            <span>
                              <strong>{title}</strong>
                              <small>{label}</small>
                            </span>
                            <ArrowUp className="diagonal" size={17} />
                          </button>
                        ),
                      )}
                    </div>
                    <div className="welcome-note">
                      <GitBranch size={14} />
                      <span>右侧实时呈现专家如何分工、查询和协作</span>
                    </div>
                  </div>
                )
              ) : (
                <div className="messages">
                  {turns.map((t) => (
                    <article className="turn" key={t.id}>
                      <div className="user-message">
                        {t.hasImage && (
                          <span className="attachment-tag">
                            <Paperclip size={13} /> 已附图片
                          </span>
                        )}
                        {t.question}
                      </div>
                      <div className="assistant-message">
                        <div className="assistant-label">
                          {t.route ? (
                            <Avatar small agent={t.route.primary} />
                          ) : (
                            <span className="auto-icon">
                              <Sparkles size={16} />
                            </span>
                          )}
                          <strong>
                            {t.route
                              ? experts[t.route.primary].name
                              : "咨询协调 Agent"}
                          </strong>
                          {t.route && t.route.tasks.length > 1 && (
                            <span className="collab-label">
                              + {t.route.tasks.length - 1} 位协作
                            </span>
                          )}
                          <button
                            className="trace-link"
                            onClick={() => {
                              setSelectedTurn(t.id);
                              setMobilePanel(true);
                            }}
                          >
                            查看流程 <ChevronRight size={12} />
                          </button>
                        </div>
                        {t.status === "running" && (
                          <div className="thinking">
                            <LoaderCircle size={15} className="spin" />
                            <span>
                              {t.answer ? "正在生成回答…" : t.trace.at(-1)?.title || "正在连接咨询服务…"}
                            </span>
                          </div>
                        )}
                        {t.meal && <MealCard meal={t.meal} disabled={busy} onChange={(meal) => updateTurn(activeId, t.id, { meal })}
                          onDiscuss={() => { if (t.meal!.mode !== mode) { setNotice("请先切换到这条餐食记录对应的运行模式，再请求解读。"); return; } setMealIntent(false); void send(`请营养师读取已确认的${t.meal!.date}${t.meal!.slot}餐食记录，简短解读${t.meal!.items.map((f) => f.name).join("、")}这餐的营养，并给一个可执行建议。`, undefined, true); }}
                          onCorrect={() => { updateTurn(activeId, t.id, { meal: { ...t.meal!, status: "discarded" } }); setMealIntent(true); setInput(t.meal!.items.map((f) => f.name).join("、")); inputRef.current?.focus(); }} />}
                        {t.answer && (
                          <>
                            <div className="answer-mode">
                              {t.result?.mode === "demo"
                                ? "预设流程演示"
                                : "真实模型生成"}
                              {t.result?.dataSource === "demo" &&
                                " · 使用演示档案"}
                            </div>
                            <Markdown text={answerForDisplay(t.answer)} />
                          </>
                        )}
                        {t.answer && (t.status === "stopped" || t.status === "error") && (
                          <p className="partial-note">回答未完成，以上仅为已生成的部分。</p>
                        )}
                        {t.error && (
                          <div className="error-card">
                            <p>{t.error}</p>
                            <button
                              disabled={busy}
                              onClick={() => t.mealRequest ? analyzeMeal(t.mode === "demo") : send(t.question, t.id)}
                            >
                              <RotateCcw size={13} /> 重新执行
                            </button>
                            {t.hasImage && (
                              <small>重试图片问题时，请重新附图。</small>
                            )}
                          </div>
                        )}
                        {t.result?.partial && (
                          <p className="partial-note">
                            部分专家未完成，本次回答已保留相应信息缺口。
                          </p>
                        )}
                        {!!t.result?.sources.length && (
                          <details className="sources">
                            <summary>
                              <FileText size={13} /> {t.result.sources.length}{" "}
                              项数据与参考来源 <ChevronDown size={12} />
                            </summary>
                            {t.result.sources.map((s) => (
                              <div key={s.id}>
                                {s.url ? (
                                  <a
                                    href={s.url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {s.title} ↗
                                  </a>
                                ) : (
                                  <strong>{s.title}</strong>
                                )}
                                <small>{s.detail}</small>
                                {s.excerpt && (
                                  <p className="source-excerpt">{s.excerpt}</p>
                                )}
                              </div>
                            ))}
                          </details>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
            <div className="composer-area">
              {notice && (
                <div className="notice" role="status">
                  {notice}
                  <button aria-label="关闭提示" onClick={() => setNotice("")}>
                    <X size={14} />
                  </button>
                </div>
              )}
              {mode === "demo" && <button className="meal-demo" disabled={busy || !hydrated} onClick={() => analyzeMeal(true)}>体验示例餐食 · 不计入真实摄入</button>}
              {todaysMeals.length > 0 && <div className="meal-daily" role="status">{mode === "demo" ? "示例 · " : ""}今天已记录 {todaysMeals.length} 餐 · 约 {Math.round(todayTotals.kcal)} 千卡 · 蛋白质 {Math.round(todayTotals.protein)} 克 · 碳水 {Math.round(todayTotals.carbs)} 克 · 脂肪 {Math.round(todayTotals.fat)} 克<span>仅当前咨询已确认记录</span></div>}
              <div className="data-strip">
                <Database size={13} />
                <span>
                  {active?.intake
                    ? active.intake.status === "saved"
                      ? "本次睡眠、饮食与运动资料已载入"
                      : "可先补充上方今日资料"
                    : profile.source === "demo"
                      ? "虚构演示档案已载入"
                      : "使用你录入的健康档案"}
                </span>
                <button
                  disabled={busy}
                  onClick={() => {
                    setDraftProfile(profile);
                    setModal("profile");
                  }}
                >
                  查看档案 <ChevronRight size={12} />
                </button>
              </div>
              <div className="composer">
                {image && (
                  <div className="image-preview">
                    <img src={image} alt="待分析图片" />
                    <button
                      aria-label="移除图片"
                      onClick={() => setImage(undefined)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                )}
                {mealIntent && <div className="meal-composer-label"><Utensils size={14} /> 拍照记餐 · 营养师识别
                  <button disabled={busy} onClick={() => setMealIntent(false)}>切回普通咨询</button></div>}
                {image && !mealIntent && <button className="meal-image-switch" onClick={() => setMealIntent(true)}>这是食物照片？转为拍照记餐</button>}
                <textarea
                  aria-label="咨询内容"
                  ref={inputRef}
                  value={input}
                  maxLength={4000}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={mealIntent ? "可补充食物名称、烹饪方式或分量，也可以直接发送照片…" : "说说你最近的状态，或问一个健康问题…"}
                  rows={2}
                  disabled={busy}
                />
                <div className="composer-tools">
                  <div>
                    <button className="food-entry" disabled={busy || !hydrated} onClick={() => {
                      if (mode === "demo") { setMealIntent(true); setNotice("可点击“体验示例餐食”查看流程；识别自己的食物请切换真实模型。"); return; }
                      setMealIntent(true); foodFileRef.current?.click();
                    }}><Camera size={17} />拍食物</button>
                    <input ref={foodFileRef} type="file" accept="image/png,image/jpeg,image/webp" capture="environment" hidden onChange={(e) => { chooseFile(e.target.files?.[0], true); e.target.value = ""; }} />
                    <button
                      title="添加图片（真实模型模式）"
                      aria-label="添加图片"
                      disabled={busy}
                      onClick={() => fileRef.current?.click()}
                    >
                      <Paperclip size={18} />
                    </button>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      hidden
                      onChange={(e) => {
                        chooseFile(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                    <span>
                      <Sparkles size={12} />
                      {preferred === "auto"
                        ? "自动选择专家"
                        : experts[preferred].name}
                    </span>
                  </div>
                  {busy ? (
                    <button
                      className="send-button stop"
                      aria-label="停止咨询"
                      onClick={() => abortRef.current?.abort()}
                    >
                      <Square size={15} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      disabled={(!input.trim() && !image) || !hydrated}
                      aria-label="发送咨询"
                      onClick={() => send()}
                    >
                      <ArrowUp size={21} />
                    </button>
                  )}
                </div>
              </div>
              <p className="composer-note">
                AI 健康咨询原型 · 诊断与治疗请咨询持证医疗人员
              </p>
            </div>
          </section>

          <aside className={`flow-pane ${mobilePanel ? "mobile-visible" : ""}`}>
            <div className="flow-header">
              <div>
                <span className="eyebrow">AGENT WORKSPACE</span>
                <h2>协作正在发生</h2>
              </div>
              <span className={`flow-state ${running ? "live" : ""}`}>
                {running ? (
                  <LoaderCircle size={12} className="spin" />
                ) : (
                  <span className="green-dot" />
                )}
                {running
                  ? "执行中"
                  : turn?.status === "done"
                    ? "已完成"
                    : "就绪"}
              </span>
            </div>
            <div className="panel-tabs">
              <button
                className={panelTab === "flow" ? "active" : ""}
                onClick={() => setPanelTab("flow")}
              >
                <Network size={15} /> 架构流程
              </button>
              <button
                className={panelTab === "logs" ? "active" : ""}
                onClick={() => setPanelTab("logs")}
              >
                <ClipboardList size={15} /> 执行记录{" "}
                {trace.length > 0 && <span>{trace.length}</span>}
              </button>
              <button
                className="close-mobile icon-button"
                aria-label="返回咨询"
                onClick={() => setMobilePanel(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div
              className="flow-content"
              role="region"
              aria-label="架构与执行详情"
              tabIndex={0}
            >
              {panelTab === "flow" ? (
                <>
                  <div className="architecture">
                    <div className="graph-caption">
                      <span>每次咨询按需唤起专家</span>
                      <span>
                        <i />
                        待命 <i className="on" />
                        参与
                      </span>
                    </div>
                    <div
                      className={`graph-input ${stage >= 1 ? "engaged" : ""}`}
                    >
                      <MessageSquare size={14} />
                      <span>用户问题 + 对话上下文</span>
                    </div>
                    <div className={`stem ${stage >= 1 ? "lit" : ""}`} />
                    <button
                      className={`coordinator node ${stage === 1 && running ? "node-active" : ""} ${stage >= 1 ? "engaged" : ""}`}
                      onClick={() => {
                        setSelectedAgent(null);
                        setPanelTab("logs");
                      }}
                    >
                      <span className="coordinator-icon">
                        <GitBranch size={22} />
                      </span>
                      <span>
                        <strong>咨询协调 Agent</strong>
                        <small>
                          {route?.summary || "识别意图 · 拆分任务 · 安排专家"}
                        </small>
                      </span>
                      {stage >= 2 ? (
                        <Check size={16} />
                      ) : (
                        <Sparkles size={16} />
                      )}
                    </button>
                    <div className={`branch ${route ? "lit" : ""}`}>
                      <div />
                    </div>
                    <div className="expert-nodes">
                      {agentIds.map((id) => {
                        const state = agentState(id);
                        const Icon = icons[id];
                        return (
                          <button
                            key={id}
                            className={`expert-node ${state} ${selectedAgent === id ? "focused" : ""}`}
                            onClick={() =>
                              setSelectedAgent(selectedAgent === id ? null : id)
                            }
                            style={
                              {
                                "--expert-color": experts[id].color,
                              } as React.CSSProperties
                            }
                          >
                            <span className="expert-node-icon">
                              <Icon size={21} strokeWidth={1.6} />
                              {state === "done" && (
                                <span className="node-check">
                                  <Check size={9} />
                                </span>
                              )}
                            </span>
                            <strong>{experts[id].name}</strong>
                            <small>
                              {state === "active"
                                ? "处理中"
                                : state === "done"
                                  ? "已完成"
                                  : state === "waiting"
                                    ? "等待依赖"
                                    : state === "failed"
                                      ? "未完成"
                                      : state === "skipped"
                                        ? "未执行"
                                        : state === "stopped"
                                          ? "已停止"
                                          : "待命"}
                            </small>
                          </button>
                        );
                      })}
                    </div>
                    <div
                      className={`branch reverse ${stage >= 2 ? "lit" : ""}`}
                    >
                      <div />
                    </div>
                    <div
                      className={`tools-group ${lastEvent?.type === "tool" && running ? "node-active" : ""}`}
                    >
                      <div className="layer-caption">共享上下文与受控工具</div>
                      <div>
                        <span>
                          <ClipboardList size={17} />
                          健康档案
                        </span>
                        <span>
                          <Activity size={17} />
                          健康记录
                        </span>
                        <span>
                          <FileText size={17} />
                          营养 RAG / 参考知识
                        </span>
                      </div>
                      <small>读取结果 → 判断是否充分 → 继续调用或完成</small>
                    </div>
                    <div className={`stem ${stage >= 3 ? "lit" : ""}`} />
                    <button
                      className={`summary-node node ${stage === 3 && running ? "node-active" : ""} ${stage >= 3 ? "engaged" : ""}`}
                      onClick={() => {
                        setSelectedAgent(null);
                        setPanelTab("logs");
                      }}
                    >
                      <CheckCheck size={20} />
                      <span>
                        <strong>{route?.tasks.length === 1 && turn?.mode === "live" ? "专家直接回答" : "主专家汇总与检查"}</strong>
                        <small>{route?.tasks.length === 1 && turn?.mode === "live" ? "依据已读资料 · 直接生成正文" : "整合建议 · 保留约束 · 标记分歧"}</small>
                      </span>
                      {stage === 4 && <Check size={15} />}
                    </button>
                    <div className={`stem short ${stage === 4 ? "lit" : ""}`} />
                    <div
                      className={`graph-output ${stage === 4 ? "engaged" : ""}`}
                    >
                      <MessageSquare size={13} /> 一份完整的咨询回答
                    </div>
                  </div>
                  <NutritionLibrary />
                  <div className="execution-detail">
                    <div className="detail-heading">
                      <strong>
                        {selectedAgent
                          ? `${experts[selectedAgent].name} · 任务详情`
                          : "本次执行"}
                      </strong>
                      {selectedAgent && (
                        <button
                          className="icon-button"
                          aria-label="取消选择专家"
                          onClick={() => setSelectedAgent(null)}
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                    {turn?.result?.metrics && (
                      <p className="assigned-task">
                        {turn.result.metrics.path === "fast" ? "日常快速回答" : turn.result.metrics.path === "single" ? "单师直接回答" : "协作流程"}
                        {" · "}总耗时 {(turn.result.metrics.totalMs / 1000).toFixed(1)} 秒
                        {turn.result.metrics.firstTextMs !== null && <> · 首段正文 {(turn.result.metrics.firstTextMs / 1000).toFixed(1)} 秒</>}
                        {turn.result.metrics.modelCalls !== null && <> · 模型调用 {turn.result.metrics.modelCalls} 次</>}
                      </p>
                    )}
                    {!turn && (
                      <div className="empty-run">
                        <Workflow size={22} strokeWidth={1.4} />
                        <p>从左侧发起一次咨询</p>
                        <small>这里会展示真实执行事件与工具返回结果</small>
                      </div>
                    )}
                    {turn &&
                      selectedAgent &&
                      !route?.tasks.some((t) => t.agent === selectedAgent) && (
                        <p className="muted">本次任务尚未分配给这位专家。</p>
                      )}
                    {selectedAgent &&
                      route?.tasks.find((t) => t.agent === selectedAgent) && (
                        <p className="assigned-task">
                          {
                            route.tasks.find((t) => t.agent === selectedAgent)
                              ?.task
                          }
                        </p>
                      )}
                    {selectedAgent &&
                    route?.tasks.find((t) => t.agent === selectedAgent)
                      ?.dependsOn.length ? (
                      <p className="assigned-task">
                        前置任务 ·{" "}
                        {route.tasks
                          .find((t) => t.agent === selectedAgent)!
                          .dependsOn.map((id) => experts[id].name)
                          .join("、")}
                      </p>
                    ) : null}
                    {report && (
                      <div className="expert-report">
                        {[
                          ["发现", report.findings],
                          ["建议", report.recommendations],
                          ["约束", report.constraints],
                          ["待补充", report.missing],
                        ].map(([label, values]) =>
                          (values as string[]).length ? (
                            <div key={label as string}>
                              <strong>{label as string}</strong>
                              {(values as string[]).map((v, i) => (
                                <p key={i}>{v}</p>
                              ))}
                            </div>
                          ) : null,
                        )}
                      </div>
                    )}
                    {turn && (
                      <div className="compact-events">
                        {selectedEvents.slice(-4).map((e) => (
                          <details key={e.id}>
                            <summary>
                              <span className={`event-dot ${e.type}`} />
                              <span>{e.title}</span>
                              <ChevronDown size={12} />
                            </summary>
                            <pre>{e.detail}</pre>
                          </details>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="full-events">
                  {!trace.length && (
                    <div className="empty-run">
                      <ClipboardList size={26} />
                      <p>还没有执行记录</p>
                      <small>发送问题后，逐步记录本次执行过程。</small>
                    </div>
                  )}
                  {trace.map((e, i) => (
                    <details key={e.id} open={i === trace.length - 1}>
                      <summary>
                        <span className={`event-dot ${e.type}`} />
                        <span>
                          <strong>{e.title}</strong>
                          <small>
                            {new Date(e.at).toLocaleTimeString("zh-CN", {
                              hour12: false,
                            })}
                            {e.agent && ` · ${experts[e.agent].name}`}
                          </small>
                        </span>
                        <ChevronDown size={13} />
                      </summary>
                      <pre>{e.detail}</pre>
                    </details>
                  ))}
                </div>
              )}
            </div>
            <div className="flow-footer">
              <span className="small-square" />
              {(turn?.result?.mode ?? turn?.mode ?? mode) === "demo"
                ? "演示引擎 · 规则路由 / 预设输出"
                : `${config?.model || "qwen3.5-plus"} · 工具调用循环`}
              <span>最多 5 分钟 / 次</span>
            </div>
          </aside>
        </main>
      </div>

      <dialog
        ref={dialog}
        onCancel={() => setModal(null)}
        onClick={(e) => {
          if (e.target === dialog.current) setModal(null);
        }}
      >
        <div className="modal-content">
          <div className="modal-heading">
            <div>
              <span className="eyebrow">WELLNEST WORKSPACE</span>
              <h2>
                {modal === "profile"
                  ? "共享健康档案"
                  : modal === "settings"
                    ? "模型连接"
                    : "关于工作台"}
              </h2>
            </div>
            <button
              className="icon-button"
              aria-label="关闭窗口"
              onClick={() => setModal(null)}
            >
              <X size={20} />
            </button>
          </div>
          {modal === "profile" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const parsed = profileSchema.safeParse(draftProfile);
                if (!parsed.success) {
                  setNotice("请检查档案字段长度与年龄。");
                  return;
                }
                setProfile(parsed.data);
                setModal(null);
              }}
            >
              <p className="modal-intro">
                档案保存在当前浏览器。真实模型模式下，与问题相关的信息会发送到你配置的模型服务。
              </p>
              <div className="profile-actions">
                <span className="subtle-chip">
                  {draftProfile.source === "demo" ? "虚构演示档案" : "用户录入"}
                </span>
                <button
                  type="button"
                  onClick={() => setDraftProfile(blankProfile)}
                >
                  填写我的档案
                </button>
                <button
                  type="button"
                  onClick={() => setDraftProfile(demoProfile)}
                >
                  恢复演示档案
                </button>
              </div>
              <div className="form-grid">
                <label>
                  称呼
                  <input
                    maxLength={40}
                    value={draftProfile.name}
                    onChange={(e) =>
                      setDraftProfile({ ...draftProfile, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  年龄
                  <input
                    type="number"
                    min={1}
                    max={120}
                    value={draftProfile.age ?? ""}
                    onChange={(e) =>
                      setDraftProfile({
                        ...draftProfile,
                        age: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </label>
              </div>
              {(
                [
                  ["goals", "健康目标", "你想改善什么？"],
                  [
                    "conditions",
                    "已知健康状况",
                    "填写已确认的信息，未知可留空",
                  ],
                  ["medications", "用药记录", "名称、使用情况；未知可留空"],
                  ["allergies", "过敏与禁忌", "已确认的过敏或医生告知的限制"],
                  [
                    "sleep",
                    "睡眠记录",
                    "日期、入睡与起床时间、夜间觉醒、白天状态",
                  ],
                  ["diet", "饮食记录", "日期、食物、分量、饮料或咖啡"],
                  ["exercise", "运动记录", "日期、项目、时长、身体感受"],
                  ["vitals", "体征记录", "日期、心率、血压及测量条件"],
                ] as const
              ).map(([key, label, placeholder]) => (
                <label key={key}>
                  {label}
                  <textarea
                    maxLength={
                      key === "goals" ||
                      key === "medications" ||
                      key === "allergies"
                        ? 600
                        : key === "conditions"
                          ? 1000
                          : 2000
                    }
                    rows={key === "sleep" ? 3 : 2}
                    value={draftProfile[key]}
                    placeholder={placeholder}
                    onChange={(e) =>
                      setDraftProfile({
                        ...draftProfile,
                        [key]: e.target.value,
                      })
                    }
                  />
                </label>
              ))}
              <div className="modal-footer">
                <span>
                  {draftProfile.source === "demo"
                    ? "修改演示档案仍保留演示标记"
                    : "录入信息标记为用户自述"}
                </span>
                <button
                  className="primary-button"
                  disabled={busy}
                  type="submit"
                >
                  保存档案
                </button>
              </div>
            </form>
          )}
          {modal === "settings" && (
            <div className="settings-content">
              <div
                className={`connection-card ${config?.configured ? "ready" : ""}`}
              >
                <span className="connection-dot" />
                <div>
                  <strong>
                    {config?.configured
                      ? "服务端 API Key 已配置"
                      : "等待连接模型服务"}
                  </strong>
                  <p>
                    {config?.configured
                      ? "可以切换到真实模型模式进行咨询。"
                      : "演示模式可直接体验流程。配置 API Key 后开启真实推理。"}
                  </p>
                </div>
              </div>
              <dl>
                <div>
                  <dt>文本模型</dt>
                  <dd>{config?.model || "qwen3.5-plus"}</dd>
                </div>
                <div>
                  <dt>视觉模型</dt>
                  <dd>{config?.visionModel || "qwen3-vl-plus"}</dd>
                </div>
                <div>
                  <dt>温度</dt>
                  <dd>{config?.temperature ?? 0.2}</dd>
                </div>
                <div>
                  <dt>请求超时</dt>
                  <dd>
                    文本 {config?.timeoutSeconds ?? 60}s / 图片{" "}
                    {config?.visionTimeoutSeconds ?? 120}s
                  </dd>
                </div>
              </dl>
              <h3>本地配置</h3>
              <p>
                在项目根目录复制 <code>.env.example</code> 为{" "}
                <code>.dev.vars</code>，填入 <code>LLM_API_KEY</code>{" "}
                并重启开发服务。
              </p>
              <pre>
                LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
                {"\n"}LLM_API_KEY=你的密钥
              </pre>
              <p className="muted">
                密钥由服务端读取。网页仅展示是否已配置。线上部署通过平台 Secret
                配置同名变量。
              </p>
              <button className="primary-button" onClick={refreshConfig}>
                <RotateCcw size={14} /> 刷新连接状态
              </button>
            </div>
          )}
          {modal === "about" && (
            <div className="about-content">
              <p>
                共养是一套可交互的多 Agent
                健康咨询原型，用于展示路由、专家工具调用、依赖调度与结果汇总。
              </p>
              <h3>真实模型模式</h3>
              <p>
                协调 Agent
                生成结构化任务图。五位专家各自调用受控工具，独立任务并行执行，有依赖的任务按顺序推进。主专家汇总并检查一致性。
              </p>
              <h3>演示模式</h3>
              <p>
                使用规则路由和预设回复，工具实际读取当前档案。流程图与日志展示发生的执行事件。
              </p>
              <h3>当前数据能力</h3>
              <p>
                支持浏览器内档案与会话、人工录入记录、图片信息识别。营养师接入本地
                PDF 混合检索，回答可追溯原页。其他专家使用 CDC 睡眠及 WHO
                饮食摘要。设备平台、医院系统、临床审核与长期任务服务仍需后续接入。
              </p>
              <h3>上下文与保存</h3>
              <p>
                每次咨询携带最近 8 轮成功对话。最多保留 12
                个本地会话。原始图片仅在本次请求中使用。专家输出与健康档案分别保存。
              </p>
            </div>
          )}
        </div>
      </dialog>
    </div>
  );
}
