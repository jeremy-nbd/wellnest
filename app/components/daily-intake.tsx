"use client";
import { useState } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  ClipboardList,
  Moon,
  Sparkles,
  Utensils,
} from "lucide-react";
import {
  DailyIntake,
  emptyIntake,
  formatMinutes,
  intakeSchema,
  sampleIntake,
} from "../../lib/intake";

function DurationField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number | null;
  onChange: (minutes: number | null) => void;
  disabled: boolean;
}) {
  const hours = value === null ? "" : Math.floor(value / 60);
  const minutes = value === null ? "" : value % 60;
  return (
    <fieldset className="duration-field" disabled={disabled}>
      <legend>
        {label}
        {value !== null && (
          <button
            type="button"
            aria-label={`清空${label}`}
            onClick={() => onChange(null)}
            disabled={disabled}
          >
            ×
          </button>
        )}
      </legend>
      <div>
        <input
          aria-label={`${label}小时`}
          type="number"
          min="0"
          max="24"
          step="1"
          placeholder="—"
          value={hours}
          onChange={(e) =>
            onChange(
              e.target.value === "" && minutes === ""
                ? null
                : Number(e.target.value || 0) * 60 + Number(minutes || 0),
            )
          }
        />
        <span>时</span>
        <input
          aria-label={`${label}分钟`}
          type="number"
          min="0"
          max="59"
          step="1"
          placeholder="—"
          value={minutes}
          onChange={(e) =>
            onChange(
              e.target.value === "" && hours === ""
                ? null
                : Number(hours || 0) * 60 + Number(e.target.value || 0),
            )
          }
        />
        <span>分</span>
      </div>
    </fieldset>
  );
}
export function DailyIntakeCard({
  intake,
  onChange,
  disabled,
}: {
  intake: DailyIntake;
  onChange: (value: DailyIntake) => void;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(intake.status === "pending");
  const [error, setError] = useState("");
  function change(patch: Partial<DailyIntake>) {
    onChange({ ...intake, ...patch });
    setError("");
  }
  function save() {
    const checked = intakeSchema.safeParse({ ...intake, status: "saved" });
    if (!checked.success) {
      setError(checked.error.issues[0].message);
      return;
    }
    onChange(checked.data);
    setEditing(false);
  }
  if (!editing)
    return (
      <div className="intake-summary">
        <div>
          <span className="intake-check">
            <Check size={15} />
          </span>
          <span>
            <strong>
              {intake.status === "skipped"
                ? "今日资料待补充"
                : "本次咨询资料已就绪"}
            </strong>
            <small>
              {intake.date} ·{" "}
              {intake.source === "demo" ? "虚构演示资料" : "本次录入"}
            </small>
          </span>
          <button disabled={disabled} onClick={() => setEditing(true)}>
            补充资料
          </button>
        </div>
        {intake.status === "saved" && (
          <div className="intake-summary-items">
            <span>
              <Moon size={13} />
              {formatMinutes(intake.sleepMinutes)}
            </span>
            <span>
              <Utensils size={13} />
              {intake.diet.trim() ? "饮食已记录" : "饮食待补充"}
            </span>
            <span>
              <Activity size={13} />
              {intake.exercise.trim() ? "运动已记录" : "运动待补充"}
            </span>
          </div>
        )}
      </div>
    );
  return (
    <form
      className="intake-card"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="intake-title">
        <span className="intake-symbol">
          <ClipboardList size={22} />
        </span>
        <div>
          <span className="eyebrow">TODAY’S CHECK-IN</span>
          <h2>先了解一下今天的你</h2>
        </div>
      </div>
      <p className="intake-description">
        睡得怎么样，吃了什么，有没有动一动？
        <br />
        补充今天的资料，让专家的建议更贴近你。
      </p>
      <div className="intake-toolbar">
        <label>
          记录日期
          <input
            aria-label="记录日期"
            type="date"
            required
            value={intake.date}
            disabled={disabled}
            onChange={(e) => change({ date: e.target.value })}
          />
        </label>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            onChange(sampleIntake(intake.date));
            setError("");
          }}
        >
          <Sparkles size={13} /> 填入演示资料
        </button>
      </div>
      <div className="intake-section-label">
        <Moon size={16} />
        <strong>今天睡了多久？</strong>
        <span>今天醒来前一晚的睡眠</span>
      </div>
      <div className="duration-grid">
        <DurationField
          label="睡眠总时长"
          value={intake.sleepMinutes}
          onChange={(value) => change({ sleepMinutes: value })}
          disabled={disabled}
        />
        <DurationField
          label="深睡时长"
          value={intake.deepMinutes}
          onChange={(value) => change({ deepMinutes: value })}
          disabled={disabled}
        />
        <DurationField
          label="浅睡时长"
          value={intake.lightMinutes}
          onChange={(value) => change({ lightMinutes: value })}
          disabled={disabled}
        />
      </div>
      <p className="intake-hint">
        不清楚的项目可以留空。深睡与浅睡之外可能还有其他睡眠阶段。
      </p>
      <label className="intake-text-label">
        <span>
          <Utensils size={16} />
          今天吃了什么？
        </span>
        <textarea
          aria-label="今天吃了什么"
          maxLength={1500}
          rows={2}
          disabled={disabled}
          value={intake.diet}
          placeholder="记录早、中、晚餐，零食、饮料和大致分量…"
          onChange={(e) => change({ diet: e.target.value })}
        />
      </label>
      <label className="intake-text-label">
        <span>
          <Activity size={16} />
          今天做了什么运动？
        </span>
        <textarea
          aria-label="今天做了什么运动"
          maxLength={1500}
          rows={2}
          disabled={disabled}
          value={intake.exercise}
          placeholder="例如：傍晚快走 30 分钟；今天没有运动也可以记录"
          onChange={(e) => change({ exercise: e.target.value })}
        />
      </label>
      {error && (
        <p className="intake-error" role="alert">
          {error}
        </p>
      )}
      <div className="intake-source">
        {intake.source === "demo" ? (
          <>
            <span className="green-dot" /> 当前为演示资料
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...emptyIntake(), date: intake.date })}
            >
              改填我的资料
            </button>
          </>
        ) : (
          <>
            <span className="green-dot" /> 仅用于本次对话 · 可随时补充
          </>
        )}
      </div>
      <div className="intake-footer">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            onChange({
              ...emptyIntake(),
              date: intake.date,
              status: "skipped",
            });
            setEditing(false);
          }}
        >
          稍后补充
        </button>
        <button className="primary-button" disabled={disabled} type="submit">
          保存，开始咨询 <ArrowRight size={15} />
        </button>
      </div>
    </form>
  );
}
