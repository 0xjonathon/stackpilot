const DEFAULT_CONFIG = {
  currentTolerance: 1,
  minSamples: 60,
  windowSamples: 120,
  sampleInterval: 1,
  pressureTolerance: 1,
  temperatureTolerance: 1,
  dewpointTolerance: 1,
  strictMode: true
};

const state = { result: null, worker: null, lastFile: null, referenceMode: true, config: { ...DEFAULT_CONFIG } };
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

async function loadReference() {
  if (state.worker) state.worker.terminate();
  state.referenceMode = true;
  state.lastFile = null;
  setProgress(20);
  try {
    const response = await fetch("./reference-analysis.json", { cache: "no-store" });
    if (!response.ok) throw new Error("基准批次索引不可用");
    state.result = await response.json();
    state.config = { ...state.config, ...state.result.config };
    syncConfigForm();
    renderAll();
    setProgress(100);
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
  $("datasetName").textContent = file.name;
  $("sourceStatus").textContent = "解析中";
  $("datasetMeta").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · 本机内存分析`;
  setProgress(4);
  try {
    const text = await file.text();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    state.worker = new Worker("./analyzer-worker.js");
    state.worker.onmessage = (event) => {
      if (event.data.type === "progress") setProgress(event.data.value);
      if (event.data.type === "error") {
        toast(event.data.message);
        $("sourceStatus").textContent = "处理失败";
        setProgress(0, false);
      }
      if (event.data.type === "result") {
        state.result = event.data.result;
        renderAll();
        setProgress(100);
        toast("分析完成：原始数据未离开本机");
      }
    };
    state.worker.postMessage({ text, fileName: file.name, fileSize: file.size, sha256, config: state.config });
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

  renderPolarization(r.polarization || []);
  renderInsights(r.insights || []);
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
  $("insightList").innerHTML = insights.map((item) => `<div class="insight ${item.type === "warning" ? "warn" : ""}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></div>`).join("");
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
  const valid = cells.filter((c) => finite(c.mean)).slice(0, 40);
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
  $("reportSheets").innerHTML = sheets.map(([number, title, description]) => `<article class="sheet-card"><b>${escapeHtml(number)}</b><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></article>`).join("");
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
    strictMode: $("missingPolicy").value === "strict"
  };
  if (Object.entries(config).some(([key, value]) => typeof value === "number" && (!Number.isFinite(value) || value <= 0))) throw new Error("所有数值参数必须大于 0");
  if (config.windowSamples < config.minSamples) throw new Error("默认统计窗口不能小于平台最短持续样本");
  return config;
}

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
document.querySelectorAll("[data-goto]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.goto)));
$("chooseFileButton").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (event) => analyzeFile(event.target.files[0]));
$("loadReferenceButton").addEventListener("click", () => { loadReference(); toast("正在还原已校验基准批次"); });
const drop = $("dropZone");
["dragenter", "dragover"].forEach((type) => drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((type) => drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.remove("drag"); }));
drop.addEventListener("drop", (event) => analyzeFile(event.dataTransfer.files[0]));
["exportTopButton", "exportXlsxButton"].forEach((id) => $(id).addEventListener("click", exportXlsx));
$("exportJsonButton").addEventListener("click", exportJson);
$("configButton").addEventListener("click", () => { syncConfigForm(); $("configModal").classList.add("open"); $("configModal").setAttribute("aria-hidden", "false"); });
$("closeConfigButton").addEventListener("click", () => { $("configModal").classList.remove("open"); $("configModal").setAttribute("aria-hidden", "true"); });
$("resetConfigButton").addEventListener("click", () => { state.config = { ...DEFAULT_CONFIG }; syncConfigForm(); });
$("applyConfigButton").addEventListener("click", () => {
  try {
    state.config = readConfigForm();
    $("configModal").classList.remove("open");
    if (state.lastFile) analyzeFile(state.lastFile);
    else toast("参数模板已保存，将用于下一次导入分析");
  } catch (error) { toast(error.message); }
});
$("configModal").addEventListener("click", (event) => { if (event.target === $("configModal")) $("closeConfigButton").click(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && $("configModal").classList.contains("open")) $("closeConfigButton").click(); });

loadReference();
