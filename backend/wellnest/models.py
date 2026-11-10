"""Validated wire contracts, compatible with existing browser conversations."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .nutrition import ConfirmedMeal


class StrictModel(BaseModel):
    model_config = ConfigDict(strict=True)


Agent = Literal["nutrition", "sports", "general", "sleep", "tcm"]


class Profile(StrictModel):
    name: str = Field(max_length=40)
    age: int | None = Field(ge=1, le=120)
    goals: str = Field(max_length=600)
    conditions: str = Field(max_length=1000)
    medications: str = Field(max_length=600)
    allergies: str = Field(max_length=600)
    sleep: str = Field(max_length=2000)
    diet: str = Field(max_length=2000)
    exercise: str = Field(max_length=2000)
    vitals: str = Field(max_length=2000)
    source: Literal["demo", "user"]


class Message(StrictModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=12000)


class ChatInput(StrictModel):
    meals: list[ConfirmedMeal] = Field(default_factory=list, max_length=30)
    messages: list[Message] = Field(min_length=1, max_length=30)
    profile: Profile
    preferred: Literal["auto", "nutrition", "sports", "general", "sleep", "tcm"] = (
        "auto"
    )
    mode: Literal["demo", "live"]
    previousAgent: Agent | None = None
    image: str | None = Field(
        default=None,
        max_length=5700000,
        pattern=r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$",
    )

    @model_validator(mode="after")
    def last_message_is_user(self):
        if self.messages[-1].role != "user":
            raise ValueError("最后一条消息必须来自用户")
        return self


class Task(StrictModel):
    agent: Agent
    task: str = Field(min_length=1, max_length=1000)
    dependsOn: list[Agent] = Field(max_length=4)


class Route(StrictModel):
    primary: Agent
    tasks: list[Task] = Field(min_length=1, max_length=5)
    summary: str = Field(max_length=500)
    clarification: str | None = Field(max_length=600)
    urgent: bool

    @model_validator(mode="after")
    def valid_dependencies(self):
        ids = [task.agent for task in self.tasks]
        if len(set(ids)) != len(ids) or self.primary not in ids:
            raise ValueError("任务分配存在重复或缺少主专家")
        completed = set()
        remaining = list(self.tasks)
        while remaining:
            ready = [task for task in remaining if set(task.dependsOn) <= completed]
            if not ready:
                raise ValueError("任务依赖存在循环或缺失")
            completed.update(task.agent for task in ready)
            remaining = [task for task in remaining if task not in ready]
        return self


class ReportBody(StrictModel):
    findings: list[str] = Field(max_length=8)
    recommendations: list[str] = Field(max_length=8)
    constraints: list[str] = Field(max_length=8)
    missing: list[str] = Field(max_length=8)


class Query(StrictModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    query: str = Field(min_length=1, max_length=500)


class Verification(StrictModel):
    model_config = ConfigDict(extra="forbid")
    sourceId: str = Field(max_length=100)
    question: str = Field(min_length=1, max_length=500)


class RecordQuery(StrictModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["sleep", "diet", "exercise", "vitals"]
