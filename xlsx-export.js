/* Dependency-free XLSX report writer: 14 audited sheets plus a native line chart. */
(function () {
  const encoder = new TextEncoder();
  const xml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));
  const colName = (n) => { let out = ""; while (n) { n -= 1; out = String.fromCharCode(65 + n % 26) + out; n = Math.floor(n / 26); } return out; };
  const crcTable = (() => { const table = []; for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
  const crc32 = (bytes) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const u16 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255]);
  const u32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  const concat = (parts) => { const length = parts.reduce((sum, part) => sum + part.length, 0); const out = new Uint8Array(length); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out; };

  function zip(files) {
    let offset = 0;
    const locals = [], centrals = [];
    for (const file of files) {
      const name = encoder.encode(file.name), data = typeof file.data === "string" ? encoder.encode(file.data) : file.data, crc = crc32(data);
      const local = concat([u32(0x04034b50),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),name,data]);
      locals.push(local);
      centrals.push(concat([u32(0x02014b50),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name]));
      offset += local.length;
    }
    const central = concat(centrals);
    return concat([...locals, central, u32(0x06054b50),u16(0),u16(0),u16(files.length),u16(files.length),u32(central.length),u32(offset),u16(0)]);
  }

  function worksheet(rows, options = {}) {
    const maxCols = Math.max(1, ...rows.map((row) => row.length));
    let body = "";
    rows.forEach((row, rowIndex) => {
      body += `<row r="${rowIndex + 1}">`;
      row.forEach((value, colIndex) => {
        const ref = `${colName(colIndex + 1)}${rowIndex + 1}`, style = rowIndex === 0 ? 1 : (options.warningRows?.has(rowIndex) ? 2 : 0);
        if (typeof value === "number" && Number.isFinite(value)) body += `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
        else if (typeof value === "boolean") body += `<c r="${ref}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
        else body += `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
      });
      body += "</row>";
    });
    const widths = Array.from({ length: maxCols }, (_, colIndex) => {
      const width = Math.min(38, Math.max(12, ...rows.slice(0, 250).map((row) => String(row[colIndex] ?? "").length + 2)));
      return `<col min="${colIndex + 1}" max="${colIndex + 1}" width="${width}" customWidth="1"/>`;
    }).join("");
    const range = `A1:${colName(maxCols)}${Math.max(rows.length, 1)}`;
    const drawing = options.drawing ? '<drawing r:id="rId1"/>' : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="${range}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${widths}</cols><sheetData>${body}</sheetData><autoFilter ref="${range}"/>${drawing}</worksheet>`;
  }

  const number = (value, digits = null) => {
    if (value == null || !Number.isFinite(Number(value))) return "";
    return digits == null ? Number(value) : Number(Number(value).toFixed(digits));
  };

  function buildSheets(result) {
    const mapping = result.meta?.fieldMapping || {};
    const params = [
      ["CURRENT_TOLERANCE","电流允许偏差",result.config?.currentTolerance,"A","系统/用户模板"],
      ["MIN_CURRENT_PLATFORM_TIME","电流平台最短持续时间",result.config?.minSamples,"s","系统/用户模板"],
      ["DEFAULT_SAMPLE_TIME","默认统计截取时间",result.config?.windowSamples,"s","系统/用户模板"],
      ["SAMPLE_INTERVAL","采样周期",result.config?.sampleInterval,"s","系统/用户模板"],
      ["PRESSURE_TOLERANCE","压力稳定范围",result.config?.pressureTolerance,"±kPa","系统/用户模板"],
      ["TEMPERATURE_TOLERANCE","温度稳定范围",result.config?.temperatureTolerance,"±℃","系统/用户模板"],
      ["DEWPOINT_TOLERANCE","露点稳定范围",result.config?.dewpointTolerance,"±℃","系统/用户模板"],
      ["MISSING_PARAMETER_POLICY","缺失字段策略",result.config?.strictMode === false ? "宽松模式" : "严格模式","—","系统/用户模板"],
      ["REPEATED_CURRENT_POLICY","重复电流点",result.config?.repeatedCurrentPolicy || "分别统计","—","企业默认"],
      ["PRESSURE_STANDARD","压力口径",result.config?.pressureStandard || "表压",result.config?.pressureUnit || "kPa.g","企业默认"],
      ["HUMIDITY_STANDARD","湿度口径",result.config?.humidityStandard || "露点温度","℃","企业默认"]
    ];
    const sheets = [
      ["01_测试信息", [["项目","值","来源/说明"],
        ["批次编号",result.dataset?.id,"批次索引"],["批次名称",result.dataset?.name,"批次索引"],["企业",result.dataset?.organization,"企业资料包"],
        ["原始文件",result.source?.fileName,"源文件追溯"],["文件大小MB",number(result.source?.fileSizeMB,2),"源文件追溯"],["SHA-256",result.source?.sha256,"文件完整性"],
        ["记录数",result.meta?.rowCount,"解析结果"],["原始字段数",result.meta?.columnCount,"解析结果"],["开始时间",result.meta?.timeMin,"解析结果"],["结束时间",result.meta?.timeMax,"解析结果"],
        ["片数配置",Object.entries(result.pieceCounts || {}).map(([k,v])=>`${k}片 ${v}行`).join("；"),"结构校核"],["质量闸门",result.qualityGate?.status,"质量检查"],
        ["标准字段",`${mapping.direct || 0}直接 / ${mapping.derived || 0}派生 / ${mapping.missing || 0}缺失`,`模板 ${result.parameterTemplateVersion || "—"}`],
        ["分析引擎",result.engineVersion || result.schemaVersion,"处理版本"],["生成时间",result.generatedAt,"UTC"]]],
      ["02_本次使用参数", [["参数代码","参数名称","生效值","单位/选项","来源"], ...params]],
      ["03_目标工况设定", [["状态","工况编号","目标电流","说明"],["未提供","—","—","未提供独立目标工况设定表；本报告不执行目标符合性判定"]]],
      ["04_字段映射", [["标准字段","原始字段/计算来源","原始单位","输出单位","换算关系","完整率","状态"], ...(result.fieldMappings || []).map((m)=>[m.standardField,m.sourceField,m.sourceUnit,m.outputUnit,m.conversion,number(m.completeness,4),m.status])]],
      ["05_数据质量检查", [["级别","类别","问题","说明","证据","处理动作"], ...(result.issues || []).map((i)=>[i.severity,i.category,i.title,i.detail,i.evidence,i.action])]],
      ["06_电流平台", [["平台","目标电流A","重复序号","起始时间","结束时间","持续时间s","样本数","统计样本","起始行","结束行","实测均值A","曲线状态","目标符合性"], ...(result.platforms || []).map((p)=>[p.label || p.id,number(p.targetCurrent),p.occurrence || 1,p.startTime,p.endTime,number(p.durationSeconds ?? p.sampleCount),p.sampleCount,p.statisticSamples,p.startRow,p.endRow,number(p.actualCurrent,4),p.status,p.complianceStatus || "未判定"])]],
      ["07_稳定区间", [["平台","候选区间行号","选定统计区间","相对稳定性","统计时长s","曲线有效性","目标符合性","说明"], ...(result.platforms || []).map((p)=>[p.label || p.id,`${p.startRow}-${p.endRow}`,`${p.statisticStartRow || Math.max(p.startRow,p.endRow-p.statisticSamples+1)}-${p.endRow}`,p.stabilityStatus || "相对稳定",p.statisticSamples,p.status,p.complianceStatus || "未判定","无独立目标工况表，仅作相对稳定性统计"])]],
      ["08_极化曲线数据", [["实际电流密度A/cm²","实际电流A","目标电流A","平均单片电压V","最低单片电压V","单片标准差mV","有效样本","平台编号","状态"], ...(result.polarization || []).map((p)=>[number(p.x,6),number(p.current,4),number(p.targetCurrent),number(p.y,6),number(p.minCellVoltage,6),number(p.cellStd,4),p.samples,p.platformId,p.status])]],
      ["09_实际工况汇总", [["平台","目标电流A","实测电流A","氢气计量比","氢气流量SLPM","氢气入口压力kPa.g","氢气入口温度℃","氢气露点℃","空气计量比","空气流量SLPM","空气入口压力kPa.g","空气入口温度℃","空气露点℃","冷却液流量L/min","冷却液入口温度℃","冷却液温差℃","阳极流阻kPa","阴极流阻kPa","冷却流阻kPa","符合性"], ...(result.conditions || []).map((c)=>[c.label,number(c.targetCurrent),number(c.actualCurrent,4),number(c.h2Stoich,4),number(c.h2Flow,4),number(c.h2Pressure,4),number(c.h2Temperature,4),number(c.h2Dewpoint,4),number(c.airStoich,4),number(c.airFlow,4),number(c.airPressure,4),number(c.airTemperature,4),number(c.airDewpoint,4),number(c.coolantFlow,4),number(c.coolantInTemperature,4),number(c.coolantDeltaTemperature,4),number(c.h2Resistance,4),number(c.airResistance,4),number(c.coolantResistance,4),c.complianceStatus || "未判定"])]],
      ["10_目标工况对比", [["平台","参数","目标值","允许下限","允许上限","实际均值","偏差","结论","依据"], ...((result.platforms || []).map((p)=>[p.label || p.id,"全部启用工况","","","","","","未判定","未提供独立目标工况设定表"]))]],
      ["11_单片电压统计", [["排序","通道","均值V","最小V","最大V","标准差V","相对离均差mV","有效样本","应有样本","完整率","结论"], ...(result.cells || []).map((c)=>[c.rank || "",c.channel,number(c.mean,6),number(c.min,6),number(c.max,6),number(c.std,6),number(c.deviation*1000,4),c.count,c.eligibleRows || "",number(c.completeness,4),"阈值未配置，仅排序"])]],
      ["12_异常清单", [["级别","类别","对象","证据/数值","处理建议"], ...(result.anomalies || []).map((a)=>[a.severity,a.type,a.object,a.value,a.detail])]],
      ["13_图表", [["实际电流密度A/cm²","平均单片电压V","平台编号","状态"], ...(result.polarization || []).map((p)=>[number(p.x,6),number(p.y,6),p.platformId,p.status])]],
      ["14_处理日志", [["时间","处理阶段","记录","状态"], ...(result.auditLog || []).map((log)=>[log.time,log.stage,log.detail,log.status])]]
    ];
    const aiEntries = Object.entries(result.aiAnalyses || {});
    if (aiEntries.length) {
      const sectionNames = { qualityAiResult: "数据质量", platformAiResult: "电流平台", conditionAiResult: "实际工况", cellAiResult: "单片一致性", reportAiResult: "报告摘要" };
      const rows = [["分析范围","内容类型","标题","证据/内容","建议"]];
      aiEntries.forEach(([key, analysis]) => {
        const section = sectionNames[key] || key;
        rows.push([section,"摘要",analysis.summary || "",analysis.answer || "",""]);
        (analysis.findings || []).forEach((item) => rows.push([section,item.severity || "发现",item.title,item.evidence,item.recommendation]));
        (analysis.limitations || []).forEach((item) => rows.push([section,"分析边界","",item,""]));
      });
      sheets.push(["15_AI分析", rows]);
    }
    return sheets;
  }

  function chartXml(pointCount) {
    const last = Math.max(2, pointCount + 1);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1400" b="1"/><a:t>极化性能曲线</a:t></a:r></a:p></c:rich></c:tx><c:layout/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>平均单片电压</c:v></c:tx><c:spPr><a:ln w="28575"><a:solidFill><a:srgbClr val="00A9A9"/></a:solidFill></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/></c:marker><c:cat><c:numRef><c:f>'13_图表'!$A$2:$A$${last}</c:f></c:numRef></c:cat><c:val><c:numRef><c:f>'13_图表'!$B$2:$B$${last}</c:f></c:numRef></c:val><c:smooth val="0"/></c:ser><c:axId val="901"/><c:axId val="902"/></c:lineChart><c:catAx><c:axId val="901"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>实际电流密度 (A/cm²)</a:t></a:r></a:p></c:rich></c:tx><c:layout/></c:title><c:numFmt formatCode="0.00" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="902"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/></c:catAx><c:valAx><c:axId val="902"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>平均单片电压 (V)</a:t></a:r></a:p></c:rich></c:tx><c:layout/></c:title><c:numFmt formatCode="0.000" sourceLinked="0"/><c:majorGridlines/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="901"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/><c:layout/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
  }

  function build(result) {
    const sheets = buildSheets(result), files = [], chartSheetIndex = 12;
    files.push({ name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>` });
    files.push({ name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
    files.push({ name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map(([name],i)=>`<sheet name="${xml(name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join("")}</sheets></workbook>` });
    files.push({ name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
    files.push({ name: "xl/styles.xml", data: `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Arial"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF087C80"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF0CF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` });
    sheets.forEach(([,rows],i) => files.push({ name: `xl/worksheets/sheet${i+1}.xml`, data: worksheet(rows, { drawing: i === chartSheetIndex }) }));
    files.push({ name: `xl/worksheets/_rels/sheet${chartSheetIndex+1}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>` });
    files.push({ name: "xl/drawings/drawing1.xml", data: `<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>15</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>22</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="极化性能曲线"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>` });
    files.push({ name: "xl/drawings/_rels/drawing1.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>` });
    files.push({ name: "xl/charts/chart1.xml", data: chartXml(result.polarization?.length || 0) });
    return zip(files);
  }

  globalThis.StackPilotXlsx = {
    build,
    export(result) {
      const blob = new Blob([build(result)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `StackPilot_${result.dataset?.id || "REPORT"}_${new Date().toISOString().slice(0,10)}.xlsx`;
      a.hidden = true;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
  };
})();
