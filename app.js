const state = {
  result: null,
  worker: null,
  lastFile: null,
  demoMode: true,
  config: { currentTolerance: 1, minSamples: 60, windowSamples: 120, sampleInterval: 1, strictMode: true }
};

const $ = (id) => document.getElementById(id);
const fmt = (value, digits = 0) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const downloadBlob = (blob, name) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}

function setProgress(value, active = true) {
  $("progressTrack").classList.toggle("active", active); $("progressBar").style.width = `${value}%`;
  if (value >= 100) setTimeout(() => $("progressTrack").classList.remove("active"), 650);
}

async function loadDemo() {
  state.demoMode = true; state.lastFile = null; setProgress(25);
  try {
    const response = await fetch("./demo-analysis.json");
    if (!response.ok) throw new Error("样例分析文件不可用");
    state.result = await response.json(); setProgress(100); renderAll();
    $("datasetName").textContent = "青川科技官方样例数据";
    $("datasetMeta").textContent = "38,257 行真实数据的本地预分析结果 · 可拖入 CSV 替换";
  } catch (error) { toast(`加载失败：${error.message}`); setProgress(0, false); }
}

async function analyzeFile(file) {
  if (!file || !file.name.toLowerCase().endsWith(".csv")) { toast("请选择 CSV 文件"); return; }
  if (state.worker) state.worker.terminate();
  state.demoMode = false; state.lastFile = file;
  $("datasetName").textContent = file.name; $("datasetMeta").textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · 正在本机解析`;
  setProgress(4);
  const text = await file.text();
  state.worker = new Worker("./analyzer-worker.js");
  state.worker.onmessage = (event) => {
    if (event.data.type === "progress") setProgress(event.data.value);
    if (event.data.type === "error") { toast(event.data.message); setProgress(0, false); }
    if (event.data.type === "result") {
      state.result = event.data.result; setProgress(100); renderAll();
      $("datasetMeta").textContent = `${fmt(state.result.meta.rowCount)} 行 · ${state.result.meta.columnCount} 字段 · 仅在本机处理`;
      toast("分析完成，原始数据未离开本机");
    }
  };
  state.worker.postMessage({ text, fileName: file.name, fileSize: file.size, config: state.config });
}

function renderAll() {
  const r = state.result; if (!r) return;
  $("rowCount").textContent = fmt(r.meta.rowCount);
  $("columnCount").textContent = fmt(r.meta.columnCount);
  $("platformCount").textContent = fmt(r.platforms.length);
  $("issueCount").textContent = fmt(r.issues.length);
  $("qualityBadge").textContent = r.issues.length;
  $("trustScore").textContent = r.trust.score;
  $("trustHeadline").textContent = r.trust.headline;
  $("trustDescription").textContent = r.trust.description;
  $("analysisMode").textContent = `严格模式 · v${r.schemaVersion}`;
  renderPolarization(r.polarization);
  renderInsights(r.insights);
  renderPlatforms(r.platforms);
  renderQuality(r);
  renderCells(r.cells, r.pieceCounts);
  renderReportSheets(r.reportSheets);
  $("platformRulePill").textContent = `±${r.config.currentTolerance}A · ≥${r.config.minSamples}样本`;
}

function renderPolarization(points) {
  const svg = $("polarizationChart");
  if (!points?.length) { svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#8aa0a8">暂无有效测试点</text>'; return; }
  const W = 900, H = 330, m = { l: 56, r: 26, t: 20, b: 42 };
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = 0, maxX = Math.max(...xs) * 1.04, minY = Math.min(...ys) - .025, maxY = Math.max(...ys) + .025;
  const x = v => m.l + (v - minX) / (maxX - minX || 1) * (W - m.l - m.r);
  const y = v => H - m.b - (v - minY) / (maxY - minY || 1) * (H - m.t - m.b);
  let html = "";
  for (let i = 0; i <= 5; i++) { const value = minY + (maxY - minY) * i / 5, yy = y(value); html += `<line x1="${m.l}" y1="${yy}" x2="${W-m.r}" y2="${yy}" stroke="#e4ecee"/><text x="${m.l-10}" y="${yy+4}" text-anchor="end" font-size="10" fill="#7c9098">${value.toFixed(2)}</text>`; }
  for (let i = 0; i <= 6; i++) { const value = maxX * i / 6, xx = x(value); html += `<line x1="${xx}" y1="${m.t}" x2="${xx}" y2="${H-m.b}" stroke="#eff3f4"/><text x="${xx}" y="${H-17}" text-anchor="middle" font-size="10" fill="#7c9098">${Math.round(value)}</text>`; }
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
  html += `<path d="${path}" fill="none" stroke="#00a9a9" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  points.forEach(p => { const radius = p.samples >= 120 ? 5 : 4; html += `<circle cx="${x(p.x)}" cy="${y(p.y)}" r="${radius+5}" fill="rgba(0,169,169,.09)"/><circle cx="${x(p.x)}" cy="${y(p.y)}" r="${radius}" fill="${p.samples>=120?"#bbec4f":"#f2ad3d"}" stroke="#087c80" stroke-width="2"><title>${p.x}A · ${p.y.toFixed(3)}V · ${p.samples}样本</title></circle>`; });
  html += `<text x="${W/2}" y="${H-2}" text-anchor="middle" font-size="10" fill="#647982">目标电流（A）</text><text x="12" y="${H/2}" text-anchor="middle" transform="rotate(-90 12 ${H/2})" font-size="10" fill="#647982">平均单片电压（V）</text>`;
  svg.innerHTML = html;
  const first = points[0], last = points[points.length - 1];
  $("polarizationCaption").textContent = `代表测试点 ${points.length} 个 · ${fmt(first.x)}A / ${fmt(first.y,3)}V → ${fmt(last.x)}A / ${fmt(last.y,3)}V · 点击数据点可查看证据`;
}

function renderInsights(insights = []) {
  $("insightList").innerHTML = insights.map(i => `<div class="insight ${i.type === "warning" ? "warn" : ""}"><strong>${escapeHtml(i.title)}</strong><span>${escapeHtml(i.detail)}</span></div>`).join("");
}

function platformRow(p, detailed = false) {
  return detailed
    ? `<tr><td>${p.id}</td><td>${fmt(p.targetCurrent)} A</td><td>${fmt(p.sampleCount)}</td><td>${fmt(p.statisticSamples)}</td><td>${fmt(p.actualCurrent,2)} A</td><td>${fmt(p.avgCellVoltage,3)} V</td><td>${fmt(p.minCellVoltage,3)} V</td><td>${fmt(p.cellRange,1)} mV</td><td class="${p.status === "有效" ? "status-ok" : "status-warn"}">${escapeHtml(p.status)}</td></tr>`
    : `<tr><td>${fmt(p.targetCurrent)} A</td><td>${fmt(p.sampleCount)}</td><td>${fmt(p.actualCurrent,2)} A</td><td>${fmt(p.avgCellVoltage,3)} V</td><td>${fmt(p.cellRange,1)} mV</td><td class="${p.status === "有效" ? "status-ok" : "status-warn"}">${escapeHtml(p.status)}</td></tr>`;
}
function renderPlatforms(platforms) {
  $("overviewPlatformRows").innerHTML = platforms.slice().sort((a,b)=>b.sampleCount-a.sampleCount).slice(0,7).map(p => platformRow(p)).join("");
  $("allPlatformRows").innerHTML = platforms.map(p => platformRow(p, true)).join("");
}

function renderQuality(r) {
  $("qualityGateStatus").textContent = r.issues.some(i=>i.severity==="error") ? "阻断" : "有条件通过";
  $("qualityGateStatus").className = `pill ${r.issues.some(i=>i.severity==="error") ? "bad" : "warn"}`;
  $("qualityCards").innerHTML = r.issues.map(i => `<article class="quality-card ${i.severity === "info" ? "good" : ""}"><div class="quality-icon">${i.severity === "warning" ? "!" : "✓"}</div><div><strong>${escapeHtml(i.title)}</strong><p>${escapeHtml(i.detail)}</p></div><small>${escapeHtml(i.evidence)}</small></article>`).join("");
  const fields = r.fieldCompleteness || [];
  $("fieldBars").innerHTML = fields.map(f => { const p = Math.round(f.completeness * 100); return `<div class="field-row"><span>${escapeHtml(f.name)}</span><div class="field-track"><span class="${p<50?"low":""}" style="width:${p}%"></span></div><b>${p}%</b></div>`; }).join("") || '<p>暂无字段完整率数据</p>';
}

function cellBars(cells, large = false) {
  const valid = cells.filter(c => c.completeness > .05).slice(0, 20); if (!valid.length) return "";
  const min = Math.min(...valid.map(c=>c.mean)), max = Math.max(...valid.map(c=>c.mean));
  return valid.map(c => { const h = 30 + (c.mean - min) / (max - min || 1) * (large ? 230 : 105); return `<div class="cell-bar ${c.flag!=="正常"?"warn":""}" style="height:${h}px"><em>${fmt(c.mean,3)}</em><span>${c.channel}</span><title>单片${c.channel} · 均值${fmt(c.mean,3)}V · 完整率${fmt(c.completeness*100)}%</title></div>`; }).join("");
}
function renderCells(cells, pieceCounts) {
  $("cellMiniChart").innerHTML = cellBars(cells);
  $("cellLargeChart").innerHTML = cellBars(cells, true);
  const active = cells.filter(c=>c.completeness>.05); const lowest = [...active].sort((a,b)=>a.mean-b.mean)[0];
  $("cellSummary").textContent = lowest ? `有效通道 ${active.length} 个 · 最低均值：单片 ${lowest.channel}（${fmt(lowest.mean,3)}V）` : "未识别单片电压通道";
  const configs = Object.entries(pieceCounts || {}).map(([k,v])=>`${k}片 ${fmt(v)}行`).join(" · ");
  $("cellChannelPill").textContent = configs || `${active.length} 个有效通道`;
  const anomalies = active.filter(c=>c.flag!=="正常");
  $("cellAnomalies").innerHTML = anomalies.length ? anomalies.map(c=>`<div class="anomaly-item"><span>单片 ${c.channel}</span><b>${fmt(c.mean,3)} V</b><em>${fmt(c.deviation*1000,1)} mV</em></div>`).join("") : '<div class="anomaly-item"><span>未发现超过当前阈值的通道</span><b class="status-ok">通过</b></div>';
}

function renderReportSheets(sheets = []) { $("reportSheets").innerHTML = sheets.map(([n,title,desc])=>`<article class="sheet-card"><b>${n}</b><strong>${escapeHtml(title)}</strong><p>${escapeHtml(desc)}</p></article>`).join(""); }

function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".nav-item").forEach(v => v.classList.toggle("active", v.dataset.view === name));
  $("pageTitle").textContent = ({overview:"分析总览",quality:"数据质量",platforms:"电流平台",cells:"单片一致性",report:"报告中心"})[name];
  window.scrollTo({top:0,behavior:"smooth"});
}

function exportXlsx() { if (!state.result) return toast("暂无分析结果"); window.StackPilotXlsx.export(state.result); toast("XLSX 报告已生成"); }
function exportJson() { if (!state.result) return toast("暂无分析结果"); downloadBlob(new Blob([JSON.stringify(state.result,null,2)],{type:"application/json"}),`StackPilot_${new Date().toISOString().slice(0,10)}.json`); }

document.querySelectorAll(".nav-item").forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));
document.querySelectorAll("[data-goto]").forEach(b => b.addEventListener("click", () => showView(b.dataset.goto)));
$("chooseFileButton").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => analyzeFile(e.target.files[0]));
$("loadDemoButton").addEventListener("click", loadDemo);
const drop = $("dropZone");
["dragenter","dragover"].forEach(type => drop.addEventListener(type, e => { e.preventDefault(); drop.classList.add("drag"); }));
["dragleave","drop"].forEach(type => drop.addEventListener(type, e => { e.preventDefault(); drop.classList.remove("drag"); }));
drop.addEventListener("drop", e => analyzeFile(e.dataTransfer.files[0]));
["exportTopButton","exportXlsxButton"].forEach(id => $(id).addEventListener("click", exportXlsx));
$("exportJsonButton").addEventListener("click", exportJson);
$("configButton").addEventListener("click", () => { $("configModal").classList.add("open"); $("configModal").setAttribute("aria-hidden","false"); });
$("closeConfigButton").addEventListener("click", () => { $("configModal").classList.remove("open"); $("configModal").setAttribute("aria-hidden","true"); });
$("resetConfigButton").addEventListener("click", () => { [["currentTolerance",1],["minSamples",60],["windowSamples",120],["sampleInterval",1]].forEach(([id,v])=>$(id).value=v); });
$("applyConfigButton").addEventListener("click", () => {
  state.config = { ...state.config, currentTolerance:+$("currentTolerance").value, minSamples:+$("minSamples").value, windowSamples:+$("windowSamples").value, sampleInterval:+$("sampleInterval").value };
  $("configModal").classList.remove("open");
  if (state.lastFile) analyzeFile(state.lastFile); else toast("参数已保存；拖入 CSV 后将按新参数分析");
});
$("configModal").addEventListener("click", e => { if (e.target === $("configModal")) $("closeConfigButton").click(); });

loadDemo();
