"""Server-only configuration, shared by API and indexing commands."""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[2]


def bounded(values, key, default, minimum, maximum):
    try:
        value = float(values.get(key, default))
        return max(minimum, min(maximum, value)) if value == value else default
    except (TypeError, ValueError):
        return default


@dataclass
class Settings:
    api_key: str = ""
    base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    model: str = "qwen3.5-plus"
    vision_model: str = "qwen3-vl-plus"
    temperature: float = 0.2
    timeout: float = 60
    vision_timeout: float = 120
    token: str = ""
    embedding_model: str = "text-embedding-v4"
    dimensions: int = 512
    root: Path = ROOT

    @property
    def rag_directory(self):
        return self.root / ".rag"

    @classmethod
    def load(cls):
        values = {**dotenv_values(ROOT / ".dev.vars"), **os.environ}
        return cls(
            api_key=values.get("LLM_API_KEY", ""),
            base_url=values.get("LLM_BASE_URL", cls.base_url).rstrip("/"),
            model=values.get("LLM_DEFAULT_MODEL_ID", cls.model),
            vision_model=values.get("VLM_DEFAULT_MODEL_ID", cls.vision_model),
            temperature=bounded(values, "LLM_TEMPERATURE", 0.2, 0, 2),
            timeout=bounded(values, "LLM_TIMEOUT_S", 60, 5, 180),
            vision_timeout=bounded(values, "VLM_TIMEOUT_S", 120, 5, 240),
            token=values.get("BACKEND_SERVICE_TOKEN")
            or values.get("RAG_SERVICE_TOKEN", ""),
            embedding_model=values.get("RAG_EMBEDDING_MODEL", cls.embedding_model),
            dimensions=int(bounded(values, "RAG_EMBEDDING_DIMENSIONS", 512, 64, 2048)),
        )
