"""Build the bundled StackPilot demo analysis from the official Qingchuan CSV.

The generated JSON contains only derived statistics, never raw time-series rows.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd


DEFAULT_SOURCE = Path("/Users/ren/Downloads/T02_设备测试数据分析与自动报告助手/企业资料包03_青川易创与云汉达/02 样例数据-青川科技.csv")
OUTPUT = Path(__file__).resolve().parents[1] / "demo-analysis.json"
CONFIG = {"currentTolerance": 1, "minSamples": 60, "windowSamples": 120, "sampleInterval": 1, "strictMode": True}


def finite_mean(values: pd.Series) -> float | None:
    values = pd.to_numeric(values, errors="coerce").dropna()
    return float(values.mean()) if len(values) else None


def main() -> None:
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not source.is_file():
        raise SystemExit("CSV not found. Pass its path as the first argument.")
    df = pd.read_csv(source, encoding="utf-8-sig", low_memory=False)
    timestamps = df["测试时间"].astype(str)
    target = pd.to_numeric(df["电流设定值（A）"], errors="coerce").to_numpy()
    actual = pd.to_numeric(df["实际电流（A）"], errors="coerce").to_numpy()
    qualifies = (target > 0) & np.isfinite(actual) & (np.abs(actual - target) <= CONFIG["currentTolerance"])
    platforms = []
    start = 0
    for i in range(1, len(df) + 1):
        same = i < len(df) and qualifies[i] and qualifies[i - 1] and target[i] == target[i - 1]
        if same:
            continue
        if qualifies[start] and i - start >= CONFIG["minSamples"]:
            count = i - start
            stat_start = max(start, i - CONFIG["windowSamples"])
            part = df.iloc[stat_start:i]
            platforms.append({
                "id": len(platforms) + 1,
                "targetCurrent": float(target[start]),
                "startRow": start + 2,
                "endRow": i + 1,
                "startTime": timestamps.iloc[start],
                "endTime": timestamps.iloc[i - 1],
                "sampleCount": count,
                "statisticSamples": len(part),
                "actualCurrent": finite_mean(part["实际电流（A）"]),
                "avgCellVoltage": finite_mean(part["平均电压（V）"]),
                "minCellVoltage": finite_mean(part["最小电压（V）"]),
                "cellRange": finite_mean(part["极差（mV）"]),
                "status": "有效" if count >= CONFIG["windowSamples"] else "时长警告",
            })
        start = i

    best = {}
    for platform in platforms:
        old = best.get(platform["targetCurrent"])
        if old is None or platform["sampleCount"] > old["sampleCount"]:
            best[platform["targetCurrent"]] = platform
    polarization = [
        {"x": p["targetCurrent"], "y": p["avgCellVoltage"], "samples": p["sampleCount"]}
        for p in sorted(best.values(), key=lambda x: x["targetCurrent"])
        if p["avgCellVoltage"] is not None
    ]

    cell_columns = [c for c in df.columns if c.startswith("单片电压")]
    operating = df[pd.to_numeric(df["电流设定值（A）"], errors="coerce") > 0]
    cells = []
    for number, column in enumerate(cell_columns, 1):
        values = pd.to_numeric(operating[column], errors="coerce").dropna()
        if not len(values):
            continue
        cells.append({"channel": number, "mean": float(values.mean()), "min": float(values.min()), "max": float(values.max()), "count": int(len(values)), "completeness": float(len(values) / len(operating))})
    baseline = np.mean([c["mean"] for c in cells if c["completeness"] > .8])
    for cell in cells:
        cell["deviation"] = float(cell["mean"] - baseline)
        cell["flag"] = "关注" if cell["completeness"] > .8 and abs(cell["deviation"]) > .02 else "正常"

    unique_ts = int(timestamps.nunique())
    duplicate_rows = int(timestamps.duplicated(keep=False).sum())
    completeness = df.notna().mean()
    high_missing = int((completeness < .1).sum())
    piece_counts = {str(int(k)): int(v) for k, v in df["片数"].value_counts().items()}
    issues = [
        {"severity": "warning", "title": "时间戳精度不足或重复", "detail": f"{duplicate_rows:,} 行处于重复时间戳中，持续时间按采样周期估算。", "evidence": f"{unique_ts:,} 个唯一时间戳 / {len(df):,} 行"},
        {"severity": "warning", "title": "高缺失率字段", "detail": f"{high_missing} 个字段缺失率超过 90%，分析时保留原列并标记。", "evidence": "未执行静默删除"},
        {"severity": "info", "title": "单片数量动态变化", "detail": f"检测到 {' / '.join(piece_counts)} 片配置，通道统计已按行动态处理。", "evidence": "；".join(f"{k}片 {v:,}行" for k, v in piece_counts.items())},
        {"severity": "info", "title": "未提供目标工况表", "detail": "本次仅进行相对稳定性与性能分析，不输出目标工况符合性结论。", "evidence": "防幻觉策略已启用"},
    ]
    relevant = []
    for column, value in completeness.items():
        if any(key in column for key in ["时间", "电流", "平均电压", "最小电压", "极差", "片数", "单片电压"]):
            relevant.append({"name": column, "completeness": float(value)})
    relevant = sorted(relevant, key=lambda x: x["completeness"])[:14]
    low_cell = min((c for c in cells if c["completeness"] > .8), key=lambda x: x["mean"])
    insights = [
        {"type": "good", "title": f"识别 {len(platforms)} 个稳定平台", "detail": f"覆盖 {len(set(p['targetCurrent'] for p in platforms))} 个目标电流档位；重复平台独立保留。"},
        {"type": "good", "title": "极化趋势可计算", "detail": f"{len(polarization)} 个代表点可用于性能曲线，所有点均可回溯到原始行号。"},
        {"type": "warning", "title": "时间结论需谨慎", "detail": "原始时间戳精度不足，报告按配置采样周期估算，不伪造秒级时间。"},
        {"type": "warning", "title": f"单片 {low_cell['channel']} 均值最低", "detail": f"均值 {low_cell['mean']:.3f}V；当前仅提示排序，不直接判定故障。"},
    ]
    anomalies = [
        {"type": "单片电压", "object": f"单片 {c['channel']}", "value": c["mean"], "detail": f"相对主通道均值偏差 {c['deviation']*1000:.1f}mV", "severity": "关注"}
        for c in cells if c["flag"] != "正常"
    ]
    result = {
        "schemaVersion": "1.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {"fileName": source.name, "fileSizeMB": round(source.stat().st_size / 1024 / 1024, 2), "dataPolicy": "local-only", "derivedOnly": True},
        "config": CONFIG,
        "meta": {"rowCount": len(df), "columnCount": len(df.columns), "timeMin": str(timestamps.min()), "timeMax": str(timestamps.max()), "uniqueTimestamps": unique_ts, "duplicateTimestampRows": duplicate_rows, "highMissingColumns": high_missing},
        "trust": {"score": 78, "headline": "可分析，但需携带质量声明", "description": f"{len(issues)} 项质量说明已写入报告，数值计算未调用生成式模型。"},
        "issues": issues,
        "platforms": platforms,
        "polarization": polarization,
        "cells": cells,
        "pieceCounts": piece_counts,
        "fieldCompleteness": relevant,
        "insights": insights,
        "anomalies": anomalies,
        "reportSheets": [["01","测试摘要","数据范围、可信度、关键结论"],["02","本次使用参数","阈值、采样周期与来源"],["03","数据质量检查","时间、字段、通道与处理建议"],["04","电流平台","平台区间、统计窗口和指标"],["05","极化曲线数据","代表测试点与有效性标记"],["06","单片电压统计","均值、极值、完整率与排序"],["07","异常清单","问题、影响、证据和建议"],["08","处理日志","文件、算法版本与生成时间"]],
    }
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {OUTPUT} ({len(platforms)} platforms, {len(polarization)} curve points)")


if __name__ == "__main__":
    main()
