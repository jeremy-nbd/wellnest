"""DAG scheduling and bounded specialist tool loops."""

import asyncio
import json
import re
from datetime import UTC, datetime
from uuid import uuid4

from pydantic import ValidationError

from .models import ReportBody, Route
from .provider import Provider, ProviderError, parse_json
from .tools import EXPERTS, PROMPTS, RESOURCES, execute_tool, unique_sources


def encode(value):
    return json.dumps(value, ensure_ascii=False)


def prompt(template, **values):
    result = PROMPTS[template]
    for key, value in values.items():
        result = result.replace("{" + key + "}", value)
    return result


def simulated_route(data):
    question = data["messages"][-1]["content"]
    patterns = [
        ("sleep", "睡|失眠|作息|夜醒|早醒|困倦"),
        ("nutrition", "饮食|吃|营养|咖啡|减重|食物|晚餐"),
        ("sports", "运动|跑步|锻炼|健身|步行|训练"),
        ("tcm", "中医|体质|调养|气虚|湿气"),
    ]
    selected = [agent for agent, pattern in patterns if re.search(pattern, question)]
    if re.search("血压|心率|头痛|胸痛|疾病|用药", question):
        selected.insert(0, "general")
    if data["preferred"] != "auto":
        selected.insert(0, data["preferred"])
    ids = list(dict.fromkeys(selected or [data.get("previousAgent") or "general"]))[:3]
    return Route.model_validate(
        dict(
            primary=ids[0],
            summary="演示规则匹配，安排"
            + "、".join(EXPERTS[a]["name"] for a in ids)
            + "参与。",
            tasks=[
                dict(
                    agent=a,
                    task=EXPERTS[a]["scope"],
                    dependsOn=["general"] if ids[0] == "general" and i else [],
                )
                for i, a in enumerate(ids)
            ],
            urgent=False,
            clarification=None,
        )
    ).model_dump()


def failed_report(agent, message, sources=None):
    return dict(
        agent=agent,
        status="failed",
        findings=[],
        recommendations=[],
        constraints=[],
        missing=[message],
        sources=unique_sources(sources or []),
    )


async def run_consultation(data, settings, emit, client, rag, provider=None):
    provider = provider or Provider(settings, client)
    profile = data["profile"]

    def trace(kind, title, detail, agent=None):
        event = dict(
            id=str(uuid4()),
            type=kind,
            title=title,
            detail=detail,
            at=datetime.now(UTC).isoformat(),
        )
        if agent:
            event["agent"] = agent
        emit(dict(type="trace", data=event))

    image_context = ""
    if data.get("image"):
        if data["mode"] == "demo":
            raise ProviderError("图片识别需要真实模型模式和服务端 API Key。")
        trace(
            "tool",
            "识别上传图片",
            f"使用 {settings.vision_model} 提取可见信息，识别结果标记为待核对。",
        )
        response = await provider.complete(
            [
                dict(role="system", content=prompt("vision")),
                dict(
                    role="user",
                    content=[
                        dict(
                            type="text",
                            text="提取图片中与健康咨询有关的信息，保留原始单位和日期。",
                        ),
                        dict(type="image_url", image_url={"url": data["image"]}),
                    ],
                ),
            ],
            vision=True,
        )
        image_context = "图片识别结果（待用户核对）：" + str(response["content"])
    trace(
        "route",
        "协调 Agent · 识别咨询需求",
        "演示模式使用确定性规则。"
        if data["mode"] == "demo"
        else "结合当前问题、最近对话、已选专家和健康档案摘要分配任务。",
    )
    if data["mode"] == "demo":
        await asyncio.sleep(0.45)
        route = simulated_route(data)
    else:
        context = dict(
            messages=data["messages"],
            preferred=data["preferred"],
            previousAgent=data.get("previousAgent"),
            imageContext=image_context,
            knowledgeCapabilities={
                "nutrition": dict(
                    configured=rag.ready(),
                    searchTool="search_nutrition_knowledge",
                    verificationTool="verify_nutrition_page",
                    returns=["文件名", "PDF页码", "原文片段", "原页链接"],
                )
            },
            profile={
                **{k: profile[k] for k in ["age", "goals", "conditions", "source"]},
                "recordAvailability": {
                    k: bool(profile[k]) for k in ["sleep", "diet", "exercise", "vitals"]
                },
            },
        )
        response = await provider.complete(
            [
                dict(role="system", content=prompt("router", experts=encode(EXPERTS))),
                dict(role="user", content=encode(context)),
            ],
            json_mode=True,
        )
        try:
            route = Route.model_validate(
                parse_json(response.get("content"))
            ).model_dump()
        except (ValidationError, ProviderError):
            trace(
                "route", "修正任务分配格式", "模型任务图未通过校验，正在重新生成一次。"
            )
            corrected = await provider.complete(
                [
                    dict(role="system", content=prompt("routeRepair")),
                    dict(
                        role="user",
                        content=encode(
                            dict(
                                original=response.get("content"),
                                question=data["messages"][-1]["content"],
                            )
                        ),
                    ),
                ],
                json_mode=True,
            )
            route = Route.model_validate(
                parse_json(corrected.get("content"))
            ).model_dump()
    emit(dict(type="route", data=route))
    trace("route", "任务分配完成", route["summary"], route["primary"])
    result = dict(
        route=route,
        reports=[],
        sources=[],
        mode=data["mode"],
        dataSource=profile["source"],
        partial=False,
    )
    if route["urgent"] or route["clarification"]:
        result["answer"] = (
            "你描述的情况可能需要及时的线下医疗评估。若症状正在发生或加重，请立即联系当地急救服务或前往急诊，并让身边的人陪同。此次咨询先暂停常规健康建议。"
            if route["urgent"]
            else route["clarification"]
        )
        return result
    reports = []

    async def run_expert(task):
        agent = task["agent"]
        sources = []
        trace("agent", EXPERTS[agent]["name"] + "开始处理", task["task"], agent)

        async def tool(name, args):
            response = await execute_tool(
                agent, name, args, profile, rag, provider, sources
            )
            sources.extend(response["sources"])
            trace("tool", response["label"], encode(response["data"]), agent)
            return response["data"]

        try:
            if data["mode"] == "demo":
                kind = dict(
                    nutrition="diet",
                    sleep="sleep",
                    sports="exercise",
                    general="vitals",
                    tcm="sleep",
                )[agent]
                for name, args in [
                    ("read_health_profile", {}),
                    ("read_health_records", {"kind": kind}),
                    ("search_knowledge", {"query": EXPERTS[agent]["scope"]}),
                ]:
                    await asyncio.sleep(0.45)
                    await tool(name, args)
                body = dict(
                    findings=[profile[kind] or "尚未提供相关记录。"],
                    recommendations=[
                        "请补充记录的实际日期、变化过程和你最希望解决的问题。"
                    ],
                    constraints=[
                        "演示模式使用预设输出，接入模型后将生成针对当前问题的分析。"
                    ],
                    missing=[] if profile[kind] else ["相关健康记录"],
                )
            else:
                messages = [
                    dict(
                        role="system",
                        content=prompt(
                            "expert",
                            name=EXPERTS[agent]["name"],
                            scope=EXPERTS[agent]["scope"],
                        ),
                    ),
                    dict(
                        role="user",
                        content=encode(
                            dict(
                                task=task["task"],
                                messages=data["messages"],
                                imageContext=image_context,
                                upstream=[
                                    r
                                    for r in reports
                                    if r["agent"] in task["dependsOn"]
                                ],
                            )
                        ),
                    ),
                ]
                count = 0
                if agent == "nutrition":
                    messages[0]["content"] += PROMPTS["nutrition"]
                    call_id = str(uuid4())
                    args = {"query": task["task"][:500]}
                    messages.append(
                        dict(
                            role="assistant",
                            content=None,
                            tool_calls=[
                                dict(
                                    id=call_id,
                                    type="function",
                                    function=dict(
                                        name="search_nutrition_knowledge",
                                        arguments=encode(args),
                                    ),
                                )
                            ],
                        )
                    )
                    evidence = await tool("search_nutrition_knowledge", args)
                    messages.append(
                        dict(
                            role="tool", tool_call_id=call_id, content=encode(evidence)
                        )
                    )
                    count = 1
                body = None
                for turn in range(5):
                    last = turn == 4 or count >= 8
                    if last:
                        messages.append(
                            dict(
                                role="user",
                                content="工具调用阶段已结束。基于已获取信息完成报告，保留所有缺口。"
                                + PROMPTS["reportFormat"],
                            )
                        )
                    response = await provider.complete(
                        messages,
                        json_mode=last,
                        tools=None if last else RESOURCES["definitions"][agent],
                    )
                    messages.append(response)
                    calls = response.get("tool_calls")
                    if not calls:
                        try:
                            body = ReportBody.model_validate(
                                parse_json(response.get("content"))
                            ).model_dump()
                        except (ValidationError, ProviderError):
                            trace(
                                "agent",
                                EXPERTS[agent]["name"] + "整理报告格式",
                                "保留已检索的证据，将结果整理为结构化报告。",
                                agent,
                            )
                            corrected = await provider.complete(
                                messages
                                + [
                                    dict(
                                        role="user",
                                        content="上次输出未通过结构校验。基于已获取的资料整理报告，禁止补造事实。每个字段最多4条，保留引用和信息缺口。"
                                        + PROMPTS["reportFormat"],
                                    )
                                ],
                                json_mode=True,
                            )
                            body = ReportBody.model_validate(
                                parse_json(corrected.get("content"))
                            ).model_dump()
                        break
                    for call in calls:
                        count += 1
                        try:
                            if last or count > 8:
                                raise ValueError(
                                    "已达到工具调用上限，请基于已有资料完成报告。"
                                )
                            response_data = await tool(
                                call["function"]["name"],
                                json.loads(call["function"]["arguments"] or "{}"),
                            )
                        except (ValueError, ProviderError, KeyError, TypeError):
                            response_data = {
                                "error": "工具请求未完成，请检查工具权限、参数或知识库状态。"
                            }
                            trace(
                                "tool", "工具请求未完成", encode(response_data), agent
                            )
                        messages.append(
                            dict(
                                role="tool",
                                tool_call_id=call["id"],
                                content=encode(response_data),
                            )
                        )
                if body is None:
                    raise ProviderError("专家执行达到轮数限制。")
            trace(
                "agent",
                EXPERTS[agent]["name"] + "完成",
                "\n".join(body["findings"]),
                agent,
            )
            return dict(
                **body, agent=agent, status="complete", sources=unique_sources(sources)
            )
        except Exception as error:
            message = (
                str(error)
                if isinstance(error, ProviderError)
                else "专家输出格式异常，未采纳该结果。"
            )
            trace("error", EXPERTS[agent]["name"] + "暂未完成", message, agent)
            return failed_report(agent, message, sources)

    pending = list(route["tasks"])
    complete = set()
    while pending:
        ready = [task for task in pending if set(task["dependsOn"]) <= complete]
        if not ready:
            raise ProviderError("任务依赖无法继续执行。")

        async def scheduled(task):
            if any(
                r["status"] == "failed" and r["agent"] in task["dependsOn"]
                for r in reports
            ):
                trace(
                    "error",
                    EXPERTS[task["agent"]]["name"] + "暂停",
                    "上游专业约束未完成。",
                    task["agent"],
                )
                return failed_report(task["agent"], "上游任务失败")
            return await run_expert(task)

        batch = await asyncio.gather(*(scheduled(task) for task in ready))
        reports.extend(batch)
        complete.update(task["agent"] for task in ready)
        pending = [task for task in pending if task not in ready]
    if all(r["status"] == "failed" for r in reports):
        raise ProviderError(reports[0]["missing"][0])
    sources = unique_sources([s for report in reports for s in report["sources"]])
    trace(
        "review",
        "主专家 · 汇总与一致性检查",
        "保留各专家的数据依据、约束和信息缺口；遇到冲突明确列为待确认事项。",
        route["primary"],
    )
    if data["mode"] == "demo":
        answer = (
            "已由"
            + "、".join(EXPERTS[r["agent"]]["name"] for r in reports)
            + "协作完成流程演示。\n\n"
        )
        answer += "\n\n".join(
            "### "
            + EXPERTS[r["agent"]]["name"]
            + "查阅到的信息\n"
            + "\n".join(r["findings"])
            for r in reports
        )
        answer += "\n\n### 下一步\n切换到真实模型模式后，专家会围绕你的具体问题选择工具、分析记录，并整合建议。\n\n本次为预设流程演示，以上记录的来源已在右侧标注。"
    else:
        response = await provider.complete(
            [
                dict(
                    role="system",
                    content=prompt("synthesis", name=EXPERTS[route["primary"]]["name"]),
                ),
                dict(
                    role="user",
                    content=encode(
                        dict(
                            messages=data["messages"],
                            reports=reports,
                            sources=sources,
                            imageContext=image_context,
                            dataSource=profile["source"],
                        )
                    ),
                ),
            ]
        )
        answer = str(response.get("content", ""))

        def citation(match):
            source = next(
                (s for s in sources if s.get("url") == match[2].replace("&amp;", "&")),
                None,
            )
            return (
                f"[{source['title']}]({source['url']})"
                if source
                else match[1] + "（引用待核对）"
            )

        answer = re.sub(r"\[([^\]]+)\]\((/api/rag/page\?[^\s)]+)\)", citation, answer)
    trace(
        "status",
        "本次咨询完成",
        f"共 {len(reports)} 位专家参与，{len(sources)} 项数据与知识来源。",
    )
    return dict(
        result,
        answer=answer,
        reports=reports,
        sources=sources,
        partial=any(r["status"] == "failed" for r in reports),
    )
