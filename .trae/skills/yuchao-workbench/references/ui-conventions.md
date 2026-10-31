# 界面约定 · klinecharts v10 / 主题 / 交互

写前端前先读本篇。技术栈：vite + 原生 TS（无框架）+ klinecharts v10。
入口 `frontend/src/main.ts`，每页一个模块 `src/pages/<page>.ts`，
API 只经 `src/api.ts` 且只 import `clients/ts/yuchao.d.ts`（契约生成物，勿手改）。

## klinecharts v10（血泪配置，逐条都是排障换来的）

- **dataLoader 门控**：v10 必须先显式 `setSymbol` + `setPeriod` 再喂 `getBars`，
  否则画布空白且**无任何报错**。初始化顺序固定，勿动。
- `offsetRightDistance: 0`：默认 50px 会让最新 K 线悬空，显式归零贴轴。
- `candle_up_stroke` 阳线空心、无网格线；成交量 Y 轴万/亿单位格式化。
- 原生滚轮缩放/拖拽平移保留，不自绘。
- **多布局**（单屏/左右/上下/四格）参考策影：上下/四格布局只显示主图，
  左右布局保留主+副图；布局选择 localStorage 持久化。
- 周期栏整合：周期选择器、布局、缩放、高度控制全部同一行，不散落。
- 图表高度支持拖拽调整 + 双击恢复默认，配置 localStorage 持久化。
- 指标面板：默认隐藏，点「指标」按钮在按钮正下方右对齐弹出，点外部关闭；
  主图叠加/副图两组分明；常显星标可把任意指标（含「更多」面板内）固定到工具栏。
- Y 轴刻度整数显示；十字光标 tooltip 紧凑、小号、半透明，不遮 K 线；
  日K标题=日期，周K=周区间+「周线」，月K=月份+「月线」。
- 指标图例（MA 标签等）半透明胶囊浮在图右上角，`pointer-events:none` 防挡十字光标。
- 摆动指标内置参考线（KDJ 80/20、RSI 70/30、WR 80/20、VOLX 40日均量），灰虚线。
- 框选统计：Shift+拖拽统计区间涨跌幅/累计成交额/极值；底部导航条悬浮显示
  可见窗口日期范围（跨度≥3 年用 `24/03 ~ 26/10` 紧凑格式）。

## 实时价合并（防「显示昨日收盘价」）

- 后端把盘中 live bar 合并进 kline 响应，三护栏：TTL 统一时效、
  开盘前假 bar 日期守卫、量单位换算统一。
- 前端 10-15s 轮询只更新最后一根 bar，不整表重载；切股时图表先渲染
  （不等实时响应），实时数据异步套用，用 symbol 匹配过滤过期响应。
- 个股头部信息条 20s 可见刷新 + 快照时间小标。

## 主题与色值（硬约定：组件层零硬编码色值）

- 三层 token：L1 原始色板 → L2 语义变量（`--bg-page` `--panel` `--border`
  `--text` `--accent` `--up` `--down` …）→ L3 组件类。
- 深色默认；`data-theme` / `data-accent` / `data-dir` 写在 `<html>` 上，
  main.ts 必须订阅 appearance 状态并调 applyAppearance（否则切主题不即时生效）。
- 涨跌色方向可切换（红涨绿跌默认）；新颜色一律先加 L1/L2 变量再引用。
- 全局 CSS 必须含 `[hidden]{display:none!important}`（flex 规则会压过 hidden 属性）。

## 交互细节（策影验证过的手感）

- 搜索：全站统一组件（fuzzy + 拼音缩写/全拼 + 历史下拉 + 会话级去重缓存）；
  下拉项带实时涨跌幅红绿着色；Enter/Esc 快捷键；点击用事件委托
  （innerHTML 重渲染会吞监听器）。
- 左侧导航默认 58px 可拖（最小 48px）持久化；卡片 10px 圆角、页边距 8-14px；
  右侧卡片列 366px 可拖（280–560）按用户持久化。
- 偏好同步：防抖 + `beforeunload`/`visibilitychange` keepalive fetch 冲刷，
  防刷新丢改。
- 更新进度全局化：顶栏徽章「更新中 · 任务 X%」（强调色脉冲）/「更新排队 · N 项」
  （黄色脉冲），空闲恢复健康态；空闲时手机版隐藏。
- 数据看板（底座页）：3s 轮询展示数据集新鲜度/任务日志/失败记录/健康分
  （freshness 40% + 覆盖 30% + 缺口 20% + 账本 10%）+ 一键修复。
- localStorage 键用 `yc_` 前缀（如 `yc_secview` 热力/排行视图切换）。

## 移动端

- 桌面/移动顶栏切换，偏好 localStorage 持久化；移动端左栏转底部 tab（6 核心页），
  适配安全区、杜绝横向溢出；卡片功能整合进底部菜单，不用滚动条浏览内容。

## 新页面 checklist

- [ ] 契约先定（contracts/ + gen_ts_client.sh），前端不猜字段
- [ ] 页面模块放 `src/pages/<page>.ts`，入口在 main.ts 注册
- [ ] 只用语义变量上色；涨跌语义用 `--up`/`--down` 不写死红绿
- [ ] 列表/排行可排序 + localStorage 记忆视图状态
- [ ] 空态明确提示（数据未采集 vs 接口错误，两者文案不同）
- [ ] `npm run build` 过 TS 校验后再提交
