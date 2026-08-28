"""Build the audited StackPilot reference analysis from the Qingchuan dataset.

The generated JSON contains derived statistics and traceability metadata only.
Raw time-series rows remain in the enterprise material package.
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SOURCE = ROOT / "企业资料包03_青川易创与云汉达" / "02 样例数据-青川科技.csv"
OUTPUT = Path(__file__).resolve().parents[1] / "reference-analysis.json"
ENGINE_VERSION = "2.0.0"
PARAMETER_TEMPLATE_VERSION = "QC-T02-V1.0"
CONFIG = {
    "currentTolerance": 1,
    "minSamples": 60,
    "windowSamples": 120,
    "sampleInterval": 1,
    "pressureTolerance": 1,
    "temperatureTolerance": 1,
    "dewpointTolerance": 1,
    "strictMode": True,
    "repeatedCurrentPolicy": "分别统计",
    "curveSelectionPolicy": "同电流取持续时间最长的平台",
    "pressureStandard": "表压",
    "pressureUnit": "kPa.g",
    "humidityStandard": "露点温度",
}


FIELD_MAPPING = [
    ("目标电流", "电流设定值（A）", "A", "A", "direct"),
    ("实测电流", "实际电流（A）", "A", "A", "direct"),
    ("目标电流密度", "电流密度设定值（mA/cm2）", "mA/cm²", "A/cm²", "scale_0.001"),
    ("实测电流密度", "电流密度（mA/cm2）", "mA/cm²", "A/cm²", "scale_0.001"),
    ("氢气计量比", "实际电流（A） + 阳极流量（SLPM） + 片数", "-", "-", "derived"),
    ("目标氢气流量", "阳极流量设定值（SLPM）", "SLPM", "SLPM", "direct"),
    ("实际氢气流量", "阳极流量（SLPM）", "SLPM", "SLPM", "direct"),
    ("目标氢气入口压力", "阳极入堆压力设定值（kPa）", "kPa", "kPa.g", "direct"),
    ("实际氢气入口压力", "阳极入堆压力（kPa）", "kPa", "kPa.g", "direct"),
    ("目标氢气入口温度", "阳极入堆温度设定值（℃）", "℃", "℃", "direct"),
    ("实际氢气入口温度", "阳极入堆温度（℃）", "℃", "℃", "direct"),
    ("目标氢气入口露点温度", "阳极增湿罐水温度设定值（℃）", "℃", "℃", "direct"),
    ("实际氢气入口露点温度", "阳极增湿罐水温度（℃）", "℃", "℃", "direct"),
    ("实际氢气出口压力", "阳极出堆压力（kPa）", "kPa", "kPa.g", "direct"),
    ("氢气出口温度", "阳极出堆温度（℃）", "℃", "℃", "direct"),
    ("空气计量比", "实际电流（A） + 阴极流量（SLPM） + 片数", "-", "-", "derived"),
    ("目标空气流量", "阴极流量设定值（SLPM）", "SLPM", "SLPM", "direct"),
    ("实际空气流量", "阴极流量（SLPM）", "SLPM", "SLPM", "direct"),
    ("目标空气入口压力", "阴极入堆压力设定值（kPa）", "kPa", "kPa.g", "direct"),
    ("实际空气入口压力", "阴极入堆压力（kPa）", "kPa", "kPa.g", "direct"),
    ("目标空气入口温度", "阴极入堆温度设定值（℃）", "℃", "℃", "direct"),
    ("实际空气入口温度", "阴极入堆温度（℃）", "℃", "℃", "direct"),
    ("目标空气入口露点温度", "阴极增湿罐水温度设定值（℃）", "℃", "℃", "direct"),
    ("实际空气入口露点温度", "阴极增湿罐水温度（℃）", "℃", "℃", "direct"),
    ("实际空气出口压力", "阴极出堆压力（kPa）", "kPa", "kPa.g", "direct"),
    ("空气出口温度", "阴极出堆温度（℃）", "℃", "℃", "direct"),
    ("目标冷却液入口温度", "循环水入堆温度设定值（℃）", "℃", "℃", "direct"),
    ("实际冷却液入口温度", "循环水入堆温度（℃）", "℃", "℃", "direct"),
    ("实际冷却液出口温度", "循环水出堆温度（℃）", "℃", "℃", "direct"),
    ("冷却液温差", "循环水出堆温度（℃） - 循环水入堆温度（℃）", "℃", "℃", "derived"),
    ("冷却液入口压力", "循环水入堆压力（kPa）", "kPa", "kPa.g", "direct"),
    ("冷却液流量", "循环水流量（L/min）", "L/min", "L/min", "direct"),
    ("冷却液出口压力", "循环水出堆压力（kPa）", "kPa", "kPa.g", "direct"),
    ("冷却液流阻", "循环水入堆压力（kPa） - 循环水出堆压力（kPa）", "kPa", "kPa", "derived"),
    ("电堆总电压", "总电压（V）", "V", "V", "direct"),
    ("平均电压", "平均电压（V）", "V", "V", "direct"),
    ("最大电压", "最大电压（V）", "V", "V", "direct"),
    ("最小电压", "最小电压（V）", "V", "V", "direct"),
    ("电压极差", "极差（mV）", "mV", "mV", "direct"),
    ("电压离均差", "离均差（mV）", "mV", "mV", "direct"),
    ("电压标准差", "标准差（mV）", "mV", "mV", "direct"),
    ("电堆片数", "片数", "片", "片", "direct"),
    ("单片电压", "单片电压1（V）…单片电压40（V）", "V", "V", "array"),
    ("内阻", "", "", "mΩ", "missing"),
]


CONDITION_FIELDS = {
    "actualCurrent": ("实际电流（A）", "A"),
    "currentDensity": ("电流密度（mA/cm2）", "mA/cm²"),
    "stackVoltage": ("总电压（V）", "V"),
    "power": ("功率（kW)", "kW"),
    "avgCellVoltage": ("平均电压（V）", "V"),
    "minCellVoltage": ("最小电压（V）", "V"),
    "maxCellVoltage": ("最大电压（V）", "V"),
    "cellRange": ("极差（mV）", "mV"),
    "cellStd": ("标准差（mV）", "mV"),
    "h2Flow": ("阳极流量（SLPM）", "SLPM"),
    "h2InPressure": ("阳极入堆压力（kPa）", "kPa.g"),
    "h2OutPressure": ("阳极出堆压力（kPa）", "kPa.g"),
    "h2InTemperature": ("阳极入堆温度（℃）", "℃"),
    "h2Dewpoint": ("阳极增湿罐水温度（℃）", "℃"),
    "airFlow": ("阴极流量（SLPM）", "SLPM"),
    "airInPressure": ("阴极入堆压力（kPa）", "kPa.g"),
    "airOutPressure": ("阴极出堆压力（kPa）", "kPa.g"),
    "airInTemperature": ("阴极入堆温度（℃）", "℃"),
    "airDewpoint": ("阴极增湿罐水温度（℃）", "℃"),
    "coolantInTemperature": ("循环水入堆温度（℃）", "℃"),
    "coolantOutTemperature": ("循环水出堆温度（℃）", "℃"),
    "coolantFlow": ("循环水流量（L/min）", "L/min"),
    "coolantInPressure": ("循环水入堆压力（kPa）", "kPa.g"),
    "coolantOutPressure": ("循环水出堆压力（kPa）", "kPa.g"),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def numeric(df: pd.DataFrame, column: str) -> pd.Series:
    if column not in df:
        return pd.Series(np.nan, index=df.index, dtype=float)
    return pd.to_numeric(df[column], errors="coerce")


def stats(series: pd.Series) -> dict:
    clean = pd.to_numeric(series, errors="coerce").dropna()
    if not len(clean):
        return {"mean": None, "min": None, "max": None, "std": None, "count": 0}
    return {
        "mean": float(clean.mean()),
        "min": float(clean.min()),
        "max": float(clean.max()),
        "std": float(clean.std(ddof=0)),
        "count": int(len(clean)),
    }


def build_field_mappings(df: pd.DataFrame) -> list[dict]:
    mappings = []
    cell_columns = [c for c in df.columns if c.startswith("单片电压")]
    active_cells = [c for c in cell_columns if df[c].notna().any()]
    for standard, source, source_unit, output_unit, method in FIELD_MAPPING:
        if method == "missing":
            status, completeness, conversion = "缺失", 0.0, "未提供"
        elif method == "derived":
            status, completeness, conversion = "可计算", 1.0, "按任务说明书公式"
        elif method == "array":
            status = "已映射"
            completeness = float(df[active_cells].notna().any(axis=1).mean()) if active_cells else 0.0
            conversion = f"动态识别 {len(active_cells)} 个有效通道"
        else:
            status = "已映射" if source in df.columns else "缺失"
            completeness = float(df[source].notna().mean()) if source in df.columns else 0.0
            conversion = "×0.001" if method == "scale_0.001" else "原值"
        mappings.append({
            "standardField": standard,
            "sourceField": source or "—",
            "sourceUnit": source_unit or "—",
            "outputUnit": output_unit,
            "conversion": conversion,
            "status": status,
            "completeness": completeness,
        })
    return mappings


def build_platforms(df: pd.DataFrame) -> list[dict]:
    target = numeric(df, "电流设定值（A）").to_numpy()
    actual = numeric(df, "实际电流（A）").to_numpy()
    timestamps = df["测试时间"].astype(str).to_numpy()
    qualifies = (target > 0) & np.isfinite(actual) & (np.abs(actual - target) <= CONFIG["currentTolerance"])
    platforms = []
    i = 0
    while i < len(df):
        if not qualifies[i]:
            i += 1
            continue
        start = i
        target_current = float(target[i])
        i += 1
        while i < len(df) and qualifies[i] and target[i] == target_current:
            i += 1
        count = i - start
        if count < CONFIG["minSamples"]:
            continue
        stat_start = max(start, i - CONFIG["windowSamples"])
        part = df.iloc[stat_start:i].copy()
        metric_stats = {key: stats(part[column]) for key, (column, _) in CONDITION_FIELDS.items()}
        metric_stats["h2Resistance"] = stats(numeric(part, "阳极入堆压力（kPa）") - numeric(part, "阳极出堆压力（kPa）"))
        metric_stats["airResistance"] = stats(numeric(part, "阴极入堆压力（kPa）") - numeric(part, "阴极出堆压力（kPa）"))
        metric_stats["coolantResistance"] = stats(numeric(part, "循环水入堆压力（kPa）") - numeric(part, "循环水出堆压力（kPa）"))
        metric_stats["coolantDeltaTemperature"] = stats(numeric(part, "循环水出堆温度（℃）") - numeric(part, "循环水入堆温度（℃）"))
        current = numeric(part, "实际电流（A）")
        pieces = numeric(part, "片数")
        theoretical_h2 = current * pieces * 22.414 * 60 / (2 * 96485.33212)
        theoretical_air = current * pieces * 22.414 * 60 / (4 * 96485.33212 * 0.2095)
        metric_stats["h2Stoich"] = stats(numeric(part, "阳极流量（SLPM）") / theoretical_h2.replace(0, np.nan))
        metric_stats["airStoich"] = stats(numeric(part, "阴极流量（SLPM）") / theoretical_air.replace(0, np.nan))
        stability_rules = {
            "h2InPressure": CONFIG["pressureTolerance"] * 2,
            "airInPressure": CONFIG["pressureTolerance"] * 2,
            "coolantInPressure": CONFIG["pressureTolerance"] * 2,
            "h2InTemperature": CONFIG["temperatureTolerance"] * 2,
            "h2Dewpoint": CONFIG["dewpointTolerance"] * 2,
            "airInTemperature": CONFIG["temperatureTolerance"] * 2,
            "airDewpoint": CONFIG["dewpointTolerance"] * 2,
            "coolantInTemperature": CONFIG["temperatureTolerance"] * 2,
        }
        stability_checks = {
            key: metric_stats[key]["count"] == len(part)
            and metric_stats[key]["max"] - metric_stats[key]["min"] <= allowed_span
            for key, allowed_span in stability_rules.items()
        }
        relative_stable = all(stability_checks.values())
        if relative_stable and count >= CONFIG["windowSamples"]:
            point_status = "正式点"
        elif relative_stable:
            point_status = "观察点"
        else:
            point_status = "工况复核"
        platforms.append({
            "id": len(platforms) + 1,
            "targetCurrent": target_current,
            "startRow": start + 2,
            "endRow": i + 1,
            "startTime": timestamps[start],
            "endTime": timestamps[i - 1],
            "sampleCount": count,
            "durationSeconds": count * CONFIG["sampleInterval"],
            "statisticSamples": len(part),
            "statisticStartRow": stat_start + 2,
            "actualCurrent": metric_stats["actualCurrent"]["mean"],
            "currentDensity": (metric_stats["currentDensity"]["mean"] or 0) / 1000,
            "avgCellVoltage": metric_stats["avgCellVoltage"]["mean"],
            "minCellVoltage": metric_stats["minCellVoltage"]["mean"],
            "cellRange": metric_stats["cellRange"]["mean"],
            "cellStd": metric_stats["cellStd"]["mean"],
            "stackVoltage": metric_stats["stackVoltage"]["mean"],
            "power": metric_stats["power"]["mean"],
            "status": point_status,
            "stabilityStatus": "相对稳定" if relative_stable else "工况波动待复核",
            "stabilityEvidence": {
                "passed": sum(stability_checks.values()),
                "total": len(stability_checks),
                "checks": stability_checks,
            },
            "complianceStatus": "未判定",
            "metrics": metric_stats,
        })
    occurrences: dict[float, int] = {}
    for platform in platforms:
        current = platform["targetCurrent"]
        occurrences[current] = occurrences.get(current, 0) + 1
        platform["occurrence"] = occurrences[current]
        platform["label"] = f"{current:g}A-{occurrences[current]}"
    return platforms


def build_cells(df: pd.DataFrame) -> list[dict]:
    piece_count = numeric(df, "片数")
    target = numeric(df, "电流设定值（A）")
    cell_columns = [c for c in df.columns if c.startswith("单片电压") and df[c].notna().any()]
    operating = target > 0
    cell_frame = df[cell_columns].apply(pd.to_numeric, errors="coerce")
    row_mean = cell_frame.mean(axis=1)
    cells = []
    for channel, column in enumerate(cell_columns, 1):
        eligible = operating & (piece_count >= channel)
        values = cell_frame.loc[eligible, column].dropna()
        deviations = (cell_frame.loc[eligible, column] - row_mean.loc[eligible]).dropna()
        if not len(values):
            continue
        cells.append({
            "channel": channel,
            "mean": float(values.mean()),
            "min": float(values.min()),
            "max": float(values.max()),
            "std": float(values.std(ddof=0)),
            "count": int(len(values)),
            "eligibleRows": int(eligible.sum()),
            "completeness": float(len(values) / max(1, eligible.sum())),
            "deviation": float(deviations.mean()) if len(deviations) else 0.0,
            "flag": "仅排序",
        })
    for rank, cell in enumerate(sorted(cells, key=lambda item: item["deviation"]), 1):
        cell["rank"] = rank
    return cells


def main() -> None:
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not source.is_file():
        raise SystemExit("CSV not found. Pass its path as the first argument.")
    df = pd.read_csv(source, encoding="utf-8-sig", low_memory=False)
    timestamps = df["测试时间"].astype(str)
    parsed_time = pd.to_datetime(timestamps, errors="coerce")
    fingerprint = sha256(source)
    mappings = build_field_mappings(df)
    platforms = build_platforms(df)
    cells = build_cells(df)
    piece_counts = {str(int(k)): int(v) for k, v in numeric(df, "片数").value_counts().sort_index().items()}
    direct_count = sum(m["status"] == "已映射" for m in mappings)
    derived_count = sum(m["status"] == "可计算" for m in mappings)
    missing_count = sum(m["status"] == "缺失" for m in mappings)
    all_cell_columns = [c for c in df.columns if c.startswith("单片电压")]
    active_cell_columns = [c for c in all_cell_columns if df[c].notna().any()]
    reserved_cell_columns = len(all_cell_columns) - len(active_cell_columns)
    duplicate_rows = int(timestamps.duplicated(keep=False).sum())
    reversed_rows = int((parsed_time.diff().dt.total_seconds() < 0).sum())

    issues = [
        {
            "severity": "warning",
            "category": "时间质量",
            "title": "源时间戳仅保留到分钟",
            "detail": "同一分钟内包含多条采样记录，秒级持续时间按参数模板中的 1 s 采样周期换算。",
            "evidence": f"{timestamps.nunique():,} 个分钟时间戳 / {len(df):,} 行；倒序 {reversed_rows} 行",
            "action": "报告保留样本数、换算持续时间和原始行号。",
        },
        {
            "severity": "info",
            "category": "结构校核",
            "title": "电堆片数随测试阶段变化",
            "detail": f"检测到 {' / '.join(piece_counts)} 片配置，单片完整率按每行实际片数计算。",
            "evidence": "；".join(f"{k}片 {v:,}行" for k, v in piece_counts.items()),
            "action": "不将第 9 片在 8 片阶段的空值计为缺失。",
        },
        {
            "severity": "info",
            "category": "字段完整性",
            "title": "预留单片通道未启用",
            "detail": f"原始表保留 40 个单片列，其中 {len(active_cell_columns)} 个通道存在有效值。",
            "evidence": f"{reserved_cell_columns} 个预留通道全空",
            "action": "仅分析存在值且符合实际片数的通道。",
        },
        {
            "severity": "warning",
            "category": "目标工况",
            "title": "未提供独立目标工况设定表",
            "detail": "本批次输出相对稳定性和实际工况统计，不作目标工况符合性结论。",
            "evidence": "符合任务说明书 9.2、12.2 的无设定表处理规则",
            "action": "导入目标工况设定后可启用符合性判定。",
        },
        {
            "severity": "warning",
            "category": "字段完整性",
            "title": "内阻信号未提供",
            "detail": "本批次无法输出内阻统计及内阻-电流密度曲线。",
            "evidence": "标准字段 44：内阻 = 缺失",
            "action": "其余电性能与工况统计继续执行。",
        },
    ]

    best_by_current: dict[float, dict] = {}
    for platform in platforms:
        old = best_by_current.get(platform["targetCurrent"])
        if old is None or platform["sampleCount"] > old["sampleCount"]:
            best_by_current[platform["targetCurrent"]] = platform
    polarization = [
        {
            "x": p["currentDensity"],
            "current": p["actualCurrent"],
            "targetCurrent": p["targetCurrent"],
            "y": p["avgCellVoltage"],
            "minCellVoltage": p["minCellVoltage"],
            "cellStd": p["cellStd"],
            "samples": p["sampleCount"],
            "platformId": p["id"],
            "status": p["status"],
        }
        for p in sorted(best_by_current.values(), key=lambda item: item["targetCurrent"])
        if p["avgCellVoltage"] is not None
    ]
    formal_points = sum(p["status"] == "正式点" for p in polarization)
    repeats = len(platforms) - len(best_by_current)
    field_completeness = [
        {"name": col, "completeness": float(df[col].notna().mean())}
        for col in [
            "测试时间", "实际电流（A）", "电流密度（mA/cm2）", "总电压（V）", "平均电压（V）",
            "阳极入堆压力（kPa）", "阳极入堆温度（℃）", "阳极流量（SLPM）",
            "阴极入堆压力（kPa）", "阴极入堆温度（℃）", "阴极流量（SLPM）",
            "循环水入堆温度（℃）", "循环水流量（L/min）", "片数",
        ]
    ]
    conditions = []
    for p in platforms:
        metrics = p["metrics"]
        conditions.append({
            "platformId": p["id"], "label": p["label"], "targetCurrent": p["targetCurrent"],
            "actualCurrent": p["actualCurrent"], "currentDensity": p["currentDensity"],
            "h2Flow": metrics["h2Flow"]["mean"], "h2Pressure": metrics["h2InPressure"]["mean"],
            "h2Stoich": metrics["h2Stoich"]["mean"],
            "h2Temperature": metrics["h2InTemperature"]["mean"], "h2Dewpoint": metrics["h2Dewpoint"]["mean"],
            "airFlow": metrics["airFlow"]["mean"], "airPressure": metrics["airInPressure"]["mean"],
            "airStoich": metrics["airStoich"]["mean"],
            "airTemperature": metrics["airInTemperature"]["mean"], "airDewpoint": metrics["airDewpoint"]["mean"],
            "coolantFlow": metrics["coolantFlow"]["mean"], "coolantInTemperature": metrics["coolantInTemperature"]["mean"],
            "coolantDeltaTemperature": metrics["coolantDeltaTemperature"]["mean"],
            "h2Resistance": metrics["h2Resistance"]["mean"], "airResistance": metrics["airResistance"]["mean"],
            "coolantResistance": metrics["coolantResistance"]["mean"], "complianceStatus": "未判定",
        })

    generated_at = datetime.now(timezone.utc).isoformat()
    audit_log = [
        {"time": generated_at, "stage": "文件校验", "detail": f"SHA-256 {fingerprint}", "status": "完成"},
        {"time": generated_at, "stage": "字段映射", "detail": f"直接映射 {direct_count}，派生 {derived_count}，缺失 {missing_count}", "status": "完成"},
        {"time": generated_at, "stage": "质量闸门", "detail": f"错误 0，警告 {sum(i['severity']=='warning' for i in issues)}，说明 {sum(i['severity']=='info' for i in issues)}", "status": "有条件通过"},
        {"time": generated_at, "stage": "平台识别", "detail": f"识别 {len(platforms)} 个平台，保留 {repeats} 个重复电流点", "status": "完成"},
        {"time": generated_at, "stage": "统计截取", "detail": "按平台末端最多 120 个样本统计", "status": "完成"},
        {"time": generated_at, "stage": "报告快照", "detail": f"StackPilot Engine {ENGINE_VERSION}", "status": "已固化"},
    ]
    result = {
        "schemaVersion": "2.0",
        "engineVersion": ENGINE_VERSION,
        "parameterTemplateVersion": PARAMETER_TEMPLATE_VERSION,
        "generatedAt": generated_at,
        "dataset": {
            "id": "QC-FC-20260623-01",
            "name": "青川科技 · 电堆极化测试批次",
            "organization": "北京青川易创科技有限公司",
            "sourceType": "企业资料包原始时序数据",
            "reviewStatus": "已校验",
        },
        "source": {
            "fileName": source.name,
            "fileSizeBytes": source.stat().st_size,
            "fileSizeMB": round(source.stat().st_size / 1024 / 1024, 2),
            "sha256": fingerprint,
            "dataPolicy": "derived-statistics-only",
            "derivedOnly": True,
        },
        "config": CONFIG,
        "meta": {
            "rowCount": int(len(df)), "columnCount": int(len(df.columns)),
            "timeMin": parsed_time.min().isoformat(), "timeMax": parsed_time.max().isoformat(),
            "uniqueTimestamps": int(timestamps.nunique()), "duplicateTimestampRows": duplicate_rows,
            "timestampResolutionSeconds": 60, "sampleIntervalSeconds": CONFIG["sampleInterval"],
            "activeCellChannels": len(active_cell_columns), "reservedCellChannels": reserved_cell_columns,
            "fieldMapping": {"direct": direct_count, "derived": derived_count, "missing": missing_count, "total": len(mappings)},
        },
        "qualityGate": {
            "status": "有条件通过", "code": "CONDITIONAL_PASS", "errors": 0,
            "warnings": sum(i["severity"] == "warning" for i in issues),
            "notices": sum(i["severity"] == "info" for i in issues),
            "headline": "数据可用于性能与实际工况分析",
            "description": "目标工况表与内阻信号缺失，相关结论已降级为“未判定”，未补造任何数值。",
        },
        "trust": {"score": None, "headline": "数据可用于性能与实际工况分析", "description": "质量限制与处理依据已写入报告。"},
        "issues": issues,
        "platforms": platforms,
        "polarization": polarization,
        "conditions": conditions,
        "cells": cells,
        "pieceCounts": piece_counts,
        "fieldMappings": mappings,
        "fieldCompleteness": field_completeness,
        "insights": [
            {"type": "good", "title": f"{len(platforms)} 个电流平台全部保留", "detail": f"覆盖 {len(best_by_current)} 个目标电流档位，{repeats} 个重复点未被合并。"},
            {"type": "good", "title": f"{formal_points} 个正式极化点", "detail": f"代表曲线共 {len(polarization)} 个电流档位；每一点均关联平台编号和原始行号。"},
            {"type": "good", "title": f"{direct_count + derived_count}/{len(mappings)} 个标准字段可用", "detail": f"其中 {derived_count} 个字段按任务说明书公式派生，{missing_count} 个字段明确标记缺失。"},
            {"type": "warning", "title": "目标符合性未判定", "detail": "未提供独立目标工况设定表；系统仅输出相对稳定性和实际工况，不推断原测试目标。"},
        ],
        "anomalies": [
            {"type": i["category"], "object": i["title"], "value": i["evidence"], "detail": i["action"], "severity": "警告" if i["severity"] == "warning" else "说明"}
            for i in issues
        ],
        "auditLog": audit_log,
        "reportSheets": [
            ["01", "测试信息", "批次、数据范围、校验值与版本"],
            ["02", "本次使用参数", "生效阈值、规则及参数来源"],
            ["03", "目标工况设定", "输入状态与符合性判定边界"],
            ["04", "字段映射", "标准字段、原始字段、单位及换算"],
            ["05", "数据质量检查", "问题、证据、影响与处理动作"],
            ["06", "电流平台", "重复点、区间、时长与原始行号"],
            ["07", "稳定区间", "统计窗口、相对稳定性与有效性"],
            ["08", "极化曲线数据", "电流密度、电压与平台引用"],
            ["09", "实际工况汇总", "阳极、阴极与冷却回路统计"],
            ["10", "目标工况对比", "未提供设定表时明确标记未判定"],
            ["11", "单片电压统计", "动态片数、完整率、离散度与排序"],
            ["12", "异常清单", "质量问题、工况限制与建议"],
            ["13", "图表", "极化曲线及引用数据"],
            ["14", "处理日志", "校验、映射、识别与版本追踪"],
        ],
    }
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {OUTPUT} ({len(df):,} rows, {len(platforms)} platforms, {len(polarization)} curve points)")


if __name__ == "__main__":
    main()
