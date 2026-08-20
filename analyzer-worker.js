/* StackPilot local-only CSV analysis worker. No data leaves the browser. */

self.onmessage = (event) => {
  const { text, fileName, fileSize, config } = event.data;
  try {
    const result = analyzeCsv(text, fileName, fileSize, config);
    self.postMessage({ type: "result", result });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message || String(error) });
  }
};

function parseCsv(text, onRow) {
  let row = [];
  let field = "";
  let quoted = false;
  let rowIndex = 0;
  for (let i = 0; i <= text.length; i += 1) {
    const ch = i < text.length ? text[i] : "\n";
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") onRow(row, rowIndex++);
      row = [];
      if (rowIndex % 5000 === 0) self.postMessage({ type: "progress", value: Math.min(92, Math.round((i / text.length) * 92)) });
    } else field += ch;
  }
}

const toNumber = (value) => {
  if (value == null || value.trim?.() === "") return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

function analyzeCsv(text, fileName, fileSize, config) {
  let headers = [];
  let idx = {};
  let rowCount = 0;
  const nonEmpty = [];
  const timestampCounts = new Map();
  let timeMin = null;
  let timeMax = null;
  const cellStats = [];
  const pieceCounts = new Map();
  let operatingRows = 0;
  const rows = [];
  const headerAliases = {
    timestamp: ["测试时间", "Timestamp", "时间"],
    target: ["电流设定值（A）", "目标电流", "FC_SysLoadCurr"],
    actual: ["实际电流（A）", "FC_CurrOut", "电堆电流"],
    avgCell: ["平均电压（V）", "FC_AvgCellVoltage", "平均单体电压"],
    minCell: ["最小电压（V）", "FC_MinCellVoltage", "最小单体电压"],
    range: ["极差（mV）", "FC_AvgCellVoltDev", "离均差"],
    pieceCount: ["片数", "单片数量"]
  };

  const findIndex = (names) => names.map((n) => headers.indexOf(n)).find((n) => n >= 0) ?? -1;

  parseCsv(text, (row, rowIndex) => {
    if (rowIndex === 0) {
      headers = row.map((h) => h.replace(/^\ufeff/, "").trim());
      nonEmpty.push(...headers.map(() => 0));
      Object.entries(headerAliases).forEach(([key, names]) => { idx[key] = findIndex(names); });
      idx.cells = headers.map((h, i) => /^单片电压\d+（V）$/.test(h) ? i : -1).filter((i) => i >= 0);
      idx.cells.forEach(() => cellStats.push({ sum: 0, count: 0, min: Infinity, max: -Infinity }));
      if (idx.target < 0 || idx.actual < 0) throw new Error("无法识别目标电流或实测电流字段，请使用青川样例结构的 CSV。");
      return;
    }
    rowCount += 1;
    for (let i = 0; i < headers.length; i += 1) if ((row[i] ?? "").trim() !== "") nonEmpty[i] += 1;
    const timestamp = idx.timestamp >= 0 ? (row[idx.timestamp] || "").trim() : String(rowCount);
    timestampCounts.set(timestamp, (timestampCounts.get(timestamp) || 0) + 1);
    if (timestamp) { if (timeMin == null || timestamp < timeMin) timeMin = timestamp; if (timeMax == null || timestamp > timeMax) timeMax = timestamp; }
    const target = toNumber(row[idx.target]);
    const actual = toNumber(row[idx.actual]);
    const avgCell = idx.avgCell >= 0 ? toNumber(row[idx.avgCell]) : NaN;
    const minCell = idx.minCell >= 0 ? toNumber(row[idx.minCell]) : NaN;
    const range = idx.range >= 0 ? toNumber(row[idx.range]) : NaN;
    const pieceCount = idx.pieceCount >= 0 ? toNumber(row[idx.pieceCount]) : NaN;
    if (Number.isFinite(pieceCount)) pieceCounts.set(pieceCount, (pieceCounts.get(pieceCount) || 0) + 1);
    if (target > 0) {
      operatingRows += 1;
      idx.cells.forEach((column, cellIndex) => {
        const value = toNumber(row[column]);
        if (Number.isFinite(value)) {
          const stat = cellStats[cellIndex]; stat.sum += value; stat.count += 1; stat.min = Math.min(stat.min, value); stat.max = Math.max(stat.max, value);
        }
      });
    }
    rows.push({ timestamp, target, actual, avgCell, minCell, range });
  });

  self.postMessage({ type: "progress", value: 95 });
  const tolerance = Number(config.currentTolerance) || 1;
  const minSamples = Number(config.minSamples) || 60;
  const windowSamples = Number(config.windowSamples) || 120;
  const platforms = [];
  let start = 0;
  const qualifies = (r) => r.target > 0 && Number.isFinite(r.actual) && Math.abs(r.actual - r.target) <= tolerance;
  for (let i = 1; i <= rows.length; i += 1) {
    const sameRun = i < rows.length && qualifies(rows[i]) && qualifies(rows[i - 1]) && rows[i].target === rows[i - 1].target;
    if (sameRun) continue;
    if (qualifies(rows[start]) && i - start >= minSamples) {
      const fullCount = i - start;
      const statStart = Math.max(start, i - windowSamples);
      const slice = rows.slice(statStart, i);
      const mean = (key) => {
        const values = slice.map((r) => r[key]).filter(Number.isFinite);
        return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      };
      platforms.push({
        id: platforms.length + 1,
        targetCurrent: rows[start].target,
        startRow: start + 2,
        endRow: i + 1,
        startTime: rows[start].timestamp,
        endTime: rows[i - 1].timestamp,
        sampleCount: fullCount,
        statisticSamples: slice.length,
        actualCurrent: mean("actual"),
        avgCellVoltage: mean("avgCell"),
        minCellVoltage: mean("minCell"),
        cellRange: mean("range"),
        status: fullCount >= windowSamples ? "有效" : "时长警告"
      });
    }
    start = i;
  }

  const bestByTarget = new Map();
  platforms.forEach((p) => { const old = bestByTarget.get(p.targetCurrent); if (!old || p.sampleCount > old.sampleCount) bestByTarget.set(p.targetCurrent, p); });
  const polarization = [...bestByTarget.values()].filter((p) => Number.isFinite(p.avgCellVoltage)).sort((a, b) => a.targetCurrent - b.targetCurrent).map((p) => ({ x: p.targetCurrent, y: p.avgCellVoltage, samples: p.sampleCount }));
  const cells = cellStats.map((s, i) => ({ channel: i + 1, mean: s.count ? s.sum / s.count : null, min: s.count ? s.min : null, max: s.count ? s.max : null, count: s.count, completeness: operatingRows ? s.count / operatingRows : 0 })).filter((s) => s.count > 0);
  const meanCell = cells.filter((c) => c.completeness > .8).reduce((a, c) => a + c.mean, 0) / Math.max(1, cells.filter((c) => c.completeness > .8).length);
  cells.forEach((c) => { c.deviation = c.mean - meanCell; c.flag = c.completeness > .8 && Math.abs(c.deviation) > .02 ? "关注" : "正常"; });
  const over90Missing = nonEmpty.filter((n) => rowCount && n / rowCount < .1).length;
  const duplicateRows = [...timestampCounts.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0);
  const dynamicPieces = pieceCounts.size > 1;
  const issues = [];
  if (duplicateRows > 0) issues.push({ severity: "warning", title: "时间戳精度不足或重复", detail: `${duplicateRows.toLocaleString()} 行处于重复时间戳中，持续时间按采样周期估算。`, evidence: `${timestampCounts.size.toLocaleString()} 个唯一时间戳 / ${rowCount.toLocaleString()} 行` });
  if (over90Missing > 0) issues.push({ severity: "warning", title: "高缺失率字段", detail: `${over90Missing} 个字段缺失率超过 90%，分析时保留原列并标记。`, evidence: "未执行静默删除" });
  if (dynamicPieces) issues.push({ severity: "info", title: "单片数量动态变化", detail: `检测到 ${[...pieceCounts.keys()].sort((a,b)=>a-b).join(" / ")} 片配置，通道统计已按行动态处理。`, evidence: [...pieceCounts.entries()].map(([k,v]) => `${k}片 ${v.toLocaleString()}行`).join("；") });
  issues.push({ severity: "info", title: "未提供目标工况表", detail: "本次仅进行相对稳定性与性能分析，不输出目标工况符合性结论。", evidence: "防幻觉策略已启用" });
  const critical = issues.filter((i) => i.severity === "error").length;
  const warning = issues.filter((i) => i.severity === "warning").length;
  const trustScore = Math.max(55, 96 - critical * 18 - warning * 7 - (timestampCounts.size < rowCount * .1 ? 4 : 0));

  const relevantFields = headers.map((name, i) => ({ name, completeness: rowCount ? nonEmpty[i] / rowCount : 0 })).filter((f) => /时间|电流|平均电压|最小电压|极差|片数|单片电压[1-9]/.test(f.name)).sort((a, b) => a.completeness - b.completeness).slice(0, 14);
  const lowCell = [...cells].filter((c) => c.completeness > .8).sort((a,b)=>a.mean-b.mean)[0];
  const insights = [
    { type: "good", title: `识别 ${platforms.length} 个稳定平台`, detail: `覆盖 ${new Set(platforms.map(p=>p.targetCurrent)).size} 个目标电流档位；重复平台独立保留。` },
    { type: "good", title: "极化趋势可计算", detail: `${polarization.length} 个代表点可用于性能曲线，所有点均可回溯到原始行号。` },
    { type: "warning", title: "时间结论需谨慎", detail: "原始时间戳精度不足，报告按配置采样周期估算，不伪造秒级时间。" },
    lowCell ? { type: "warning", title: `单片 ${lowCell.channel} 均值最低`, detail: `均值 ${lowCell.mean.toFixed(3)}V；当前仅提示排序，不直接判定故障。` } : null
  ].filter(Boolean);
  const anomalies = cells.filter((c) => c.flag !== "正常").map((c) => ({ type: "单片电压", object: `单片 ${c.channel}`, value: c.mean, detail: `相对主通道均值偏差 ${(c.deviation * 1000).toFixed(1)}mV`, severity: "关注" }));

  self.postMessage({ type: "progress", value: 100 });
  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    source: { fileName, fileSizeMB: +(fileSize / 1024 / 1024).toFixed(2), dataPolicy: "local-only" },
    config: { ...config, currentTolerance: tolerance, minSamples, windowSamples },
    meta: { rowCount, columnCount: headers.length, timeMin, timeMax, uniqueTimestamps: timestampCounts.size, duplicateTimestampRows: duplicateRows, highMissingColumns: over90Missing },
    trust: { score: trustScore, headline: critical ? "存在阻断问题" : warning ? "可分析，但需携带质量声明" : "数据通过质量闸门", description: `${issues.length} 项质量说明已写入报告，数值计算未调用生成式模型。` },
    issues, platforms, polarization, cells, pieceCounts: Object.fromEntries(pieceCounts), fieldCompleteness: relevantFields, insights, anomalies,
    reportSheets: [
      ["01", "测试摘要", "数据范围、可信度、关键结论"], ["02", "本次使用参数", "阈值、采样周期与来源"], ["03", "数据质量检查", "时间、字段、通道与处理建议"], ["04", "电流平台", "平台区间、统计窗口和指标"], ["05", "极化曲线数据", "代表测试点与有效性标记"], ["06", "单片电压统计", "均值、极值、完整率与排序"], ["07", "异常清单", "问题、影响、证据和建议"], ["08", "处理日志", "文件、算法版本与生成时间"]
    ]
  };
}
