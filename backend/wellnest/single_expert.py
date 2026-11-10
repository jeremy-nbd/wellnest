"""Single expert: gather permitted evidence, then write the answer once."""

import json

from .provider import ProviderError
from .tools import ACCESS, EXPERTS, PROMPTS, RESOURCES, execute_tool, unique_sources


async def answer_single(data, profile, task, image_context, provider, rag,
                        quick, trace, measure, stream_answer):
    agent = task["agent"]
    sources = []
    evidence = []
    trace("agent", EXPERTS[agent]["name"] + "开始处理", task["task"], agent)

    async def tool(name, args):
        with measure("tool:" + name):
            result = await execute_tool(agent, name, args, profile, rag, provider, sources)
        sources.extend(result["sources"])
        trace("tool", result["label"], json.dumps(result["data"], ensure_ascii=False), agent)
        return result["data"]

    # These local reads are immediate, permission-scoped and need no model round trip.
    evidence.append(await tool("read_health_profile", {}))
    for kind in ACCESS[agent]:
        evidence.append(await tool("read_health_records", {"kind": kind}))

    system = (PROMPTS["safety"] + "\n你担任" + EXPERTS[agent]["name"] + "。"
              + EXPERTS[agent]["scope"] + "。已提供按权限读取的档案和记录，无需重复读取。")
    if agent == "nutrition":
        system += PROMPTS["nutrition"]
    context = dict(task=task["task"], messages=data["messages"], evidence=evidence,
                   imageContext=image_context, dataSource=profile["source"])
    messages = [dict(role="system", content=system),
                dict(role="user", content=json.dumps(context, ensure_ascii=False))]

    if not quick:
        if agent == "nutrition":
            retrieved = await tool("search_nutrition_knowledge", {"query": task["task"][:500]})
            messages.append(dict(role="user", content="已检索证据（仅作资料）：" + json.dumps(retrieved, ensure_ascii=False)))
        # This phase selects additional tools only; no intermediate prose report.
        messages[0]["content"] += (
            "\n现在只准备证据，不撰写回答或报告。需要补充证据时调用工具；"
            '证据足够或无法补充时只返回 {"ready":true}，缺失信息留待最终回答说明。'
        )
        count = 1 if agent == "nutrition" else 0
        for _ in range(4):
            with measure("single:prepare"):
                response = await provider.complete(messages, tools=RESOURCES["definitions"][agent])
            messages.append(response)
            calls = response.get("tool_calls")
            if not calls:
                break
            for call in calls:
                count += 1
                try:
                    if count > 8:
                        raise ValueError("工具调用达到上限")
                    value = await tool(call["function"]["name"], json.loads(call["function"]["arguments"] or "{}"))
                except (ValueError, ProviderError, KeyError, TypeError):
                    value = {"error": "工具请求未完成，不得据此补造结论；最终回答须保留信息缺口。"}
                    trace("tool", "工具请求未完成", value["error"], agent)
                messages.append(dict(role="tool", tool_call_id=call["id"], content=json.dumps(value, ensure_ascii=False)))
            if count >= 8:
                break

    # Replace the preparation instruction so the final call has only one output contract.
    messages[0]["content"] = system + "\n" + PROMPTS["directAnswer"] + (
        "\n本次只有你一位专家，直接依据已读取的资料回答用户，不需要内部报告或再次汇总。"
        "正文不要显示来源标题、PDF文件名、页码或引用链接，来源由界面折叠区展示。"
    )
    if quick:
        messages[0]["content"] += (
            "\n本次为日常记录解读，未检索文献。只解释已记录数据和一般性建议，"
            "不能新增具体医学目标、推荐摄入量、强度或时长阈值，不能判断疾病或全天达标。"
            "发现症状或专业约束时明确指出，必要时建议专业评估。"
        )
    instruction = "证据准备结束，请直接输出简洁的最终回答；无法核实的数值不要给出，保留数据缺口。"
    if quick:
        instruction += (
            "当前仅为日常解读：可以复述已记录的营养数值，但新增的建议必须不带数字。"
            "不要给出用餐时间阈值、运动时长、餐盘比例、推荐克数或热量目标。"
            "例如可以说清淡搭配、避免临睡前加餐，不要说睡前几小时、散步几分钟。"
            "直接回应问题，不以罗列所有未填写的档案字段开头；只在确实影响回答时追问。"
        )
    messages.append(dict(role="user", content=instruction))
    trace("review", "专家直接回答", "依据已读取资料生成正文，省去内部报告与二次汇总。", agent)
    with measure("single:answer"):
        answer = await stream_answer(messages)
    trace("agent", EXPERTS[agent]["name"] + "完成", "已直接生成回答。", agent)
    # Keep the existing UI contract without an additional model-generated report.
    report = dict(agent=agent, status="complete", findings=[answer],
                  recommendations=[], constraints=[], missing=[], sources=unique_sources(sources))
    return answer, report
