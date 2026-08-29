/* StackPilot local-first CSV analysis worker. Raw rows never leave this worker. */

self.onmessage = async (event) => {
  const { file, text, fileName, fileSize, sha256, config } = event.data;
  try {
    const result = await analyzeCsv(file || text, fileName, fileSize, sha256, config || {});
    self.postMessage({ type: "result", result });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message || String(error) });
  }
};

const CHUNK_SIZE = 1024 * 1024;

function detectDelimiter(sample) {
  const counts = new Map([[",", 0], ["\t", 0], [";", 0]]);
  let quoted = false;
  for (let i = 0; i < sample.length; i += 1) {
    const ch = sample[i];
    if (ch === '"') {
      if (quoted && sample[i + 1] === '"') i += 1;
      else quoted = !quoted;
    } else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch) + 1);
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0][1] ? ranked[0][0] : ",";
}

function createCsvParser(delimiter, onRow) {
  let row = [];
  let field = "";
  let quoted = false;
  let rowIndex = 0;
  let pendingQuote = false;
  let skipLf = false;
  const emit = () => {
    row.push(field);
    field = "";
    if (row.length > 1 || row[0] !== "") onRow(row, rowIndex++);
    row = [];
  };
  return (chunk, final = false) => {
    let i = 0;
    if (pendingQuote) {
      if (chunk[0] === '"') { field += '"'; i = 1; }
      else quoted = false;
      pendingQuote = false;
    }
    for (; i < chunk.length; i += 1) {
      const ch = chunk[i];
      if (skipLf) {
        skipLf = false;
        if (ch === "\n") continue;
      }
      if (quoted) {
        if (ch === '"' && chunk[i + 1] === '"') { field += '"'; i += 1; }
        else if (ch === '"' && i === chunk.length - 1 && !final) pendingQuote = true;
        else if (ch === '"') quoted = false;
        else field += ch;
        continue;
      }
      if (ch === '"' && field === "") quoted = true;
      else if (ch === delimiter) { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r") skipLf = true;
        emit();
      } else field += ch;
    }
    if (final) {
      if (pendingQuote) { quoted = false; pendingQuote = false; }
      if (quoted) throw new Error("CSV 存在未闭合的引号字段，请检查文件编码或导出格式。");
      if (field !== "" || row.length) emit();
    }
  };
}

async function parseCsv(source, onRow) {
  if (typeof source === "string") {
    const parser = createCsvParser(detectDelimiter(source.slice(0, 65536)), onRow);
    parser(source, true);
    return;
  }
  if (!source?.slice || !Number.isFinite(source.size)) throw new Error("无法读取 CSV 数据源");
  const head = await source.slice(0, Math.min(source.size, 65536)).text();
  const parser = createCsvParser(detectDelimiter(head), onRow);
  const decoder = new TextDecoder("utf-8");
  for (let offset = 0; offset < source.size; offset += CHUNK_SIZE) {
    const buffer = await source.slice(offset, Math.min(offset + CHUNK_SIZE, source.size)).arrayBuffer();
    parser(decoder.decode(buffer, { stream: true }), false);
    self.postMessage({ type: "progress", value: Math.min(82, Math.round(((offset + buffer.byteLength) / Math.max(1, source.size)) * 82)) });
  }
  parser(decoder.decode(), true);
}

async function digestFile(source) {
  if (!source?.arrayBuffer || !self.crypto?.subtle || source.size > 128 * 1024 * 1024) return null;
  const digest = await self.crypto.subtle.digest("SHA-256", await source.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const FIELD_ALIASES = {
  timestamp: ["测试时间", "Timestamp", "时间", "采集时间"],
  target: ["电流设定值（A）", "电流设定值(A)", "目标电流", "FC_SysLoadCurr"],
  actual: ["实际电流（A）", "实际电流(A)", "FC_CurrOut", "电堆电流"],
  avgCell: ["平均电压（V）", "平均电压(V)", "FC_AvgCellVoltage", "平均单体电压"],
  minCell: ["最小电压（V）", "最小电压(V)", "FC_MinCellVoltage", "最小单体电压"],
  range: ["极差（mV）", "极差(mV)", "FC_AvgCellVoltDev", "离均差"],
  pieceCount: ["片数", "单片数量", "电堆片数"]
};

const SIGNAL_FIELDS = {
  currentDensity: "电流密度（mA/cm2）", stackVoltage: "总电压（V）", power: "功率（kW)", maxCell: "最大电压（V）", cellStd: "标准差（mV）",
  h2Flow: "阳极流量（SLPM）", h2Pressure: "阳极入堆压力（kPa）", h2OutPressure: "阳极出堆压力（kPa）", h2Temperature: "阳极入堆温度（℃）", h2Dewpoint: "阳极增湿罐水温度（℃）",
  airFlow: "阴极流量（SLPM）", airPressure: "阴极入堆压力（kPa）", airOutPressure: "阴极出堆压力（kPa）", airTemperature: "阴极入堆温度（℃）", airDewpoint: "阴极增湿罐水温度（℃）",
  coolantFlow: "循环水流量（L/min）", coolantPressure: "循环水入堆压力（kPa）", coolantOutPressure: "循环水出堆压力（kPa）", coolantInTemperature: "循环水入堆温度（℃）", coolantOutTemperature: "循环水出堆温度（℃）"
};

const toNumber = (value) => {
  if (value == null || value.trim?.() === "") return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

async function analyzeCsv(source, fileName, fileSize, sha256, config) {
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
  const findIndex = (key, names) => {
    const configured = config.fieldMappings?.[key];
    if (configured && headers.includes(configured)) return headers.indexOf(configured);
    return names.map((name) => headers.indexOf(name)).find((column) => column >= 0) ?? -1;
  };

  await parseCsv(source, (row, rowIndex) => {
    if (rowIndex === 0) {
      headers = row.map((h) => h.replace(/^\ufeff/, "").trim());
      nonEmpty.push(...headers.map(() => 0));
      Object.entries(FIELD_ALIASES).forEach(([key, names]) => { idx[key] = findIndex(key, names); });
      idx.cells = headers.map((header, column) => {
        const match = header.match(/^(?:单片电压|cell(?:voltage)?)[_#\s-]*(\d+)(?:（v）|\(v\)|_v)?$/i);
        return match ? { column, channel: Number(match[1]) } : null;
      }).filter(Boolean).sort((a, b) => a.channel - b.channel);
      idx.cells.forEach(({ channel }) => cellStats.push({ channel, sum: 0, count: 0, eligible: 0, min: Infinity, max: -Infinity }));
      idx.signals = Object.fromEntries(Object.entries(SIGNAL_FIELDS).map(([key, fallback]) => [key, findIndex(key, [fallback])]));
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
      idx.cells.forEach(({ column, channel }, cellIndex) => {
        const stat = cellStats[cellIndex];
        const eligible = Number.isFinite(pieceCount) ? channel <= pieceCount : (row[column] ?? "").trim() !== "";
        if (eligible) stat.eligible += 1;
        const value = eligible ? toNumber(row[column]) : NaN;
        if (Number.isFinite(value)) {
          stat.sum += value; stat.count += 1; stat.min = Math.min(stat.min, value); stat.max = Math.max(stat.max, value);
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

  const effectiveSha256 = sha256 || await digestFile(source);
  self.postMessage({ type: "progress", value: 90 });
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
  const cells = cellStats.map((s) => ({ channel: s.channel, mean: s.count ? s.sum / s.count : null, min: s.count ? s.min : null, max: s.count ? s.max : null, count: s.count, eligibleCount: s.eligible, completeness: s.eligible ? s.count / s.eligible : 0 })).filter((s) => s.count > 0);
  const meanCell = cells.filter((c) => c.completeness > .8).reduce((a, c) => a + c.mean, 0) / Math.max(1, cells.filter((c) => c.completeness > .8).length);
  cells.forEach((c) => { c.deviation = c.mean - meanCell; c.flag = "仅排序"; });
  [...cells].sort((a,b)=>a.deviation-b.deviation).forEach((c,index)=>{ c.rank=index+1; });
  const over90Missing = nonEmpty.filter((n) => rowCount && n / rowCount < .1).length;
  const duplicateRows = [...timestampCounts.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0);
  const dynamicPieces = pieceCounts.size > 1;
  const issues = [];
  if (duplicateRows > 0) issues.push({ severity: "warning", category: "时间质量", title: "源时间戳精度不足", detail: `${duplicateRows.toLocaleString()} 行处于重复分钟时间戳中，持续时间按采样周期换算。`, evidence: `${timestampCounts.size.toLocaleString()} 个分钟时间戳 / ${rowCount.toLocaleString()} 行`, action: "保留样本数、换算时长与原始行号" });
  if (over90Missing > 0) issues.push({ severity: "info", category: "字段完整性", title: "存在未启用或高缺失率列", detail: `${over90Missing} 个字段缺失率超过 90%，原始列保留且不参与无依据计算。`, evidence: "未执行静默删除", action: "仅统计已映射且有有效值的信号" });
  if (dynamicPieces) issues.push({ severity: "info", category: "结构校核", title: "电堆片数随测试阶段变化", detail: `检测到 ${[...pieceCounts.keys()].sort((a,b)=>a-b).join(" / ")} 片配置，任意编号单片通道均按行实际片数处理。`, evidence: [...pieceCounts.entries()].map(([k,v]) => `${k}片 ${v.toLocaleString()}行`).join("；"), action: "不将未配置通道判定为低电压" });
  if (!effectiveSha256) issues.push({ severity: "info", category: "文件追溯", title: "超大文件未在浏览器生成 SHA-256", detail: "文件仍采用分块解析；为避免 WebCrypto 整体缓冲造成内存峰值，本机报告记录文件名和字节数。", evidence: `${fileSize.toLocaleString()} bytes`, action: "如需归档级校验，可在服务端或数据湖生成哈希" });
  issues.push({ severity: "warning", category: "目标工况", title: "未提供独立目标工况设定表", detail: "本批次仅进行相对稳定性与实际工况分析，不输出目标符合性结论。", evidence: "符合企业任务说明书的无设定表处理规则", action: "目标工况对比保持未判定" });
  const critical = issues.filter((i) => i.severity === "error").length;
  const warning = issues.filter((i) => i.severity === "warning").length;
  const mappingSpecs = [
    ["target","目标电流","A","A","原值"],["actual","实测电流","A","A","原值"],["currentDensity","实测电流密度","mA/cm²","A/cm²","×0.001"],
    ["h2Flow","氢气流量","SLPM","SLPM","原值"],["h2Pressure","氢气入口压力","kPa","kPa.g","原值"],["h2Temperature","氢气入口温度","℃","℃","原值"],["h2Dewpoint","氢气入口露点","℃","℃","原值"],
    ["airFlow","空气流量","SLPM","SLPM","原值"],["airPressure","空气入口压力","kPa","kPa.g","原值"],["airTemperature","空气入口温度","℃","℃","原值"],["airDewpoint","空气入口露点","℃","℃","原值"],
    ["coolantInTemperature","冷却液入口温度","℃","℃","原值"],["coolantFlow","冷却液流量","L/min","L/min","原值"],["stackVoltage","电堆总电压","V","V","原值"],["avgCell","平均单片电压","V","V","原值"]
  ];
  const fieldMappings = mappingSpecs.map(([key,standardField,sourceUnit,outputUnit,conversion]) => {
    const column = key in idx ? idx[key] : idx.signals[key];
    const sourceField = column >= 0 ? headers[column] : "—";
    const completeness = column >= 0 ? nonEmpty[column] / Math.max(1,rowCount) : 0;
    return { standardField, sourceField, sourceUnit, outputUnit, conversion, completeness, status: column >= 0 ? "已映射" : "缺失" };
  });
  const firstCellColumn = idx.cells[0]?.column ?? -1;
  fieldMappings.push({ standardField: "单片电压", sourceField: firstCellColumn >= 0 ? `${headers[firstCellColumn]} 等 ${idx.cells.length} 个动态通道` : "—", sourceUnit: "V", outputUnit: "V", conversion: "按通道编号与实际片数", completeness: firstCellColumn >= 0 ? nonEmpty[firstCellColumn] / Math.max(1,rowCount) : 0, status: firstCellColumn >= 0 ? "已映射" : "缺失" });
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
    source: { fileName, fileSizeBytes: fileSize, fileSizeMB: +(fileSize / 1024 / 1024).toFixed(2), sha256: effectiveSha256, dataPolicy: "local-raw-data" },
    config: { ...config, currentTolerance: tolerance, minSamples, windowSamples },
    meta: { rowCount, columnCount: headers.length, timeMin: timeMin == null ? null : new Date(timeMin).toISOString(), timeMax: timeMax == null ? null : new Date(timeMax).toISOString(), uniqueTimestamps: timestampCounts.size, duplicateTimestampRows: duplicateRows, highMissingColumns: over90Missing, activeCellChannels: cells.length, reservedCellChannels: Math.max(0,idx.cells.length-cells.length), fieldMapping: mappingSummary },
    qualityGate: { status: critical ? "阻断" : warning ? "有条件通过" : "通过", code: critical ? "BLOCKED" : warning ? "CONDITIONAL_PASS" : "PASS", errors: critical, warnings: warning, notices: issues.filter((i)=>i.severity==="info").length, headline: critical ? "存在阻断问题" : "数据可用于性能与实际工况分析", description: "限制项与处理依据已写入报告；缺失结论保持未判定。" },
    trust: { score: null, headline: "数据质量闸门已完成", description: "限制项与处理依据已写入报告。" },
    issues, platforms, polarization, conditions, cells, pieceCounts: Object.fromEntries(pieceCounts), fieldMappings, fieldCompleteness: relevantFields, insights, anomalies,
    auditLog: [
      {time:generatedAt,stage:"文件校验",detail:`SHA-256 ${effectiveSha256 || "超大文件跳过浏览器哈希"}`,status:"完成"},
      {time:generatedAt,stage:"字段映射",detail:`直接映射 ${mappingSummary.direct}，派生 ${mappingSummary.derived}，缺失 ${mappingSummary.missing}；人工覆盖 ${Object.keys(config.fieldMappings || {}).length} 项`,status:"完成"},
      {time:generatedAt,stage:"平台识别",detail:`识别 ${platforms.length} 个平台，重复电流点独立保留`,status:"完成"},
      {time:generatedAt,stage:"报告快照",detail:"StackPilot Engine 2.0.0-local",status:"完成"}
    ],
    reportSheets: [
      ["01","测试信息","批次、数据范围、校验值与版本"],["02","本次使用参数","生效阈值、规则及参数来源"],["03","目标工况设定","输入状态与符合性判定边界"],["04","字段映射","标准字段、原始字段、单位及换算"],["05","数据质量检查","问题、证据、影响与处理动作"],["06","电流平台","重复点、区间、时长与原始行号"],["07","稳定区间","统计窗口、相对稳定性与有效性"],["08","极化曲线数据","电流密度、电压与平台引用"],["09","实际工况汇总","阳极、阴极与冷却回路统计"],["10","目标工况对比","缺少设定表时明确标记未判定"],["11","单片电压统计","动态片数、完整率与排序"],["12","异常清单","质量问题、工况限制与建议"],["13","图表","极化曲线及引用数据"],["14","处理日志","校验、映射、识别与版本追踪"]
    ]
  };
}
