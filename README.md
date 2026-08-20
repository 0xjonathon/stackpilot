# StackPilot 堆智检 MVP

燃料电池电堆测试数据的本地可信分析与 XLSX 报告工具，面向浦发·IGNITE 未来能源黑客松 T02-03。

## 运行

使用 Python 3 启动静态服务器：

```bash
python3 serve.py
```

打开 `http://127.0.0.1:4173`。

应用运行仅需 Python 3 的标准库；CSV 解析、分析和 XLSX 生成全部在浏览器完成。

## 演示路径

1. 首页默认加载青川科技官方样例数据的派生分析结果。
2. 查看数据质量闸门、极化曲线与稳定平台。
3. 拖入 `02 样例数据-青川科技.csv`，在浏览器本机重新计算。
4. 在报告中心导出多工作表 XLSX 或完整分析 JSON。

## 隐私与可信性

- CSV 在浏览器 Web Worker 中解析，不上传到任何服务器。
- 数值由确定性规则计算，未调用生成式模型。
- 时间戳精度、动态单片数量、字段缺失与目标工况缺失均显式记录。
- 阈值、统计窗口、原始行号和处理日志随报告导出。

## 文件说明

- `index.html`：应用结构
- `styles.css`：响应式视觉系统
- `app.js`：界面状态、交互和图表
- `analyzer-worker.js`：本地 CSV 分析引擎
- `xlsx-export.js`：无依赖 XLSX 导出器
- `demo-analysis.json`：官方样例的派生统计，不含原始时序行
- `tools/build_demo.py`：从本地官方样例重建派生统计

重建演示数据需要 pandas/numpy，可传入 CSV 路径：

```bash
python3 tools/build_demo.py "/absolute/path/to/sample.csv"
```

企业资料仅限本次赛事使用，请勿对外传播原始数据。
