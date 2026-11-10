"""Conservative shortcuts for routine requests; anything else uses the router."""

import re

from .models import Route


RISK = re.compile(
    r"痛|晕|喘|呼吸|出血|呕|吐|发热|发烧|过敏|疾病|糖尿|血糖|血压|心率|"
    r"心脏|肾|肝|癌|药|手术|怀孕|孕期|哺乳|儿童|孩子|婴|诊断|治疗|"
    r"急救|昏|麻木|无力|自杀|自伤|不想活|催吐|暴食|进食障碍|医嘱|"
    r"指南|文献|推荐量|标准|参考摄入|每天.*(?:多少|几克)|PDF|pdf|一起|多师|多位|综合"
)


def quick_route(data, profile):
    if data.get("image"):
        return None
    if profile.get("age") is not None and not 18 <= profile["age"] < 65:
        return None
    # Explicit constraints, even in the existing conversation, require routing.
    if any(profile.get(key, "").strip() not in ("", "未提供", "未知", "无", "无已知")
           for key in ("conditions", "medications", "allergies")):
        return None
    history = " ".join(message["content"] for message in data["messages"] if message["role"] == "user")
    if RISK.search(history):
        return None
    question = data["messages"][-1]["content"].strip().rstrip("。？！?!")
    # Only narrowly specified everyday intents qualify. No arbitrary keyword routing.
    patterns = {
        "nutrition": [
            r"(?:请|帮我|请帮我)?(?:营养师)?(?:看看|解读|分析)(?:一下)?(?:这餐|这顿饭|我的饮食|我的饮食记录)(?:的营养)?",
            r"(?:今晚|今天|晚上)?吃(?:得|的)?(?:太多|多了)(?:[，, ]*(?:晚上|今晚)?(?:应该|该|需要)?(?:做点什么吗|怎么办|怎么调整))?",
            r"(?:早餐|午餐|晚餐)(?:可以)?(?:怎么搭配|吃什么)",
        ],
        "sleep": [r"(?:请|帮我|请帮我)?(?:看看|整理|总结)(?:一下)?(?:我的|今天的|昨晚的)?(?:睡眠记录|作息记录)"],
        "sports": [r"(?:请|帮我|请帮我)?(?:看看|整理|总结)(?:一下)?(?:我的|今天的)?(?:运动记录|锻炼记录)"],
    }
    agent = next((key for key, expressions in patterns.items()
                  if any(re.fullmatch(pattern, question) for pattern in expressions)), None)
    # The UI's meal interpretation action contains user-corrected food names.
    if (not agent and len(question) <= 300 and data.get("meals")
            and re.fullmatch(r"请营养师读取已确认的\d{4}-\d{2}-\d{2}(?:早餐|午餐|晚餐|加餐)餐食记录，简短解读[^。\n]+这餐的营养，并给一个可执行建议", question)):
        agent = "nutrition"
    if not agent and question in ("还有呢", "再简单一点", "具体怎么做", "能举个例子吗"):
        # Continue only a previously recognizable routine question.
        previous = data["messages"][:-1]
        if previous and data.get("previousAgent"):
            prior_users = [i for i, message in enumerate(previous) if message["role"] == "user"]
            if prior_users:
                prior = quick_route({**data, "messages": previous[:prior_users[-1] + 1]}, profile)
                if prior and prior["primary"] == data["previousAgent"]:
                    agent = prior["primary"]
    if not agent or data.get("preferred", "auto") not in ("auto", agent):
        return None
    return Route.model_validate(dict(
        primary=agent, tasks=[dict(agent=agent, task=question, dependsOn=[])],
        summary="日常单领域问题，直接交给对应专家。", clarification=None, urgent=False,
    )).model_dump()
