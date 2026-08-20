/* Minimal dependency-free XLSX writer (ZIP store mode + inline strings). */
(function () {
  const encoder = new TextEncoder();
  const xml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));
  const colName = (n) => { let s=""; while(n){ n--; s=String.fromCharCode(65+n%26)+s; n=Math.floor(n/26); } return s; };
  const crcTable = (() => { const t=[]; for(let n=0;n<256;n++){let c=n; for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1; t[n]=c>>>0;} return t; })();
  const crc32 = (bytes) => { let c=0xffffffff; for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8); return (c^0xffffffff)>>>0; };
  const u16=(n)=>new Uint8Array([n&255,(n>>>8)&255]); const u32=(n)=>new Uint8Array([n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255]);
  const concat=(parts)=>{const len=parts.reduce((a,p)=>a+p.length,0),out=new Uint8Array(len);let o=0;for(const p of parts){out.set(p,o);o+=p.length;}return out;};
  function zip(files){let offset=0;const locals=[],centrals=[];for(const file of files){const name=encoder.encode(file.name),data=typeof file.data==="string"?encoder.encode(file.data):file.data,crc=crc32(data);const local=concat([u32(0x04034b50),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),name,data]);locals.push(local);centrals.push(concat([u32(0x02014b50),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name]));offset+=local.length;}const central=concat(centrals);return concat([...locals,central,u32(0x06054b50),u16(0),u16(0),u16(files.length),u16(files.length),u32(central.length),u32(offset),u16(0)]);}
  function worksheet(rows){let body="";rows.forEach((row,r)=>{body+=`<row r="${r+1}">`;row.forEach((value,c)=>{const ref=`${colName(c+1)}${r+1}`;if(typeof value==="number"&&Number.isFinite(value))body+=`<c r="${ref}" s="${r===0?1:0}"><v>${value}</v></c>`;else body+=`<c r="${ref}" t="inlineStr" s="${r===0?1:0}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;});body+="</row>";});const range=`A1:${colName(Math.max(...rows.map(r=>r.length),1))}${Math.max(rows.length,1)}`;return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${range}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols><col min="1" max="30" width="18" customWidth="1"/></cols><sheetData>${body}</sheetData><autoFilter ref="${range}"/></worksheet>`;}
  function buildSheets(result){
    const params=Object.entries(result.config).map(([k,v])=>[k,v,"用户配置"]);
    return [
      ["测试摘要",[["项目","值"],["源文件",result.source.fileName],["记录数",result.meta.rowCount],["字段数",result.meta.columnCount],["时间范围",`${result.meta.timeMin||""} ~ ${result.meta.timeMax||""}`],["可信度",result.trust.score],["稳定平台",result.platforms.length],["生成时间",result.generatedAt]]],
      ["本次使用参数",[["参数代码","生效值","来源"],...params]],
      ["数据质量检查",[["级别","问题","说明","证据"],...result.issues.map(x=>[x.severity,x.title,x.detail,x.evidence])]],
      ["电流平台",[["编号","目标电流A","样本数","统计样本","实测均值A","平均单片V","最低单片V","极差mV","起始行","结束行","状态"],...result.platforms.map(p=>[p.id,p.targetCurrent,p.sampleCount,p.statisticSamples,p.actualCurrent,p.avgCellVoltage,p.minCellVoltage,p.cellRange,p.startRow,p.endRow,p.status])]],
      ["极化曲线数据",[["目标电流A","平均单片电压V","有效样本"],...result.polarization.map(p=>[p.x,p.y,p.samples])]],
      ["单片电压统计",[["通道","均值V","最小V","最大V","完整率","偏差V","状态"],...result.cells.map(c=>[c.channel,c.mean,c.min,c.max,c.completeness,c.deviation,c.flag])]],
      ["异常清单",[["类型","对象","数值","说明","级别"],...result.anomalies.map(a=>[a.type,a.object,a.value,a.detail,a.severity])]],
      ["处理日志",[["时间","动作","说明"],[result.generatedAt,"本地分析","CSV 在浏览器内解析，未上传"],[result.generatedAt,"平台识别",`±${result.config.currentTolerance}A，最短${result.config.minSamples}样本`],[result.generatedAt,"报告生成","StackPilot schema 1.0"]]]
    ];
  }
  function build(result) {
    const sheets=buildSheets(result),files=[];
    files.push({name:"[Content_Types].xml",data:`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`});
    files.push({name:"_rels/.rels",data:`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`});
    files.push({name:"xl/workbook.xml",data:`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map(([name],i)=>`<sheet name="${xml(name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join("")}</sheets></workbook>`});
    files.push({name:"xl/_rels/workbook.xml.rels",data:`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`});
    files.push({name:"xl/styles.xml",data:`<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF087C80"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`});
    sheets.forEach(([,rows],i)=>files.push({name:`xl/worksheets/sheet${i+1}.xml`,data:worksheet(rows)}));
    return zip(files);
  }
  window.StackPilotXlsx={
    build,
    export(result){
      const blob=new Blob([build(result)],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
      const a=document.createElement("a");
      a.href=URL.createObjectURL(blob);
      a.download=`StackPilot_${new Date().toISOString().slice(0,10)}.xlsx`;
      a.hidden=true;
      document.body.appendChild(a);
      a.click();
      setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);
    }
  };
})();
