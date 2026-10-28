/* K线图表 —— klinecharts 10，配置 1:1 对齐策影 1.0（strategy-lens）
 *  · candle_up_stroke 阳线空心 · 涨 #EF5350 / 跌 #519C2C · 无网格 · 最新价水平线关
 *  · 自研操盘通道：短线 MA7/MA10、中线 MA35/MA45，逐柱填充（强橙/弱蓝）
 *  · registerYAxis('normal') 全局轴模板：成交量轴万/亿（策影 config.ts 同款）
 *  · 滚轮缩放 / 拖拽平移为 klinecharts 原生能力
 *  · 十字光标浮动信息卡：OHLC/涨跌/振幅/区间位置/量额，周期（日/周/月）区分标题
 */
import { init, dispose, registerIndicator, registerYAxis, type Chart } from "klinecharts";
import type { Bar } from "../api";
import { cssv } from "../fmt";

/* ── 策影配色（tradingColors） ── */
const UP = "#EF5350";
const DOWN = "#519C2C";
const NEUTRAL = "#757575";
const CH_FAST = "#FF9800";
const CH_SLOW = "#0A84FF";
const channelFill = (strong: boolean, alpha: number) =>
  strong ? `rgba(255, 155, 87, ${alpha})` : `rgba(90, 88, 251, ${alpha})`;

export function chartUp(): string {
  return document.documentElement.dataset.dir === "intl" ? DOWN : UP;
}
export function chartDown(): string {
  return document.documentElement.dataset.dir === "intl" ? UP : DOWN;
}

/* ── 自研操盘通道（策影 indicatorRegistry 逐字移植） ──
 * 短线：MA7 快 + MA10 慢（α .82）｜中线：MA35 快 + MA45 慢（α .86）
 * 收盘 > 慢线 → 多头（橙）否则空头（蓝）
 */
function registerTrendChannel(
  name: string, shortName: string,
  fastPeriod: number, slowPeriod: number, alpha: number,
): void {
  registerIndicator({
    name,
    shortName,
    calcParams: [
      { key: "fastPeriod", value: fastPeriod },
      { key: "slowPeriod", value: slowPeriod },
    ],
    calc: (kLineDataList, indicator) => {
      const params = { fastPeriod, slowPeriod };
      indicator?.calcParams?.forEach((p: { key?: string; value?: number }) => {
        if (p.key !== undefined) (params as Record<string, number>)[p.key] = p.value!;
      });
      const fp = params.fastPeriod, sp = params.slowPeriod;
      const sma = (period: number): (number | null)[] => {
        const result: (number | null)[] = [];
        let sum = 0;
        for (let i = 0; i < kLineDataList.length; i++) {
          sum += kLineDataList[i].close;
          if (i >= period) sum -= kLineDataList[i - period].close;
          result.push(i >= period - 1 ? sum / period : null);
        }
        return result;
      };
      const fastMA = sma(fp), slowMA = sma(sp);
      return kLineDataList.map((k, i) => {
        const fast = fastMA[i], slow = slowMA[i];
        if (fast == null || slow == null) {
          return { fast: null, slow: null, upper: null, lower: null, strong: null };
        }
        return {
          fast, slow,
          upper: Math.max(fast, slow),
          lower: Math.min(fast, slow),
          strong: k.close > slow,
        };
      });
    },
    figures: [
      { key: "fast", title: "快线", type: "line", styles: () => ({ color: CH_FAST }) },
      { key: "slow", title: "慢线", type: "line", styles: () => ({ color: CH_SLOW }) },
    ],
    draw: (params: { ctx?: CanvasRenderingContext2D; chart?: Chart; indicator?: { result?: unknown[] } }) => {
      const { ctx, chart, indicator } = params;
      const data = (indicator?.result || []) as ({ upper: number | null; lower: number | null; strong: boolean | null } | null)[];
      if (!ctx || !chart || data.length === 0) return false;
      const barSpace = chart.getBarSpace?.() || { bar: 8 };
      const barWidth = Math.max(2, (barSpace.bar || 8) - 1);
      data.forEach((item, i) => {
        if (!item || item.upper == null || item.lower == null) return;
        const px = (v: number) => chart.convertToPixel({ dataIndex: i, value: v }) as { x?: number; y?: number };
        const upperPixel = px(item.upper), lowerPixel = px(item.lower), xPixel = px(0);
        if (upperPixel.y == null || lowerPixel.y == null || xPixel.x == null) return;
        const x = xPixel.x - barWidth / 2;
        const y = Math.min(upperPixel.y, lowerPixel.y);
        const h = Math.abs(upperPixel.y - lowerPixel.y);
        if (h < 0.5) return;
        ctx.fillStyle = channelFill(item.strong === true, alpha);
        ctx.fillRect(x, y, barWidth, h);
      });
      return true;
    },
  });
}
let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  registered = true;
  registerTrendChannel("SHORT_TREND_CHANNEL", "短线通道", 7, 10, 0.82);
  registerTrendChannel("MID_TREND_CHANNEL", "中线通道", 35, 45, 0.86);
  // 全局 Y 轴模板：覆盖内置 'normal'，成交量轴自动万/亿（策影 config.ts 同款）
  try {
    registerYAxis({
      name: "normal",
      displayValueToText: (value: number, precision: number) => {
        if (Math.abs(value) >= 1e8) return (value / 1e8).toFixed(2) + "亿";
        if (Math.abs(value) >= 1e4) return (value / 1e4).toFixed(0) + "万";
        return value.toFixed(precision);
      },
    });
  } catch { /* 重复注册会报错，忽略 */ }
}

/* ── 时间转换（策影 format.ts 逐字） ── */
function toTs(time: string): number {
  if (!time) return Date.now();
  return time.includes("T") ? new Date(time).getTime() : new Date(time + "T00:00:00").getTime();
}

export type MainKey = "ma" | "boll" | "short" | "mid";
export type SubKey = "vol" | "macd" | "kdj";

export interface KlineChartHandle {
  chart: Chart;
  setData: (bars: Bar[]) => void;
  /** 主图多选叠加：增量增删，不动已叠加的同名指标 */
  setMain: (inds: MainKey[]) => void;
  /** 副图多选：每个指标一个窗格，高度均分（策影 autoLayout 同款） */
  setSub: (inds: SubKey[]) => void;
  /** 当前周期（d/w/m）：决定十字光标卡片的标题形态 */
  setPeriod: (p: "d" | "w" | "m") => void;
  retheme: () => void;
  resize: () => void;
  destroy: () => void;
}

const MAIN_NAMES: Record<MainKey, string> = {
  ma: "MA", boll: "BOLL", short: "SHORT_TREND_CHANNEL", mid: "MID_TREND_CHANNEL",
};
const SUB_NAMES: Record<SubKey, string> = { vol: "VOL", macd: "MACD", kdj: "KDJ" };

function styles() {
  const border = cssv("--border") || "#2B2B2F";
  const axis = cssv("--axis") || border;
  const text = cssv("--faint") || "#717176";
  const up = chartUp(), dn = chartDown();
  return {
    grid: { show: false },
    separator: { size: 1, color: border, fill: false, activeBackgroundColor: border },
    candle: {
      type: "candle_up_stroke" as const,
      tooltip: { showRule: "none" as const },
      bar: {
        upColor: "rgba(0,0,0,0)", downColor: dn, noChangeColor: NEUTRAL,
        upBorderColor: up, downBorderColor: dn, noChangeBorderColor: NEUTRAL,
        upWickColor: up, downWickColor: dn, noChangeWickColor: NEUTRAL,
      },
      priceMark: { show: true, last: { show: false }, high: { show: true }, low: { show: true } },
    },
    indicator: {
      tooltip: { showRule: "none" as const, title: { showName: false, showParams: false } },
      ohlc: { upColor: up, downColor: dn, noChangeColor: NEUTRAL },
    },
    crosshair: {
      show: true,
      horizontal: {
        show: true, line: { show: true, size: 1, color: text, dashedValue: [4, 4] },
        text: { show: false },
      },
      vertical: {
        show: true, line: { show: true, size: 1, color: text, dashedValue: [4, 4] },
        text: { show: true, color: cssv("--text") || "#F5F5F7", size: 12, backgroundColor: cssv("--panel-3") || "#2D2D31", borderSize: 1, borderColor: text, borderRadius: 4 },
      },
    },
    xAxis: {
      show: true, size: "auto" as const,
      axisLine: { color: axis, size: 1 }, tickLine: { color: axis, size: 1, length: 3 },
      tickText: { show: true, color: text, size: 11 },
    },
    yAxis: {
      show: true, size: "auto" as const,
      axisLine: { color: axis, size: 1 }, tickLine: { color: axis, size: 1, length: 3 },
      tickText: { show: true, color: text, size: 11 },
    },
  };
}

/* ── 十字光标浮动信息卡（周期区分标题） ── */
type TipPeriod = "d" | "w" | "m";

/** 量/额：万以下原值，万 → 亿（策影 formatVolumeValue 口径 + 手单位） */
function fmtWanYi(v: number, unit = ""): string {
  if (!isFinite(v)) return "—";
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + "亿" + unit;
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + "万" + unit;
  return v.toFixed(0) + unit;
}

function tipTitle(date: string, p: TipPeriod): string {
  if (p === "m") return `${date.slice(0, 7)} · 月线`;
  if (p === "w") return `${date} 当周 · 周线`;
  return `${date} · 北京时间`;
}

/** 区间位置：当前收盘在近 window 根（含当根）高低区间内的分位（%） */
function rangePosition(list: { high: number; low: number; close: number }[], i: number, window = 250): number | null {
  const s = Math.max(0, i - window + 1);
  const seg = list.slice(s, i + 1);
  const hi = Math.max(...seg.map((x) => x.high));
  const lo = Math.min(...seg.map((x) => x.low));
  if (!isFinite(hi) || !isFinite(lo) || hi === lo) return null;
  return ((list[i].close - lo) / (hi - lo)) * 100;
}

const sgn = (v: number, digits = 2): string => (v > 0 ? "+" : "") + v.toFixed(digits);

export function mountKline(el: HTMLElement): KlineChartHandle {
  ensureRegistered();
  const chart = init(el, {
    styles: styles(),
    layout: {
      barSpaceLimit: {
        min: 1,
        max: Math.max(50, Math.ceil((el.clientWidth || 1440) / 16)),
      },
    },
  }) as Chart;
  // v10 门控：symbol/period 无效时 getBars 永远不触发（canvas 空白无报错），
  // 数据虽由外部回填，仍需设置合法 symbol/period 才能打开加载开关
  chart.setSymbol({ ticker: "YUCHAO", pricePrecision: 2, volumePrecision: 0 });
  chart.setPeriod({ type: "day", span: 1 });

  /* ── 浮动信息卡：跟随十字光标，边缘翻转避让 ── */
  const tip = document.createElement("div");
  tip.className = "kl-tip";
  tip.style.display = "none";
  el.appendChild(tip);
  let period: TipPeriod = "d";

  const onCross = (...args: unknown[]) => {
    const ch = args[0] as { x?: number; y?: number } | null;
    if (!ch || ch.x == null || ch.y == null) { tip.style.display = "none"; return; }
    const list = chart.getDataList() as { timestamp: number; open: number; high: number; low: number; close: number; volume?: number; amount?: number; date?: string }[];
    // v10 crosshair 事件只带坐标，经 convertFromPixel 反查数据索引（策影同款）
    const hit = chart.convertFromPixel([{ x: ch.x }]) as unknown;
    const di = (Array.isArray(hit) ? hit[0] : hit)?.dataIndex as number | undefined;
    const bar = di != null ? list[di] : undefined;
    if (!bar) { tip.style.display = "none"; return; }
    const prev = di! > 0 ? list[di! - 1] : undefined;
    const base = prev?.close || bar.open;                 // 涨跌/振幅基准（首根 vs 开盘）
    const chg = bar.close - base;
    const pct = base ? (chg / base) * 100 : 0;
    const amp = base ? ((bar.high - bar.low) / base) * 100 : 0;
    const pos = rangePosition(list, di!);
    const posTxt = pos == null ? "—" : pos.toFixed(1) + "%";
    const row = (k: string, v: string, cls = "") =>
      `<div class="r"><span>${k}</span><b class="num ${cls}">${v}</b></div>`;
    const cls = chg > 0 ? "up" : chg < 0 ? "down" : "";
    tip.innerHTML =
      `<div class="t num">${tipTitle(bar.date ?? "", period)}</div>` +
      row("开", bar.open.toFixed(2)) + row("高", bar.high.toFixed(2)) +
      row("低", bar.low.toFixed(2)) + row("收", bar.close.toFixed(2)) +
      row("涨跌", `${sgn(chg)} (${sgn(pct)}%)`, cls) +
      row("振幅", amp.toFixed(2) + "%") + row("位置", posTxt) +
      row("量", fmtWanYi(bar.volume ?? 0, "手")) + row("额", fmtWanYi(bar.amount ?? 0));
    tip.style.display = "block";
    // 定位 + 翻转（卡片实际尺寸就绪后再算，避免首帧抖动）
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const flipX = ch.x + 16 + w > el.clientWidth;
    const flipY = ch.y + 16 + h > el.clientHeight;
    tip.style.left = (flipX ? ch.x - w - 16 : ch.x + 16) + "px";
    tip.style.top = (flipY ? ch.y - h - 16 : ch.y + 16) + "px";
  };
  try { chart.subscribeAction("onCrosshairChange", onCross as never); } catch { /* 忽略 */ }

  const handle: KlineChartHandle = {
    chart,
    setData(bars: Bar[]) {
      const list = bars.map((b) => ({
        timestamp: toTs(b.date), open: b.open, high: b.high, low: b.low,
        close: b.close, volume: b.volume ?? 0, amount: b.amount ?? 0,
        date: b.date,
      }));
      tip.style.display = "none";                          // 数据重载时收起旧卡片
      // v10 无 applyNewData，经 DataLoader 一次性回填（策影同款）
      chart.setDataLoader({ getBars: (params) => { params.callback(list, false); } });
    },
    setMain(inds: MainKey[]) {
      // 主图多选叠加（策影同款）：先按实例移除不再选中的，再增量补建缺失的
      const want = new Set(inds.map((k) => MAIN_NAMES[k]));
      chart.getIndicators({ paneId: "candle_pane" }).forEach((i) => {
        if (Object.values(MAIN_NAMES).includes(i.name) && !want.has(i.name))
          chart.removeIndicator({ id: i.id });
      });
      const have = new Set(chart.getIndicators({ paneId: "candle_pane" }).map((i) => i.name));
      for (const k of inds) {
        if (have.has(MAIN_NAMES[k])) continue;
        if (k === "ma") {
          // MA 配色与页面图例一致：MA5 琥珀 / MA10 蓝 / MA20 VIP 金
          chart.createIndicator({
            name: "MA", paneId: "candle_pane", calcParams: [5, 10, 20], isStack: true,
            styles: { lines: [{ color: cssv("--accent") || "#FF9F43" }, { color: "#0A84FF" }, { color: cssv("--vip") || "#FFD60A" }] },
          } as never, true);
        } else if (k === "boll") {
          const dim = cssv("--dim") || "#A1A1A6";
          chart.createIndicator({
            name: "BOLL", paneId: "candle_pane", isStack: true,
            styles: { lines: [{ color: dim }, { color: dim }, { color: dim }] },
          } as never, true);
        } else {
          chart.createIndicator({ name: MAIN_NAMES[k], paneId: "candle_pane", isStack: true } as never, true);
        }
      }
    },
    setSub(inds: SubKey[]) {
      // 副图多选：全清后按固定顺序重建，每指标一个窗格
      chart.getIndicators()
        .filter((i) => i.paneId !== "candle_pane")
        .forEach((i) => chart.removeIndicator({ id: i.id }));
      const up = chartUp(), dn = chartDown();
      for (const k of inds) {
        if (k === "vol") {
          // 策影 createSubIndicatorConfig：禁用大数格式化，轴/图例文本走万/亿
          chart.createIndicator({
            name: "VOL", shouldFormatBigNumber: false,
            styles: { bars: [{ upColor: up, downColor: dn, noChangeColor: NEUTRAL }] },
          } as never, false);
        } else if (k === "macd") {
          chart.createIndicator({
            name: "MACD",
            styles: { bars: [{ upColor: up, downColor: dn, noChangeColor: NEUTRAL }] },
          } as never, false);
        } else {
          chart.createIndicator({ name: "KDJ" } as never, false);
        }
      }
      // 多窗格高度均分：副图合计约占 38%，单窗格 64–110px（策影 updateAllPaneHeights 同款）
      const panes = (chart.getPaneOptions() as { id: string }[])
        .filter((p) => p.id !== "candle_pane" && p.id !== "x_axis_pane");
      if (!panes.length) return;
      const n = panes.length;
      const h = Math.max(64, Math.min(110, Math.round(el.clientHeight * 0.38 / n)));
      panes.forEach((p) => chart.setPaneOptions({ id: p.id, height: h }));
    },
    setPeriod(p: "d" | "w" | "m") { period = p; },
    retheme() { chart.setStyles(styles()); },
    resize() { chart.resize(); },
    destroy() {
      try { chart.unsubscribeAction("onCrosshairChange", onCross as never); } catch { /* 忽略 */ }
      tip.remove();
      dispose(el);
    },
  };
  return handle;
}
