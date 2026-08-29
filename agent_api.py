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

INSTRUCTIONS = """你是 StackPilot 燃料电池电堆测试分析助手。请解释确定性引擎已经计算出的证据、发现值得复核的模式，并给出可执行的下一步建议。

要求：
1. 只使用输入 JSON 中的证据，不补造原始数据、目标工况、阈值、标准条款或故障结论。
2. 数值计算与平台判定以确定性引擎为准，只负责解释、关联和建议。
3. “均值最低”或“离均差最大”不等于故障；没有阈值时必须说明仅建议复核。
4. 缺少目标工况表、内阻或必要信号时，相关符合性保持“未判定”。
5. 使用简洁、专业的中文；每条发现引用可核验的数值或平台编号。
6. 返回严格 JSON 格式（不要使用 Markdown 包装），根对象字段必须包含：
   - summary: 简明综合结论（字符串）
   - findings: 关键发现列表（数组，每个元素包含 severity ['info'|'attention'|'risk'], title, evidence, recommendation）
   - answer: 详细回答或专业诊断（字符串）
   - limitations: 分析边界与免责说明（字符串数组）
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
    if not isinstance(response, dict):
        return ""
    
    # 1. 尝试标准 choices[0].message
    choices = response.get("choices")
    if isinstance(choices, list) and choices:
        choice = choices[0] if isinstance(choices[0], dict) else {}
        message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
        content = message.get("content")
        
        # 兼容 reasoning_content (如 DeepSeek-R1 / Qwen-QwQ 等推理模型)
        reasoning = message.get("reasoning_content") or message.get("reasoning") or choice.get("reasoning_content")
        
        if isinstance(content, str) and content.strip():
            return content
        if isinstance(content, list):
            joined = "".join(str(part.get("text") or part.get("content") or "") for part in content if isinstance(part, dict))
            if joined.strip():
                return joined
        if isinstance(content, dict):
            return json.dumps(content, ensure_ascii=False)
        
        # 如果 content 为空但有 reasoning 内容，回退到 reasoning
        if isinstance(reasoning, str) and reasoning.strip():
            return reasoning
            
        # 兼容 choices[0].text
        if choice.get("text") and str(choice.get("text")).strip():
            return str(choice.get("text"))
            
        # 兼容 choices[0].delta (流式格式响应)
        delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
        if delta.get("content"):
            return str(delta.get("content"))
        if delta.get("reasoning_content"):
            return str(delta.get("reasoning_content"))

    # 2. 兼容顶层 output 或 text 格式 (如部分中转平台或 DashScope 兼容接口)
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


def _find_json_object(text: str) -> dict | None:
    # 移除 <think> 标签
    cleaned = re.sub(r"<think\b[^>]*>.*?</think>", "", text, flags=re.IGNORECASE | re.DOTALL).strip().lstrip("\ufeff")
    if not cleaned:
        # 如果去掉 think 之后为空，可能整个输出都被包在 think 中，去掉单标签重试
        cleaned = re.sub(r"</?think\b[^>]*>", "", text, flags=re.IGNORECASE).strip()

    # 提取 Markdown 代码块中的内容
    md_blocks = re.findall(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, flags=re.IGNORECASE)
    for block in md_blocks:
        try:
            val = json.loads(block.strip())
            if isinstance(val, dict):
                return val
        except Exception:
            pass

    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)

    # 尝试从每个 '{' 开始解析
    decoder = json.JSONDecoder()
    for index, char in enumerate(cleaned):
        if char == "{":
            candidate = cleaned[index:].strip()
            try:
                value, _ = decoder.raw_decode(candidate)
                if isinstance(value, str):
                    value = json.loads(value)
                if isinstance(value, dict):
                    return value
            except (json.JSONDecodeError, TypeError):
                # 尝试修复截断的 JSON (追加各种常见闭合括号/引号)
                patches = [
                    "}", '"}', "}]", '"}]', "}]}", '"}]}', "}]}}", '"}]}}',
                    '", "recommendation": "建议"}]}',
                    '", "limitations": []}',
                ]
                for patch in patches:
                    try:
                        value, _ = decoder.raw_decode(candidate + patch)
                        if isinstance(value, dict):
                            return value
                    except Exception:
                        continue

    # 正则提取兜底：尝试提取 summary / answer / findings
    summary_match = re.search(r'"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"', cleaned)
    answer_match = re.search(r'"answer"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"', cleaned)
    if summary_match or answer_match:
        findings = []
        for f_match in re.finditer(r'\{[^{}]*?"title"\s*:\s*"([^"]+)"[^{}]*?"evidence"\s*:\s*"([^"]+)"[^{}]*?\}', cleaned):
            findings.append({
                "severity": "attention",
                "title": f_match.group(1),
                "evidence": f_match.group(2),
                "recommendation": "结合工况进一步复查",
            })
        return {
            "summary": summary_match.group(1).encode().decode("unicode_escape", errors="ignore") if summary_match else "AI 分析摘要",
            "findings": findings,
            "answer": answer_match.group(1).encode().decode("unicode_escape", errors="ignore") if answer_match else "",
            "limitations": ["由部分截断数据中恢复。"],
        }

    return None


def _parse_json_result(text: str) -> dict:
    raw_str = str(text or "").strip()
    if not raw_str:
        return {
            "summary": "AI 分析已生成（模型未返回正文）",
            "findings": [
                {
                    "severity": "attention",
                    "title": "模型返回为空或处于纯思考状态",
                    "evidence": "当前接入的模型未在正文字段输出文本，或 Token 预算耗尽于思考过程。",
                    "recommendation": "可尝试更换为标准通用模型（如 GPT-4o、Claude 3.5、Qwen-Max、DeepSeek-V3 等）并重新生成。",
                }
            ],
            "answer": "未捕获到模型正文内容。请检查模型是否为纯推理模型，或增加 Token 配额。",
            "limitations": ["模型响应正文为空。"],
            "_parseMode": "fallback",
        }

    # 优先尝试提取标准 JSON
    result = _find_json_object(raw_str)
    
    if result is None:
        # 如果不是标准 JSON，尝试提取段落文本进行专业降级展示
        cleaned = re.sub(r"<think\b[^>]*>.*?</think>", "", raw_str, flags=re.IGNORECASE | re.DOTALL).strip()
        if not cleaned:
            cleaned = re.sub(r"</?think\b[^>]*>", "", raw_str, flags=re.IGNORECASE).strip()
            
        plain = re.sub(r"^```(?:markdown|text)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE).strip()
        lines = [l.strip() for l in plain.splitlines() if l.strip()]
        first_line = next((l.lstrip("#*- ") for l in lines), "AI 诊断分析已生成")
        
        # 简单提取要点
        findings = []
        for line in lines[1:8]:
            if line.startswith(("-", "*", "1.", "2.", "3.", "4.", "5.", "•", "【")):
                findings.append({
                    "severity": "info",
                    "title": "AI 诊断要点",
                    "evidence": line.lstrip("-*12345. •【】"),
                    "recommendation": "结合平台确定性工况数据进行综合复核",
                })
                if len(findings) >= 4:
                    break

        return {
            "summary": first_line[:240],
            "findings": findings,
            "answer": plain[:4000],
            "limitations": ["模型返回了非结构化格式，已自适应提取关键信息呈现。"],
            "_parseMode": "text",
        }

    raw_findings = result.get("findings") if isinstance(result.get("findings"), list) else []
    findings = []
    for item in raw_findings[:5]:
        if not isinstance(item, dict):
            continue
        severity = item.get("severity") if item.get("severity") in {"info", "attention", "risk"} else "info"
        findings.append({
            "severity": severity,
            "title": str(item.get("title") or "分析发现")[:240],
            "evidence": str(item.get("evidence") or "")[:1200],
            "recommendation": str(item.get("recommendation") or "")[:1200],
        })
        
    limitations = result.get("limitations") if isinstance(result.get("limitations"), list) else []
    fallback_summary = result.get("answer") or result.get("content") or result.get("message") or "分析已完成"
    return {
        "summary": str(result.get("summary") or fallback_summary)[:2000],
        "findings": findings,
        "answer": str(result.get("answer") or result.get("content") or "")[:4000],
        "limitations": [str(item)[:800] for item in limitations[:5]],
        "_parseMode": "json",
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
    
    # 构造请求体，优先使用 json_object 保证最大的兼容性
    request_body = {
        "model": config["model"],
        "messages": [
            {"role": "system", "content": INSTRUCTIONS},
            {"role": "user", "content": f"分析任务：{question}\n\n分析上下文：\n{context_text}"},
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
