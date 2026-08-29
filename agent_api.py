"""OpenAI-compatible LLM adapter for StackPilot.

Only compact analysis evidence is accepted. User supplied credentials are used
for the current request and are never persisted by the server.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import urllib.error
import urllib.request
from urllib.parse import urlparse


DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-5-mini"
MAX_CONTEXT_BYTES = 900_000
DEFAULT_MAX_TOKENS = 4096

AGENT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "summary": {"type": "string"},
        "findings": {
            "type": "array",
            "maxItems": 5,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "severity": {"type": "string", "enum": ["info", "attention", "risk"]},
                    "title": {"type": "string"},
                    "evidence": {"type": "string"},
                    "recommendation": {"type": "string"},
                },
                "required": ["severity", "title", "evidence", "recommendation"],
            },
        },
        "answer": {"type": "string"},
        "limitations": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
    },
    "required": ["summary", "findings", "answer", "limitations"],
}

INSTRUCTIONS = """你是 StackPilot 燃料电池电堆测试分析专家。请根据输入的确定性计算证据进行专业研判与可复核建议。

【严格执行准则】
1. 确定性计算优先：所有数值计算与工况判定以引擎提供的数据为准，仅进行专业解读、多信号关联和行动建议，不编造未给出的参数或结论。
2. 边界合规：缺少目标工况设定表或内阻等信号时，相关符合性明确说明“未判定”；没有明确超差阈值时仅作为“建议复核”。
3. 纯净输出要求（极重要）：
   - 绝对禁止输出任何“思考过程”、“用户需要我做...”、“首先理清要求...”等自我对话、推理链草稿或元说明。
   - 必须直接返回一个合法的 JSON 格式对象，不要在 JSON 前后添加任何多余文字或 Markdown 代码块包裹。
4. 返回 JSON 根结构必须为：
   {
     "summary": "简明综合结论（1-2句，客观专业，禁止第一人称草稿语调）",
     "findings": [
       {
         "severity": "info" | "attention" | "risk",
         "title": "简短发现标题",
         "evidence": "引用的具体数据指标、平台或通道号",
         "recommendation": "可落地的工程复核或改进建议"
       }
     ],
     "answer": "针对用户提问的详细解答与工程分析",
     "limitations": ["分析边界与免责声明1", "声明2"]
   }
"""


def _server_config() -> dict:
    return {
        "baseUrl": os.environ.get("LLM_BASE_URL") or os.environ.get("OPENAI_BASE_URL") or DEFAULT_BASE_URL,
        "apiKey": os.environ.get("LLM_API_KEY") or os.environ.get("OPENAI_API_KEY") or "",
        "model": os.environ.get("LLM_MODEL") or os.environ.get("OPENAI_MODEL") or DEFAULT_MODEL,
    }


def api_status() -> dict:
    config = _server_config()
    return {
        "available": bool(config["apiKey"]),
        "model": config["model"] if config["apiKey"] else None,
        "provider": "OpenAI Compatible API",
        "customConfigSupported": True,
    }


def _validate_endpoint(base_url: str) -> str:
    value = str(base_url or "").strip().rstrip("/")
    if not value or len(value) > 512:
        raise ValueError("AI 接口地址无效")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("AI 接口地址必须是有效的 HTTP(S) 地址")
    local_hosts = {"localhost", "127.0.0.1", "::1"}
    is_local = parsed.hostname in local_hosts
    allow_private = os.environ.get("ALLOW_PRIVATE_LLM", "").lower() in {"1", "true", "yes"}
    private_target = is_local

    if not is_local:
        try:
            for info in socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM):
                if not ipaddress.ip_address(info[4][0]).is_global:
                    private_target = True
        except socket.gaierror as error:
            raise ValueError("无法解析 AI 接口地址") from error

    if private_target and not allow_private:
        raise ValueError("AI 接口地址不能指向内网或保留地址")
    if parsed.scheme == "http" and not private_target:
        raise ValueError("公网 AI 接口必须使用 HTTPS")

    if value.endswith("/chat/completions"):
        return value
    if value.endswith("/v1"):
        return f"{value}/chat/completions"
    return f"{value}/v1/chat/completions"


def _request_config(payload: dict) -> dict:
    server = _server_config()
    supplied = payload.get("llmConfig") if isinstance(payload.get("llmConfig"), dict) else {}
    if supplied:
        api_key = str(supplied.get("apiKey") or "").strip()
        model = str(supplied.get("model") or "").strip()
        base_url = str(supplied.get("baseUrl") or "").strip()
    else:
        api_key = str(server["apiKey"]).strip()
        model = str(server["model"]).strip()
        base_url = str(server["baseUrl"]).strip()
    if not api_key:
        raise RuntimeError("请先配置 AI API Key")
    if not model or len(model) > 160:
        raise ValueError("AI 模型名称无效")
    return {"endpoint": _validate_endpoint(base_url), "apiKey": api_key, "model": model}


def _post_json(endpoint: str, api_key: str, body: dict) -> dict:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            raw = json.loads(error.read().decode("utf-8"))
            detail = raw.get("error", {}).get("message") or raw.get("message") or str(raw)
        except Exception:
            detail = None
        failure = RuntimeError(detail or f"AI 接口返回 HTTP {error.code}")
        failure.status = error.code
        raise failure from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"无法连接 AI 接口：{error.reason}") from error


def _extract_content(response: dict) -> str:
    """从上游响应中提取正文文本，优先提取真实 content，杜绝纯推理过程误替代。"""
    if not isinstance(response, dict):
        return ""
    
    # 1. 尝试标准 choices[0].message
    choices = response.get("choices")
    if isinstance(choices, list) and choices:
        choice = choices[0] if isinstance(choices[0], dict) else {}
        message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
        content = message.get("content")
        
        # 提取 content
        if isinstance(content, str) and content.strip():
            return content
        if isinstance(content, list):
            joined = "".join(str(part.get("text") or part.get("content") or "") for part in content if isinstance(part, dict))
            if joined.strip():
                return joined
        if isinstance(content, dict):
            return json.dumps(content, ensure_ascii=False)
            
        # 兼容 choices[0].text
        if choice.get("text") and str(choice.get("text")).strip():
            return str(choice.get("text"))
            
        # 兼容 delta
        delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
        if delta.get("content"):
            return str(delta.get("content"))

        # 仅在 content 彻底为空时，才回退到 reasoning_content
        reasoning = message.get("reasoning_content") or message.get("reasoning") or choice.get("reasoning_content") or delta.get("reasoning_content")
        if isinstance(reasoning, str) and reasoning.strip():
            return reasoning

    # 2. 兼容顶层 output 或 text 格式
    if response.get("text"):
        return str(response.get("text"))
    if isinstance(response.get("output"), dict):
        out = response["output"]
        if out.get("text"):
            return str(out["text"])
        if isinstance(out.get("choices"), list) and out["choices"]:
            msg = out["choices"][0].get("message") or {}
            if msg.get("content"):
                return str(msg.get("content"))
    if response.get("result"):
        return str(response.get("result"))
    if response.get("content"):
        return str(response.get("content"))

    return ""


def _strip_thinking_process(text: str) -> str:
    """彻底剥离任何形式的 CoT 思考过程、元认知草稿和自言自语前缀。"""
    raw = str(text or "").strip().lstrip("\ufeff")
    if not raw:
        return ""

    # 1. 剥离所有显式思考标签
    cleaned = re.sub(r"<(?:think|thought|thinking|reasoning|scratchpad)\b[^>]*>.*?</(?:think|thought|thinking|reasoning|scratchpad)>", "", raw, flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r"```(?:thought|thinking|reasoning)\b[\s\S]*?```", "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.strip()

    # 2. 剥离单侧未闭合的思考标签 (例如截断时)
    cleaned = re.sub(r"^<(?:think|thought|thinking|reasoning|scratchpad)\b[^>]*>[\s\S]*?(?=(?:```json|\{|$))", "", cleaned, flags=re.IGNORECASE).strip()
    cleaned = re.sub(r"</?(?:think|thought|thinking|reasoning|scratchpad)\b[^>]*>", "", cleaned, flags=re.IGNORECASE).strip()

    # 3. 剥离以“思考过程：”、“Thought:”、“Thinking Process:”等开头的段落
    cleaned = re.sub(r"^(?:思考过程|思维链|分析思路|【思考过程】|【分析思路】|Thought|Thinking Process|Reasoning Process)\s*[:：][\s\S]*?(?=(?:```json|\{\s*\"summary\"|\{\s*\"findings\"|\n\n(?:总结|结论|【分析结论】|分析结果)))", "", cleaned, flags=re.IGNORECASE).strip()

    # 4. 如果文本开头存在明显的自言自语/题目复述，并且后面跟随了 JSON 或结论标记，切除前置思考
    cot_prefix_match = re.search(r"^(?:用户现在需要我|用户希望我|首先(?:我|得|需要)|我需要先|根据(?:给定的|题目|输入)|按照要求(?:生成|输出))[\s\S]*?(?=(```json|\{\s*\"summary\"|\{\s*\"findings\"|```|\n\n(?:总结|结论|【分析结论】|分析报告|一、|1\.)))", cleaned)
    if cot_prefix_match:
        tail = cleaned[cot_prefix_match.end():].strip()
        if tail:
            cleaned = tail

    return cleaned.strip() or raw


def _clean_field_text(text: str) -> str:
    """净化提取后的单个字段文本，去除草稿口吻与思考残留。"""
    s = str(text or "").strip()
    if not s:
        return ""
    # 移除开头的思考标志
    s = re.sub(r"^(?:思考过程|分析思路|注意点|说明|草稿)\s*[:：]\s*", "", s, flags=re.IGNORECASE)
    s = re.sub(r"^(?:我发现|我认为|根据分析|由此可见)\s*[,，]?\s*", "", s)
    return s.strip()


def _find_json_object(text: str) -> dict | None:
    """优先从文本末尾/代码块中寻找最完整、最符合业务 schema 的 JSON 对象。"""
    cleaned = _strip_thinking_process(text)

    # 1. 优先提取 Markdown 代码块中的 JSON (从后往前搜索，因为模型通常在思考之后输出 JSON)
    md_blocks = re.findall(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, flags=re.IGNORECASE)
    for block in reversed(md_blocks):
        try:
            val = json.loads(block.strip())
            if isinstance(val, dict) and any(k in val for k in ("summary", "findings", "answer")):
                return val
        except Exception:
            # 尝试修复截断
            decoder = json.JSONDecoder()
            for patch in ["}", '"}', "}]", '"}]', "}]}", '"}]}', "}]}}", '"}]}}']:
                try:
                    val, _ = decoder.raw_decode(block.strip() + patch)
                    if isinstance(val, dict) and any(k in val for k in ("summary", "findings", "answer")):
                        return val
                except Exception:
                    continue

    # 2. 从后往前遍历所有的 '{' 开始解析，确保抓住最终输出的 JSON 结构
    decoder = json.JSONDecoder()
    candidate_indices = [i for i, char in enumerate(cleaned) if char == "{"]
    
    # 优先从后往前找
    for index in reversed(candidate_indices):
        candidate = cleaned[index:].strip()
        try:
            value, _ = decoder.raw_decode(candidate)
            if isinstance(value, str):
                value = json.loads(value)
            if isinstance(value, dict) and any(k in value for k in ("summary", "findings", "answer")):
                return value
        except (json.JSONDecodeError, TypeError):
            # 尝试各种闭合补丁
            for patch in ["}", '"}', "}]", '"}]', "}]}", '"}]}', "}]}}", '"}]}}', '", "limitations": []}']:
                try:
                    value, _ = decoder.raw_decode(candidate + patch)
                    if isinstance(value, dict) and any(k in value for k in ("summary", "findings", "answer")):
                        return value
                except Exception:
                    continue

    # 3. 正则提取兜底：精准抓取 summary / answer / findings 字段
    summary_match = re.search(r'"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"', cleaned)
    answer_match = re.search(r'"answer"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"', cleaned)
    if summary_match or answer_match:
        findings = []
        for f_match in re.finditer(r'\{[^{}]*?"title"\s*:\s*"([^"]+)"[^{}]*?"evidence"\s*:\s*"([^"]+)"[^{}]*?\}', cleaned):
            findings.append({
                "severity": "attention",
                "title": _clean_field_text(f_match.group(1)),
                "evidence": _clean_field_text(f_match.group(2)),
                "recommendation": "结合工况与历史基线复查",
            })
        return {
            "summary": _clean_field_text(summary_match.group(1).encode().decode("unicode_escape", errors="ignore")) if summary_match else "AI 诊断研判",
            "findings": findings,
            "answer": _clean_field_text(answer_match.group(1).encode().decode("unicode_escape", errors="ignore")) if answer_match else "",
            "limitations": ["由结构化片段自适应恢复。"],
        }

    return None


def _parse_json_result(text: str) -> dict:
    """将 LLM 输出解析为专业、纯净的 Agent 分析报告。"""
    raw_str = str(text or "").strip()
    if not raw_str:
        return {
            "summary": "AI 分析完成（模型未返回可识别正文）",
            "findings": [
                {
                    "severity": "attention",
                    "title": "响应正文为空",
                    "evidence": "当前接入的模型可能未在标准字段输出文本或被上游过滤。",
                    "recommendation": "建议在配置中检查模型名称与 API 额度，或更换为常用通用模型重试。",
                }
            ],
            "answer": "未捕获到模型正文内容。若配置了推理模型，请确保接口已分配足够的 Token 预算。",
            "limitations": ["模型响应正文为空。"],
            "_parseMode": "fallback",
        }

    # 1. 优先尝试提取标准 JSON
    result = _find_json_object(raw_str)
    
    if result is not None:
        raw_findings = result.get("findings") if isinstance(result.get("findings"), list) else []
        findings = []
        for item in raw_findings[:5]:
            if not isinstance(item, dict):
                continue
            severity = item.get("severity") if item.get("severity") in {"info", "attention", "risk"} else "info"
            title = _clean_field_text(str(item.get("title") or "分析发现"))
            evidence = _clean_field_text(str(item.get("evidence") or ""))
            recommendation = _clean_field_text(str(item.get("recommendation") or ""))
            if title or evidence:
                findings.append({
                    "severity": severity,
                    "title": title[:240],
                    "evidence": evidence[:1200],
                    "recommendation": recommendation[:1200],
                })
            
        limitations = result.get("limitations") if isinstance(result.get("limitations"), list) else []
        summary = _clean_field_text(str(result.get("summary") or result.get("answer") or "AI 研判分析已完成"))
        answer = _clean_field_text(str(result.get("answer") or ""))
        
        # 确保 summary 中没有残留自言自语
        if summary.startswith(("用户现在需要", "用户希望", "首先得", "首先我")):
            summary = "本批次电堆测试数据已完成智能研判与风险筛查。"

        return {
            "summary": summary[:2000],
            "findings": findings,
            "answer": answer[:4000],
            "limitations": [_clean_field_text(str(item))[:800] for item in limitations[:5] if str(item).strip()],
            "_parseMode": "json",
        }

    # 2. 如果未能提取到标准 JSON，进行严格的文本降级与思考剥离
    cleaned = _strip_thinking_process(raw_str)
    plain = re.sub(r"^```(?:markdown|text)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE).strip()
    
    # 拆分有效行，过滤思考自白行
    valid_lines = []
    for line in plain.splitlines():
        l = line.strip()
        if not l:
            continue
        # 过滤掉明显的思考自言自语行
        if re.match(r"^(?:用户现在需要|用户希望|首先(?:我|得|先)|我需要先|根据(?:给定的|题目)|按照要求|下面生成|组织JSON)", l):
            continue
        valid_lines.append(l)

    first_line = next((l.lstrip("#*- 0123456789.【】") for l in valid_lines), "AI 诊断研判分析已生成")
    if first_line.startswith(("用户现在需要", "用户希望", "首先")):
        first_line = "燃料电池电堆测试数据综合研判与建议"

    findings = []
    for line in valid_lines[1:10]:
        if line.startswith(("-", "*", "1.", "2.", "3.", "4.", "5.", "•", "【", "平台", "通道", "工况", "质量")):
            cleaned_line = line.lstrip("-*0123456789. •【】")
            if len(cleaned_line) > 5 and not cleaned_line.startswith(("用户", "首先", "我需要")):
                findings.append({
                    "severity": "info",
                    "title": "AI 研判要点",
                    "evidence": cleaned_line[:300],
                    "recommendation": "结合平台确定性数据进行综合复查",
                })
            if len(findings) >= 4:
                break

    filtered_answer = "\n\n".join(valid_lines[:15]) if valid_lines else plain[:2000]

    return {
        "summary": first_line[:240],
        "findings": findings,
        "answer": filtered_answer[:4000],
        "limitations": ["模型返回了非结构化文本，系统已自动剥离思考过程并提取核心结论。"],
        "_parseMode": "text_cleaned",
    }


def analyze(payload: dict) -> dict:
    config = _request_config(payload)
    context = payload.get("context")
    if not isinstance(context, dict):
        raise ValueError("缺少结构化分析上下文")
    context_text = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    if len(context_text.encode("utf-8")) > MAX_CONTEXT_BYTES:
        raise ValueError("分析上下文超过服务端限制")

    question = str(payload.get("question") or "请生成本批次分析摘要。")[:1200]
    scope_hint = str(payload.get("scope") or "").strip()
    scope_prefix = f"【当前聚焦模块：{scope_hint}】\n" if scope_hint else ""
    
    # 构造请求体，优先使用 json_object 保证最大的兼容性
    request_body = {
        "model": config["model"],
        "messages": [
            {"role": "system", "content": INSTRUCTIONS},
            {"role": "user", "content": f"{scope_prefix}分析任务：{question}\n\n分析上下文数据：\n{context_text}"},
        ],
        "temperature": 0.2,
        "max_tokens": DEFAULT_MAX_TOKENS,
        "response_format": {"type": "json_object"},
    }

    raw = None
    try:
        raw = _post_json(config["endpoint"], config["apiKey"], request_body)
    except RuntimeError as error:
        # 如果模型不支持 response_format (常见 400, 422, 500 等错误状态)，降级重试
        status = getattr(error, "status", 0)
        if status in {400, 422, 500, 404} or "response_format" in str(error).lower() or "schema" in str(error).lower():
            request_body.pop("response_format", None)
            raw = _post_json(config["endpoint"], config["apiKey"], request_body)
        else:
            raise

    # 提取内容
    content = _extract_content(raw)
    
    # 如果提取出的内容仍然为空，且先前带有 response_format，尝试无 format 再次重试一次
    if not content.strip() and "response_format" in request_body:
        request_body.pop("response_format", None)
        try:
            raw = _post_json(config["endpoint"], config["apiKey"], request_body)
            content = _extract_content(raw)
        except Exception:
            pass

    result = _parse_json_result(content)
    parse_mode = result.pop("_parseMode", "json")
    result["meta"] = {
        "provider": "OpenAI Compatible API",
        "model": raw.get("model", config["model"]) if isinstance(raw, dict) else config["model"],
        "responseId": raw.get("id") if isinstance(raw, dict) else None,
        "usage": raw.get("usage") if isinstance(raw, dict) else None,
        "parseMode": parse_mode,
    }
    return result
