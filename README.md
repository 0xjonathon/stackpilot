# StackPilot 堆智检

燃料电池电堆测试数据分析与标准化报告平台，面向浦发·IGNITE 未来能源黑客松 T02-03 企业命题。

在线系统：[https://stackpilot-xi.vercel.app](https://stackpilot-xi.vercel.app)

## 产品能力

- 读取测试台 CSV 时序数据并在浏览器本机完成解析，原始记录不上传。
- 将测试台原始表头统一映射到企业标准字段，并记录单位与换算关系。
- 按电流允许偏差和最短持续时间识别电流平台，重复电流点独立保留。
- 生成极化性能、阳极/阴极/冷却回路实际工况、流阻和单片一致性统计。
- 在输入资料不足时明确输出“未判定”，不补造目标工况或内阻数据。
- 导出符合企业任务说明书结构的 14 工作表 XLSX 报告及审计 JSON。

## 基准批次

系统默认读取 `reference-analysis.json`。该文件由企业资料包中的原始 CSV 生成，只包含派生统计和追溯元数据，不包含原始时序行。

当前基准批次：

- 批次编号：`QC-FC-20260623-01`
- 原始记录：38,257 行、127 列
- 数据时间：2026-06-23 14:30 至 2026-06-24 17:29
- 标准字段：39 项直接映射、4 项派生、1 项明确缺失
- 平台结果：41 个独立电流平台、20 个代表电流档位

上述值均由构建脚本从资料包计算，不在界面代码中固定。

## 本地运行

```bash
python3 serve.py
```

访问 `http://127.0.0.1:4173`。应用运行只依赖 Python 标准库；CSV 解析、规则计算和 XLSX 生成在浏览器中完成。

## 重建基准分析

构建脚本需要 pandas 和 numpy：

```bash
python3 tools/build_reference_analysis.py "/absolute/path/to/02 样例数据-青川科技.csv"
```

构建过程会重新计算批次时间范围、字段映射、平台、工况、单片统计和 SHA-256 校验值，并覆盖 `reference-analysis.json`。

## 核心文件

- `index.html`：产品信息架构和无障碍语义
- `styles.css`：响应式视觉系统
- `app.js`：批次状态、交互和可视化
- `analyzer-worker.js`：本地 CSV 分析引擎
- `xlsx-export.js`：浏览器端 XLSX 报告生成器
- `reference-analysis.json`：企业原始数据的已校验派生分析快照
- `tools/build_reference_analysis.py`：可复现的基准分析构建程序

企业资料仅用于本次赛事的学习、开发、演示与评审。公开部署不包含原始时序数据。
