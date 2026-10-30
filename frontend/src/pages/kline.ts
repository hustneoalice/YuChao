/* K线图表 —— klinecharts 10，配置 1:1 对齐策影 1.0（strategy-lens）
 *  · candle_up_stroke 阳线空心 · 涨 #EF5350 / 跌 #519C2C · 无网格 · 最新价水平线关
 *  · 自研操盘趋势：短线 MA7/MA10、中线 MA35/MA45，逐柱填充（强橙/弱蓝）
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
/* 趋势通道配色 · 四方案用户可选（本地 yc_trendpal，云同步键 trend_palette）：
   与 K 线红绿、MA 琥珀/蓝、BOLL 灰区隔，避免与主流机构撞色 */
export const TRENDS: Record<string, { label: string; fast: string; slow: string; fr: number[]; sr: number[] }> = {
  A: { label: "A · 琥珀橙 × 皇家蓝", fast: "#FF9800", slow: "#0A84FF", fr: [255, 152, 0], sr: [10, 132, 255] },
  B: { label: "B · 紫罗兰 × 青绿", fast: "#C084FC", slow: "#2DD4BF", fr: [192, 132, 252], sr: [45, 212, 191] },
  C: { label: "C · 玫红 × 天蓝", fast: "#FB7185", slow: "#38BDF8", fr: [251, 113, 133], sr: [56, 189, 248] },
  D: { label: "D · 金黄 × 石墨", fast: "#EAB308", slow: "#94A3B8", fr: [234, 179, 8], sr: [148, 163, 184] },
};
let _pal = localStorage.getItem("yc_trendpal") || "B";
if (!TRENDS[_pal]) _pal = "B";

export function setTrendPalette(p: string): void {
  if (TRENDS[p]) {
    _pal = p;
    localStorage.setItem("yc_trendpal", p);
  }
}
export function trendPalette(): { label: string; fast: string; slow: string; fr: number[]; sr: number[] } {
  return TRENDS[_pal] ?? TRENDS.B;
}
export function trendPaletteKey(): string {
  return TRENDS[_pal] ? _pal : "B";
}
const channelFill = (strong: boolean, alpha: number) => {
  const p = trendPalette();
  const c = strong ? p.fr : p.sr;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
};

export function chartUp(): string {
  return document.documentElement.dataset.dir === "intl" ? DOWN : UP;
}
export function chartDown(): string {
  return document.documentElement.dataset.dir === "intl" ? UP : DOWN;
}

/* ── 自研操盘趋势（策影 indicatorRegistry 逐字移植） ──
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
      { key: "fast", title: "快线", type: "line", styles: () => ({ color: trendPalette().fast }) },
      { key: "slow", title: "慢线", type: "line", styles: () => ({ color: trendPalette().slow }) },
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
  registerTrendChannel("SHORT_TREND_CHANNEL", "短线趋势", 7, 10, 0.82);
  registerTrendChannel("MID_TREND_CHANNEL", "中线趋势", 35, 45, 0.86);
  // 分时均价线（VWAP）：后端 /market/minute 已算好，直接透传画线
  try {
    registerIndicator({
      name: "TIME_AVG",
      shortName: "均价",
      calc: (kLineDataList) =>
        (kLineDataList as unknown as { avg?: number }[]).map((b) => ({ avg: b.avg ?? null })),
      figures: [{ key: "avg", title: "均价", type: "line", styles: () => ({ color: "#26C6DA" }) }],
    });
  } catch { /* 重复注册忽略 */ }
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

/* ── 时间转换（策影 format.ts 逐字 + 分钟级 datetime 支持） ── */
function toTs(time: string): number {
  if (!time) return Date.now();
  if (time.includes("T")) return new Date(time).getTime();
  if (time.includes(" ")) return new Date(time.replace(" ", "T") + ":00").getTime();
  return new Date(time + "T00:00:00").getTime();
}

export type MainKey = "ma" | "boll" | "short" | "mid" | "avg";
export type SubKey = "vol" | "macd" | "kdj" | "rsi" | "obv";

export interface KlineChartHandle {
  chart: Chart;
  setData: (bars: Bar[]) => void;
  /** 主图多选叠加：增量增删，不动已叠加的同名指标 */
  setMain: (inds: MainKey[]) => void;
  /** 图内右上角指标图例（MA/BOLL/操盘趋势，色块+名称；多面板时每实例一份） */
  drawLegend: (inds: MainKey[]) => void;
  /** 副图多选：每个指标一个窗格，高度均分（策影 autoLayout 同款） */
  setSub: (inds: SubKey[]) => void;
  /** 当前周期（d/w/m）：决定十字光标卡片的标题形态 */
  setPeriod: (p: "t" | "60" | "d" | "w" | "m") => void;
  /** 智能高度：按容器高重分主/副图（3.6:1，策影同款；开关关时副图固定 100px） */
  applyHeights: () => void;
  /** 缩放：factor>1 放大（K 线变宽），等价策影工具条 ±（barSpace ×1.25 / ×0.8） */
  zoom: (factor: number) => void;
  /** 观察档位：一键显示最近 n 根（纯视图缩放，不重载数据，策影同款） */
  viewBars: (n: number) => void;
  /** 重置视图：默认档位（宽度/16）并回到最新 */
  resetView: () => void;
  /** 数据/主题变化后重画底部导航条缩略图 */
  navRefresh: () => void;
  retheme: () => void;
  resize: () => void;
  destroy: () => void;
}

const MAIN_NAMES: Record<MainKey, string> = {
  ma: "MA", boll: "BOLL", short: "SHORT_TREND_CHANNEL", mid: "MID_TREND_CHANNEL",
  avg: "TIME_AVG",
};
const SUB_NAMES: Record<SubKey, string> = { vol: "VOL", macd: "MACD", kdj: "KDJ", rsi: "RSI", obv: "OBV" };

/* ── 智能高度（策影 computeAutoPaneHeights 同款） ──
 * 主图:单个副图 = 3.6:1（1 副图 → 主图 78%，2 → 64%，3 → 55%）；
 * 副图夹在 44~132px；主图硬约束 ≥ 3×副图且 ≥160px，空间不足时副图退让。 */
const X_AXIS_H = 24, MAIN_SUB_RATIO = 3.6,
  SUB_MIN = 44, SUB_MAX = 132, MAIN_MIN = 160, MAIN_MIN_RATIO = 3;

function smartHeights(total: number, n: number): { main: number; sub: number } {
  const avail = Math.max(160, Math.round(total - X_AXIS_H));
  if (n <= 0) return { main: avail, sub: 0 };
  let sub = Math.min(SUB_MAX, Math.round(avail / (MAIN_SUB_RATIO + n)));
  const ratioCap = Math.floor(avail / (MAIN_MIN_RATIO + n));
  if (sub > ratioCap) sub = ratioCap;
  sub = Math.max(SUB_MIN, sub);
  let main = avail - sub * n;
  if (main < MAIN_MIN) {
    sub = Math.max(SUB_MIN, Math.floor((avail - MAIN_MIN) / n));
    main = avail - sub * n;
  }
  return { main, sub };
}

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
type TipPeriod = "t" | "60" | "d" | "w" | "m";

/** 量/额：万以下原值，万 → 亿（策影 formatVolumeValue 口径 + 手单位） */
function fmtWanYi(v: number, unit = ""): string {
  if (!isFinite(v)) return "—";
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + "亿" + unit;
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + "万" + unit;
  return v.toFixed(0) + unit;
}

function tipTitle(date: string, p: TipPeriod): string {
  if (p === "t") return `${date} · 分时`;
  if (p === "60") return `${date} · 60分钟`;
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
  // 最新K线贴右：默认 50px 右偏移清零，首根（最新）紧挨 Y 刻度
  try { chart.setOffsetRightDistance(0); } catch { /* 忽略 */ }
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

  /* ── 图内右上角指标图例：色块 + 名称；操盘趋势按本面板数据判多空 ── */
  const legend = document.createElement("div");
  legend.className = "legend";
  el.appendChild(legend);
  const drawLegend = (inds: MainKey[]) => {
    const accC = cssv("--accent") || "#FF9F43", p1C = "#0A84FF", vipC = cssv("--vip") || "#FFD60A";
    const dimC = cssv("--dim") || "#A1A1A6";
    const parts: string[] = [];
    if (inds.includes("ma"))
      parts.push(`<span><i style="background:${accC}"></i>MA5</span><span><i style="background:${p1C}"></i>MA10</span><span><i style="background:${vipC}"></i>MA20</span>`);
    if (inds.includes("boll"))
      parts.push(`<span><i style="background:${dimC}"></i>BOLL(20,2)</span>`);
    if (inds.includes("avg"))
      parts.push(`<span><i style="background:#26C6DA"></i>均价线</span>`);
    const list = chart.getDataList() as { close: number }[];
    for (const k of inds) {
      if (k !== "short" && k !== "mid") continue;
      const n = k === "short" ? 10 : 45;
      const closes = list.map((b) => b.close);
      const last = closes[closes.length - 1];
      const ma = closes.length >= n ? closes.slice(-n).reduce((s, v) => s + v, 0) / n : null;
      const strong = ma != null && last > ma;
      const p = trendPalette();
      const fill = strong ? `rgba(${p.fr.join(",")},.82)` : `rgba(${p.sr.join(",")},.86)`;
      parts.push(`<span><i style="background:${trendPalette().fast}"></i>${k === "short" ? "短线" : "中线"}快线</span>` +
        `<span><i style="background:${trendPalette().slow}"></i>慢线</span>` +
        `<span><i style="background:${fill}"></i>${strong ? "多头 · 偏强" : "空头 · 偏弱"}</span>`);
    }
    legend.innerHTML = parts.join("");
    legend.style.display = parts.length ? "flex" : "none";
  };

  /* ── 操盘状态颜色条（策影 SignalBars 同款）：K线上方逐柱状态带 ──
   * 日线：日短=收盘vs MA10、日中=收盘vs MA45；周线：周短 MA10 / 周中 MA30；60分钟：60短 MA10。
   * 收盘 > 慢线 → 偏强（趋势调色板强色），否则偏弱（弱色）；分时/月/季不显示。
   * 逐柱对齐 convertToPixel.x，缩放平移实时跟随；左侧标签底永不被遮挡。 */
  const SIG_ROWS: Partial<Record<TipPeriod, { label: string; n: number }[]>> = {
    d: [{ label: "日短", n: 10 }, { label: "日中", n: 45 }],
    w: [{ label: "周短", n: 10 }, { label: "周中", n: 30 }],
    "60": [{ label: "60短", n: 10 }],
  };
  const sig = document.createElement("div");
  sig.className = "klp-sig";
  sig.style.display = "none";
  sig.innerHTML = "<canvas></canvas>";
  el.parentElement?.insertBefore(sig, el);           // klp-bar 与 klp-main 之间（文档流让位，策影同款）
  const sigCv = sig.querySelector("canvas")!;
  /** 显示/隐藏与行高同步：行数变化时主图重算布局，返回当前行配置 */
  const sigSync = (): { rows: { label: string; n: number }[] } | null => {
    const rows = SIG_ROWS[period];
    if (!rows || !chart.getDataList().length) {
      if (sig.style.display !== "none") {
        sig.style.display = "none";
        try { chart.resize(); } catch { /* 忽略 */ }
        applyHeights();
      }
      return null;
    }
    const stripH = 3 + rows.length * 7 + (rows.length - 1) * 2 + 2;
    if (sig.style.display === "none" || sig.dataset.h !== String(stripH)) {
      sig.style.display = "block";
      sig.style.height = stripH + "px";
      sig.dataset.h = String(stripH);
      try { chart.resize(); } catch { /* 忽略 */ }
      applyHeights();
    }
    return { rows };
  };
  const sigDraw = () => {
    const sync = sigSync();
    if (!sync) return;
    const list = chart.getDataList() as { close: number }[];
    const w = sigCv.clientWidth || 1, h = sigCv.clientHeight || 1;
    const dpr = window.devicePixelRatio || 1;
    sigCv.width = Math.round(w * dpr); sigCv.height = Math.round(h * dpr);
    const ctx = sigCv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const closes = list.map((b) => b.close);
    // 逐柱 MA 状态（策影同款口径：收盘 > MA = 偏强）
    const states = sync.rows.map(({ n }) => {
      const st: (boolean | null)[] = [];
      let sum = 0;
      for (let i = 0; i < closes.length; i++) {
        sum += closes[i];
        if (i >= n) sum -= closes[i - n];
        st.push(i >= n - 1 ? closes[i] > sum / n : null);
      }
      return st;
    });
    // 可见范围：realFrom/realTo 排除右侧预留幻影索引（缩放时越 Y 轴的根源）
    const r = chart.getVisibleRange?.() as { from: number; to: number; realFrom?: number; realTo?: number } | undefined;
    if (!r) return;
    const from = Math.max(0, Math.floor(r.realFrom ?? r.from));
    const to = Math.min(list.length - 1, Math.ceil(r.realTo ?? r.to));
    const barSpace = chart.getBarSpace?.() || { bar: 8 };
    const cw = Math.max(1, (barSpace.bar || 8) - 1);
    const xs: number[] = [];
    for (let i = from; i <= to; i++) {
      try {
        const px = chart.convertToPixel({ dataIndex: i, value: 0 }) as { x?: number };
        if (px?.x != null) xs.push(px.x);
      } catch { /* 忽略 */ }
    }
    if (!xs.length) return;
    const rightBound = xs[xs.length - 1] + cw / 2 + 1;
    // 先画柱（与可见 K 线一一对应），再画标签（覆盖其上永不被遮挡）
    sync.rows.forEach((_, row) => {
      const y = 3 + row * 9;
      let last: boolean | null = null;
      xs.forEach((x, k) => {
        const s = states[row][from + k];
        if (s != null) last = s;
        if (last === null) return;
        const left = x - cw / 2;
        const right = Math.min(left + cw, rightBound);
        if (left >= rightBound || right <= left) return;
        ctx.fillStyle = channelFill(last === true, 0.9);
        ctx.fillRect(left, y, right - left, 7);
      });
    });
    const labelW = 36;
    ctx.fillStyle = cssv("--panel-2") || "rgba(20,20,24,.92)";
    ctx.fillRect(0, 0, labelW, h);
    ctx.font = "9px monospace";
    ctx.fillStyle = cssv("--faint") || "#8e8e93";
    ctx.textBaseline = "middle";
    sync.rows.forEach(({ label }, row) => ctx.fillText(label, 4, 3 + row * 9 + 3.5));
  };

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
    const cls = chg > 0 ? "up" : chg < 0 ? "down" : "";
    // 紧凑分组：OHLC 一行 · 涨跌/振幅/位置 一行 · 量/额 一行（减少遮挡）
    const kv = (k: string, v: string, c = "") => `<span>${k}<b class="num ${c}">${v}</b></span>`;
    tip.innerHTML =
      `<div class="t num">${tipTitle(bar.date ?? "", period)}</div>` +
      `<div class="grp">${kv("开", bar.open.toFixed(2))}${kv("高", bar.high.toFixed(2))}${kv("低", bar.low.toFixed(2))}${kv("收", bar.close.toFixed(2), cls)}</div>` +
      `<div class="grp">${kv("涨跌", `${sgn(chg)} (${sgn(pct)}%)`, cls)}${kv("振幅", amp.toFixed(2) + "%")}${kv("位置", posTxt)}</div>` +
      `<div class="grp">${kv("量", fmtWanYi(bar.volume ?? 0, "手"))}${kv("额", fmtWanYi(bar.amount ?? 0))}</div>`;
    tip.style.display = "block";
    // 定位 + 翻转（卡片实际尺寸就绪后再算，避免首帧抖动）
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const flipX = ch.x + 16 + w > el.clientWidth;
    const flipY = ch.y + 16 + h > el.clientHeight;
    tip.style.left = (flipX ? ch.x - w - 16 : ch.x + 16) + "px";
    tip.style.top = (flipY ? ch.y - h - 16 : ch.y + 16) + "px";
  };
  try { chart.subscribeAction("onCrosshairChange", onCross as never); } catch { /* 忽略 */ }

  /* ── 底部导航条（策影同款：缩略图 + 拖拽窗口平移 + 回到最新） ── */
  const nav = document.createElement("div");
  nav.className = "kl-nav";
  nav.innerHTML =
    `<div class="kl-nav-btns"><button data-j="first" title="跳到最早">⇤</button>` +
    `<button data-j="prev" title="向前一页">‹</button></div>` +
    `<canvas class="kl-nav-cv"></canvas>` +
    `<div class="kl-nav-win" title="拖动调整可见范围"><i></i><b></b></div>` +
    `<div class="kl-nav-btns r"><button data-j="next" title="向后一页">›</button>` +
    `<button data-j="last" title="回到最新">⇥</button></div>` +
    `<button class="kl-nav-latest" title="回到最新">最新 ›</button>`;
  el.appendChild(nav);
  const navCv = nav.querySelector("canvas")!;
  const navWin = nav.querySelector(".kl-nav-win") as HTMLElement;
  // 快速跳转（策影 navJump 同款：first / ±0.8 页 / last）
  nav.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-j]");
    if (!b) return;
    const list = chart.getDataList();
    const r = chart.getVisibleRange?.() as { from: number; to: number } | undefined;
    if (!list.length || !r) return;
    const vis = r.to - r.from;
    try {
      if (b.dataset.j === "first") chart.scrollToDataIndex(0, 0);
      else if (b.dataset.j === "last") chart.scrollToRealTime(0);
      else if (b.dataset.j === "prev") chart.scrollToDataIndex(Math.max(0, Math.round(r.from - vis * 0.8)), 0);
      else if (b.dataset.j === "next") chart.scrollToDataIndex(Math.min(Math.max(0, list.length - vis), Math.round(r.from + vis * 0.8)), 0);
    } catch { /* 忽略 */ }
  });

  /** 画全量 close 缩略线（涨跌分段染色），并按可见区间刷新窗口位置 */
  const navDraw = () => {
    const list = chart.getDataList() as { close: number }[];
    const w = navCv.clientWidth || 1, h = navCv.clientHeight || 1;
    const dpr = window.devicePixelRatio || 1;
    navCv.width = Math.round(w * dpr); navCv.height = Math.round(h * dpr);
    const ctx = navCv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    navCv.style.display = list.length > 1 ? "block" : "none";
    if (list.length > 1) {
      let mn = Infinity, mx = -Infinity;
      for (const x of list) { if (x.close < mn) mn = x.close; if (x.close > mx) mx = x.close; }
      const X = (i: number) => (i / (list.length - 1)) * w;
      const Y = (v: number) => h - 5 - ((v - mn) / (mx - mn || 1)) * (h - 10);
      ctx.lineWidth = 1;
      const up = chartUp(), dn = chartDown();
      for (let i = 1; i < list.length; i++) {
        ctx.strokeStyle = list[i].close >= list[i - 1].close ? up : dn;
        ctx.beginPath(); ctx.moveTo(X(i - 1), Y(list[i - 1].close)); ctx.lineTo(X(i), Y(list[i].close)); ctx.stroke();
      }
    }
    navUpdateWin();
  };
  const navUpdateWin = () => {
    const list = chart.getDataList();
    const r = chart.getVisibleRange?.() as { from: number; to: number } | undefined;
    if (!list.length || !r) return;
    const L = list.length;
    const from = Math.max(0, Math.floor(r.from)), to = Math.min(L, Math.ceil(r.to));
    // 窗口定位相对缩略图画布区（两侧有跳转按钮占位）
    const cvL = navCv.offsetLeft, cvW = navCv.clientWidth;
    navWin.style.left = cvL + (from / L) * cvW + "px";
    navWin.style.width = Math.max(2, ((to - from) / L) * cvW) + "px";
  };
  const onVisChange = () => { requestAnimationFrame(() => { navUpdateWin(); sigDraw(); }); };
  try { chart.subscribeAction("onVisibleRangeChange", onVisChange as never); } catch { /* 忽略 */ }

  // 窗口拖拽：只平移不缩放（策影同款），pointer capture 跟手
  const navDrag = { x: 0, from: 0, count: 0 };
  navWin.addEventListener("pointerdown", (e) => {
    const r = chart.getVisibleRange?.() as { from: number; to: number } | undefined;
    if (!r) return;
    navDrag.x = e.clientX; navDrag.from = r.from; navDrag.count = r.to - r.from;
    navWin.setPointerCapture(e.pointerId);
    navWin.style.cursor = "grabbing";
  });
  navWin.addEventListener("pointermove", (e) => {
    if (!navWin.hasPointerCapture?.(e.pointerId)) return;
    const L = chart.getDataList().length;
    if (!L || !navCv.clientWidth) return;
    const nf = Math.max(0, Math.min(L - navDrag.count,
      navDrag.from + ((e.clientX - navDrag.x) / navCv.clientWidth) * L));
    try { chart.scrollToDataIndex(Math.round(nf), 0); } catch { /* 忽略 */ }
    navUpdateWin();
  });
  const navDragEnd = (e: PointerEvent) => {
    if (navWin.hasPointerCapture?.(e.pointerId)) navWin.releasePointerCapture(e.pointerId);
    navWin.style.cursor = "";
  };
  navWin.addEventListener("pointerup", navDragEnd);
  navWin.addEventListener("pointercancel", navDragEnd);
  nav.querySelector(".kl-nav-latest")!.addEventListener("click", () => {
    try { chart.scrollToRealTime(0); } catch { /* 忽略 */ }
  });

  // 智能高度（闭包函数：setSub 与 resize 内部也复用）
  const applyHeights = () => {
    const auto = localStorage.getItem("yc_autoh") !== "0";
    const panes = (chart.getPaneOptions() as { id: string }[])
      .filter((p) => p.id !== "candle_pane" && p.id !== "x_axis_pane");
    const { main, sub } = smartHeights(el.clientHeight, panes.length);
    try {
      chart.setPaneOptions({ id: "candle_pane", height: auto ? main : Math.max(200, el.clientHeight - panes.length * 100 - X_AXIS_H) });
      panes.forEach((p) => chart.setPaneOptions({ id: p.id, height: auto ? sub : 100 }));
    } catch { /* 忽略 */ }
  };

  const handle: KlineChartHandle = {
    chart,
    setData: (bars: Bar[]) => {
      const list = bars.map((b) => ({
        timestamp: toTs(b.date), open: b.open, high: b.high, low: b.low,
        close: b.close, volume: b.volume ?? 0, amount: b.amount ?? 0,
        date: b.date,
      }));
      tip.style.display = "none";                          // 数据重载时收起旧卡片
      // v10 无 applyNewData，经 DataLoader 一次性回填（策影同款）
      chart.setDataLoader({ getBars: (params) => { params.callback(list, false); } });
      requestAnimationFrame(() => { navDraw(); sigDraw(); try { chart.scrollToRealTime(0); } catch { /* 忽略 */ } });
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
        } else if (k === "avg") {
          chart.createIndicator({ name: "TIME_AVG", paneId: "candle_pane", isStack: true } as never, true);
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
          // 策影 createSubIndicatorConfig：禁用大数格式化，轴/图例文本走万/亿；
          // calcParams [5,10,40] = 5/10/40 日均量线（40 日均量作缩放量能基准）
          chart.createIndicator({
            name: "VOL", shouldFormatBigNumber: false, calcParams: [5, 10, 40],
            styles: { bars: [{ upColor: up, downColor: dn, noChangeColor: NEUTRAL }] },
          } as never, false);
        } else if (k === "macd") {
          chart.createIndicator({
            name: "MACD",
            styles: { bars: [{ upColor: up, downColor: dn, noChangeColor: NEUTRAL }] },
          } as never, false);
        } else if (k === "rsi" || k === "obv") {
          chart.createIndicator({ name: SUB_NAMES[k] } as never, false);
        } else {
          chart.createIndicator({ name: "KDJ" } as never, false);
        }
      }
      // 窗格高度交给智能高度统一分配（含 candle_pane）
      applyHeights();
    },
    setPeriod(p: TipPeriod) {
      period = p;
      // 颜色条按周期显隐（行数变化时 sigSync 内部已重排主图）
      requestAnimationFrame(sigDraw);
    },
    applyHeights,
    zoom(factor: number) {
      const bs = chart.getBarSpace?.() as { bar: number } | undefined;
      if (!bs?.bar) return;
      try { chart.setBarSpace(Math.min(50, Math.max(1, bs.bar * factor))); } catch { /* 忽略 */ }
    },
    viewBars(n: number) {
      const w = el.clientWidth;
      if (!w) return;
      try {
        chart.setBarSpace(Math.min(50, Math.max(1, w / n)));
        chart.scrollToRealTime(0);
      } catch { /* 忽略 */ }
    },
    resetView() {
      try {
        chart.setBarSpace(Math.min(50, Math.max(1, el.clientWidth / 16)));
        chart.scrollToRealTime(0);
      } catch { /* 忽略 */ }
    },
    navRefresh() { requestAnimationFrame(navDraw); },
    drawLegend,
    retheme() { chart.setStyles(styles()); requestAnimationFrame(() => { navDraw(); sigDraw(); }); },
    resize() {
      chart.resize();
      requestAnimationFrame(() => { applyHeights(); navDraw(); sigDraw(); });
    },
    destroy() {
      try { chart.unsubscribeAction("onCrosshairChange", onCross as never); } catch { /* 忽略 */ }
      tip.remove();
      legend.remove();
      nav.remove();
      sig.remove();
      dispose(el);
    },
  };
  return handle;
}
