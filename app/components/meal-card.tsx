"use client";

import { useState } from "react";
import { Check, Utensils, Trash2 } from "lucide-react";
import { Meal, mealSchema, mealTotals } from "../../lib/meals";

export function MealCard({ meal, disabled, onChange, onDiscuss, onCorrect }: {
  meal: Meal;
  disabled: boolean;
  onChange: (meal: Meal) => void;
  onDiscuss: () => void;
  onCorrect: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const totals = mealTotals(meal.items);
  const confirmed = meal.status === "confirmed";
  const locked = disabled || saving || confirmed;
  const incomplete = !meal.items.length || meal.items.some((f) => f.grams === null);
  if (meal.status === "discarded") return <div className="meal-discarded">餐食草稿已取消，未计入记录。</div>;

  async function confirm() {
    const next = { ...meal, status: "confirmed" as const };
    if (!mealSchema.safeParse(next).success) {
      setError("请检查日期并补齐每项食物的实际食用克数（1–5000克）。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const { id, date, slot, mode, items, status } = next;
      const response = await fetch("/api/meals/calculate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, date, slot, mode, items, status }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "确认失败，请重试。");
      onChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "确认失败，请重试。");
    } finally { setSaving(false); }
  }

  return <section className="meal-card" aria-label="餐食营养卡片">
    <header><span><Utensils size={17} /> {meal.title}</span>
      <small>{meal.mode === "demo" ? "虚构示例 · " : ""}{confirmed ? "已确认" : "待你核对"}</small></header>
    <p className="meal-hint">{confirmed ? "已记在当前咨询中。营养师和其他老师可按需读取。" : "先核对食物，再填写你实际吃下的分量；共餐只保留自己吃的部分。"}</p>
    <fieldset disabled={locked}>
      <div className="meal-meta"><label>日期<input type="date" value={meal.date} onChange={(e) => onChange({ ...meal, date: e.target.value })} /></label>
        <label>餐次<select value={meal.slot} onChange={(e) => onChange({ ...meal, slot: e.target.value as Meal["slot"] })}>
          {["早餐", "午餐", "晚餐", "加餐"].map((s) => <option key={s}>{s}</option>)}
        </select></label></div>
      {meal.items.map((food, index) => <div className="meal-food" key={index}>
        <div><strong>{food.name}</strong><small>识别分量：{food.portion}</small>{food.note && <small>{food.note}</small>}</div>
        <div className="meal-amount"><label>实际食用<input aria-label={`${food.name}实际食用克数`} type="number" min="1" max="5000" step="any" placeholder="待补充" value={food.grams ?? ""} onChange={(e) => onChange({ ...meal, items: meal.items.map((f, i) => i === index ? { ...f, grams: e.target.value === "" ? null : Number(e.target.value) } : f) })} />克</label>
          {!confirmed && <div className="meal-portion-actions"><button type="button" disabled={food.grams === null} onClick={() => onChange({ ...meal, items: meal.items.map((f, i) => i === index ? { ...f, grams: Math.max(1, (f.grams ?? 0) / 2) } : f) })}>减半</button>
            <button type="button" aria-label={`移除${food.name}`} onClick={() => onChange({ ...meal, items: meal.items.filter((_, i) => i !== index) })}><Trash2 size={13} />没吃</button></div>}
        </div>
      </div>)}
    </fieldset>
    {!!meal.items.length && <div className="meal-nutrients" aria-label="估算营养">
      {([ ["kcal", "热量", "千卡"], ["protein", "蛋白质", "克"], ["carbs", "碳水", "克"], ["fat", "脂肪", "克"] ] as const).map(([key, label, unit]) => <div key={key}><small>{label}</small><strong>{Math.round(totals[key])}<span>{unit}</span></strong></div>)}
    </div>}
    {incomplete && <p className="meal-hint">{meal.question || "请补齐分量后确认。当前只估算分量已知的食物。"}</p>}
    {meal.notes.map((note, i) => <p className="meal-hint" key={i}>{note}</p>)}
    <p className="meal-source">分量与每100克营养均为 AI 参考估算，未接入权威营养数据库。仅统计已确认餐食，未记录不代表未进食。</p>
    {error && <p role="alert" className="meal-error">{error}</p>}
    <footer>{confirmed ? <><span><Check size={14} />{meal.mode === "demo" ? "示例已确认" : "已记录"}</span><button disabled={disabled} onClick={onDiscuss}>请营养师解读</button>
      <button disabled={disabled} onClick={() => onChange({ ...meal, status: "draft" })}>修改记录</button></> : <>
      <button className="meal-primary" disabled={disabled || saving || incomplete} onClick={confirm}>{saving ? "正在确认…" : "确认并记录"}</button>
      <button disabled={disabled || saving} onClick={onCorrect}>食物不对？重新描述</button>
      <button disabled={disabled || saving} onClick={() => onChange({ ...meal, status: "discarded" })}>取消</button></>}</footer>
  </section>;
}
