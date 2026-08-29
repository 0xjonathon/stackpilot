const DEFAULT_CONFIG = {
  currentTolerance: 1,
  minSamples: 60,
  windowSamples: 120,
  sampleInterval: 1,
  pressureTolerance: 1,
  temperatureTolerance: 1,
  dewpointTolerance: 1,
  strictMode: true,
  knowledgeTemplate: "enterprise-t02",
  fieldMappings: {}
};

const DEFAULT_LLM_CONFIG = { baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini", apiKey: "" };

function loadLlmConfig() {
  try {
    return { ...DEFAULT_LLM_CONFIG, ...JSON.parse(sessionStorage.getItem("stackpilot:llm-config") || "{}") };
  } catch {
    return { ...DEFAULT_LLM_CONFIG };
  }
}

const STANDARD_FIELDS = [
  { key: "timestamp", label: "测试时间", required: true, unit: "日期时间", aliases: ["测试时间", "Timestamp", "时间", "采集时间"] },
  { key: "target", label: "目标电流", required: true, unit: "A", aliases: ["电流设定值（A）", "电流设定值(A)", "目标电流", "FC_SysLoadCurr"] },
  { key: "actual", label: "实测电流", required: true, unit: "A", aliases: ["实际电流（A）", "实际电流(A)", "FC_CurrOut", "电堆电流"] },
  { key: "currentDensity", label: "实测电流密度", required: false, unit: "mA/cm² → A/cm²", aliases: ["电流密度（mA/cm2）", "电流密度(mA/cm2)"] },
  { key: "avgCell", label: "平均单片电压", required: true, unit: "V", aliases: ["平均电压（V）", "平均电压(V)", "FC_AvgCellVoltage", "平均单体电压"] },
  { key: "minCell", label: "最低单片电压", required: false, unit: "V", aliases: ["最小电压（V）", "最小电压(V)", "FC_MinCellVoltage", "最小单体电压"] },
  { key: "range", label: "单片电压极差", required: false, unit: "mV", aliases: ["极差（mV）", "极差(mV)", "FC_AvgCellVoltDev", "离均差"] },
  { key: "pieceCount", label: "电堆片数", required: false, unit: "片", aliases: ["片数", "单片数量", "电堆片数"] },
  { key: "stackVoltage", label: "电堆总电压", required: false, unit: "V", aliases: ["总电压（V）", "总电压(V)"] },
  { key: "power", label: "功率", required: false, unit: "kW", aliases: ["功率（kW)", "功率(kW)"] },
  { key: "h2Flow", label: "氢气流量", required: false, unit: "SLPM", aliases: ["阳极流量（SLPM）", "阳极流量(SLPM)"] },
  { key: "h2Pressure", label: "氢气入口压力", required: false, unit: "kPa.g", aliases: ["阳极入堆压力（kPa）", "阳极入堆压力(kPa)"] },
  { key: "h2OutPressure", label: "氢气出口压力", required: false, unit: "kPa.g", aliases: ["阳极出堆压力（kPa）", "阳极出堆压力(kPa)"] },
  { key: "h2Temperature", label: "氢气入口温度", required: false, unit: "℃", aliases: ["阳极入堆温度（℃）", "阳极入堆温度(℃)"] },
  { key: "h2Dewpoint", label: "氢气入口露点", required: false, unit: "℃", aliases: ["阳极增湿罐水温度（℃）", "阳极增湿罐水温度(℃)"] },
  { key: "airFlow", label: "空气流量", required: false, unit: "SLPM", aliases: ["阴极流量（SLPM）", "阴极流量(SLPM)"] },
  { key: "airPressure", label: "空气入口压力", required: false, unit: "kPa.g", aliases: ["阴极入堆压力（kPa）", "阴极入堆压力(kPa)"] },
  { key: "airOutPressure", label: "空气出口压力", required: false, unit: "kPa.g", aliases: ["阴极出堆压力（kPa）", "阴极出堆压力(kPa)"] },
  { key: "airTemperature", label: "空气入口温度", required: false, unit: "℃", aliases: ["阴极入堆温度（℃）", "阴极入堆温度(℃)"] },
  { key: "airDewpoint", label: "空气入口露点", required: false, unit: "℃", aliases: ["阴极增湿罐水温度（℃）", "阴极增湿罐水温度(℃)"] },
  { key: "coolantFlow", label: "冷却液流量", required: false, unit: "L/min", aliases: ["循环水流量（L/min）", "循环水流量(L/min)"] },
  { key: "coolantPressure", label: "冷却液入口压力", required: false, unit: "kPa.g", aliases: ["循环水入堆压力（kPa）", "循环水入堆压力(kPa)"] },
  { key: "coolantOutPressure", label: "冷却液出口压力", required: false, unit: "kPa.g", aliases: ["循环水出堆压力（kPa）", "循环水出堆压力(kPa)"] },
  { key: "coolantInTemperature", label: "冷却液入口温度", required: false, unit: "℃", aliases: ["循环水入堆温度（℃）", "循环水入堆温度(℃)"] },
  { key: "coolantOutTemperature", label: "冷却液出口温度", required: false, unit: "℃", aliases: ["循环水出堆温度（℃）", "循环水出堆温度(℃)"] }
];

const state = {
  result: null,
  worker: null,
  lastFile: null,
  sourceHeaders: [],
  referenceMode: true,
  config: { ...DEFAULT_CONFIG, fieldMappings: {} },
  agentAvailable: false,
  agentServerAvailable: false,
  agentServerModel: "",
  agentBusy: false,
  agentResult: null,
  agentResults: {},
  llmConfig: loadLlmConfig()
};
const $ = (id) => document.getElementById(id);
const fmt = (value, digits = 0) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const finite = (value) => value != null && Number.isFinite(Number(value));
const formatDateTime = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
};
const downloadBlob = (blob, name) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2800);
}

function setProgress(value, active = true) {
  $("progressTrack").classList.toggle("active", active);
  $("progressBar").style.width = `${Math.max(0, Math.min(100, value))}%`;
  if (value >= 100) setTimeout(() => $("progressTrack").classList.remove("active"), 650);
}

function parseHeaderRow(text) {
  let quoted = false;
  const counts = { ",": 0, "\t": 0, ";": 0 };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') i += 1;
      else quoted = !quoted;
    } else if (!quoted && ch in counts) counts[ch] += 1;
    else if (!quoted && (ch === "\r" || ch === "\n")) break;
  }
  const delimiter = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const fields = [];
  let field = "";
  quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted && ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
    else if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === delimiter) { fields.push(field); field = ""; }
    else if (!quoted && (ch === "\r" || ch === "\n")) { fields.push(field); break; }
    else field += ch;
  }
  return fields.map((value) => value.replace(/^\ufeff/, "").trim()).filter(Boolean);
}

async function readSourceHeaders(file) {
  return parseHeaderRow(await file.slice(0, Math.min(file.size, 128 * 1024)).text());
}

function autoFieldMappings(headers = state.sourceHeaders) {
  const normalized = new Map(headers.map((header) => [header.replace(/[\s（）()]/g, "").toLowerCase(), header]));
  return Object.fromEntries(STANDARD_FIELDS.map((field) => {
    const exact = field.aliases.find((alias) => headers.includes(alias));
    const relaxed = field.aliases.map((alias) => normalized.get(alias.replace(/[\s（）()]/g, "").toLowerCase())).find(Boolean);
    return [field.key, exact || relaxed || ""];
  }).filter(([, source]) => source));
}

async function loadReference() {
  if (state.worker) state.worker.terminate();
  state.referenceMode = true;
  state.lastFile = null;
  state.sourceHeaders = [];
  state.agentResult = null;
  state.agentResults = {};
  setProgress(20);
  try {
    const response = await fetch("./reference-analysis.json", { cache: "no-store" });
    if (!response.ok) throw new Error("基准批次索引不可用");
    state.result = await response.json();
    state.config = { ...state.config, ...state.result.config };
    syncConfigForm();
    renderAll();
    setProgress(100);
    await checkAgentStatus();
  } catch (error) {
    toast(`加载失败：${error.message}`);
    setProgress(0, false);
  }
}

async function analyzeFile(file) {
  if (!file || !file.name.toLowerCase().endsWith(".csv")) return toast("当前版本支持导入 CSV 时序数据");
  if (state.worker) state.worker.terminate();
  state.referenceMode = false;
  state.lastFile = file;
  state.agentResult = null;
  state.agentResults = {};
  $("datasetName").textContent = file.name;
  $("sourceStatus").textContent = "解析中";
  $("datasetMeta").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · Worker 分块解析`;
  setProgress(4);
  try {
    state.sourceHeaders = await readSourceHeaders(file);
    if (!Object.keys(state.config.fieldMappings || {}).length) state.config.fieldMappings = autoFieldMappings();
    state.worker = new Worker("./analyzer-worker.js");
    state.worker.onmessage = (event) => {
      if (event.data.type === "progress") setProgress(event.data.value);
      if (event.data.type === "error") {
        toast(event.data.message);
        $("sourceStatus").textContent = "处理失败";
        setProgress(0, false);
        if (/字段|电流/.test(event.data.message)) openMappingModal();
      }
      if (event.data.type === "result") {
        state.result = event.data.result;
        renderAll();
        setProgress(100);
        toast("分析完成：原始数据未离开浏览器 Worker");
      }
    };
    state.worker.postMessage({ file, fileName: file.name, fileSize: file.size, config: state.config });
  } catch (error) {
    toast(`读取失败：${error.message}`);
    setProgress(0, false);
  }
}

function renderAll() {
  const r = state.result;
  if (!r) return;
  const mapping = r.meta?.fieldMapping || { direct: 0, derived: 0, missing: 0, total: r.meta?.columnCount || 0 };
  const quality = r.qualityGate || {
    status: r.issues?.some((i) => i.severity === "error") ? "阻断" : "有条件通过",
    headline: r.trust?.headline,
    description: r.trust?.description,
    warnings: r.issues?.filter((i) => i.severity === "warning").length || 0,
    errors: r.issues?.filter((i) => i.severity === "error").length || 0
  };
  const usableFields = mapping.direct + mapping.derived;
  const uniqueCurrents = new Set((r.platforms || []).map((p) => p.targetCurrent)).size;

  $("datasetName").textContent = r.dataset?.name || r.source?.fileName || "本机导入批次";
  $("sourceStatus").textContent = state.referenceMode ? (r.dataset?.reviewStatus || "已校验") : "本机分析";
  $("datasetMeta").textContent = `${fmt(r.meta?.rowCount)} 行 · ${fmt(r.meta?.columnCount)} 个原始信号 · ${fmt(r.source?.fileSizeMB, 2)} MB`;
  $("engineLabel").textContent = `计算引擎 v${r.engineVersion || r.schemaVersion || "1.0"}`;
  $("rowCount").textContent = fmt(r.meta?.rowCount);
  $("rowCountFoot").textContent = `${formatDateTime(r.meta?.timeMin)} 起`;
  $("fieldMappingCount").textContent = mapping.total ? `${usableFields}/${mapping.total}` : fmt(r.meta?.columnCount);
  $("fieldMappingFoot").textContent = `${mapping.direct || 0} 直接映射 · ${mapping.derived || 0} 派生`;
  $("platformCount").textContent = fmt(r.platforms?.length);
  $("platformCountFoot").textContent = `${uniqueCurrents} 个电流档位 · 重复点独立保留`;
  $("issueCount").textContent = fmt((r.issues || []).length);
  $("issueCountFoot").textContent = `${quality.warnings || 0} 警告 · ${quality.errors || 0} 错误`;
  $("qualityBadge").textContent = quality.warnings + quality.errors;
  $("trustScore").textContent = quality.errors ? "阻断" : "通过";
  $("trustHeadline").textContent = quality.headline || "质量闸门已完成";
  $("trustDescription").textContent = quality.description || "限制与处理依据已写入报告。";
  $("analysisMode").textContent = `${r.config?.strictMode === false ? "宽松" : "严格"}模式 · ${r.parameterTemplateVersion || `schema ${r.schemaVersion}`}`;
  $("datasetId").textContent = r.dataset?.id || "LOCAL-IMPORT";
  $("datasetRange").textContent = `${formatDateTime(r.meta?.timeMin)} — ${formatDateTime(r.meta?.timeMax)}`;
  $("datasetHash").textContent = r.source?.sha256 ? `${r.source.sha256.slice(0, 12)}…` : "本机临时批次";
  $("datasetHash").title = r.source?.sha256 || "";
  $("analysisVersion").textContent = `Engine ${r.engineVersion || r.schemaVersion || "1.0"} · ${r.parameterTemplateVersion || "本机模板"}`;
  $("platformRulePill").textContent = `±${r.config?.currentTolerance ?? 1} A · ≥${r.config?.minSamples ?? 60} 样本 · 末端 ${r.config?.windowSamples ?? 120}`;
  $("agentTemplate").textContent = state.llmConfig.apiKey ? state.llmConfig.model : (state.agentServerModel || "燃料电池电堆分析");

  renderPolarization(r.polarization || []);
  if (state.agentResult) renderAgentResult(state.agentResult);
  else renderInsights(r.insights || []);
  renderPlatforms(r.platforms || []);
  renderQuality(r, quality);
  renderConditions(r.conditions || []);
  renderCells(r.cells || [], r.pieceCounts || {}, r.meta || {});
  renderReportSheets(r.reportSheets || []);
  renderAudit(r.auditLog || []);
}

function renderPolarization(points) {
  const svg = $("polarizationChart");
  if (!points.length) {
    svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#8aa0a8">没有满足当前规则的曲线点</text>';
    $("polarizationCaption").textContent = "当前批次未形成可用极化曲线";
    return;
  }
  const W = 900, H = 330, m = { l: 58, r: 26, t: 20, b: 44 };
  const xs = points.map((p) => finite(p.x) ? Number(p.x) : Number(p.targetCurrent));
  const ys = points.map((p) => Number(p.y));
  const minX = Math.min(0, ...xs), maxX = Math.max(...xs) * 1.04;
  const minY = Math.min(...ys) - 0.025, maxY = Math.max(...ys) + 0.025;
  const x = (v) => m.l + (v - minX) / (maxX - minX || 1) * (W - m.l - m.r);
  const y = (v) => H - m.b - (v - minY) / (maxY - minY || 1) * (H - m.t - m.b);
  let html = "";
  for (let i = 0; i <= 5; i += 1) {
    const value = minY + (maxY - minY) * i / 5, yy = y(value);
    html += `<line x1="${m.l}" y1="${yy}" x2="${W-m.r}" y2="${yy}" stroke="#e4ecee"/><text x="${m.l-10}" y="${yy+4}" text-anchor="end" font-size="10" fill="#7c9098">${value.toFixed(2)}</text>`;
  }
  for (let i = 0; i <= 6; i += 1) {
    const value = maxX * i / 6, xx = x(value);
    html += `<line x1="${xx}" y1="${m.t}" x2="${xx}" y2="${H-m.b}" stroke="#eff3f4"/><text x="${xx}" y="${H-18}" text-anchor="middle" font-size="10" fill="#7c9098">${value.toFixed(maxX < 10 ? 2 : 0)}</text>`;
  }
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(finite(p.x) ? Number(p.x) : Number(p.targetCurrent)).toFixed(1)},${y(Number(p.y)).toFixed(1)}`).join(" ");
  html += `<path d="${path}" fill="none" stroke="#00a9a9" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  points.forEach((p) => {
    const px = finite(p.x) ? Number(p.x) : Number(p.targetCurrent);
    const formal = p.status === "正式点";
    const fill = formal ? "#bbec4f" : "#f2ad3d";
    html += `<circle cx="${x(px)}" cy="${y(p.y)}" r="10" fill="rgba(0,169,169,.09)"/><circle cx="${x(px)}" cy="${y(p.y)}" r="5" fill="${fill}" stroke="#087c80" stroke-width="2"><title>平台 ${p.platformId || "—"} · ${fmt(p.current ?? p.targetCurrent, 2)} A · ${fmt(p.y, 3)} V · ${fmt(p.samples)} 样本</title></circle>`;
  });
  const xLabel = Math.max(...xs) < 10 ? "实际平均电流密度（A/cm²）" : "目标电流（A）";
  html += `<text x="${W/2}" y="${H-3}" text-anchor="middle" font-size="10" fill="#647982">${xLabel}</text><text x="13" y="${H/2}" text-anchor="middle" transform="rotate(-90 13 ${H/2})" font-size="10" fill="#647982">平均单片电压（V）</text>`;
  svg.innerHTML = html;
  const formalCount = points.filter((p) => p.status === "正式点").length;
  $("polarizationCaption").textContent = `${points.length} 个代表电流档位 · ${formalCount} 个正式点 · 选点策略：${state.result?.config?.curveSelectionPolicy || "同电流取持续时间最长的平台"}`;
}

function renderInsights(insights) {
  $("agentStatus").textContent = state.agentAvailable ? "AI 就绪" : "待配置";
  $("agentStatus").className = `ai-chip ${state.agentAvailable ? "ready" : "local"}`;
  $("agentSummary").textContent = state.agentAvailable ? "分析数据已准备，可生成 AI 研判。" : "配置 AI 接口后，可生成关联研判与追问回答。";
  $("agentAnswer").hidden = true;
  $("insightList").innerHTML = insights.map((item) => `<div class="insight ${item.type === "warning" ? "warn" : ""}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></div>`).join("");
}

function renderAgentResult(result) {
  $("agentStatus").textContent = "AI 已研判";
  $("agentStatus").className = "ai-chip ready";
  $("agentSummary").textContent = result.summary || "智能研判已完成。";
  $("insightList").innerHTML = (result.findings || []).map((item) => `<div class="insight agent-${escapeHtml(item.severity)}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.evidence)}</span><small>建议：${escapeHtml(item.recommendation)}</small></div>`).join("");
  const limitations = (result.limitations || []).length ? `<small class="agent-limitations">边界：${escapeHtml(result.limitations.join("；"))}</small>` : "";
  $("agentAnswer").innerHTML = `${result.answer ? `<strong>AI 回答</strong><p>${escapeHtml(result.answer)}</p>` : ""}${limitations}`;
  $("agentAnswer").hidden = !result.answer && !limitations;
}

function compactRange(items, key, digits = 2) {
  const values = items.map((item) => Number(item[key])).filter(Number.isFinite);
  if (!values.length) return null;
  return { min: +Math.min(...values).toFixed(digits), max: +Math.max(...values).toFixed(digits) };
}

function buildAgentContext() {
  const r = state.result;
  const platforms = (r.platforms || []).map((p) => ({
    id: p.id, label: p.label, targetCurrentA: p.targetCurrent, actualCurrentA: p.actualCurrent,
    samples: p.sampleCount, avgCellV: p.avgCellVoltage, minCellV: p.minCellVoltage,
    rangeMv: p.cellRange, status: p.status, stability: p.stabilityStatus, compliance: p.complianceStatus
  }));
  return {
    contract: {
      deterministicEngineOwnsCalculations: true,
      agentMayInterpretOnly: true,
      rawRowsIncluded: false,
      knowledgeTemplate: r.config?.knowledgeTemplate || state.config.knowledgeTemplate || "enterprise-t02"
    },
    dataset: {
      id: r.dataset?.id, name: r.dataset?.name, rows: r.meta?.rowCount, columns: r.meta?.columnCount,
      timeMin: r.meta?.timeMin, timeMax: r.meta?.timeMax, sha256Prefix: r.source?.sha256?.slice(0, 16)
    },
    qualityGate: r.qualityGate,
    issues: (r.issues || []).map(({ severity, category, title, detail, evidence, action }) => ({ severity, category, title, detail, evidence, action })),
    fieldMapping: r.meta?.fieldMapping,
    missingFields: (r.fieldMappings || []).filter((m) => m.status === "缺失").map((m) => m.standardField),
    platforms,
    polarization: r.polarization || [],
    conditions: (r.conditions || []).map((c) => ({
      platform: c.label || c.platformId, actualCurrentA: c.actualCurrent,
      h2FlowSlpm: c.h2Flow, h2PressureKpa: c.h2Pressure, h2TemperatureC: c.h2Temperature, h2DewpointC: c.h2Dewpoint,
      airFlowSlpm: c.airFlow, airPressureKpa: c.airPressure, airTemperatureC: c.airTemperature, airDewpointC: c.airDewpoint,
      coolantFlowLpm: c.coolantFlow, coolantInTemperatureC: c.coolantInTemperature,
      coolantDeltaTemperatureC: c.coolantDeltaTemperature, h2ResistanceKpa: c.h2Resistance,
      airResistanceKpa: c.airResistance, coolantResistanceKpa: c.coolantResistance
    })),
    cells: [...(r.cells || [])].sort((a, b) => a.deviation - b.deviation).slice(0, 20).map(({ channel, mean, min, max, deviation, completeness, rank }) => ({ channel, mean, min, max, deviation, completeness, rank })),
    operatingConditionRanges: {
      h2PressureKpa: compactRange(r.conditions || [], "h2Pressure", 1),
      airPressureKpa: compactRange(r.conditions || [], "airPressure", 1),
      coolantInTemperatureC: compactRange(r.conditions || [], "coolantInTemperature", 1),
      coolantFlowLpm: compactRange(r.conditions || [], "coolantFlow", 1)
    }
  };
}

async function checkAgentStatus() {
  const locallyConfigured = Boolean(state.llmConfig.baseUrl && state.llmConfig.model && state.llmConfig.apiKey);
  try {
    const response = await fetch("/api/agent", { cache: "no-store" });
    const status = await response.json();
    state.agentServerAvailable = Boolean(response.ok && status.available);
    state.agentServerModel = status.model || "";
    state.agentAvailable = locallyConfigured || state.agentServerAvailable;
    $("runAgentButton").disabled = false;
    $("runAgentButton").textContent = state.agentAvailable ? "生成 AI 分析" : "配置 AI 接口";
    $("agentTemplate").textContent = state.llmConfig.apiKey ? state.llmConfig.model : (state.agentServerModel || "燃料电池电堆分析");
    if (!state.agentResult && state.result) renderInsights(state.result.insights || []);
  } catch {
    state.agentAvailable = locallyConfigured;
    $("runAgentButton").disabled = false;
    $("runAgentButton").textContent = state.agentAvailable ? "生成 AI 分析" : "配置 AI 接口";
  }
  return state.agentAvailable;
}

function renderScopedAgentResult(targetId, result) {
  const panel = $(targetId);
  if (!panel) return;
  const findings = (result.findings || []).map((item) => `<div class="insight agent-${escapeHtml(item.severity)}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.evidence)}</span><small>${escapeHtml(item.recommendation)}</small></div>`).join("");
  const limitations = (result.limitations || []).length ? `<div class="section-ai-limit">分析边界：${escapeHtml(result.limitations.join("；"))}</div>` : "";
  panel.innerHTML = `<div class="panel-head"><div><span class="section-kicker">AI INSIGHT</span><h2>${escapeHtml(result.summary || "AI 分析结果")}</h2></div><span class="ai-chip ready">${escapeHtml(result.meta?.model || "已完成")}</span></div><div class="section-ai-findings">${findings}</div>${result.answer ? `<p class="section-ai-answer">${escapeHtml(result.answer)}</p>` : ""}${limitations}`;
  panel.hidden = false;
}

async function runAgent(question = "", silent = false, targetId = "") {
  if (!state.result) return toast("请先完成批次分析");
  if (state.agentBusy) return;
  if (!state.agentAvailable && !(await checkAgentStatus())) {
    openAiConfigModal();
    return toast("请先配置 AI 接口");
  }
  state.agentBusy = true;
  $("runAgentButton").disabled = true;
  $("runAgentButton").textContent = "AI 分析中…";
  $("agentStatus").textContent = "分析中";
  const target = targetId ? $(targetId) : null;
  if (target) {
    target.hidden = false;
    target.innerHTML = '<div class="ai-loading"><i></i><span>正在分析当前数据…</span></div>';
  }
  try {
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, context: buildAgentContext(), llmConfig: state.llmConfig.apiKey ? state.llmConfig : undefined })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "AI 服务调用失败");
    state.agentResult = body;
    if (targetId) {
      state.agentResults[targetId] = body;
      state.result.aiAnalyses = Object.fromEntries(Object.entries(state.agentResults).map(([key, value]) => [key, { ...value, meta: { ...value.meta, usage: undefined } }]));
      renderScopedAgentResult(targetId, body);
      renderReportSheets(state.result.reportSheets || []);
    } else renderAgentResult(body);
    if (!silent) toast("AI 分析已更新");
  } catch (error) {
    $("agentStatus").textContent = "分析失败";
    if (target) target.hidden = true;
    if (!silent) toast(error.message);
  } finally {
    state.agentBusy = false;
    $("runAgentButton").disabled = false;
    $("runAgentButton").textContent = state.agentAvailable ? "重新生成分析" : "配置 AI 接口";
  }
}

function platformRow(p, detailed = false) {
  const statusClass = p.status === "正式点" || p.status === "有效" ? "status-ok" : "status-warn";
  if (!detailed) return `<tr><td>${escapeHtml(p.label || `P${p.id}`)}</td><td>${fmt(p.sampleCount)}</td><td>${fmt(p.durationSeconds ?? p.sampleCount)} s</td><td>${fmt(p.actualCurrent, 2)} A</td><td>${fmt(p.avgCellVoltage, 3)} V</td><td>${fmt(p.cellRange, 1)} mV</td><td class="${statusClass}">${escapeHtml(p.status)}</td></tr>`;
  return `<tr><td>${escapeHtml(p.label || `P${p.id}`)}</td><td>${fmt(p.targetCurrent)} A</td><td>第 ${fmt(p.occurrence || 1)} 次</td><td>${fmt(p.startRow)}–${fmt(p.endRow)}</td><td>${fmt(p.sampleCount)}</td><td>${fmt(p.durationSeconds ?? p.sampleCount)} s</td><td>末端 ${fmt(p.statisticSamples)} 样本</td><td>${fmt(p.actualCurrent, 2)} A</td><td>${fmt(p.avgCellVoltage, 3)} V</td><td>${fmt(p.minCellVoltage, 3)} V</td><td class="${statusClass}">${escapeHtml(p.status)}</td><td class="status-muted">${escapeHtml(p.complianceStatus || "未判定")}</td></tr>`;
}

function renderPlatforms(platforms) {
  $("overviewPlatformRows").innerHTML = [...platforms].sort((a, b) => b.sampleCount - a.sampleCount).slice(0, 7).map((p) => platformRow(p)).join("");
  $("allPlatformRows").innerHTML = platforms.map((p) => platformRow(p, true)).join("");
}

function renderQuality(r, quality) {
  const blocked = quality.errors > 0;
  $("qualityGateStatus").textContent = quality.status || (blocked ? "阻断" : "有条件通过");
  $("qualityGateStatus").className = `pill ${blocked ? "bad" : "warn"}`;
  $("qualityCards").innerHTML = (r.issues || []).map((issue) => {
    const good = issue.severity === "info";
    const icon = issue.severity === "error" ? "×" : issue.severity === "warning" ? "!" : "i";
    return `<article class="quality-card ${good ? "good" : issue.severity === "error" ? "error" : ""}"><div class="quality-icon">${icon}</div><div><span class="quality-category">${escapeHtml(issue.category || "质量检查")}</span><strong>${escapeHtml(issue.title)}</strong><p>${escapeHtml(issue.detail)}</p><p class="quality-action">处理：${escapeHtml(issue.action || "写入报告并继续追踪")}</p></div><small>${escapeHtml(issue.evidence)}</small></article>`;
  }).join("");
  const mappings = r.fieldMappings || [];
  const summary = r.meta?.fieldMapping || { direct: mappings.filter((m) => m.status === "已映射").length, derived: mappings.filter((m) => m.status === "可计算").length, missing: mappings.filter((m) => m.status === "缺失").length, total: mappings.length };
  $("mappingSummary").textContent = `企业标准字段 ${summary.total || mappings.length} 项；单位口径与换算关系随报告固化。`;
  $("mappingPill").textContent = `${summary.direct || 0} 映射 · ${summary.derived || 0} 派生 · ${summary.missing || 0} 缺失`;
  $("mappingRows").innerHTML = mappings.map((m) => `<tr><td><strong>${escapeHtml(m.standardField)}</strong></td><td>${escapeHtml(m.sourceField)}</td><td>${escapeHtml(m.sourceUnit)}</td><td>${escapeHtml(m.outputUnit)}</td><td>${escapeHtml(m.conversion)}</td><td>${fmt((m.completeness || 0) * 100)}%</td><td class="${m.status === "缺失" ? "status-warn" : "status-ok"}">${escapeHtml(m.status)}</td></tr>`).join("") || '<tr><td colspan="7">本机导入批次未生成完整字段映射。</td></tr>';
  $("fieldBars").innerHTML = (r.fieldCompleteness || []).map((field) => {
    const percent = Math.round(field.completeness * 100);
    return `<div class="field-row"><span>${escapeHtml(field.name)}</span><div class="field-track"><span class="${percent < 95 ? "low" : ""}" style="width:${percent}%"></span></div><b>${percent}%</b></div>`;
  }).join("") || "<p>本批次没有可展示的字段完整率结果。</p>";
}

function renderConditions(conditions) {
  if (!conditions.length) {
    $("conditionRows").innerHTML = '<tr><td colspan="19">当前批次没有形成实际工况汇总。</td></tr>';
    $("conditionKpis").innerHTML = "";
    return;
  }
  const values = (key) => conditions.map((c) => Number(c[key])).filter(Number.isFinite);
  const span = (key, digits, unit) => {
    const list = values(key);
    return list.length ? `${fmt(Math.min(...list), digits)}–${fmt(Math.max(...list), digits)} ${unit}` : "—";
  };
  $("conditionKpis").innerHTML = [
    ["阳极入口压力范围", span("h2Pressure", 1, "kPa.g")],
    ["阴极入口压力范围", span("airPressure", 1, "kPa.g")],
    ["冷却液入口温度范围", span("coolantInTemperature", 1, "℃")],
    ["冷却液流量范围", span("coolantFlow", 1, "L/min")]
  ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("");
  $("conditionRows").innerHTML = conditions.map((c) => `<tr><td>${escapeHtml(c.label || `P${c.platformId}`)}</td><td>${fmt(c.actualCurrent,2)} A</td><td>${fmt(c.h2Stoich,2)}</td><td>${fmt(c.h2Flow,1)} SLPM</td><td>${fmt(c.h2Pressure,1)}</td><td>${fmt(c.h2Temperature,1)} ℃</td><td>${fmt(c.h2Dewpoint,1)} ℃</td><td>${fmt(c.airStoich,2)}</td><td>${fmt(c.airFlow,1)} SLPM</td><td>${fmt(c.airPressure,1)}</td><td>${fmt(c.airTemperature,1)} ℃</td><td>${fmt(c.airDewpoint,1)} ℃</td><td>${fmt(c.coolantFlow,1)} L/min</td><td>${fmt(c.coolantInTemperature,1)} ℃</td><td>${fmt(c.coolantDeltaTemperature,2)} ℃</td><td>${fmt(c.h2Resistance,2)} kPa</td><td>${fmt(c.airResistance,2)} kPa</td><td>${fmt(c.coolantResistance,2)} kPa</td><td class="status-muted">${escapeHtml(c.complianceStatus || "未判定")}</td></tr>`).join("");
}

function cellBars(cells, large = false) {
  const valid = cells.filter((c) => finite(c.mean));
  if (!valid.length) return "";
  const min = Math.min(...valid.map((c) => c.mean)), max = Math.max(...valid.map((c) => c.mean));
  return valid.map((c) => {
    const height = 34 + (c.mean - min) / (max - min || 1) * (large ? 220 : 100);
    const rankClass = c.rank === 1 ? "rank-low" : "";
    return `<div class="cell-bar ${rankClass}" style="height:${height}px"><em>${fmt(c.mean,3)}</em><span>${c.channel}</span><title>单片 ${c.channel} · 均值 ${fmt(c.mean,3)} V · 相对离均差 ${fmt(c.deviation*1000,1)} mV · 完整率 ${fmt(c.completeness*100)}%</title></div>`;
  }).join("");
}

function renderCells(cells, pieceCounts, meta) {
  $("cellMiniChart").innerHTML = cellBars(cells);
  $("cellLargeChart").innerHTML = cellBars(cells, true);
  const ranked = [...cells].filter((c) => finite(c.deviation)).sort((a, b) => a.deviation - b.deviation);
  const lowest = ranked[0];
  $("cellSummary").textContent = lowest ? `${cells.length} 个有效通道 · 最低相对离均差：单片 ${lowest.channel}（${fmt(lowest.deviation*1000,1)} mV）` : "未识别单片电压通道";
  const configs = Object.entries(pieceCounts).map(([count, rows]) => `${count}片 ${fmt(rows)}行`).join(" · ");
  $("cellChannelPill").textContent = configs || `${cells.length} 个有效通道`;
  $("cellPageDescription").textContent = `动态识别 ${meta.activeCellChannels || cells.length} 个有效通道、${meta.reservedCellChannels || 0} 个预留通道；完整率按每行实际片数校核。`;
  $("cellAnomalies").innerHTML = ranked.slice(0, 6).map((c) => `<div class="anomaly-item"><span><b>#${fmt(c.rank)}</b> 单片 ${c.channel}</span><strong>${fmt(c.mean,3)} V</strong><em>${fmt(c.deviation*1000,1)} mV</em><small>完整率 ${fmt(c.completeness*100)}%</small></div>`).join("") || '<div class="anomaly-item"><span>没有可排序的单片通道</span></div>';
}

function renderReportSheets(sheets) {
  const visibleSheets = [...sheets];
  if (Object.keys(state.agentResults).length && !visibleSheets.some((sheet) => String(sheet[1]).includes("AI"))) {
    visibleSheets.push(["15", "AI 分析", "已生成的分析摘要、证据与建议"]);
  }
  $("reportSheets").innerHTML = visibleSheets.map(([number, title, description]) => `<article class="sheet-card"><b>${escapeHtml(number)}</b><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></article>`).join("");
}

function renderAudit(logs) {
  $("auditRows").innerHTML = logs.map((log) => `<tr><td>${escapeHtml(formatDateTime(log.time))}</td><td><strong>${escapeHtml(log.stage)}</strong></td><td>${escapeHtml(log.detail)}</td><td class="status-ok">${escapeHtml(log.status)}</td></tr>`).join("") || '<tr><td colspan="4">本机分析日志将在完成后生成。</td></tr>';
}

function showView(name) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  $("pageTitle").textContent = ({ overview: "分析总览", quality: "质量与映射", platforms: "电流平台", conditions: "实际工况", cells: "单片一致性", report: "报告与审计" })[name];
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function exportXlsx() {
  if (!state.result) return toast("当前没有可导出的分析结果");
  window.StackPilotXlsx.export(state.result);
  toast("正式 XLSX 报告已生成");
}

function exportJson() {
  if (!state.result) return toast("当前没有可导出的分析结果");
  const batch = state.result.dataset?.id || "LOCAL";
  downloadBlob(new Blob([JSON.stringify(state.result, null, 2)], { type: "application/json" }), `StackPilot_${batch}_${new Date().toISOString().slice(0,10)}.json`);
}

function syncConfigForm() {
  ["currentTolerance", "minSamples", "windowSamples", "sampleInterval", "pressureTolerance", "temperatureTolerance", "dewpointTolerance"].forEach((id) => {
    if ($(id) && finite(state.config[id])) $(id).value = state.config[id];
  });
  $("missingPolicy").value = state.config.strictMode === false ? "lenient" : "strict";
  $("knowledgeTemplate").value = state.config.knowledgeTemplate || "enterprise-t02";
}

function readConfigForm() {
  const config = {
    ...state.config,
    currentTolerance: +$("currentTolerance").value,
    minSamples: +$("minSamples").value,
    windowSamples: +$("windowSamples").value,
    sampleInterval: +$("sampleInterval").value,
    pressureTolerance: +$("pressureTolerance").value,
    temperatureTolerance: +$("temperatureTolerance").value,
    dewpointTolerance: +$("dewpointTolerance").value,
    strictMode: $("missingPolicy").value === "strict",
    knowledgeTemplate: $("knowledgeTemplate").value,
    fieldMappings: { ...(state.config.fieldMappings || {}) }
  };
  if (Object.entries(config).some(([key, value]) => typeof value === "number" && (!Number.isFinite(value) || value <= 0))) throw new Error("所有数值参数必须大于 0");
  if (config.windowSamples < config.minSamples) throw new Error("默认统计窗口不能小于平台最短持续样本");
  return config;
}

function closeModal(id) {
  $(id).classList.remove("open");
  $(id).setAttribute("aria-hidden", "true");
}

function openAiConfigModal() {
  $("llmBaseUrl").value = state.llmConfig.baseUrl || DEFAULT_LLM_CONFIG.baseUrl;
  $("llmModel").value = state.llmConfig.model || DEFAULT_LLM_CONFIG.model;
  $("llmApiKey").value = state.llmConfig.apiKey || "";
  $("aiConfigModal").classList.add("open");
  $("aiConfigModal").setAttribute("aria-hidden", "false");
}

function saveAiConfig() {
  const config = {
    baseUrl: $("llmBaseUrl").value.trim().replace(/\/$/, ""),
    model: $("llmModel").value.trim(),
    apiKey: $("llmApiKey").value.trim()
  };
  if (!config.baseUrl || !config.model || !config.apiKey) return toast("请填写接口地址、模型和 API Key");
  try {
    const url = new URL(config.baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
  } catch {
    return toast("请输入有效的 AI 接口地址");
  }
  state.llmConfig = config;
  sessionStorage.setItem("stackpilot:llm-config", JSON.stringify(config));
  state.agentAvailable = true;
  $("agentTemplate").textContent = config.model;
  closeModal("aiConfigModal");
  checkAgentStatus();
  toast("AI 接口已启用");
}

function clearAiConfig() {
  state.llmConfig = { ...DEFAULT_LLM_CONFIG };
  sessionStorage.removeItem("stackpilot:llm-config");
  $("llmApiKey").value = "";
  closeModal("aiConfigModal");
  checkAgentStatus();
  toast("当前会话的 AI 配置已清除");
}

function openMappingModal() {
  renderMappingEditor();
  $("mappingModal").classList.add("open");
  $("mappingModal").setAttribute("aria-hidden", "false");
}

function renderMappingEditor(forceAuto = false) {
  const editable = Boolean(state.lastFile && state.sourceHeaders.length);
  const mappings = forceAuto ? autoFieldMappings() : { ...autoFieldMappings(), ...(state.config.fieldMappings || {}) };
  const currentMappings = new Map((state.result?.fieldMappings || []).map((item) => [item.standardField, item.sourceField]));
  $("mappingModalDescription").textContent = editable ? `${state.lastFile.name} · ${state.sourceHeaders.length} 个原始字段，可人工覆盖自动匹配。` : "当前为已校验基准批次；导入新的 CSV 后可使用下拉框覆盖自动映射。";
  $("mappingModalStatus").textContent = editable ? `${Object.values(mappings).filter(Boolean).length}/${STANDARD_FIELDS.length} 已匹配` : "基准映射只读";
  $("mappingEditorRows").innerHTML = STANDARD_FIELDS.map((field) => {
    const inferred = mappings[field.key] || "";
    if (!editable) {
      const source = currentMappings.get(field.label) || field.aliases.find((alias) => [...currentMappings.values()].includes(alias)) || "—";
      return `<tr><td><strong>${escapeHtml(field.label)}</strong></td><td><span class="mapping-required ${field.required ? "is-required" : ""}">${field.required ? "必需" : "可选"}</span></td><td>${escapeHtml(source)}</td><td>${escapeHtml(field.unit)}</td></tr>`;
    }
    const options = [`<option value="">不映射</option>`, ...state.sourceHeaders.map((header) => `<option value="${escapeHtml(header)}" ${header === inferred ? "selected" : ""}>${escapeHtml(header)}</option>`)].join("");
    return `<tr><td><strong>${escapeHtml(field.label)}</strong><small>${escapeHtml(field.key)}</small></td><td><span class="mapping-required ${field.required ? "is-required" : ""}">${field.required ? "必需" : "可选"}</span></td><td><select data-mapping-key="${field.key}">${options}</select></td><td>${escapeHtml(field.unit)}</td></tr>`;
  }).join("");
  $("saveMappingButton").disabled = !editable;
  $("autoMappingButton").disabled = !editable;
}

function saveFieldMappings() {
  if (!state.lastFile) return toast("请先导入需要配置的 CSV 文件");
  const mappings = {};
  document.querySelectorAll("[data-mapping-key]").forEach((select) => { if (select.value) mappings[select.dataset.mappingKey] = select.value; });
  const missingRequired = STANDARD_FIELDS.filter((field) => field.required && !mappings[field.key]);
  if (missingRequired.length) return toast(`请完成必需字段：${missingRequired.map((field) => field.label).join("、")}`);
  state.config.fieldMappings = mappings;
  closeModal("mappingModal");
  analyzeFile(state.lastFile);
}

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
document.querySelectorAll("[data-goto]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.goto)));
$("chooseFileButton").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (event) => analyzeFile(event.target.files[0]));
$("loadReferenceButton").addEventListener("click", () => { loadReference(); toast("正在还原已校验基准批次"); });
$("mappingButton").addEventListener("click", openMappingModal);
$("aiConfigButton").addEventListener("click", openAiConfigModal);
const drop = $("dropZone");
["dragenter", "dragover"].forEach((type) => drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((type) => drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.remove("drag"); }));
drop.addEventListener("drop", (event) => analyzeFile(event.dataTransfer.files[0]));
["exportTopButton", "exportXlsxButton"].forEach((id) => $(id).addEventListener("click", exportXlsx));
$("exportJsonButton").addEventListener("click", exportJson);
$("configButton").addEventListener("click", () => { syncConfigForm(); $("configModal").classList.add("open"); $("configModal").setAttribute("aria-hidden", "false"); });
$("closeConfigButton").addEventListener("click", () => closeModal("configModal"));
$("resetConfigButton").addEventListener("click", () => { state.config = { ...DEFAULT_CONFIG, fieldMappings: { ...(state.config.fieldMappings || {}) } }; syncConfigForm(); });
$("applyConfigButton").addEventListener("click", () => {
  try {
    state.config = readConfigForm();
    closeModal("configModal");
    if (state.lastFile) analyzeFile(state.lastFile);
    else toast("参数模板已保存，将用于下一次导入分析");
  } catch (error) { toast(error.message); }
});
$("closeMappingButton").addEventListener("click", () => closeModal("mappingModal"));
$("autoMappingButton").addEventListener("click", () => renderMappingEditor(true));
$("saveMappingButton").addEventListener("click", saveFieldMappings);
$("closeAiConfigButton").addEventListener("click", () => closeModal("aiConfigModal"));
$("saveAiConfigButton").addEventListener("click", saveAiConfig);
$("clearAiConfigButton").addEventListener("click", clearAiConfig);
$("agentDetailButton").addEventListener("click", () => { $("agentBoundaryModal").classList.add("open"); $("agentBoundaryModal").setAttribute("aria-hidden", "false"); });
$("closeAgentBoundaryButton").addEventListener("click", () => closeModal("agentBoundaryModal"));
$("runAgentButton").addEventListener("click", () => runAgent("请生成本批次智能研判摘要，并指出最值得人工复核的证据。"));
$("agentQuestionForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const question = $("agentQuestion").value.trim();
  if (!question) return;
  runAgent(question);
});
document.querySelectorAll("[data-ai-target]").forEach((button) => button.addEventListener("click", () => runAgent(button.dataset.aiQuestion, false, button.dataset.aiTarget)));
["configModal", "mappingModal", "aiConfigModal", "agentBoundaryModal"].forEach((id) => $(id).addEventListener("click", (event) => { if (event.target === $(id)) closeModal(id); }));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  ["configModal", "mappingModal", "aiConfigModal", "agentBoundaryModal"].forEach((id) => { if ($(id).classList.contains("open")) closeModal(id); });
});

loadReference();
