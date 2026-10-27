/* K线图表 —— klinecharts 10，配置 1:1 对齐策影 1.0（strategy-lens）
 *  · candle_up_stroke 阳线空心 · 涨 #EF5350 / 跌 #519C2C · 无网格 · 最新价水平线关
 *  · 自研操盘通道：短线 MA7/MA10、中线 MA35/MA45，逐柱填充（强橙/弱蓝）
 *  · registerYAxis('normal') 全局轴模板：成交量轴万/亿（策影 config.ts 同款）
 *  · 滚轮缩放 / 拖拽平移为 klinecharts 原生能力
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

export interface KlineChartHandle {
  chart: Chart;
  setData: (bars: Bar[]) => void;
  setMain: (ind: "ma" | "boll" | "short" | "mid") => void;
  setSub: (ind: "vol" | "macd" | "kdj") => void;
  retheme: () => void;
  resize: () => void;
  destroy: () => void;
}

const MAIN_NAMES: Record<string, string> = {
  ma: "MA", boll: "BOLL", short: "SHORT_TREND_CHANNEL", mid: "MID_TREND_CHANNEL",
};
export type SubKey = "vol" | "macd" | "kdj";

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

  const handle: KlineChartHandle = {
    chart,
    setData(bars: Bar[]) {
      const list = bars.map((b) => ({
        timestamp: toTs(b.date), open: b.open, high: b.high, low: b.low,
        close: b.close, volume: b.volume ?? 0,
      }));
      // v10 无 applyNewData，经 DataLoader 一次性回填（策影同款）
      chart.setDataLoader({ getBars: (params) => { params.callback(list, false); } });
    },
    setMain(ind) {
      // 策影同款：按实例逐个移除主图指标，再 isStack=true 叠加创建
      // （isStack=false 会触发 addIndicator 的 pane replace 语义）
      chart.getIndicators({ paneId: "candle_pane" }).forEach((i) =>
        chart.removeIndicator({ id: i.id }));
      if (ind === "ma") {
        // MA 配色与页面图例一致：MA5 琥珀 / MA10 蓝 / MA20 VIP 金
        chart.createIndicator({
          name: "MA", paneId: "candle_pane", calcParams: [5, 10, 20], isStack: true,
          styles: { lines: [{ color: cssv("--accent") || "#FF9F43" }, { color: "#0A84FF" }, { color: cssv("--vip") || "#FFD60A" }] },
        } as never, true);
      } else if (ind === "boll") {
        const dim = cssv("--dim") || "#A1A1A6";
        chart.createIndicator({
          name: "BOLL", paneId: "candle_pane", isStack: true,
          styles: { lines: [{ color: dim }, { color: dim }, { color: dim }] },
        } as never, true);
      } else {
        chart.createIndicator({ name: MAIN_NAMES[ind], paneId: "candle_pane", isStack: true } as never, true);
      }
    },
    setSub(ind: SubKey) {
      // 策影同款：移除所有副图指标（空窗格由 v10 自动回收），再新建单副图
      chart.getIndicators()
        .filter((i) => i.paneId !== "candle_pane")
        .forEach((i) => chart.removeIndicator({ id: i.id }));
      const up = chartUp(), dn = chartDown();
      // 注意：createIndicator 返回的是 indicator.id 而非 paneId！
      // 高度须经 getPaneOptions() 找到新窗格再设置（策影 updateAllPaneHeights 同款）
      const applySubHeight = () => {
        const panes = chart.getPaneOptions() as { id: string }[];
        const subs = panes.filter((p) => p.id !== "candle_pane" && p.id !== "x_axis_pane");
        subs.forEach((p) => chart.setPaneOptions({ id: p.id, height: 92 }));
      };
      if (ind === "vol") {
        // 策影 createSubIndicatorConfig：禁用大数格式化，轴/图例文本走万/亿
        chart.createIndicator({
          name: "VOL", shouldFormatBigNumber: false,
          styles: { bars: [{ upColor: up, downColor: dn, noChangeColor: NEUTRAL }] },
        } as never, false);
      } else if (ind === "macd") {
        chart.createIndicator({
          name: "MACD",
          styles: { bars: [{ upColor: up, downColor: dn, noChangeColor: NEUTRAL }] },
        } as never, false);
      } else {
        chart.createIndicator({ name: "KDJ" } as never, false);
      }
      applySubHeight();
    },
    retheme() { chart.setStyles(styles()); },
    resize() { chart.resize(); },
    destroy() { dispose(el); },
  };
  return handle;
}
