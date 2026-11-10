import asyncio
import base64
import json
import unittest
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.wellnest.api import create_app
from backend.wellnest.config import Settings
from backend.wellnest.models import ChatInput
from backend.wellnest.nutrition import (
    AnalyzeInput, ConfirmedMeal, Food, analyze, calculate, with_meals,
)
from backend.wellnest.provider import ProviderError
from backend.wellnest.tools import execute_local

FOOD = dict(name="熟米饭", portion="一碗", grams=150,
            per100g=dict(kcal=116, protein=2.6, carbs=25.9, fat=0.3), note="估算")
MEAL = dict(id="meal-1", date="2026-11-10", slot="午餐", mode="live",
            status="confirmed", items=[FOOD])
PROFILE = dict(name="", age=None, goals="", conditions="", medications="",
               allergies="", sleep="", diet="", exercise="", vitals="", source="user")


class NutritionTests(unittest.TestCase):
    def test_calculation_and_unknown_are_not_zero_intake(self):
        result = calculate([Food.model_validate(FOOD), Food.model_validate(dict(FOOD, grams=None))])
        self.assertEqual(result["totals"]["kcal"], 174)
        self.assertEqual(result["unknownItems"], 1)
        self.assertEqual(calculate([Food.model_validate(dict(FOOD, grams=75))])["totals"]["kcal"], 87)

    def test_confirm_rejects_unknown_negative_nan_and_invalid_date(self):
        for grams in (None, -1, 0, 5001, float("nan"), float("inf")):
            with self.assertRaises(ValidationError):
                ConfirmedMeal.model_validate(dict(MEAL, items=[dict(FOOD, grams=grams)]))
        with self.assertRaises(ValidationError):
            ConfirmedMeal.model_validate(dict(MEAL, date="2026-02-30"))
        with self.assertRaises(ValidationError):
            ConfirmedMeal.model_validate(dict(MEAL, items=[]))

    def test_image_validation(self):
        png = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 20).decode()
        self.assertEqual(AnalyzeInput(mode="live", image=png).image, png)
        for image in (png.replace("png", "jpeg"), "file:///tmp/test", "data:image/png;base64,xxx", "data:image/png;base64," + base64.b64encode(b"x" * 20).decode()):
            with self.assertRaises(ValidationError):
                AnalyzeInput(mode="live", image=image)
        with self.assertRaises(ValidationError):
            AnalyzeInput(mode="demo", image=png)

    def test_draft_and_demo_isolation_and_deduplication(self):
        self.assertEqual(with_meals(PROFILE, [dict(MEAL, status="draft"), dict(MEAL, mode="demo")], "live"), PROFILE)
        shared = with_meals(PROFILE, [MEAL, MEAL], "live")
        self.assertEqual(shared["diet"].count("热量 174千卡"), 1)
        self.assertEqual(PROFILE["diet"], "")
        tool = execute_local("nutrition", "read_health_records", {"kind": "diet"}, shared)
        self.assertIn("熟米饭", tool["data"]["record"])
        self.assertIn("非文献值", tool["data"]["record"])

    def test_real_meal_does_not_borrow_demo_profile(self):
        shared = with_meals(dict(PROFILE, source="demo", age=32, sleep="虚构睡眠", diet="虚构饮食"), [MEAL], "live")
        self.assertEqual(shared["source"], "user")
        self.assertIsNone(shared["age"])
        self.assertNotIn("虚构", str(shared))

    def test_chat_accepts_old_contract_and_rejects_drafts(self):
        data = dict(messages=[dict(role="user", content="分析这餐")], profile=PROFILE, mode="live")
        self.assertEqual(ChatInput.model_validate(data).meals, [])
        with self.assertRaises(ValidationError):
            ChatInput.model_validate(dict(data, meals=[dict(MEAL, status="draft")]))

    def test_live_vision_and_no_food(self):
        provider = AsyncMock()
        provider.complete.return_value = {"content": json.dumps(dict(title="未识别到餐食", items=[], notes=[], question="请补充清晰照片"))}
        result = asyncio.run(analyze(AnalyzeInput(mode="live", text="这是一张桌子照片"), provider))
        self.assertEqual(result["items"], [])
        self.assertEqual(result["question"], "请补充清晰照片")
        provider.complete.return_value = {"content": json.dumps(dict(title="餐食", items=[dict(FOOD, grams=-1)], notes=[], question=""))}
        with self.assertRaises(ProviderError):
            asyncio.run(analyze(AnalyzeInput(mode="live", text="一碗米饭"), provider))

    def test_api_demo_confirmation_and_shared_record(self):
        with TestClient(create_app(Settings(token="test"))) as client:
            self.assertEqual(client.post("/meals/analyze", json={"mode": "demo"}).status_code, 401)
            headers = {"Authorization": "Bearer test"}
            draft = client.post("/meals/analyze", json={"mode": "demo"}, headers=headers)
            self.assertEqual(draft.status_code, 200)
            self.assertIn("非照片识别", draft.json()["title"])
            meal = dict(MEAL, mode="demo", items=draft.json()["items"])
            for _ in range(2):
                self.assertEqual(client.post("/meals/calculate", json=meal, headers=headers).json()["totals"]["kcal"], 384)
            self.assertEqual(client.post("/meals/calculate", json=dict(meal, status="draft"), headers=headers).status_code, 400)
            self.assertEqual(client.post("/meals/analyze", json={"mode": "live", "text": "一碗米饭"}, headers=headers).status_code, 503)
            chat = client.post("/chat", json=dict(messages=[dict(role="user", content="看看已确认饮食")], profile=PROFILE, mode="demo", preferred="nutrition", meals=[meal]), headers=headers)
            self.assertEqual(chat.status_code, 200)
            self.assertIn("熟米饭", chat.text)
