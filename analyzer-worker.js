/* StackPilot local-only CSV analysis worker. No data leaves the browser. */

self.onmessage = (event) => {
  const { text, fileName, fileSize, sha256, config } = event.data;
  try {
    const result = analyzeCsv(text, fileName, fileSize, sha256, config);
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

function analyzeCsv(text, fileName, fileSize, sha256, config) {
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
      idx.signals = {
        currentDensity: headers.indexOf("电流密度（mA/cm2）"), stackVoltage: headers.indexOf("总电压（V）"), power: headers.indexOf("功率（kW)"),
        maxCell: headers.indexOf("最大电压（V）"), cellStd: headers.indexOf("标准差（mV）"),
        h2Flow: headers.indexOf("阳极流量（SLPM）"), h2Pressure: headers.indexOf("阳极入堆压力（kPa）"), h2OutPressure: headers.indexOf("阳极出堆压力（kPa）"), h2Temperature: headers.indexOf("阳极入堆温度（℃）"), h2Dewpoint: headers.indexOf("阳极增湿罐水温度（℃）"),
        airFlow: headers.indexOf("阴极流量（SLPM）"), airPressure: headers.indexOf("阴极入堆压力（kPa）"), airOutPressure: headers.indexOf("阴极出堆压力（kPa）"), airTemperature: headers.indexOf("阴极入堆温度（℃）"), airDewpoint: headers.indexOf("阴极增湿罐水温度（℃）"),
        coolantFlow: headers.indexOf("循环水流量（L/min）"), coolantPressure: headers.indexOf("循环水入堆压力（kPa）"), coolantOutPressure: headers.indexOf("循环水出堆压力（kPa）"), coolantInTemperature: headers.indexOf("循环水入堆温度（℃）"), coolantOutTemperature: headers.indexOf("循环水出堆温度（℃）")
      };
      if (idx.target < 0 || idx.actual < 0) throw new Error("无法识别目标电流或实测电流字段，请在字段映射中确认原始表头。");
      return;
    }
    rowCount += 1;
    for (let i = 0; i < headers.length; i += 1) if ((row[i] ?? "").trim() !== "") nonEmpty[i] += 1;
    const timestamp = idx.timestamp >= 0 ? (row[idx.timestamp] || "").trim() : String(rowCount);
    timestampCounts.set(timestamp, (timestampCounts.get(timestamp) || 0) + 1);
    if (timestamp) {
      const epoch = Date.parse(timestamp.replace(/\//g, "-"));
      if (Number.isFinite(epoch)) { if (timeMin == null || epoch < timeMin) timeMin = epoch; if (timeMax == null || epoch > timeMax) timeMax = epoch; }
    }
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
    const signal = (key) => idx.signals[key] >= 0 ? toNumber(row[idx.signals[key]]) : NaN;
    rows.push({
      timestamp, target, actual, avgCell, minCell, range,
      currentDensity: signal("currentDensity"), stackVoltage: signal("stackVoltage"), power: signal("power"), maxCell: signal("maxCell"), cellStd: signal("cellStd"),
      h2Flow: signal("h2Flow"), h2Pressure: signal("h2Pressure"), h2OutPressure: signal("h2OutPressure"), h2Temperature: signal("h2Temperature"), h2Dewpoint: signal("h2Dewpoint"),
      airFlow: signal("airFlow"), airPressure: signal("airPressure"), airOutPressure: signal("airOutPressure"), airTemperature: signal("airTemperature"), airDewpoint: signal("airDewpoint"),
      coolantFlow: signal("coolantFlow"), coolantPressure: signal("coolantPressure"), coolantOutPressure: signal("coolantOutPressure"), coolantInTemperature: signal("coolantInTemperature"), coolantOutTemperature: signal("coolantOutTemperature")
    });
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
      const span = (key) => {
        const values = slice.map((r) => r[key]).filter(Number.isFinite);
        return values.length === slice.length ? Math.max(...values) - Math.min(...values) : Infinity;
      };
      const relativeStable = [
        ["h2Pressure", (Number(config.pressureTolerance) || 1) * 2], ["airPressure", (Number(config.pressureTolerance) || 1) * 2], ["coolantPressure", (Number(config.pressureTolerance) || 1) * 2],
        ["h2Temperature", (Number(config.temperatureTolerance) || 1) * 2], ["h2Dewpoint", (Number(config.dewpointTolerance) || 1) * 2], ["airTemperature", (Number(config.temperatureTolerance) || 1) * 2], ["airDewpoint", (Number(config.dewpointTolerance) || 1) * 2], ["coolantInTemperature", (Number(config.temperatureTolerance) || 1) * 2]
      ].every(([key, allowed]) => span(key) <= allowed);
      const metrics = {};
      ["actual","currentDensity","stackVoltage","power","avgCell","minCell","maxCell","range","cellStd","h2Flow","h2Pressure","h2OutPressure","h2Temperature","h2Dewpoint","airFlow","airPressure","airOutPressure","airTemperature","airDewpoint","coolantFlow","coolantPressure","coolantOutPressure","coolantInTemperature","coolantOutTemperature"].forEach((key) => { metrics[key] = mean(key); });
      platforms.push({
        id: platforms.length + 1,
        targetCurrent: rows[start].target,
        startRow: start + 2,
        endRow: i + 1,
        startTime: rows[start].timestamp,
        endTime: rows[i - 1].timestamp,
        sampleCount: fullCount,
        durationSeconds: fullCount * (Number(config.sampleInterval) || 1),
        statisticSamples: slice.length,
        statisticStartRow: statStart + 2,
        actualCurrent: metrics.actual,
        currentDensity: Number.isFinite(metrics.currentDensity) ? metrics.currentDensity / 1000 : null,
        avgCellVoltage: metrics.avgCell,
        minCellVoltage: metrics.minCell,
        cellRange: metrics.range,
        cellStd: metrics.cellStd,
        stackVoltage: metrics.stackVoltage,
        power: metrics.power,
        status: relativeStable && fullCount >= windowSamples ? "正式点" : relativeStable ? "观察点" : "工况复核",
        stabilityStatus: relativeStable ? "相对稳定" : "工况波动待复核",
        complianceStatus: "未判定",
        metrics
      });
    }
    start = i;
  }

  const occurrences = new Map();
  platforms.forEach((p) => { const n = (occurrences.get(p.targetCurrent) || 0) + 1; occurrences.set(p.targetCurrent, n); p.occurrence = n; p.label = `${p.targetCurrent}A-${n}`; });
  const bestByTarget = new Map();
  platforms.forEach((p) => { const old = bestByTarget.get(p.targetCurrent); if (!old || p.sampleCount > old.sampleCount) bestByTarget.set(p.targetCurrent, p); });
  const polarization = [...bestByTarget.values()].filter((p) => Number.isFinite(p.avgCellVoltage)).sort((a, b) => a.targetCurrent - b.targetCurrent).map((p) => ({ x: Number.isFinite(p.currentDensity) ? p.currentDensity : p.targetCurrent, current: p.actualCurrent, targetCurrent: p.targetCurrent, y: p.avgCellVoltage, minCellVoltage: p.minCellVoltage, cellStd: p.cellStd, samples: p.sampleCount, platformId: p.id, status: p.status }));
  const cells = cellStats.map((s, i) => ({ channel: i + 1, mean: s.count ? s.sum / s.count : null, min: s.count ? s.min : null, max: s.count ? s.max : null, count: s.count, completeness: operatingRows ? s.count / operatingRows : 0 })).filter((s) => s.count > 0);
  const meanCell = cells.filter((c) => c.completeness > .8).reduce((a, c) => a + c.mean, 0) / Math.max(1, cells.filter((c) => c.completeness > .8).length);
  cells.forEach((c) => { c.deviation = c.mean - meanCell; c.flag = "仅排序"; });
  [...cells].sort((a,b)=>a.deviation-b.deviation).forEach((c,index)=>{ c.rank=index+1; });
  const over90Missing = nonEmpty.filter((n) => rowCount && n / rowCount < .1).length;
  const duplicateRows = [...timestampCounts.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0);
  const dynamicPieces = pieceCounts.size > 1;
  const issues = [];
  if (duplicateRows > 0) issues.push({ severity: "warning", category: "时间质量", title: "源时间戳精度不足", detail: `${duplicateRows.toLocaleString()} 行处于重复分钟时间戳中，持续时间按采样周期换算。`, evidence: `${timestampCounts.size.toLocaleString()} 个分钟时间戳 / ${rowCount.toLocaleString()} 行`, action: "保留样本数、换算时长与原始行号" });
  if (over90Missing > 0) issues.push({ severity: "info", category: "字段完整性", title: "存在未启用或高缺失率列", detail: `${over90Missing} 个字段缺失率超过 90%，原始列保留且不参与无依据计算。`, evidence: "未执行静默删除", action: "仅统计已映射且有有效值的信号" });
  if (dynamicPieces) issues.push({ severity: "info", category: "结构校核", title: "电堆片数随测试阶段变化", detail: `检测到 ${[...pieceCounts.keys()].sort((a,b)=>a-b).join(" / ")} 片配置，通道统计按行实际片数处理。`, evidence: [...pieceCounts.entries()].map(([k,v]) => `${k}片 ${v.toLocaleString()}行`).join("；"), action: "不将未配置通道判定为低电压" });
  issues.push({ severity: "warning", category: "目标工况", title: "未提供独立目标工况设定表", detail: "本批次仅进行相对稳定性与实际工况分析，不输出目标符合性结论。", evidence: "符合企业任务说明书的无设定表处理规则", action: "目标工况对比保持未判定" });
  const critical = issues.filter((i) => i.severity === "error").length;
  const warning = issues.filter((i) => i.severity === "warning").length;
  const mappingSpecs = [
    ["目标电流","电流设定值（A）","A","A","原值"],["实测电流","实际电流（A）","A","A","原值"],["实测电流密度","电流密度（mA/cm2）","mA/cm²","A/cm²","×0.001"],
    ["氢气流量","阳极流量（SLPM）","SLPM","SLPM","原值"],["氢气入口压力","阳极入堆压力（kPa）","kPa","kPa.g","原值"],["氢气入口温度","阳极入堆温度（℃）","℃","℃","原值"],["氢气入口露点","阳极增湿罐水温度（℃）","℃","℃","原值"],
    ["空气流量","阴极流量（SLPM）","SLPM","SLPM","原值"],["空气入口压力","阴极入堆压力（kPa）","kPa","kPa.g","原值"],["空气入口温度","阴极入堆温度（℃）","℃","℃","原值"],["空气入口露点","阴极增湿罐水温度（℃）","℃","℃","原值"],
    ["冷却液入口温度","循环水入堆温度（℃）","℃","℃","原值"],["冷却液流量","循环水流量（L/min）","L/min","L/min","原值"],["电堆总电压","总电压（V）","V","V","原值"],["平均单片电压","平均电压（V）","V","V","原值"],["单片电压","单片电压1（V）…","V","V","动态通道"]
  ];
  const fieldMappings = mappingSpecs.map(([standardField,sourceField,sourceUnit,outputUnit,conversion]) => { const column = sourceField.endsWith("…") ? idx.cells[0] : headers.indexOf(sourceField); const completeness = column >= 0 ? nonEmpty[column] / Math.max(1,rowCount) : 0; return { standardField, sourceField, sourceUnit, outputUnit, conversion, completeness, status: column >= 0 ? "已映射" : "缺失" }; });
  fieldMappings.push({ standardField: "冷却液温差", sourceField: "循环水出堆温度 - 循环水入堆温度", sourceUnit: "℃", outputUnit: "℃", conversion: "公式计算", completeness: 1, status: "可计算" });
  fieldMappings.push({ standardField: "内阻", sourceField: "—", sourceUnit: "—", outputUnit: "mΩ", conversion: "未提供", completeness: 0, status: "缺失" });
  const mappingSummary = { direct: fieldMappings.filter((m)=>m.status==="已映射").length, derived: fieldMappings.filter((m)=>m.status==="可计算").length, missing: fieldMappings.filter((m)=>m.status==="缺失").length, total: fieldMappings.length };

  const relevantFields = headers.map((name, i) => ({ name, completeness: rowCount ? nonEmpty[i] / rowCount : 0 })).filter((f) => /时间|电流|平均电压|最小电压|极差|片数|单片电压[1-9]/.test(f.name)).sort((a, b) => a.completeness - b.completeness).slice(0, 14);
  const lowCell = [...cells].filter((c) => c.completeness > .8).sort((a,b)=>a.mean-b.mean)[0];
  const insights = [
    { type: "good", title: `识别 ${platforms.length} 个稳定平台`, detail: `覆盖 ${new Set(platforms.map(p=>p.targetCurrent)).size} 个目标电流档位；重复平台独立保留。` },
    { type: "good", title: "极化趋势可计算", detail: `${polarization.length} 个代表点可用于性能曲线，所有点均可回溯到原始行号。` },
    { type: "warning", title: "时间结论需谨慎", detail: "原始时间戳精度不足，报告按配置采样周期估算，不伪造秒级时间。" },
    lowCell ? { type: "warning", title: `单片 ${lowCell.channel} 均值最低`, detail: `均值 ${lowCell.mean.toFixed(3)}V；当前仅提示排序，不直接判定故障。` } : null
  ].filter(Boolean);
  const anomalies = issues.map((issue) => ({ type: issue.category, object: issue.title, value: issue.evidence, detail: issue.action, severity: issue.severity === "warning" ? "警告" : "说明" }));
  const conditions = platforms.map((p) => ({
    platformId: p.id, label: p.label, targetCurrent: p.targetCurrent, actualCurrent: p.actualCurrent, currentDensity: p.currentDensity,
    h2Flow: p.metrics.h2Flow, h2Pressure: p.metrics.h2Pressure, h2Temperature: p.metrics.h2Temperature, h2Dewpoint: p.metrics.h2Dewpoint,
    airFlow: p.metrics.airFlow, airPressure: p.metrics.airPressure, airTemperature: p.metrics.airTemperature, airDewpoint: p.metrics.airDewpoint,
    coolantFlow: p.metrics.coolantFlow, coolantInTemperature: p.metrics.coolantInTemperature,
    coolantDeltaTemperature: Number.isFinite(p.metrics.coolantOutTemperature) && Number.isFinite(p.metrics.coolantInTemperature) ? p.metrics.coolantOutTemperature - p.metrics.coolantInTemperature : null,
    h2Resistance: Number.isFinite(p.metrics.h2Pressure) && Number.isFinite(p.metrics.h2OutPressure) ? p.metrics.h2Pressure - p.metrics.h2OutPressure : null,
    airResistance: Number.isFinite(p.metrics.airPressure) && Number.isFinite(p.metrics.airOutPressure) ? p.metrics.airPressure - p.metrics.airOutPressure : null,
    coolantResistance: Number.isFinite(p.metrics.coolantPressure) && Number.isFinite(p.metrics.coolantOutPressure) ? p.metrics.coolantPressure - p.metrics.coolantOutPressure : null,
    complianceStatus: "未判定"
  }));
  const generatedAt = new Date().toISOString();

  self.postMessage({ type: "progress", value: 100 });
  return {
    schemaVersion: "2.0",
    engineVersion: "2.0.0-local",
    parameterTemplateVersion: "LOCAL-T02",
    generatedAt,
    dataset: { id: `LOCAL-${generatedAt.slice(0,10).replaceAll("-","")}`, name: fileName.replace(/\.csv$/i,""), organization: "本机导入", sourceType: "CSV 时序数据", reviewStatus: "本机分析" },
    source: { fileName, fileSizeBytes: fileSize, fileSizeMB: +(fileSize / 1024 / 1024).toFixed(2), sha256, dataPolicy: "local-only" },
    config: { ...config, currentTolerance: tolerance, minSamples, windowSamples },
    meta: { rowCount, columnCount: headers.length, timeMin: timeMin == null ? null : new Date(timeMin).toISOString(), timeMax: timeMax == null ? null : new Date(timeMax).toISOString(), uniqueTimestamps: timestampCounts.size, duplicateTimestampRows: duplicateRows, highMissingColumns: over90Missing, activeCellChannels: cells.length, reservedCellChannels: Math.max(0,idx.cells.length-cells.length), fieldMapping: mappingSummary },
    qualityGate: { status: critical ? "阻断" : warning ? "有条件通过" : "通过", code: critical ? "BLOCKED" : warning ? "CONDITIONAL_PASS" : "PASS", errors: critical, warnings: warning, notices: issues.filter((i)=>i.severity==="info").length, headline: critical ? "存在阻断问题" : "数据可用于性能与实际工况分析", description: "限制项与处理依据已写入报告；缺失结论保持未判定。" },
    trust: { score: null, headline: "数据质量闸门已完成", description: "限制项与处理依据已写入报告。" },
    issues, platforms, polarization, conditions, cells, pieceCounts: Object.fromEntries(pieceCounts), fieldMappings, fieldCompleteness: relevantFields, insights, anomalies,
    auditLog: [
      {time:generatedAt,stage:"文件校验",detail:`SHA-256 ${sha256 || "未生成"}`,status:"完成"},
      {time:generatedAt,stage:"字段映射",detail:`直接映射 ${mappingSummary.direct}，派生 ${mappingSummary.derived}，缺失 ${mappingSummary.missing}`,status:"完成"},
      {time:generatedAt,stage:"平台识别",detail:`识别 ${platforms.length} 个平台，重复电流点独立保留`,status:"完成"},
      {time:generatedAt,stage:"报告快照",detail:"StackPilot Engine 2.0.0-local",status:"完成"}
    ],
    reportSheets: [
      ["01","测试信息","批次、数据范围、校验值与版本"],["02","本次使用参数","生效阈值、规则及参数来源"],["03","目标工况设定","输入状态与符合性判定边界"],["04","字段映射","标准字段、原始字段、单位及换算"],["05","数据质量检查","问题、证据、影响与处理动作"],["06","电流平台","重复点、区间、时长与原始行号"],["07","稳定区间","统计窗口、相对稳定性与有效性"],["08","极化曲线数据","电流密度、电压与平台引用"],["09","实际工况汇总","阳极、阴极与冷却回路统计"],["10","目标工况对比","缺少设定表时明确标记未判定"],["11","单片电压统计","动态片数、完整率与排序"],["12","异常清单","质量问题、工况限制与建议"],["13","图表","极化曲线及引用数据"],["14","处理日志","校验、映射、识别与版本追踪"]
    ]
  };
}
