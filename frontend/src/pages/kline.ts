/* K线图表 —— klinecharts 10，配置 1:1 对齐策影 1.0（strategy-lens）
 *  · 阳线空心（涨停实心红）· 跌实心绿 · 涨 #EF5350 / 跌 #519C2C · 无网格 · 最新价水平线关
 *  · 自研操盘趋势：短线 MA7/MA10、中线 MA35/MA45，逐柱填充（强橙/弱蓝）
 *  · registerYAxis('normal') 全局轴模板：成交量轴万/亿（策影 config.ts 同款）
 *  · 滚轮缩放 / 拖拽平移为 klinecharts 原生能力
 *  · 十字光标浮动信息卡：OHLC/涨跌/振幅/区间位置/量额，周期（日/周/月）区分标题
 */
import { init, dispose, registerIndicator, registerYAxis, type Chart, type CandleType } from "klinecharts";
import type { Bar } from "../api";
import { cssv, fmt, fmtYi, fmtVol } from "../fmt";
import { ema, sixSegmentSeries } from "../indicators";
import { accumulationSeries } from "../accumulation";
import { mainCostSeries } from "../main-cost";
import { stockOperateSeries } from "../stock-operate";
import { volumeActivitySeries } from "../volume-activity";
import { trendHistogramSeries } from "../trend-histogram";
import { strongPullbackSeries } from "../strong-pullback";
import { drawQyjjIcon, qyjjSeries, type QyjjRow } from "../qyjj";
import { volumeAverageSeries } from "../volume-average";
import { mountVolumeSettings, readVolumeSettings } from "../volume-settings";
import { mountMainCostSettings } from "../main-cost-settings";
import { applyMA, mountMASettings, visibleMARows } from "../ma-settings";

/* ── 策影配色（tradingColors） ── */
const UP = "#EF5350";
const DOWN = "#519C2C";
const NEUTRAL = "#757575";
/* 分时主图蓝系（通达信分时同款）：均价线/昨收虚线基准 */
const MIN_AVG_COLOR = "#2E6BD6";
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


/** 涨停判定：按代码所在板块的涨幅上限（主板 10 / 创业科创 20 / 北交 30）。
 *  创业板 2020-08-24 起才改 20%；阈值留 0.1 余量，避开 9.87% 这类非涨停收盘。 */
export function isLimitUp(symbol: string | undefined, pct: number | null | undefined, date?: string): boolean {
  if (!symbol || typeof pct !== "number" || !Number.isFinite(pct)) return false;
  const code = symbol.split(".")[0];
  let cap = 10;
  if (/^(4|8|92)/.test(code)) cap = 30;
  else if (/^(688|689)/.test(code)) cap = 20;
  else if (/^(300|301)/.test(code)) cap = date && date >= "2020-08-24" ? 20 : 10;
  return pct >= cap - 0.1;
}

/* ── 自研操盘趋势（策影 indicatorRegistry 逐字移植） ──
 * 短线：MA7 快 + MA10 慢（α .82）｜中线：MA35 快 + MA45 慢（α .86）
 * 收盘 ≥ 慢线 → 多头（橙）否则空头（蓝）
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
          strong: k.close >= slow,
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
/* ═══ 智能画线：黄金分割 / 支撑压力（主图叠加，独立于指标集合） ═══ */
type LineBar = { open: number; high: number; low: number; close: number; volume?: number | null };
type LinePivot = { i: number; p: number; kind: "high" | "low"; open?: boolean };
type SRZone = { center: number; lo: number; hi: number; vol: number; peak: boolean };
type SmartDrawArgs = {
  ctx: CanvasRenderingContext2D;
  chart: Chart;
  indicator: { name: string };
  xAxis: { convertToPixel: (i: number) => number };
  yAxis: {
    convertToPixel: (p: number) => number;
    getRange: () => { displayFrom: number; displayTo: number };
  };
  bounding: { width: number; height: number; top: number; bottom: number };
};

function lineAtr(bars: LineBar[], n = 14): number {
  const trs = bars.map((b, i) => {
    const pc = i ? bars[i - 1].close : b.open;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
  const a = trs.slice(-n);
  return a.reduce((x, y) => x + y, 0) / (a.length || 1);
}

/* 阶段摆动识别（ZigZag 偏差 + 最小深度）：
 *  · 阈值 max(ATR14×2.5, 收盘价×5%)——过滤掉 2~4 根 K 线的小波动（ZigZag 常用 5%）
 *  · 深度 10 根——不足 10 根的摆动直接丢弃，同向枢轴合并保留更极端值
 *  · 只保留 stage 级高点/低点，末端未确认枢轴同样受深度约束 */
const LINE_DEPTH = 10;

/** ZigZag：自适应阈值 + 最小深度，末端枢轴标记为未确认。
 *  浪型用同一套算法但更细（阈值/深度可调）：阶段线要粗，浪级要细。 */
function linePivots(bars: LineBar[], depth = LINE_DEPTH, mult = 2.5, pct = 0.05): LinePivot[] {
  if (bars.length < depth * 2) return [];
  const close = bars[bars.length - 1].close;
  const th = Math.max(lineAtr(bars) * mult, close * pct);
  const out: LinePivot[] = [];
  let dir: 0 | 1 | -1 = 0;
  let ext: { i: number; p: number } | null = null;
  let hi = { i: 0, p: bars[0].high }, lo = { i: 0, p: bars[0].low };
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    if (dir === 0) {
      if (b.high > hi.p) hi = { i, p: b.high };
      if (b.low < lo.p) lo = { i, p: b.low };
      if (hi.p - lo.p >= th) {
        if (hi.i < lo.i) { out.push({ ...lo, kind: "low" }); ext = hi; dir = 1; }
        else { out.push({ ...hi, kind: "high" }); ext = lo; dir = -1; }
      }
    } else if (dir === 1) {
      if (b.high > ext!.p) ext = { i, p: b.high };
      else if (ext!.p - b.low >= th) { out.push({ ...ext!, kind: "high" }); dir = -1; ext = { i, p: b.low }; }
    } else {
      if (b.low < ext!.p) ext = { i, p: b.low };
      else if (b.high - ext!.p >= th) { out.push({ ...ext!, kind: "low" }); dir = 1; ext = { i, p: b.high }; }
    }
  }
  if (ext) out.push({ ...ext, kind: dir === 1 ? "high" : "low", open: true });
  // 最小深度过滤：与上一枢轴距离不足 LINE_DEPTH 的摆动不成立；
  // 被丢弃枢轴之后的同向枢轴并入原枢轴（保留更极端值）
  const kept: LinePivot[] = [];
  for (const p of out) {
    const last = kept[kept.length - 1];
    if (!last) { kept.push(p); continue; }
    if (last.kind === p.kind) {
      if (p.kind === "high" ? p.p >= last.p : p.p <= last.p) kept[kept.length - 1] = p;
      continue;
    }
    if (p.i - last.i < depth) continue;
    kept.push(p);
  }
  return kept;
}

/** 最近一段有效阶段摆动腿 → 回撤/反弹比例位 */
function lineFib(bars: LineBar[]) {
  const pv = linePivots(bars);
  if (!pv.length) return null;
  const last = bars[bars.length - 1];
  const end = pv[pv.length - 1];
  const atr = lineAtr(bars);
  let start: LinePivot | null = null;
  for (let i = pv.length - 2; i >= 0; i--) {
    if (pv[i].kind !== end.kind && Math.abs(end.i - pv[i].i) >= LINE_DEPTH && Math.abs(end.p - pv[i].p) >= atr * 1.5) {
      start = pv[i]; break;
    }
  }
  if (!start) {
    // 枢轴链过短：退到末端枢轴之前窗口内的阶段极值，仍要求足够跨度与幅度
    const win = bars.slice(0, end.i + 1);
    if (!win.length) return null;
    if (end.kind === "low") {
      let mi = 0;
      win.forEach((b, i) => { if (b.high > win[mi].high) mi = i; });
      start = { i: mi, p: win[mi].high, kind: "high" };
    } else {
      let mi = 0;
      win.forEach((b, i) => { if (b.low < win[mi].low) mi = i; });
      start = { i: mi, p: win[mi].low, kind: "low" };
    }
    if (Math.abs(end.i - start.i) < LINE_DEPTH || Math.abs(end.p - start.p) < atr * 1.5) return null;
  }
  const hiP = Math.max(start.p, end.p), loP = Math.min(start.p, end.p) , diff = hiP - loP;
  if (diff <= atr * 1.5) return null;
  const rebound = end.kind === "low";
  const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((r) => ({
    r, p: rebound ? loP + diff * r : hiP - diff * r,
  }));
  const pos = rebound ? (last.close - loP) / diff : (hiP - last.close) / diff;
  return { start, end, hiP, loP, diff, rebound, levels, pos };
}

/** 支撑压力带：成交量分布峰 + 近端枢轴，合并成“带” */
function lineSR(bars: LineBar[], pv: LinePivot[]) {
  const close = bars[bars.length - 1].close;
  if (bars.length < 10) return { sup: [] as SRZone[], res: [] as SRZone[], close };
  let hi = -Infinity, lo = Infinity;
  bars.forEach((b) => { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); });
  const nb = 20, bin = ((hi - lo) / nb) || 1;
  const bins = Array.from({ length: nb }, (_, i) => ({ i, lo: lo + bin * i, hi: lo + bin * (i + 1), v: 0 }));
  bars.forEach((b) => {
    const p = (b.high + b.low + b.close) / 3;
    const k = Math.max(0, Math.min(nb - 1, Math.floor((p - lo) / bin)));
    bins[k].v += (b.volume || 1);
  });
  const top = [...bins].sort((a, b) => b.v - a.v).slice(0, 6).sort((a, b) => a.i - b.i);
  const clusters: { i1: number; i2: number; v: number; lo: number; hi: number }[] = [];
  let cur: { i1: number; i2: number; v: number; lo: number; hi: number } | null = null;
  top.forEach((x) => {
    if (cur && x.i <= cur.i2 + 1) {
      cur.i2 = x.i; cur.v += x.v; cur.lo = Math.min(cur.lo, x.lo); cur.hi = Math.max(cur.hi, x.hi);
    } else {
      if (cur) clusters.push(cur);
      cur = { i1: x.i, i2: x.i, v: x.v, lo: x.lo, hi: x.hi };
    }
  });
  if (cur) clusters.push(cur);
  const cands: SRZone[] = clusters.map((c) => ({ center: (c.lo + c.hi) / 2, lo: c.lo, hi: c.hi, vol: c.v, peak: true }));
  pv.slice(-6).forEach((p) => cands.push({ center: p.p, lo: p.p - bin * 0.35, hi: p.p + bin * 0.35, vol: 0, peak: false }));
  cands.sort((a, b) => a.center - b.center);
  const merged: SRZone[] = [];
  cands.forEach((c) => {
    const m = merged[merged.length - 1];
    if (m && Math.abs(m.center - c.center) <= bin * 1.25) {
      m.lo = Math.min(m.lo, c.lo); m.hi = Math.max(m.hi, c.hi); m.center = (m.lo + m.hi) / 2;
      m.vol += c.vol; m.peak = m.peak || c.peak;
    } else merged.push({ ...c });
  });
  const sup = merged.filter((z) => z.center < close && Math.abs(close - z.center) / close <= 0.09).sort((a, b) => b.center - a.center).slice(0, 2);
  const res = merged.filter((z) => z.center > close && Math.abs(z.center - close) / close <= 0.09).sort((a, b) => a.center - b.center).slice(0, 2);
  return { sup, res, close };
}

/* ═══ 艾略特浪型：1-5 推动浪 / A-B-C 调整浪 ═══
 * 铁律（R.N. Elliott，不可违反）：
 *   ① 2 浪不破 1 浪起点（回撤 < 100%）
 *   ② 3 浪不是 1/3/5 浪中最短的一段（通常最长）
 *   ③ 4 浪不与 1 浪价格区间重叠（引导/终结楔形除外）
 * 软规则（仅用于给候选打分，挑最优结构）：
 *   2 浪回撤 38.2%~78.6%（0.5/0.618 最典型）、4 浪回撤 23.6%~50%、
 *   3 浪 ≈ 1.618×1 浪、5 浪 ≈ 1 浪 或 0.618×3 浪、2/4 浪交替（深度不同）
 * 识别流程：细 ZigZag 取摆动点 → 滑窗枚举 6 点/5 点候选 → 铁律过滤 → 打分 + 新鲜度。
 * 只做结构描述，不预测；末端未确认的枢轴用虚线 + 「?」标注。 */
const WAVE_TH_MULT = 1.6;
const WAVE_TH_PCT = 0.035;
const WAVE_DEPTH = 4;
const WAVE_BARS = 320;                          // 只在近 320 根内识别：贴住当前价，避免标到图上早已看不到的旧结构

type WaveStruct = {
  pts: (LinePivot & { label: string })[];
  dir: 1 | -1;
  title: string;
  note: string;
};

/** 铁律校验 + 软规则打分；n = 段数（4=走到 4 浪，5=完整推动浪） */
function waveScore(p: LinePivot[], dir: 1 | -1, n: number): { score: number; note: string } | null {
  const px = (k: number): number => p[k].p;
  const leg = (a: number, b: number): number => Math.abs(px(b) - px(a));
  const l1 = leg(0, 1), l3 = leg(2, 3);
  if (l1 <= 0 || l3 <= 0) return null;
  // ① 2 浪不破 1 浪起点
  if (dir === 1 ? px(2) <= px(0) : px(2) >= px(0)) return null;
  // ② 3 浪必须越过 1 浪终点
  if (dir === 1 ? px(3) <= px(1) : px(3) >= px(1)) return null;
  const l5 = n >= 5 ? leg(4, 5) : null;
  // ② 3 浪不是最短
  if (l3 < l1 * 0.95 || (l5 != null && l3 < l5 * 0.95)) return null;
  // ③ 4 浪不与 1 浪区间重叠（重叠视为楔形：不否决，扣分并标注）
  let diagonal = false;
  if (n >= 4) {
    const deep = dir === 1 ? px(4) <= px(0) : px(4) >= px(0);
    if (deep) return null;
    diagonal = dir === 1 ? px(4) <= px(1) : px(4) >= px(1);
  }
  let score = 4 - (diagonal ? 2 : 0);
  const r2 = dir === 1 ? (px(1) - px(2)) / l1 : (px(2) - px(1)) / l1;
  if (r2 >= 0.382 && r2 <= 0.786) score += r2 >= 0.5 && r2 <= 0.618 ? 2 : 1;
  const k3 = l3 / l1;
  if (k3 >= 1.4 && k3 <= 1.9) score += 2;
  else if (k3 <= 2.618) score += 1;
  let r4 = 0;
  if (n >= 4) {
    r4 = dir === 1 ? (px(3) - px(4)) / l3 : (px(4) - px(3)) / l3;
    if (r4 >= 0.236 && r4 <= 0.5) score += 1;
    if (Math.abs(r2 - r4) >= 0.15) score += 1;             // 交替
  }
  if (l5 != null) {
    const k5 = l5 / l1;
    if ((k5 >= 0.618 && k5 <= 1.0) || Math.abs(l5 / l3 - 0.618) <= 0.15) score += 1;
  }
  const note = `3浪 ${k3.toFixed(2)}×1浪`
    + (n >= 4 ? ` · 2浪回撤 ${Math.round(r2 * 100)}%` : "")
    + (diagonal ? " · 1/4 重叠(楔形)" : "");
  return { score, note };
}

/** A-B-C 调整浪校验（跟在 5 浪之后）：B 不破 5 浪极点，C 越过 A 终点 */
function waveABC(base: LinePivot, dir: 1 | -1, rest: LinePivot[]): boolean {
  if (rest.length < 3) return false;
  const [a, b, c] = rest;
  if (a.kind === base.kind || b.kind !== base.kind || c.kind !== a.kind) return false;
  return dir === 1 ? (b.p < base.p && c.p < a.p) : (b.p > base.p && c.p > a.p);
}

function lineWave(bars: LineBar[]): WaveStruct | null {
  if (bars.length < 40) return null;
  const off = Math.max(0, bars.length - WAVE_BARS);   // 识别窗口偏移：回填成整段数据的下标
  const win = off ? bars.slice(off) : bars;
  const pv = linePivots(win, WAVE_DEPTH, WAVE_TH_MULT, WAVE_TH_PCT);
  if (pv.length < 5) return null;
  let best: { s: number; n: number; total: number; note: string } | null = null;
  for (const n of [5, 4] as const) {
    for (let e = pv.length - 1; e >= n; e--) {
      const p = pv.slice(e - n, e + 1);
      const dir: 1 | -1 = p[0].kind === "low" ? 1 : -1;
      if (!p.every((x, i) => (i % 2 === 0 ? x.kind === p[0].kind : x.kind !== p[0].kind))) continue;
      const r = waveScore(p, dir, n);
      if (!r) continue;
      // 结构质量 + 完整度 + 新鲜度（越靠近最新枢轴越优先）
      const total = r.score + (n === 5 ? 0.8 : 0) - (pv.length - 1 - e) * 0.4;
      if (!best || total > best.total) best = { s: e - n, n, total, note: r.note };
    }
  }
  if (!best) return null;
  const p = pv.slice(best.s, best.s + best.n + 1);
  const dir: 1 | -1 = p[0].kind === "low" ? 1 : -1;
  const labels = ["0", "1", "2", "3", "4", "5"].slice(0, best.n + 1);
  const pts: (LinePivot & { label: string })[] = p.map((x, k) => ({ ...x, i: x.i + off, label: labels[k] }));
  let title = dir === 1 ? "上升 1-5 浪" : "下跌 1-5 浪";
  let note = best.note;
  if (best.n === 4) {
    title = dir === 1 ? "上升 1-4 浪（5 浪待确认）" : "下跌 1-4 浪（5 浪待确认）";
  } else {
    const rest = pv.slice(best.s + best.n + 1);
    if (waveABC(p[p.length - 1], dir, rest)) {
      rest.slice(0, 3).forEach((x, k) => pts.push({ ...x, i: x.i + off, label: ["A", "B", "C"][k] }));
      title += " + A-B-C 调整";
      note += " · 调整中";
    }
  }
  const last = pts[pts.length - 1];
  if (last.open && best.n === 5) title += "（末端未确认）";
  return { pts, dir, title, note };
}

/* ═══ 箱体 / 反转形态：横向震荡区间 + W底·M头·头肩 ═══
 * 箱体：细 ZigZag 的摆动点若高点成簇、低点也成簇，且区间内绝大多数收盘落在其中，
 *   即视为横向箱体；再按最新价在箱体中的位置 + 量能给出四种提示：
 *   下沿缩量企稳（风险相对可控）/ 上沿滞涨（警惕回落）/ 放量突破 / 放量跌破。
 * 反转形态：本质是支撑压力 + 颈线的组合，只认两种最经典的结构：
 *   · 底部：W 底 / 头肩底 —— 放量突破颈线才算成立
 *   · 顶部：M 头 / 头肩顶 —— 放量跌破颈线才算确认
 * 只画最近结构，颈线用虚线延伸到右侧；未突破时明确标注「未确认」。 */
const BOX_BARS = 200;
const PAT_BARS = 320;

type BoxStruct = {
  i0: number;
  hi: number;
  lo: number;
  state: string;
  tone: "brk" | "brkdn" | "ok" | "risk" | "wait";
};

function lineBox(bars: LineBar[]): BoxStruct | null {
  if (bars.length < 40) return null;
  const off = Math.max(0, bars.length - BOX_BARS);
  const win = off ? bars.slice(off) : bars;
  const n = win.length;
  const pv = linePivots(win, 3, 1.4, 0.03);
  if (pv.length < 5) return null;
  // 末端未确认枢轴可能是突破后的新高/新低，先剔除再找箱体（突破状态由最新收盘判断）
  const all = pv.slice(-10);
  const tail = all.length > 4 && all[all.length - 1].open ? all.slice(0, -1) : all;
  let best: { pts: LinePivot[]; hi: number; lo: number; score: number } | null = null;
  for (let s = 0; s <= tail.length - 5; s++) {
    const seg = tail.slice(s);
    const highs = seg.filter((p) => p.kind === "high").map((p) => p.p);
    const lows = seg.filter((p) => p.kind === "low").map((p) => p.p);
    if (highs.length < 2 || lows.length < 2) continue;
    const hi = Math.max(...highs), lo = Math.min(...lows);
    const range = hi - lo;
    if (range <= 0) continue;
    const ratio = range / lo;
    if (ratio < 0.035 || ratio > 0.28) continue;          // 太窄不算箱体，太宽是趋势
    const hiBand = Math.max(...highs) - Math.min(...highs);
    const loBand = Math.max(...lows) - Math.min(...lows);
    if (hiBand > range * 0.45 || loBand > range * 0.45) continue;  // 上下沿各自要贴同一水平
    const i0 = seg[0].i, i1 = n - 1, span = i1 - i0 + 1;
    if (span < 25) continue;                              // 至少一个多月的横盘才算箱体
    const inside = win.slice(i0, i1 + 1).filter((b) => b.close >= lo * 0.985 && b.close <= hi * 1.015).length;
    if (inside / span < 0.86) continue;                    // 绝大多数收盘要在箱体内
    // 越长越好、上下沿越平越好，过宽的区间扣分
    const score = seg.length * 3 + (1 - (hiBand + loBand) / range) * 2 - ratio * 4;
    if (!best || score > best.score) best = { pts: seg, hi, lo, score };
  }
  if (!best) return null;
  const last = win[n - 1];
  const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const boxVol = avg(win.slice(best.pts[0].i).map((b) => b.volume || 0));
  const recentVol = avg(win.slice(-5).map((b) => b.volume || 0));
  const recentPeak = Math.max(...win.slice(-3).map((b) => b.volume || 0));
  const shrink = recentVol < boxVol * 0.85;
  const burst = recentPeak > boxVol * 1.35;
  const pos = (last.close - best.lo) / (best.hi - best.lo);
  let state = "区间震荡";
  let tone: BoxStruct["tone"] = "wait";
  if (last.close > best.hi * 1.003) {
    state = burst ? "放量突破上沿" : "突破上沿(量不足)";
    tone = "brk";
  } else if (last.close < best.lo * 0.997) {
    state = burst ? "放量跌破下沿" : "跌破下沿";
    tone = "brkdn";
  } else if (pos < 0.22) {
    state = shrink ? "下沿缩量企稳" : "回踩下沿";
    tone = shrink ? "ok" : "wait";
  } else if (pos > 0.78) {
    state = shrink ? "上沿缩量滞涨" : "上沿放量试探";
    tone = "risk";
  }
  return { i0: best.pts[0].i + off, hi: best.hi, lo: best.lo, state, tone };
}

type PatternStruct = {
  kind: "W底" | "M头" | "头肩底" | "头肩顶";
  dir: 1 | -1;                                          // 1=底部反转（看涨）· -1=顶部反转（看跌）
  pts: (LinePivot & { label: string })[];
  neck: number;
  status: string;
  confirmed: boolean;
};

function linePattern(bars: LineBar[]): PatternStruct | null {
  if (bars.length < 60) return null;
  const off = Math.max(0, bars.length - PAT_BARS);
  const win = off ? bars.slice(off) : bars;
  const pv = linePivots(win, 4, 1.8, 0.04);
  if (pv.length < 3) return null;
  const n = win.length;
  const close = win[n - 1].close;
  const vols = win.slice(-20).map((b) => b.volume || 0);
  const vAvg = vols.reduce((a, b) => a + b, 0) / (vols.length || 1);
  const volOk = Math.max(...win.slice(-3).map((b) => b.volume || 0)) > vAvg * 1.25;
  const at = (p: LinePivot, label: string) => ({ ...p, i: p.i + off, label });
  const cands: PatternStruct[] = [];
  const tag = (up: boolean): string => (volOk ? (up ? "放量突破颈线" : "放量跌破颈线") : (up ? "突破颈线(量不足)" : "跌破颈线(量不足)"));
  // 颈线穿越必须发生在最近 45 根内：老形态早就走完了，拿当前价去“确认”没有意义
  const brokeAt = (neck: number, up: boolean): number => {
    for (let i = n - 2; i >= Math.max(1, n - 45); i--) {
      const a = win[i - 1].close, b = win[i].close;
      if (up ? a <= neck && b > neck : a >= neck && b < neck) return i;
    }
    return -1;
  };
  const fresh = (i: number, bars: number): boolean => i >= n - bars;

  // 头肩底 / 头肩顶：最近 7 个枢轴内滑窗取 5 点，避免突破后新枢轴把形态挤掉
  for (let e = pv.length - 1; e >= Math.max(4, pv.length - 7); e--) {
    const [a, b, c, d, g] = pv.slice(e - 4, e + 1);
    if (a.kind === "low" && b.kind === "high" && c.kind === "low" && d.kind === "high" && g.kind === "low") {
      const neck = Math.max(b.p, d.p);
      const shGap = Math.abs(g.p - a.p) / a.p;
      if (c.p < a.p * 0.99 && c.p < g.p * 0.99 && shGap <= 0.08 && b.p > c.p * 1.02 && d.p > c.p * 1.02 && g.i - a.i <= 120) {
        const ok = close > neck * 1.002;
        if (ok ? brokeAt(neck, true) < 0 : !fresh(g.i, 50)) continue;
        cands.push({
          kind: "头肩底", dir: 1, neck, confirmed: ok,
          pts: [at(a, "左肩"), at(b, "颈1"), at(c, "头"), at(d, "颈2"), at(g, "右肩")],
          status: ok ? tag(true) : "待突破颈线 · 未确认",
        });
      }
    }
    if (a.kind === "high" && b.kind === "low" && c.kind === "high" && d.kind === "low" && g.kind === "high") {
      const neck = Math.min(b.p, d.p);
      const shGap = Math.abs(g.p - a.p) / a.p;
      if (c.p > a.p * 1.01 && c.p > g.p * 1.01 && shGap <= 0.08 && b.p < c.p * 0.98 && d.p < c.p * 0.98 && g.i - a.i <= 120) {
        const ok = close < neck * 0.998;
        if (ok ? brokeAt(neck, false) < 0 : !fresh(g.i, 50)) continue;
        cands.push({
          kind: "头肩顶", dir: -1, neck, confirmed: ok,
          pts: [at(a, "左肩"), at(b, "颈1"), at(c, "头"), at(d, "颈2"), at(g, "右肩")],
          status: ok ? tag(false) : "待跌破颈线 · 未确认",
        });
      }
    }
  }
  // W 底 / M 头：最近 6 个枢轴内滑窗取 3 点
  for (let e = pv.length - 1; e >= Math.max(2, pv.length - 6); e--) {
    const [a, b, c] = pv.slice(e - 2, e + 1);
    if (a.kind === "low" && b.kind === "high" && c.kind === "low") {
      const neck = b.p;
      if (neck > Math.max(a.p, c.p) * 1.03 && Math.abs(c.p - a.p) / a.p <= 0.06 && c.i - a.i <= 90) {
        const ok = close > neck * 1.002;
        if (ok ? brokeAt(neck, true) < 0 : !fresh(c.i, 40)) continue;
        cands.push({
          kind: "W底", dir: 1, neck, confirmed: ok,
          pts: [at(a, "底1"), at(b, "颈线"), at(c, "底2")],
          status: ok ? tag(true) : "待突破颈线 · 未确认",
        });
      }
    }
    if (a.kind === "high" && b.kind === "low" && c.kind === "high") {
      const neck = b.p;
      if (neck < Math.min(a.p, c.p) * 0.97 && Math.abs(c.p - a.p) / a.p <= 0.06 && c.i - a.i <= 90) {
        const ok = close < neck * 0.998;
        if (ok ? brokeAt(neck, false) < 0 : !fresh(c.i, 40)) continue;
        cands.push({
          kind: "M头", dir: -1, neck, confirmed: ok,
          pts: [at(a, "顶1"), at(b, "颈线"), at(c, "顶2")],
          status: ok ? tag(false) : "待跌破颈线 · 未确认",
        });
      }
    }
  }
  if (!cands.length) return null;
  // 已确认的优先（越新越好）；都没确认就画最新的那个并明确标注未确认
  const picked = cands.filter((p) => p.confirmed);
  const list = picked.length ? picked : cands;
  list.sort((x, y) => {
    const xi = x.pts[x.pts.length - 1].i, yi = y.pts[y.pts.length - 1].i;
    return yi - xi;
  });
  return list[0];
}

function drawSmartLines(a: SmartDrawArgs): void {
  const { ctx, chart, indicator, xAxis, yAxis, bounding } = a;
  const list = chart.getDataList() as unknown as LineBar[];
  if (list.length < 10) return;
  const W = bounding.width;
  // 叠加上层指标的 bounding.height 只给到图例高度（实测 22px），会被裁成一条；
  // 用价格轴显示区间反推主图高度，拿不到（NaN/异常）时退回 bounding.height。
  let H = bounding.height;
  try {
    const r = yAxis.getRange();
    const h = Math.abs(yAxis.convertToPixel(r.displayFrom) - yAxis.convertToPixel(r.displayTo));
    if (Number.isFinite(h) && h > 40) H = h;
  } catch { /* 保留 bounding.height */ }
  H = Math.max(60, H);
  const panel = cssv("--panel") || "#161618";
  const dim = cssv("--dim") || "#A1A1A6";
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  const xOf = (i: number): number => Math.max(0, Math.min(W, xAxis.convertToPixel(i)));
  const yOf = (p: number): number => yAxis.convertToPixel(p);
  const label = (txt: string, x: number, y: number, color: string): void => {
    if (y < 6 || y > H - 4) return;
    ctx.font = "9.5px ui-monospace,SFMono-Regular,Menlo,monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = panel;
    ctx.strokeText(txt, x, y - 3);
    ctx.fillStyle = color;
    ctx.fillText(txt, x, y - 3);
  };
  if (indicator.name === "ZY_FIB") {
    const f = lineFib(list);
    if (!f) { ctx.restore(); return; }
    const x0 = xOf(Math.min(f.start.i, f.end.i)), xEnd = W - 3;
    const y50 = yOf(f.levels[3].p), y618 = yOf(f.levels[4].p);
    ctx.fillStyle = "rgba(255,214,10,.07)";
    ctx.fillRect(x0, Math.min(y50, y618), Math.max(0, xEnd - x0), Math.abs(y50 - y618));
    ctx.strokeStyle = "rgba(255,159,67,.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xOf(f.start.i), yOf(f.start.p));
    ctx.lineTo(xOf(f.end.i), yOf(f.end.p));
    ctx.stroke();
    f.levels.forEach((lv) => {
      const y = yOf(lv.p);
      const gold = Math.abs(lv.r - 0.618) < 0.001;
      ctx.strokeStyle = gold ? "#FFD60A" : "rgba(161,161,166,.55)";
      ctx.lineWidth = gold ? 1.6 : 1;
      ctx.setLineDash(gold ? [] : [4, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(xEnd, y);
      ctx.stroke();
      label(`${(lv.r * 100).toFixed(1)}%  ${fmt(lv.p)}`, xEnd - 2, y, gold ? "#FFD60A" : dim);
    });
    ctx.setLineDash([]);
    [f.start, f.end].forEach((p) => {
      ctx.fillStyle = "#FF9F43";
      ctx.beginPath();
      ctx.arc(xOf(p.i), yOf(p.p), 2.6, 0, Math.PI * 2);
      ctx.fill();
    });
    const lvl = f.pos < 0.236 ? "弱反弹" : f.pos < 0.382 ? "反弹初期" : f.pos < 0.5 ? "修复反弹"
      : f.pos < 0.618 ? "强势反弹" : f.pos < 0.786 ? "接近反转" : "反转确认";
    const text = `${f.rebound ? "反弹" : "回撤"} ${Math.round(f.pos * 100)}% · ${lvl}`;
    ctx.font = "600 10px ui-monospace,SFMono-Regular,Menlo,monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(0,0,0,.42)";
    ctx.fillRect(7, 6, tw + 14, 19);
    ctx.fillStyle = "#FFD60A";
    ctx.fillText(text, 13, 10);
  } else if (indicator.name === "ZY_SR") {
    const m = lineSR(list, linePivots(list));
    const xEnd = W - 3;
    const band = (z: SRZone, kind: "sup" | "res"): void => {
      const yTop = Math.max(0, Math.min(H, yOf(z.hi)));
      const yBot = Math.max(0, Math.min(H, yOf(z.lo)));
      const y = Math.min(yTop, yBot), h = Math.max(1, Math.abs(yBot - yTop));
      const color = kind === "res" ? UP : DOWN;
      ctx.fillStyle = kind === "res" ? "rgba(239,83,80,.08)" : "rgba(81,156,44,.09)";
      ctx.fillRect(0, y, xEnd, h);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(0, yOf(z.center));
      ctx.lineTo(xEnd, yOf(z.center));
      ctx.stroke();
      ctx.setLineDash([]);
      label(`${kind === "res" ? "压力" : "支撑"} ${fmt(z.center)}${z.peak ? " · 峰" : ""}`, xEnd - 2, yOf(z.center), color);
    };
    m.res.forEach((z) => band(z, "res"));
    m.sup.forEach((z) => band(z, "sup"));
  } else if (indicator.name === "ZY_WAVE") {
    const w = lineWave(list);
    if (!w) { ctx.restore(); return; }
    const WAVE = "#FF79C6";
    const xEnd = W - 3;
    // 1-5 浪折线：3 浪金色加粗，末端未确认段虚线
    w.pts.forEach((p, k) => {
      if (k === w.pts.length - 1) return;
      const q = w.pts[k + 1];
      const is3 = k === 2;
      ctx.strokeStyle = is3 ? "#FFD60A" : WAVE;
      ctx.lineWidth = is3 ? 2 : 1.4;
      ctx.setLineDash(q.open ? [5, 4] : []);
      ctx.beginPath();
      ctx.moveTo(xOf(p.i), yOf(p.p));
      ctx.lineTo(xOf(q.i), yOf(q.p));
      ctx.stroke();
    });
    ctx.setLineDash([]);
    // 枢轴点 + 浪号（高点标在上方，低点标在下方；贴边时收进可视区）
    // 上下两侧各自记录上一个标签位置：只有同侧标签才会纵向撞在一起，异侧允许相邻
    const lastLblX: Record<"high" | "low", number> = { high: -999, low: -999 };
    w.pts.forEach((p) => {
      const x = Math.max(9, Math.min(xEnd - 9, xOf(p.i)));
      const y = yOf(p.p);
      const above = p.kind === "high";
      ctx.fillStyle = /^[ABC]$/.test(p.label) ? "#4DD0E1" : p.label === "3" ? "#FFD60A" : WAVE;
      ctx.beginPath();
      ctx.arc(xOf(p.i), y, 2.4, 0, Math.PI * 2);
      ctx.fill();
      if (Math.abs(x - lastLblX[p.kind]) < 11) return;
      lastLblX[p.kind] = x;
      ctx.font = "700 11px ui-monospace,SFMono-Regular,Menlo,monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = above ? "bottom" : "top";
      ctx.lineWidth = 3;
      ctx.strokeStyle = panel;
      ctx.strokeText(p.label, x, above ? y - 5 : y + 5);
      ctx.fillText(p.label, x, above ? y - 5 : y + 5);
    });
    // 左下角结构摘要：窄主图只留一行浪型，够高时补 3浪/1浪 比例
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const compact = H < 70;
    const t1 = `艾略特 ${w.title}`;
    const t2 = compact ? "" : w.note;
    ctx.font = "600 10px ui-monospace,SFMono-Regular,Menlo,monospace";
    const t1w = ctx.measureText(t1).width;
    ctx.font = "9.5px ui-monospace,SFMono-Regular,Menlo,monospace";
    const bw = Math.min(W - 14, Math.max(t1w, ctx.measureText(t2).width) + 16);
    const bh = compact ? 20 : 34;
    const by = Math.max(4, H - bh - 4);
    ctx.fillStyle = "rgba(0,0,0,.42)";
    ctx.fillRect(7, by, bw, bh);
    ctx.fillStyle = WAVE;
    ctx.font = "600 10px ui-monospace,SFMono-Regular,Menlo,monospace";
    ctx.fillText(t1, 13, by + 4);
    if (!compact) {
      ctx.font = "9.5px ui-monospace,SFMono-Regular,Menlo,monospace";
      ctx.fillStyle = dim;
      ctx.fillText(t2, 13, by + 19);
    }
  } else if (indicator.name === "ZY_BOX") {
    const b = lineBox(list);
    if (!b) { ctx.restore(); return; }
    const x0 = xOf(b.i0), xEnd = W - 3;
    const yTop = Math.max(0, Math.min(H, yOf(b.hi)));
    const yBot = Math.max(0, Math.min(H, yOf(b.lo)));
    const y = Math.min(yTop, yBot), h = Math.max(1, Math.abs(yBot - yTop));
    // 箱体底色 + 上下沿虚线；右端不封口，暗示区间仍在延续
    ctx.fillStyle = "rgba(144,164,174,.07)";
    ctx.fillRect(x0, y, Math.max(0, xEnd - x0), h);
    ctx.strokeStyle = "rgba(144,164,174,.7)";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, yTop);
    ctx.lineTo(xEnd, yTop);
    ctx.moveTo(x0, yBot);
    ctx.lineTo(xEnd, yBot);
    ctx.stroke();
    ctx.setLineDash([]);
    // 上下沿价格标在箱体左端（右侧已有黄金分割/支撑压力价位，避免叠字）
    ctx.font = "9.5px ui-monospace,SFMono-Regular,Menlo,monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 3;
    ctx.strokeStyle = panel;
    ctx.fillStyle = "#B0BEC5";
    const edgeX = Math.max(4, Math.min(x0 + 4, xEnd - 84));
    const edges: [string, number, number][] = [["上沿", b.hi, yTop], ["下沿", b.lo, yBot]];
    edges.forEach(([name, v, yy]) => {
      const s = `${name} ${fmt(v)}`;
      ctx.strokeText(s, edgeX, yy - 2);
      ctx.fillText(s, edgeX, yy - 2);
    });
    // 状态徽标放在箱体内部左侧：企稳 / 滞涨 / 突破，一眼看清当前该偏多还是偏空
    const tone = b.tone === "brk" ? UP : b.tone === "brkdn" ? DOWN
      : b.tone === "ok" ? "#4DD0E1" : b.tone === "risk" ? "#FFB74D" : dim;
    const txt = `箱体 · ${b.state}`;
    ctx.font = "600 10px ui-monospace,SFMono-Regular,Menlo,monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(txt).width;
    const tx = Math.max(x0 + 6, Math.min(xEnd - tw - 10, x0 + 10));
    const ty = Math.max(12, Math.min(H - 12, (yTop + yBot) / 2));
    if (h >= 44) {                                        // 箱体太窄时只留上下沿，避免三层文字叠在一起
      ctx.fillStyle = "rgba(0,0,0,.45)";
      ctx.fillRect(tx - 5, ty - 9, tw + 10, 18);
      ctx.fillStyle = tone;
      ctx.fillText(txt, tx, ty);
    }
  } else if (indicator.name === "ZY_PAT") {
    const p = linePattern(list);
    if (!p) { ctx.restore(); return; }
    const col = p.dir === 1 ? UP : DOWN;                 // 底部反转看涨用红，顶部反转看跌用绿
    const xEnd = W - 3;
    // 形态折线：依次连接左肩/头/右肩（或底1-颈-底2）
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([]);
    ctx.beginPath();
    p.pts.forEach((q, k) => {
      const x = xOf(q.i), y = yOf(q.p);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // 颈线：关键确认位，未突破时虚线到右端并明确标注
    const yNeck = yOf(p.neck);
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.setLineDash([7, 4]);
    ctx.beginPath();
    ctx.moveTo(xOf(p.pts[0].i), yNeck);
    ctx.lineTo(xEnd, yNeck);
    ctx.stroke();
    ctx.setLineDash([]);
    label(`颈线 ${fmt(p.neck)}`, xEnd - 2, yNeck, col);
    // 枢轴点 + 结构名（如 左肩 / 头 / 右肩 / 底1 / 底2）
    const lastLblX: Record<"high" | "low", number> = { high: -999, low: -999 };
    p.pts.forEach((q) => {
      const x = Math.max(12, Math.min(xEnd - 12, xOf(q.i)));
      const y = yOf(q.p);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(xOf(q.i), y, 2.4, 0, Math.PI * 2);
      ctx.fill();
      if (Math.abs(x - lastLblX[q.kind]) < 24) return;    // 结构名比浪号长，同侧间距要求更大
      lastLblX[q.kind] = x;
      ctx.font = "700 10px ui-monospace,SFMono-Regular,Menlo,monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = q.kind === "high" ? "bottom" : "top";
      ctx.lineWidth = 3;
      ctx.strokeStyle = panel;
      ctx.strokeText(q.label, x, q.kind === "high" ? y - 5 : y + 5);
      ctx.fillText(q.label, x, q.kind === "high" ? y - 5 : y + 5);
    });
    // 状态徽标固定在主图左上第二行：形态可能画得很长，跟着起点走容易跑到屏幕外
    const txt = `${p.kind} · ${p.status}`;
    ctx.font = "600 10px ui-monospace,SFMono-Regular,Menlo,monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(txt).width;
    const tx = 8, ty = 31;
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.fillRect(tx - 4, ty - 9, tw + 9, 18);
    ctx.fillStyle = col;
    ctx.fillText(txt, tx, ty);
  }
  ctx.restore();
}

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  registered = true;
  // BOLL 自研（策影同款）：注册为 BOLLX 避开 v10 内置同名不可靠覆盖；显示名仍为 BOLL
  registerIndicator({
    name: "BOLLX",
    shortName: "BOLL",
    precision: 2,
    calcParams: [
      { key: "timePeriod", value: 20 },
      { key: "stdDev", value: 2 },
    ],
    calc: (kLineDataList, indicator) => {
      const params = { timePeriod: 20, stdDev: 2 };
      indicator?.calcParams?.forEach((p: { key?: string; value?: number }) => {
        if (p.key !== undefined) (params as Record<string, number>)[p.key] = p.value!;
      });
      const n = Math.max(2, Math.round(params.timePeriod)), k = params.stdDev;
      let sum = 0, sq = 0;
      return kLineDataList.map((bar, i) => {
        sum += bar.close; sq += bar.close * bar.close;
        if (i >= n) { sum -= kLineDataList[i - n].close; sq -= kLineDataList[i - n].close ** 2; }
        if (i < n - 1) return { up: null, mid: null, dn: null };
        const mean = sum / n;
        const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
        return { up: mean + k * sd, mid: mean, dn: mean - k * sd };
      });
    },
    figures: [
      // 三轨固定色：上红 / 中蓝 / 下绿（红绿用 K 线口径，避免页面里多套红绿）
      { key: "up", title: "UP", type: "line", styles: () => ({ color: chartUp(), style: "dashed", lineWidth: 1 }) },
      { key: "mid", title: "MID", type: "line", styles: () => ({ color: "#4C8DFF", style: "dashed", lineWidth: 1 }) },
      { key: "dn", title: "DN", type: "line", styles: () => ({ color: chartDown(), style: "dashed", lineWidth: 1 }) },
    ],
    draw: (params: { ctx?: CanvasRenderingContext2D; chart?: Chart; indicator?: { result?: unknown[] } }) => {
      const { ctx, chart, indicator } = params;
      const data = (indicator?.result || []) as ({ up: number | null; dn: number | null } | null)[];
      if (!ctx || !chart || data.length === 0) return false;
      const barSpace = chart.getBarSpace?.() || { bar: 8 };
      const barWidth = Math.max(2, (barSpace.bar || 8) - 1);
      ctx.fillStyle = "rgba(142,142,147,.07)";   // 上下轨间中性淡填充，不抢 K 线
      data.forEach((item, i) => {
        if (!item || item.up == null || item.dn == null) return;
        const xPixel = chart.convertToPixel({ dataIndex: i, value: 0 }) as { x?: number };
        const upPixel = chart.convertToPixel({ dataIndex: i, value: item.up }) as { y?: number };
        const dnPixel = chart.convertToPixel({ dataIndex: i, value: item.dn }) as { y?: number };
        if (xPixel.x == null || upPixel.y == null || dnPixel.y == null) return;
        const h = Math.abs(upPixel.y - dnPixel.y);
        if (h < 0.5) return;
        ctx.fillRect(xPixel.x - barWidth / 2, Math.min(upPixel.y, dnPixel.y), barWidth, h);
      });
      return false;   // 继续默认绘制 figures（三条虚线轨道）
    },
  });
  // MACD 自研线条版：DIF/DEA 两条线 + MACD 值一条按正负着色的线。
  // 内置 MACD 画柱，和「趋势柱线」同形，放同一个副图区容易看混，改线条区分。
  registerIndicator({
    name: "MACDX",
    shortName: "MACD",
    precision: 2,
    calcParams: [12, 26, 9],
    calc: (list, indicator) => {
      const bars = list as unknown as Bar[];   // 只读 close，无需完整 Bar 字段
      const [fast, slow, sig] = ((indicator?.calcParams as number[] | undefined) ?? [12, 26, 9]);
      const ef = ema(bars, fast), es = ema(bars, slow);
      const dif = ef.map((v, i) => (v == null || es[i] == null ? null : v - es[i]!));
      // DEA = DIF 的 EMA(sig)：用首个 sig 个有效值做 SMA 种，再递推
      const dea: (number | null)[] = [];
      const k = 2 / (sig + 1);
      let seed = 0, cnt = 0, prev: number | null = null;
      for (const v of dif) {
        if (v == null) { dea.push(null); continue; }
        if (prev == null) {
          seed += v; cnt++;
          if (cnt >= sig) prev = seed / sig;
          dea.push(prev);
          continue;
        }
        prev = v * k + prev * (1 - k);
        dea.push(prev);
      }
      return dif.map((v, i) => ({
        dif: v, dea: dea[i],
        macd: v == null || dea[i] == null ? null : 2 * (v - dea[i]!),
      }));
    },
    figures: [
      { key: "dif", title: "DIF", type: "line", styles: () => ({ color: "#FF9F43", lineWidth: 1 }) },
      { key: "dea", title: "DEA", type: "line", styles: () => ({ color: "#4DD0E1", lineWidth: 1 }) },
      // 只为让纵轴把 MACD 值纳入取值范围（透明绘制，不显示这条折线）
      {
        key: "macd", title: "MACD", type: "line",
        styles: () => ({ color: "rgba(0,0,0,0)", lineWidth: 1 }),
      },
    ],
    // MACD 柱改「竖线段」：零轴到值画 1px 竖线，无空心无填充；红绿沿用 K 线口径。
    // 坐标必须用回调里的副图 xAxis/yAxis —— chart.convertToPixel 默认按主图
    // candle_pane 的价格轴换算，副图里画出来是错的（此前竖线因此看不见）。
    draw: (params: {
      ctx?: CanvasRenderingContext2D;
      xAxis?: { convertToPixel: (v: number) => number };
      yAxis?: { convertToPixel: (v: number) => number };
      indicator?: { result?: unknown[] };
    }) => {
      const { ctx, xAxis, yAxis, indicator } = params;
      const data = (indicator?.result || []) as ({ macd: number | null } | null)[];
      if (!ctx || !xAxis || !yAxis) return false;
      const up = chartUp(), dn = chartDown();
      const zeroY = yAxis.convertToPixel(0);
      ctx.lineWidth = 1;
      data.forEach((item, i) => {
        if (!item || item.macd == null) return;
        const x = Math.round(xAxis.convertToPixel(i)) + 0.5;  // +0.5 让 1px 竖线落在像素中心，不发虚
        const y = yAxis.convertToPixel(item.macd);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        ctx.strokeStyle = item.macd < 0 ? dn : up;
        ctx.beginPath();
        ctx.moveTo(x, zeroY);
        ctx.lineTo(x, y);
        ctx.stroke();
      });
      return false;   // 继续默认绘制 DIF/DEA 两条折线
    },
  });
  // 九转序列（TD Sequential）：主图数字叠加。
  // Setup：收盘对 4 根前收盘，连续计数 1..9（相等双向归零，中途断掉整段作废）；
  // 低9 画在 K 线下方、高9 上方。九转成立后进入 Countdown：收盘 ≤2 根前最低
  // （或 ≥2 根前最高）累计（非连续，不满足只跳过），尾段 10..13 续在同一行；
  // 第 13 个有效 bar 做「完美」检验（低向最低需 ≤ 第 8 个有效 bar 收盘），否则停在 12。
  registerIndicator({
    name: "ZY_TD_SEQ",
    shortName: "九转序列",
    calc: (list) => {
      const n = list.length;
      const out = Array.from({ length: n }, () => ({
        td: null as null, lo: 0, hi: 0,
        sl: 0, sh: 0, cl: 0, ch: 0,   // Setup 低/高计数、Countdown 低/高累计
      }));
      let d = 0, u = 0;                   // Setup 连续计数
      let cdL = 0, cdH = 0;               // Countdown 累计
      let pendL = false, pendH = false;   // 九转成立，等待倒计时
      let i8L = -1, i8H = -1;             // 倒计时第 8 个有效 bar
      for (let i = 0; i < n; i++) {
        const b = list[i];
        out[i].lo = b.low; out[i].hi = b.high;
        if (i >= 4) {
          const ref = list[i - 4].close;
          if (b.close < ref) { d++; u = 0; }
          else if (b.close > ref) { u++; d = 0; }
          else { d = 0; u = 0; }
          // 反向九转成立 → 取消另一方向的未完成倒计时
          if (u === 9) { pendH = true; cdH = 0; i8H = -1; pendL = false; cdL = 0; }
          if (d === 9) { pendL = true; cdL = 0; i8L = -1; pendH = false; cdH = 0; }
          out[i].sl = d; out[i].sh = u;
          if (d >= 9) d = 0;   // 九转走完，下一根重新从 1 起算
          if (u >= 9) u = 0;
        }
        // Countdown 低向：不连续，满足才 +1
        if (pendL && i >= 2 && b.close <= list[i - 2].low) {
          cdL++;
          if (cdL === 8) i8L = i;
          if (cdL >= 13) {
            if (i8L >= 0 && b.low <= list[i8L].close) out[i].cl = 13;  // 完美 → 13
            else { cdL = 12; out[i].cl = 12; }                         // 不完美 → 停 12
            pendL = false;
          } else out[i].cl = cdL;
        }
        // Countdown 高向
        if (pendH && i >= 2 && b.close >= list[i - 2].high) {
          cdH++;
          if (cdH === 8) i8H = i;
          if (cdH >= 13) {
            if (i8H >= 0 && b.high >= list[i8H].close) out[i].ch = 13;
            else { cdH = 12; out[i].ch = 12; }
            pendH = false;
          } else out[i].ch = cdH;
        }
      }
      return out;
    },
    figures: [
      { key: "td", title: "九转", type: "line", styles: () => ({ color: "transparent" }) },
    ],
    draw: ({ ctx, chart, indicator }) => {
      const data = (indicator.result || []) as ({ lo: number; hi: number; sl: number; sh: number; cl: number; ch: number } | null)[];
      const barSpace = chart.getBarSpace?.() || { bar: 8 };
      const bw = barSpace.bar || 8;
      if (bw < 3) return false;           // 太密：不标，避免糊成一片
      const font = bw >= 8 ? 10 : 9;
      ctx.save();
      ctx.textAlign = "center";
      data.forEach((it, i) => {
        if (!it) return;
        const x = (chart.convertToPixel({ dataIndex: i, value: 0 }) as { x?: number })?.x;
        if (x == null) return;
        const low = it.cl >= 10 ? it.cl : it.sl;   // 倒计时尾段优先（10..13 接在 9 后面）
        const high = it.ch >= 10 ? it.ch : it.sh;
        const put = (v: number, y: number, dir: "low" | "high") => {
          // 只标成立的 9 / 13：中间计数逐根都标会把 K 线压满（主流软件也只标关键位）
          if (v !== 9 && v !== 13) return;
          ctx.font = `600 ${font}px ui-monospace,SFMono-Regular,Menlo,monospace`;
          ctx.fillStyle = dir === "low" ? chartDown() : chartUp();
          ctx.textBaseline = dir === "low" ? "top" : "bottom";
          ctx.fillText(String(v), x, y);
        };
        const loPix = (chart.convertToPixel({ dataIndex: i, value: it.lo }) as { y?: number })?.y;
        const hiPix = (chart.convertToPixel({ dataIndex: i, value: it.hi }) as { y?: number })?.y;
        if (loPix != null) put(low, loPix + 3, "low");
        if (hiPix != null) put(high, hiPix - 3, "high");
      });
      ctx.restore();
      return false;
    },
  });
  registerTrendChannel("SHORT_TREND_CHANNEL", "短线趋势", 7, 10, 0.82);
  registerTrendChannel("MID_TREND_CHANNEL", "中线趋势", 35, 45, 0.86);
  // 分时均价线（VWAP）+ 昨收虚线基准（通达信分时同款）：后端 /market/minute 已算好，
  // baseline 由 setData 挂在每根分钟 bar 上（日线无此字段 → base 全 null 不画）
  try {
    registerIndicator({
      name: "TIME_AVG",
      shortName: "均价",
      calc: (kLineDataList) =>
        (kLineDataList as unknown as { avg?: number; baseline?: number }[]).map((b) => ({
          avg: b.avg ?? null, base: b.baseline ?? null,
        })),
      figures: [
        { key: "avg", title: "均价", type: "line", styles: () => ({ color: MIN_AVG_COLOR }) },
        { key: "base", title: "昨收", type: "line", styles: () => ({ color: MIN_AVG_COLOR, style: "dashed", lineWidth: 1 }) },
      ],
    });
  } catch { /* 重复注册忽略 */ }
  // 分时逐分钟量柱（通达信 VOLFS 同款）：红=分钟价较前分钟涨，绿=跌，灰=平
  try {
    registerIndicator<{ vol: number; rise: number }>({
      name: "VOLFS",
      shortName: "VOLFS",
      precision: 0,
      calc: (kLineDataList) => {
        const list = kLineDataList as unknown as { close: number; volume?: number; baseline?: number }[];
        return list.map((b, i) => {
          const prev = i > 0 ? list[i - 1].close : (b.baseline ?? b.close);
          return { vol: b.volume ?? 0, rise: b.close > prev ? 1 : b.close < prev ? -1 : 0 };
        });
      },
      figures: [{
        key: "vol", title: "VOLFS", type: "bar", baseValue: 0,
        styles: (params) => {
          const cur = (params.data as { current?: { rise?: number } | null }).current;
          const c = cur?.rise === 1 ? chartUp() : cur?.rise === -1 ? chartDown() : NEUTRAL;
          return { color: c, borderColor: c, borderSize: 1 };
        },
      }],
    });
  } catch { /* 重复注册忽略 */ }
  // 全局 Y 轴模板：覆盖内置 'normal'，成交量轴自动万/亿（策影 config.ts 同款）
  try {
    registerYAxis({ name: "trend_value", displayValueToText: (value: number) => value.toFixed(2) });
    registerYAxis({
      name: "normal",
      displayValueToText: (value: number, _precision: number) => {
        if (Math.abs(value) >= 1e8) return (value / 1e8).toFixed(2) + "亿";
        if (Math.abs(value) >= 1e4) return (value / 1e4).toFixed(0) + "万";
        return value.toFixed(0);   // 刻度整数化：不带小数点（万/亿缩写除外）
      },
    });
  } catch { /* 重复注册会报错，忽略 */ }
  // 六分段副图（K线下方叠加趋势图）：趋势线六位置 1..6 台阶线
  try {
    registerIndicator({
      name: "SIXSEG",
      shortName: "六段",
      precision: 0,
      calc: (kLineDataList) =>
        sixSegmentSeries(kLineDataList as unknown as { close: number; high: number; low: number }[]).map((v) => ({ seg: v })),
      figures: [{ key: "seg", title: "段位", type: "line", styles: () => ({ color: "#26C6DA" }) }],
    });
  } catch { /* 重复注册忽略 */ }
  registerIndicator({
    name: "ZY_ACCUMULATION",
    shortName: "主力吸筹",
    precision: 2,
    minValue: 0,
    calc: (list) => accumulationSeries(list).map(value => ({ accumulation: value })),
    figures: [{
      key: "accumulation", title: "吸筹", type: "bar", baseValue: 0,
      styles: () => ({ color: "#F000FF", borderColor: "#F000FF", borderSize: 1, style: "stroke" }),
    }],
  });
  registerIndicator({
    name: "ZY_MAIN_COST",
    shortName: "主力成本",
    precision: 2,
    calc: (list, indicator) => {
      // extendData 是设置弹窗的四条显隐开关（顺序同 figures），关掉的输出置 null 不上线
      const visible = (indicator?.extendData as boolean[] | undefined) ?? [true, true, true, true];
      return mainCostSeries(list as unknown as { open: number; high: number; low: number; close: number; volume?: number | null }[])
        .map(v => ({
          ultra: visible[0] === false ? null : v.ultra,
          short: visible[1] === false ? null : v.short,
          mid: visible[2] === false ? null : v.mid,
          long: visible[3] === false ? null : v.long,
        }));
    },
    figures: [
      { key: "ultra", title: "超短期", type: "line", styles: () => ({ color: "#FF9800", size: 1.2 }) },
      { key: "short", title: "短期", type: "line", styles: () => ({ color: "#C084FC", size: 1.2 }) },
      { key: "mid", title: "中期", type: "line", styles: () => ({ color: "#2DD4BF", size: 1.4 }) },
      { key: "long", title: "长期", type: "line", styles: () => ({ color: "#0A84FF", size: 1.6 }) },
    ],
    shouldUpdate: () => ({ calc: true, draw: true }),
  });
  registerIndicator({
    name: "ZY_STOCK_OPERATE", shortName: "个股操盘", precision: 2, minValue: 0, maxValue: 100,
    calc: (list) => stockOperateSeries(list as unknown as { high: number; low: number; close: number }[])
      .map(v => ({ ...v, top: 95, bottom: 5 })),
    figures: [
      // 公式里的 95,COLORGREEN 与 5,COLORBLUE 两条常量线，色值取自众赢实图
      { key: "top", title: "95", type: "line", styles: () => ({ color: "#75FB4C", size: 1 }) },
      { key: "bottom", title: "5", type: "line", styles: () => ({ color: "#0000F5", size: 1 }) },
      // 三个信号输出默认白/蓝/品红；都停在 50 时最后画品红，中间那根即呈品红
      { key: "band", title: "波段进场", type: "line", styles: () => ({ color: "#FFFFFF", size: 1 }) },
      { key: "rebound", title: "反弹进场", type: "line", styles: () => ({ color: "#0000F5", size: 1 }) },
      { key: "oversold", title: "超跌进场", type: "line", styles: () => ({ color: "#EA33F7", size: 1 }) },
    ],
    draw: ({ ctx, chart, indicator, xAxis, yAxis, bounding }) => {
      const data = indicator.result as { var4: number | null; band: number | null; rebound: number | null; oversold: number | null; red: boolean | null }[];
      const range = chart.getVisibleRange();
      const width = Math.max(1, chart.getBarSpace().bar * 0.6);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, bounding.width, bounding.height);
      ctx.clip();
      // STICKLINE(VAR4,REF(VAR4,1))：逐柱从上一值连到当前值，红=收盘≥MA10，绿=收盘<MA10
      for (let i = Math.max(1, Math.floor(range.from)); i < Math.min(data.length, Math.ceil(range.to) + 1); i++) {
        const prev = data[i - 1]?.var4, cur = data[i]?.var4;
        if (prev == null || cur == null || data[i].red == null) continue;
        const x = xAxis.convertToPixel(i);
        const y1 = yAxis.convertToPixel(prev), y2 = yAxis.convertToPixel(cur);
        ctx.fillStyle = data[i].red ? chartUp() : chartDown();
        ctx.fillRect(x - width / 2, Math.min(y1, y2), width, Math.max(1, Math.abs(y1 - y2)));
      }
      ctx.restore();
      return false;
    },
  });
  registerIndicator({
    name: "ZY_VOLUME_ACTIVITY", shortName: "量能活跃", precision: 2,
    calc: (list) => {
      const capital = (list[0] as { floatShares?: number } | undefined)?.floatShares ?? null;
      return volumeActivitySeries(list, capital).map(v => ({
        ...v, marker: v.signal ? 0 : null, zero: 0,
      }));
    },
    figures: [
      { key: "zero", title: "", type: "line", styles: () => ({ color: "transparent" }) },
      { key: "short", title: "短线量能", type: "line",
        styles: (raw: unknown) => ({ color: ((raw as {data?: {current?: {short?: number}}}).data?.current?.short ?? 0) >= 0 ? chartUp() : chartDown() }) },
      { key: "trend", title: "趋势量能", type: "line", styles: () => ({ color: "#25ACFA", size: 1.5 }) },
      { key: "marker", title: "", type: "line", styles: () => ({ color: "transparent" }) },
    ],
    draw: ({ ctx, chart, indicator, xAxis, yAxis, bounding }) => {
      const data = indicator.result as { short: number | null; signal: "TL" | "PP" | "DL" | null }[];
      const range = chart.getVisibleRange();
      const zeroY = yAxis.convertToPixel(0);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, bounding.width, bounding.height);
      ctx.clip();
      const fill = (x1: number, y1: number, x2: number, y2: number, positive: boolean) => {
        ctx.fillStyle = positive ? chartUp() : chartDown();
        ctx.beginPath();
        ctx.moveTo(x1, zeroY);
        ctx.lineTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x2, zeroY);
        ctx.closePath();
        ctx.fill();
      };
      for (let i = Math.max(1, Math.floor(range.from)); i < Math.min(data.length, Math.ceil(range.to) + 1); i++) {
        const a = data[i - 1]?.short, b = data[i]?.short;
        if (a == null || b == null) continue;
        const x1 = xAxis.convertToPixel(i - 1), x2 = xAxis.convertToPixel(i);
        const y1 = yAxis.convertToPixel(a), y2 = yAxis.convertToPixel(b);
        if (a * b < 0) {
          const cross = x1 + (x2 - x1) * a / (a - b);
          fill(x1, y1, cross, zeroY, a > 0);
          fill(cross, zeroY, x2, y2, b > 0);
        } else fill(x1, y1, x2, y2, (a || b) >= 0);
      }
      // PP=太阳（极度活跃），TL=闪电（十分活跃），DL=月亮（极度萎缩）。
      // 原模型以零轴为锚：正量能放下方，负量能放上方。
      for (let i = Math.max(0, Math.floor(range.from)); i < Math.min(data.length, Math.ceil(range.to) + 1); i++) {
        const value = data[i];
        if (!value?.signal) continue;
        const x = xAxis.convertToPixel(i);
        const y = Math.max(11, Math.min(bounding.height - 11, zeroY + ((value.short ?? 0) >= 0 ? 12 : -12)));
        ctx.save();
        ctx.translate(x, y);
        if (value.signal === "PP") {
          ctx.strokeStyle = "#F4AE19";
          ctx.lineWidth = 2;
          for (let ray = 0; ray < 12; ray++) {
            const angle = ray * Math.PI / 6;
            ctx.beginPath();
            ctx.moveTo(Math.cos(angle) * 7, Math.sin(angle) * 7);
            ctx.lineTo(Math.cos(angle) * 10, Math.sin(angle) * 10);
            ctx.stroke();
          }
          const gradient = ctx.createRadialGradient(-2, -2, 1, 0, 0, 7);
          gradient.addColorStop(0, "#FFF295"); gradient.addColorStop(1, "#F5B21C");
          ctx.fillStyle = gradient;
          ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill();
        } else if (value.signal === "TL") {
          ctx.fillStyle = "#FFD64B"; ctx.strokeStyle = "#DDA51F"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(-2, -10); ctx.lineTo(6, -10);
          ctx.lineTo(1, -2); ctx.lineTo(7, -2); ctx.lineTo(-5, 11);
          ctx.lineTo(-1, 2); ctx.lineTo(-7, 2); ctx.closePath(); ctx.fill(); ctx.stroke();
        } else {
          const gradient = ctx.createLinearGradient(-9, 0, 6, 0);
          gradient.addColorStop(0, "#A8ECFF"); gradient.addColorStop(1, "#269ACF");
          ctx.fillStyle = gradient;
          ctx.beginPath(); ctx.arc(0, 0, 10, Math.PI / 2, Math.PI * 1.5);
          ctx.bezierCurveTo(-5, -7, -5, 7, 0, 10); ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      }
      ctx.restore();
      return false; // 继续由图表绘制轮廓和蓝线。
    },
  });
  registerIndicator({
    name: "ZY_TREND_HISTOGRAM", shortName: "趋势柱线", precision: 2, shouldFormatBigNumber: false,
    calc: list => trendHistogramSeries(list).map(v => ({...v, zero: 0})),
    figures: [
      { key: "short", title: "趋势柱线", type: "line", styles: (raw: unknown) => {
        const v = (raw as {data?: {current?: {short?: number; base?: number}}}).data?.current;
        return { color: (v?.short ?? 0) >= (v?.base ?? 0) ? chartUp() : chartDown(), size: 1 };
      } },
      { key: "base", title: "中期", type: "line", styles: () => ({ color: "transparent" }) },
      { key: "zero", title: "", type: "line", styles: () => ({ color: "transparent" }) },
    ],
    draw: ({ ctx, chart, indicator, xAxis, yAxis, bounding }) => {
      const data = indicator.result as {short: number | null; base: number | null}[];
      const range = chart.getVisibleRange();
      const width = Math.max(1, chart.getBarSpace().bar * 0.6);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, bounding.width, bounding.height);
      ctx.clip();
      const column = (x: number, from: number, to: number, red: boolean) => {
        const y1 = yAxis.convertToPixel(from), y2 = yAxis.convertToPixel(to);
        ctx.fillStyle = red ? chartUp() : chartDown();
        ctx.fillRect(x - width / 2, Math.min(y1, y2), width, Math.abs(y1 - y2));
      };
      for (let i = Math.max(0, Math.floor(range.from)); i < Math.min(data.length, Math.ceil(range.to) + 1); i++) {
        const v = data[i];
        if (v?.short == null || v.base == null) continue;
        const x = xAxis.convertToPixel(i);
        column(x, 0, v.base, v.base >= 0);
        column(x, v.base, v.short, v.short > v.base);
      }
      const selected = data[(indicator.extendData as number | undefined) ?? data.length - 1];
      // 标题「趋势柱线」由 indicator tooltip 画在左上（10.5px），数值接在其右侧，避免压字
      ctx.font = "10.5px sans-serif";
      const titleW = ctx.measureText("趋势柱线").width;
      ctx.font = "12px sans-serif";
      ctx.textBaseline = "top";
      ctx.fillStyle = (selected?.short ?? 0) >= (selected?.base ?? 0) ? chartUp() : chartDown();
      ctx.fillText(`${selected?.short == null ? "--" : selected.short.toFixed(2)}`, 8 + titleW + 14, 5);
      ctx.restore();
      return false;
    },
  });
  registerIndicator({
    name: "ZY_STRONG_PULLBACK", shortName: "强势调整", precision: 2,
    calc: list => strongPullbackSeries(list).map(v => ({...v, eye: v.hit ? v.eye : null})),
    figures: [
      {key: "eye", title: "", type: "line", styles: () => ({color: "transparent"})},
      {key: "protection", title: "保护位", type: "line", styles: () => ({color: "transparent"})},
    ],
    draw: ({ctx, chart, indicator, xAxis, yAxis, bounding}) => {
      const data = indicator.result as ReturnType<typeof strongPullbackSeries>;
      const groups = new Map<number, {end: number; hits: number[]}>();
      data.forEach((v,i) => {
        if(v.anchor==null) return;
        let group=groups.get(v.anchor);
        if(!group){group={end:i,hits:[]};groups.set(v.anchor,group);}
        group.end=i;if(v.hit)group.hits.push(i);
      });
      const visible=chart.getVisibleRange();
      ctx.save();ctx.beginPath();ctx.rect(0,0,bounding.width,bounding.height);ctx.clip();
      groups.forEach((g,anchor) => {
        if(!g.hits.length || g.end<visible.from || anchor>visible.to) return;
        const first=g.hits[0],last=g.hits[g.hits.length-1];
        const protection=data[first].protection!,eye=data[first].eye!;
        const ex=xAxis.convertToPixel((first+last)/2),ey=yAxis.convertToPixel(eye);
        const py=yAxis.convertToPixel(protection),start=xAxis.convertToPixel(anchor),end=xAxis.convertToPixel(g.end);
        ctx.strokeStyle=chartDown();ctx.fillStyle=chartDown();ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(start,py);ctx.lineTo(end,py);ctx.stroke();
        ctx.font="11px sans-serif";ctx.textAlign="left";ctx.textBaseline="bottom";
        ctx.fillText("保护位 "+protection.toFixed(2),Math.min(end+5,bounding.width-100),py-3);
        ctx.strokeStyle=chartUp();ctx.fillStyle=chartUp();
        g.hits.forEach(i => {
          const tx=xAxis.convertToPixel(i),ty=yAxis.convertToPixel(data[i].low)+4;
          const angle=Math.atan2(ty-ey,tx-ex);
          ctx.beginPath();ctx.moveTo(ex,ey-4);ctx.lineTo(tx,ty);ctx.stroke();
          ctx.beginPath();ctx.moveTo(tx,ty);
          ctx.lineTo(tx-6*Math.cos(angle-0.45),ty-6*Math.sin(angle-0.45));
          ctx.lineTo(tx-6*Math.cos(angle+0.45),ty-6*Math.sin(angle+0.45));ctx.closePath();ctx.fill();
        });
        // 共用一只眼睛，位于本组首末命中K线的中间；仅影响绘图，不回写历史信号。
        ctx.fillStyle="#DDA53E";ctx.strokeStyle="#9C6A20";ctx.lineWidth=1;
        ctx.beginPath();ctx.ellipse(ex,ey,9,6,0,0,Math.PI*2);ctx.fill();ctx.stroke();
        ctx.fillStyle="#FFF4D3";ctx.beginPath();ctx.ellipse(ex,ey,6.5,4,0,0,Math.PI*2);ctx.fill();
        ctx.fillStyle="#171717";ctx.beginPath();ctx.arc(ex,ey,3.5,0,Math.PI*2);ctx.fill();
        ctx.fillStyle="#FFFFFF";ctx.beginPath();ctx.arc(ex+1,ey-1.5,1.2,0,Math.PI*2);ctx.fill();
      });
      ctx.restore();return true;
    },
  });
  // 钱眼掘金·近似：钱袋=阶段低点（画在最低价下方），地雷=阶段高点（画在最高价上方）
  registerIndicator({
    name: "ZY_QYJJ", shortName: "阶段反转", precision: 2, shouldFormatBigNumber: false,
    calc: list => qyjjSeries(list).map(v => ({ ...v, px: v.close })),
    figures: [{ key: "px", title: "", type: "line", styles: () => ({ color: "transparent" }) }],
    draw: ({ ctx, chart, indicator, xAxis, yAxis, bounding }) => {
      const data = indicator.result as QyjjRow[];
      const range = chart.getVisibleRange();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, bounding.width, bounding.height);
      ctx.clip();
      for (let i = Math.max(0, Math.floor(range.from)); i < Math.min(data.length, Math.ceil(range.to) + 1); i++) {
        const row = data[i];
        if (!row?.signal || row.anchor == null) continue;
        const x = xAxis.convertToPixel(i);
        const y = yAxis.convertToPixel(row.anchor);
        // 图标贴 K 线外侧；靠边时夹到绘图区内，避免被裁剪
        if (row.signal === "money") drawQyjjIcon(ctx, "money", x, Math.min(bounding.height - 11, y + 15));
        else drawQyjjIcon(ctx, "mine", x, Math.max(11, y - 15));
      }
      ctx.restore();
      return false;
    },
  });
  // ATR 自研（klinecharts v10 未内置）：14 日真实波幅均值
  try {
    registerIndicator({
      name: "ATR",
      shortName: "ATR",
      precision: 2,
      calc: (kLineDataList) => {
        const list = kLineDataList as unknown as { high: number; low: number; close: number }[];
        const n = 14;
        const tr = list.map((b, i) =>
          i ? Math.max(b.high - b.low, Math.abs(b.high - list[i - 1].close), Math.abs(b.low - list[i - 1].close)) : b.high - b.low);
        let sum = 0;
        return list.map((_, i) => {
          sum += tr[i];
          if (i >= n) sum -= tr[i - n];
          return { atr: i >= n - 1 ? sum / n : NaN };
        });
      },
      figures: [{ key: "atr", title: "ATR", type: "line", styles: () => ({ color: "#F2C94C" }) }],
    });
  } catch { /* 重复注册忽略 */ }
  // VOLX 自研成交量：量柱涨红跌绿，两条均量线周期可调。
  try {
    registerIndicator({
      name: "VOLX",
      shortName: "VOL",
      precision: 0,
      shouldFormatBigNumber: true,
      calcParams: [5, 10],
      shouldUpdate: () => ({ calc: true, draw: true }),
      calc: (list, indicator) => volumeAverageSeries(list, indicator.calcParams as number[])
        .map(value => ({ ...value,
          ma1: (indicator.extendData as boolean[] | undefined)?.[0] === false ? null : value.ma1,
          ma2: (indicator.extendData as boolean[] | undefined)?.[1] === false ? null : value.ma2,
        })) as never,
      draw: ({ ctx, indicator }) => {
        ctx.save();
        ctx.textBaseline = "top";
        // 标题由 tooltip 画在左上（仅名称）；均量线标签不带周期参数，避免从图面反推实现
        ctx.font = "11px sans-serif";
        const startX = 38;
        indicator.calcParams.forEach((_, i) => {
          if ((indicator.extendData as boolean[] | undefined)?.[i] === false) return;
          ctx.fillStyle = i === 0 ? "#FF9F43" : "#4DD0E1";
          ctx.fillText(`均量${i + 1}`, startX + i * 48, 4);
        });
        ctx.restore();
        return false;
      },
      figures: [
        {
          key: "volume", title: "VOL", type: "bar",
          // v10 回调第一参即 {data:{prev,current,next}}，current 为 calc 结果项。
          // 与 K 线同款：阳线空心红、阴线实心绿、涨停阳线实心红；色值直接用 K 线口径。
          styles: (raw: unknown) => {
            const c = (raw as { data?: { current?: { close?: number; open?: number; limitUp?: boolean } } })?.data?.current;
            const up = chartUp(), dn = chartDown();
            const bar = (color: string, style: "fill" | "stroke") =>
              ({ color, borderColor: color, borderSize: 1, style });
            if (c?.close == null || c.open == null) return bar(NEUTRAL, "fill");
            if (c.close > c.open) {
              if (c.limitUp) return bar(up, "fill");
              return { color: "rgba(0,0,0,0)", borderColor: up, borderSize: 1, style: "stroke" };
            }
            if (c.close < c.open) return bar(dn, "fill");
            return bar(NEUTRAL, "fill");
          },
        },
        { key: "ma1", title: "M1", type: "line", styles: () => ({ color: "#FF9F43", size: 1 }) },
        { key: "ma2", title: "M2", type: "line", styles: () => ({ color: "#4DD0E1", size: 1 }) },
      ],
    });
  } catch { /* 重复注册忽略 */ }
  // 超买超卖三件套（v10 内置无 80/20、70/30 阈值参考线，自研补齐）：
  // KDJX(9,3,3) 80/20 · RSIX(6/12/24) 70/30 · WRX(10,6) 80/20 —— 阈值线作为固定值 figures 灰虚线
  try {
    const smaCn = (src: (number | null)[], n: number, m: number): (number | null)[] => {
      const out: (number | null)[] = [];
      let prev = NaN;
      for (let i = 0; i < src.length; i++) {
        const x = src[i];
        if (x == null) { out.push(null); continue; }
        prev = isNaN(prev) ? x : (m * x + (n - m) * prev) / n;
        out.push(prev);
      }
      return out;
    };
    const dash = (key: string, title: string) => ({
      key, title, type: "line" as const,
      styles: () => ({ color: "rgba(142,142,147,.55)", style: "dashed" as const, lineWidth: 1 }),
    });
    registerIndicator({
      name: "KDJX",
      shortName: "KDJ",
      precision: 2,
      calcParams: [
        { key: "n", value: 9 }, { key: "m1", value: 3 }, { key: "m2", value: 3 },
      ],
      calc: (kLineDataList, indicator) => {
        const p: Record<string, number> = { n: 9, m1: 3, m2: 3 };
        indicator?.calcParams?.forEach((x: { key?: string; value?: number }) => {
          if (x.key !== undefined) p[x.key] = x.value!;
        });
        const list = kLineDataList as unknown as { high: number; low: number; close: number }[];
        const n = Math.max(1, Math.round(p.n));
        const rsv: (number | null)[] = list.map((_, i) => {
          if (i < n - 1) return null;
          let h = -Infinity, l = Infinity;
          for (let j = i - n + 1; j <= i; j++) { h = Math.max(h, list[j].high); l = Math.min(l, list[j].low); }
          return h === l ? 50 : ((list[i].close - l) / (h - l)) * 100;
        });
        const k = smaCn(rsv, p.m1, 1), d = smaCn(k, p.m2, 1);
        return list.map((_, i) => ({
          k: k[i], d: d[i], j: k[i] != null && d[i] != null ? 3 * k[i]! - 2 * d[i]! : null,
          ob: 80, os: 20,
        }));
      },
      figures: [
        { key: "k", title: "K", type: "line", styles: () => ({ color: "#FF9F43" }) },
        { key: "d", title: "D", type: "line", styles: () => ({ color: "#4DD0E1" }) },
        { key: "j", title: "J", type: "line", styles: () => ({ color: "#AB47BC" }) },
        dash("ob", "超买80"), dash("os", "超卖20"),
      ],
    });
    // OBOS 超买超卖（策影 CAOPAN 同款）：操盘值 = 加权价(2C+H+L+O)/5 在 14 周期
    // LLV~HHV 区间的位置百分位；超买 95 橙 / 中轴 50 灰 / 超卖 5 青参考线
    registerIndicator({
      name: "OBOSX",
      shortName: "操盘",
      precision: 0,
      calcParams: [{ key: "n", value: 14 }],
      calc: (kLineDataList, indicator) => {
        const p: Record<string, number> = { n: 14 };
        indicator?.calcParams?.forEach((x: { key?: string; value?: number }) => {
          if (x.key !== undefined) p[x.key] = x.value!;
        });
        const list = kLineDataList as unknown as { open: number; high: number; low: number; close: number }[];
        const n = Math.max(1, Math.round(p.n));
        const base = list.map((k) => (2 * k.close + k.high + k.low + k.open) / 5);
        return list.map((_, i) => {
          if (i < n - 1) return { cp: null, ob: 95, mid: 50, os: 5 };
          let h = -Infinity, l = Infinity;
          for (let j = i - n + 1; j <= i; j++) { h = Math.max(h, base[j]); l = Math.min(l, base[j]); }
          return { cp: h === l ? 50 : ((base[i] - l) / (h - l)) * 100, ob: 95, mid: 50, os: 5 };
        });
      },
      figures: [
        { key: "cp", title: "操盘", type: "line", styles: () => ({ color: "#4FC3F7", lineWidth: 1.4 }) },
        dash("ob", "超买95"), dash("mid", "中轴50"), dash("os", "超卖5"),
      ],
    });
    registerIndicator({
      name: "RSIX",
      shortName: "RSI",
      precision: 2,
      calcParams: [
        { key: "n1", value: 6 }, { key: "n2", value: 12 }, { key: "n3", value: 24 },
      ],
      calc: (kLineDataList, indicator) => {
        const p: Record<string, number> = { n1: 6, n2: 12, n3: 24 };
        indicator?.calcParams?.forEach((x: { key?: string; value?: number }) => {
          if (x.key !== undefined) p[x.key] = x.value!;
        });
        const list = kLineDataList as unknown as { close: number }[];
        const rsiOf = (n: number): (number | null)[] => {
          const up: (number | null)[] = [], dn: (number | null)[] = [];
          for (let i = 0; i < list.length; i++) {
            if (!i) { up.push(null); dn.push(null); continue; }
            const ch = list[i].close - list[i - 1].close;
            up.push(Math.max(ch, 0)); dn.push(Math.abs(ch));
          }
          const su = smaCn(up, n, 1), sd = smaCn(dn, n, 1);
          return list.map((_, i) =>
            su[i] == null || sd[i] == null ? null : sd[i] === 0 ? 100 : (su[i]! / sd[i]!) * 100);
        };
        const r1 = rsiOf(p.n1), r2 = rsiOf(p.n2), r3 = rsiOf(p.n3);
        return list.map((_, i) => ({ r1: r1[i], r2: r2[i], r3: r3[i], ob: 70, os: 30 }));
      },
      figures: [
        { key: "r1", title: "RSI6", type: "line", styles: () => ({ color: "#FF9F43" }) },
        { key: "r2", title: "RSI12", type: "line", styles: () => ({ color: "#4DD0E1" }) },
        { key: "r3", title: "RSI24", type: "line", styles: () => ({ color: "#AB47BC" }) },
        dash("ob", "超买70"), dash("os", "超卖30"),
      ],
    });
    registerIndicator({
      name: "WRX",
      shortName: "WR",
      precision: 2,
      calcParams: [
        { key: "n1", value: 10 }, { key: "n2", value: 6 },
      ],
      calc: (kLineDataList, indicator) => {
        const p: Record<string, number> = { n1: 10, n2: 6 };
        indicator?.calcParams?.forEach((x: { key?: string; value?: number }) => {
          if (x.key !== undefined) p[x.key] = x.value!;
        });
        const list = kLineDataList as unknown as { high: number; low: number; close: number }[];
        const wrOf = (n: number): (number | null)[] =>
          list.map((_, i) => {
            if (i < n - 1) return null;
            let h = -Infinity, l = Infinity;
            for (let j = i - n + 1; j <= i; j++) { h = Math.max(h, list[j].high); l = Math.min(l, list[j].low); }
            return h === l ? 50 : ((h - list[i].close) / (h - l)) * 100;
          });
        const w1 = wrOf(Math.max(1, Math.round(p.n1))), w2 = wrOf(Math.max(1, Math.round(p.n2)));
        return list.map((_, i) => ({ w1: w1[i], w2: w2[i], ob: 80, os: 20 }));
      },
      figures: [
        { key: "w1", title: "WR10", type: "line", styles: () => ({ color: "#FF9F43" }) },
        { key: "w2", title: "WR6", type: "line", styles: () => ({ color: "#4DD0E1" }) },
        dash("ob", "超买80"), dash("os", "超卖20"),
      ],
    });
  } catch { /* 重复注册忽略 */ }
  /* 智能画线：黄金分割 / 支撑压力（主图叠加，不进入指标集合） */
  try {
    registerIndicator({
      name: "ZY_FIB",
      shortName: "黄金分割",
      precision: 2,
      calc: (kLineDataList) => (kLineDataList as unknown as LineBar[]).map((b) => ({ guide: b.close })),
      figures: [{ key: "guide", title: "", type: "line", styles: () => ({ color: "transparent", size: 0.1 }) }],
      draw: (p) => { drawSmartLines(p as unknown as SmartDrawArgs); return true; },
    });
  } catch { /* 重复注册忽略 */ }
  try {
    registerIndicator({
      name: "ZY_SR",
      shortName: "支撑压力",
      precision: 2,
      calc: (kLineDataList) => (kLineDataList as unknown as LineBar[]).map((b) => ({ guide: b.close })),
      figures: [{ key: "guide", title: "", type: "line", styles: () => ({ color: "transparent", size: 0.1 }) }],
      draw: (p) => { drawSmartLines(p as unknown as SmartDrawArgs); return true; },
    });
  } catch { /* 重复注册忽略 */ }
  try {
    registerIndicator({
      name: "ZY_WAVE",
      shortName: "浪型结构",
      precision: 2,
      calc: (kLineDataList) => (kLineDataList as unknown as LineBar[]).map((b) => ({ guide: b.close })),
      figures: [{ key: "guide", title: "", type: "line", styles: () => ({ color: "transparent", size: 0.1 }) }],
      draw: (p) => { drawSmartLines(p as unknown as SmartDrawArgs); return true; },
    });
  } catch { /* 重复注册忽略 */ }
  try {
    registerIndicator({
      name: "ZY_BOX",
      shortName: "箱体区间",
      precision: 2,
      calc: (kLineDataList) => (kLineDataList as unknown as LineBar[]).map((b) => ({ guide: b.close })),
      figures: [{ key: "guide", title: "", type: "line", styles: () => ({ color: "transparent", size: 0.1 }) }],
      draw: (p) => { drawSmartLines(p as unknown as SmartDrawArgs); return true; },
    });
  } catch { /* 重复注册忽略 */ }
  try {
    registerIndicator({
      name: "ZY_PAT",
      shortName: "反转形态",
      precision: 2,
      calc: (kLineDataList) => (kLineDataList as unknown as LineBar[]).map((b) => ({ guide: b.close })),
      figures: [{ key: "guide", title: "", type: "line", styles: () => ({ color: "transparent", size: 0.1 }) }],
      draw: (p) => { drawSmartLines(p as unknown as SmartDrawArgs); return true; },
    });
  } catch { /* 重复注册忽略 */ }
}

/* ── 时间转换（策影 format.ts 逐字 + 分钟级 datetime 支持） ── */
function toTs(time: string): number {
  if (!time) return Date.now();
  if (time.includes("T")) return new Date(time).getTime();
  if (time.includes(" ")) return new Date(time.replace(" ", "T") + ":00").getTime();
  return new Date(time + "T00:00:00").getTime();
}

/* ── 指标注册表：klinecharts 内置名直通 + 自研（SHORT/MID/SIXSEG/TIME_AVG）──
 * 分类对齐主流软件（同花顺/东财/TradingView）：主图叠加 / 趋势 / 动量 / 量能 / 摆动人气 / 波动分位 */
export type IndCat = "main" | "trend" | "mom" | "vol" | "swing" | "volat";
export type IndDef = { key: string; kc: string; label: string; cat: IndCat; where: "main" | "sub"; desc: string };
export const IND_CATS: { cat: IndCat; label: string }[] = [
  { cat: "main", label: "主图叠加" }, { cat: "trend", label: "趋势" }, { cat: "mom", label: "动量" },
  { cat: "vol", label: "量能" }, { cat: "swing", label: "摆动人气" }, { cat: "volat", label: "波动分位" },
];
export const IND_DEFS: IndDef[] = [
  // 主图叠加
  { key: "qyjj", kc: "ZY_QYJJ", label: "阶段反转", cat: "main", where: "main", desc: "阶段反转信号：钱袋=阶段低点、地雷=阶段高点，信号落在拐点后一根" },
  { key: "strongpullback", kc: "ZY_STRONG_PULLBACK", label: "强势调整", cat: "main", where: "main", desc: "起点后限定周期内连线，随后结束；量能配合、收盘站上中线趋势；破保护位或缩量结束；同组眼睛连线" },
  { key: "ma", kc: "MA", label: "均线", cat: "main", where: "main", desc: "移动平均线（周期可设置）" },
  { key: "td", kc: "ZY_TD_SEQ", label: "九转序列", cat: "main", where: "main", desc: "TD Sequential：只在成立的计数节点处标数字（需完美检验）" },
  { key: "ema", kc: "EMA", label: "指数均线", cat: "main", where: "main", desc: "指数移动平均线" },
  { key: "boll", kc: "BOLLX", label: "BOLL", cat: "main", where: "main", desc: "布林带（虚线三轨+淡填充）" },
  { key: "sar", kc: "SAR", label: "SAR", cat: "main", where: "main", desc: "抛物线转向（停损点）" },
  { key: "short", kc: "SHORT_TREND_CHANNEL", label: "短线趋势", cat: "main", where: "main", desc: "短线操盘趋势通道（价格相对慢线的位置着色）" },
  { key: "maincost", kc: "ZY_MAIN_COST", label: "主力成本", cat: "main", where: "main", desc: "按量能占比分档权重的多条成本线，齿轮里可逐条开关；原软件标注仅大盘，此处个股也可显示" },
  { key: "mid", kc: "MID_TREND_CHANNEL", label: "中线趋势", cat: "main", where: "main", desc: "中线操盘趋势通道（价格相对慢线的位置着色）" },
  { key: "avg", kc: "TIME_AVG", label: "均价线", cat: "main", where: "main", desc: "分时均价线（日内）" },
  { key: "bbi", kc: "BBI", label: "BBI", cat: "main", where: "main", desc: "多空指数（四均线加权）" },
  { key: "bbiboll", kc: "BBIBOLL", label: "BBIBOLL", cat: "main", where: "main", desc: "BBI 布林变异带（多均线布林）" },
  // 趋势类
  { key: "trendhistogram", kc: "ZY_TREND_HISTOGRAM", label: "趋势柱线", cat: "trend", where: "sub", desc: "零轴至中期值、短期至中期值的红绿实心柱；个股与指数可用" },
  { key: "macd", kc: "MACDX", label: "MACD", cat: "trend", where: "sub", desc: "指数平滑异同移动平均（DIF/DEA 折线 + MACD 柱改竖线段，红绿按正负）" },
  { key: "dmi", kc: "DMI", label: "DMI", cat: "trend", where: "sub", desc: "趋向指标（ADX 强弱方向）" },
  { key: "trix", kc: "TRIX", label: "TRIX", cat: "trend", where: "sub", desc: "三重指数平滑平均线" },
  { key: "emv", kc: "EMV", label: "EMV", cat: "trend", where: "sub", desc: "简易波动指标（量价趋势）" },
  { key: "dma", kc: "DMA", label: "DMA", cat: "trend", where: "sub", desc: "平均线差（快慢均线差值）" },
  // 动量类
  { key: "stockoperate", kc: "ZY_STOCK_OPERATE", label: "个股操盘", cat: "mom", where: "sub", desc: "收盘在近期高低区间的位置平滑；红柱=站上慢线、绿柱=跌破慢线；三根水平参考线；波段/反弹/超跌进场时信号线上移" },
  { key: "kdj", kc: "KDJX", label: "KDJ", cat: "mom", where: "sub", desc: "随机指标（超买/超卖参考线）" },
  { key: "rsi", kc: "RSIX", label: "RSI", cat: "mom", where: "sub", desc: "相对强弱指标（超买/超卖参考线）" },
  { key: "cci", kc: "CCI", label: "CCI", cat: "mom", where: "sub", desc: "顺势指标（脱离常态范围）" },
  { key: "roc", kc: "ROC", label: "ROC", cat: "mom", where: "sub", desc: "变动率指标" },
  { key: "mtm", kc: "MTM", label: "MTM", cat: "mom", where: "sub", desc: "动量指标" },
  { key: "wr", kc: "WRX", label: "WR", cat: "mom", where: "sub", desc: "威廉指标（超买/超卖参考线）" },
  { key: "obos", kc: "OBOSX", label: "超买超卖", cat: "mom", where: "sub", desc: "操盘线：加权价位置百分位（超买/中轴/超卖参考）" },
  { key: "psy", kc: "PSY", label: "PSY", cat: "mom", where: "sub", desc: "心理线（上涨天数占比）" },
  { key: "lwr", kc: "LWR", label: "LWR", cat: "mom", where: "sub", desc: "威廉随机指标（快慢随机线）" },
  { key: "osc", kc: "OSC", label: "OSC", cat: "mom", where: "sub", desc: "变动率柱（震荡量指标）" },
  { key: "udl", kc: "UDL", label: "UDL", cat: "mom", where: "sub", desc: "引力线（多周期动量合成）" },
  // 量能类
  { key: "volumeactivity", kc: "ZY_VOLUME_ACTIVITY", label: "量能活跃", cat: "vol", where: "sub", desc: "短线量能红绿填充、趋势量能蓝线；太阳=极度活跃、闪电=十分活跃、月亮=极度萎缩；指数或缺少数据不计算" },
  { key: "accumulation", kc: "ZY_ACCUMULATION", label: "主力吸筹", cat: "vol", where: "sub", desc: "紫色柱为价格推导指标，非实际主力资金" },
  { key: "vol", kc: "VOLX", label: "VOL", cat: "vol", where: "sub", desc: "成交量（两条均量线，周期可设置）" },
  { key: "volfs", kc: "VOLFS", label: "VOLFS", cat: "vol", where: "sub", desc: "分时逐分钟量柱（分钟价涨红/跌绿，通达信分时同款）" },
  { key: "obv", kc: "OBV", label: "OBV", cat: "vol", where: "sub", desc: "能量潮（量能累积方向）" },
  { key: "vr", kc: "VR", label: "VR", cat: "vol", where: "sub", desc: "成交量比率" },
  { key: "wvad", kc: "WVAD", label: "WVAD", cat: "vol", where: "sub", desc: "威廉变异离散量（量价加权）" },
  // 摆动人气类
  { key: "brar", kc: "BRAR", label: "BRAR", cat: "swing", where: "sub", desc: "情绪指标（人气/意愿）" },
  { key: "cr", kc: "CR", label: "CR", cat: "swing", where: "sub", desc: "能量指标（中间意愿）" },
  { key: "bias", kc: "BIAS", label: "BIAS", cat: "swing", where: "sub", desc: "乖离率（偏离均线程度）" },
  // 波动分位类
  { key: "atr", kc: "ATR", label: "ATR", cat: "volat", where: "sub", desc: "真实波幅（波动强度）" },
  { key: "sixseg", kc: "SIXSEG", label: "六段", cat: "volat", where: "sub", desc: "趋势线六位置（超跌/反弹/突破/超涨/回踩/跌破）：价格相对短线趋势快慢线的位置" },
];
export const IND_BY_KEY: Record<string, IndDef> = Object.fromEntries(IND_DEFS.map((d) => [d.key, d]));

/** 合法键集合由注册表决定（放宽为 string，持久化值经 KMAIN_OK/KSUB_OK 校验） */
export type MainKey = string;
export type SubKey = string;

/** 框选区间统计（图表侧算完抛给行情页：价格/量额口径全在这，资金由接口补） */
export interface RangeStats {
  startDate: string; endDate: string; days: number;
  changePct: number; amp: number;
  high: number; low: number; close: number;
  amount: number; avgAmount: number; volume: number;
  upN: number; downN: number;
  /* 选区像素位置（卡片定位用，跨模块无用） */
  x0: number; x1: number;
}

/** 单根 K 线选中（点击蜡烛）：行情页据此把右列资金卡切到「该交易日」口径 */
export interface PickBar {
  date: string;
  index: number;
  open: number; high: number; low: number; close: number;
  prevClose: number | null;
  changePct: number;
  amp: number;
  amount: number;
  volume: number;
}

/** 区间资金（/market/fundflow 的回填口径；指数 available=false，只报原因） */
export interface RangeFund {
  available: boolean;
  covered: number;
  net_main: number | null;
  net_super: number | null;
  net_large: number | null;
  net_medium: number | null;
  net_small: number | null;
}

export interface KlineChartHandle {
  chart: Chart;
  setData: (bars: Bar[], keepView?: boolean, floatShares?: number | null, focusDate?: string, symbol?: string) => void;
  /** 主图多选叠加：增量增删，不动已叠加的同名指标 */
  setMain: (inds: MainKey[]) => void;
  /** 图内右上角指标图例（MA/BOLL/操盘趋势，色块+名称；多面板时每实例一份） */
  drawLegend: (inds: MainKey[]) => void;
  /** 副图多选：每个指标一个窗格，高度均分（策影 autoLayout 同款） */
  setSub: (inds: SubKey[]) => void;
  /** 智能画线：黄金分割 / 支撑压力 / 浪型结构（主图叠加，独立开关） */
  setLines: (fib: boolean, sr: boolean, wave: boolean, box: boolean, pat: boolean) => void;
  /** 当前周期（d/w/m/q）：决定十字光标卡片的标题形态 */
  setPeriod: (p: "t" | "60" | "d" | "w" | "m" | "q") => void;
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
  /** 框选模式开关：开=左键直接拖拽框选（禁用平移），关=恢复平移并清空选区 */
  setRangeMode: (on: boolean) => void;
  /** 框选模式是否开启（工具栏按钮态与图表实例对账用） */
  isRangeMode: () => boolean;
  /** 单选 K 线模式开关：开=点击蜡烛选中单根；关=点击不再选中并清空已有选中 */
  setPickMode: (on: boolean) => void;
  /** 单选 K 线模式是否开启 */
  isPickMode: () => boolean;
  /** 区间资金回填（行情页拉到 /market/fundflow 后写回卡片） */
  setRangeFund: (f: RangeFund | null) => void;
  /** 清空选区（切标的 / 切周期 / 关闭模式时调用，notify=true 会同步清右列） */
  clearRange: (notify?: boolean) => void;
  /** 清空单根选中（notify=true 同步通知行情页把资金卡退回当日口径） */
  clearPick: (notify?: boolean) => void;
  retheme: () => void;
  resize: () => void;
  destroy: () => void;
}

/* ── 智能高度（策影 computeAutoPaneHeights 同款） ──
 * 主图:单个副图 = 3.6:1（1 副图 → 主图 78%，2 → 64%，3 → 55%）；
 * 副图夹在 44~132px；主图硬约束 ≥ 3×副图且 ≥160px，空间不足时副图退让。 */
const X_AXIS_H = 24, MAIN_SUB_RATIO = 3.6,
  SUB_MIN = 44, SUB_MAX = 132, MAIN_MIN = 160, MAIN_MIN_RATIO = 3;
/** 默认视图末根与价格轴之间的留白（px）：一根半柱宽，末根完整可见但不显得离轴太远 */
const RIGHT_GAP_PX = 14;

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

/** 副图标题：只画名称，不带参数，避免从图面反推实现细节 */
function subTip(label: string) {
  return () => ({
    name: label,
    calcParamsText: "",
    legends: [],
    features: [],
  });
}

/** 主图指标：回传空数据源，让出价格区（标题只给副图） */
const NO_TIP = () => ({ name: "", calcParamsText: "", legends: [], features: [] });

function styles() {
  const border = cssv("--border") || "#2B2B2F";
  const axis = cssv("--axis") || border;
  const text = cssv("--faint") || "#717176";
  const dim = cssv("--dim") || "#A1A1A6";
  const up = chartUp(), dn = chartDown();
  const hole = cssv("--panel") || "#161618";      // 空心阳线的填充色 = 图表面板底色
  return {
    grid: { show: false },
    separator: { size: 1, color: border, fill: false, activeBackgroundColor: border },
    candle: {
      // 实心图元 + 逐柱配色：阳线用面板底色填充做出空心（影线只留上下两截），
      // 涨停阳线改为实心红；阴线实心绿。原 candle_up_stroke 无法给单根涨停改实心。
      type: "candle_solid" as CandleType,
      tooltip: { showRule: "none" as const },
      bar: (data: unknown) => {
        const cur = (data as { current?: { open?: number; close?: number; limitUp?: boolean } | null })?.current;
        if (!cur || cur.close == null || cur.open == null) {
          return { color: NEUTRAL, borderColor: NEUTRAL, wickColor: NEUTRAL };
        }
        if (cur.close > cur.open) {
          return cur.limitUp
            ? { color: up, borderColor: up, wickColor: up }
            : { color: hole, borderColor: up, wickColor: up };
        }
        if (cur.close < cur.open) return { color: dn, borderColor: dn, wickColor: dn };
        return { color: NEUTRAL, borderColor: NEUTRAL, wickColor: NEUTRAL };
      },
      // area 形态默认（分时主图用，periodStyles 覆盖线色/填充）
      area: {
        lineSize: 1.2, lineColor: up, value: "close", smooth: false,
        backgroundColor: [
          { offset: 0, color: "rgba(64,110,161,0.30)" },
          { offset: 1, color: "rgba(64,110,161,0.02)" },
        ],
        point: { show: false, color: up, radius: 0, rippleColor: up, rippleRadius: 0, animation: false },
      },
      priceMark: { show: true, last: { show: false }, high: { show: true }, low: { show: true } },
    },
    indicator: {
      // 副图常显标题（名称+参数）：多个副图窗格不再分不清谁是谁。
      // 数值图例行由各指标 callback 关闭（只留标题），44~132px 的副图里少遮挡。
      tooltip: {
        showRule: "always" as const,
        showType: "standard" as const,
        offsetLeft: 8, offsetRight: 8, offsetTop: 3,
        title: {
          show: true, showName: true, showParams: true,
          color: dim, size: 10.5,
          marginLeft: 0, marginTop: 0, marginRight: 0, marginBottom: 0,
        },
        legend: { color: text, size: 10, marginLeft: 0, marginTop: 0, marginRight: 8, marginBottom: 0 },
      },
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
    // 时间轴交给底部控制条（顶部一条细刻度），图表内不重复画 x 轴日期
    // （多窗格各自一条 x 轴 = 视觉上「两个时间轴」，同时白占高度）
    xAxis: { show: false, size: "auto" as const },
    yAxis: {
      show: true, size: "auto" as const,
      axisLine: { color: axis, size: 1 }, tickLine: { color: axis, size: 1, length: 3 },
      tickText: { show: true, color: text, size: 11 },
    },
  };
}

/* 分时主图形态（众赢/策影同款）：价格曲线（area）+ 均价线，非蜡烛。
 * 其余周期走基础样式；retheme/切周期统一经此，避免 setStyles 把 area 冲回蜡烛。 */
function periodStyles(p: TipPeriod): ReturnType<typeof styles> {
  const s = styles();
  if (p !== "t") return s;
  const line = cssv("--text") || "#F5F5F7";
  return {
    ...s,
    candle: {
      ...s.candle,
      type: "area",
      priceMark: {
        ...s.candle.priceMark,
        high: { ...s.candle.priceMark.high, show: false },
        low: { ...s.candle.priceMark.low, show: false },
      },
      area: { ...s.candle.area, lineColor: line, point: { ...s.candle.area.point, color: line, rippleColor: line } },
    },
  };
}

/* ── 十字光标浮动信息卡（周期区分标题） ── */
type TipPeriod = "t" | "60" | "d" | "w" | "m" | "q";

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
  if (p === "q") {
    const q = Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;
    return `${date.slice(0, 4)}Q${q} · 季线`;
  }
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
  // 最新 K 线右侧留 14px 空隙：0 时末根实体压在价格轴上（klinecharts 的
  // scrollToDataIndex 就会把它顶到 diff=0），太大则末根离轴太远像数据缺失。
  try { chart.setOffsetRightDistance(RIGHT_GAP_PX); } catch { /* 忽略 */ }
  // v10 门控：symbol/period 无效时 getBars 永远不触发（canvas 空白无报错），
  // 数据虽由外部回填，仍需设置合法 symbol/period 才能打开加载开关
  chart.setSymbol({ ticker: "YUCHAO", pricePrecision: 2, volumePrecision: 0 });
  chart.setPeriod({ type: "day", span: 1 });

  /* 框选状态（声明提前：onCross 里要判断"是否已有区间卡"，避免与十字光标卡同屏叠两张） */
  let rangeMode = false;
  let lastSel: RangeStats | null = null;
  /* 单选 K 线模式：默认关闭（点击只移动十字光标，不选单根）；勾选后点击才选中 */
  let pickMode = false;

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
  let legendInds: MainKey[] = [];
  const drawLegend = (inds: MainKey[]) => {
    legendInds = inds;
    const parts: string[] = [];
    if (inds.includes("ma"))
      parts.push(visibleMARows().map((line) =>
        `<span><i style="background:${line.color}"></i>${line.label}</span>`).join(""));
    if (inds.includes("boll"))
      parts.push(`<span><i style="background:${chartUp()}"></i><i style="background:#4C8DFF"></i><i style="background:${chartDown()}"></i>BOLL</span>`);
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
      // 每趋势一项：双色调语义（主色=强 / 次色=弱），当前状态全亮、另一态半透明
      const cF = `rgb(${p.fr.join(",")})`, cS = `rgb(${p.sr.join(",")})`;
      parts.push(`<span title="通道颜色：主色=趋势强，次色=趋势弱">` +
        `${k === "short" ? "短线" : "中线"}趋势` +
        `<i style="background:${cF}"></i><b style="${strong ? "" : "opacity:.4"}">强</b>` +
        `<i style="background:${cS}"></i><b style="${!strong ? "" : "opacity:.4"}">弱</b></span>`);
    }
    legend.innerHTML = parts.join("");
    legend.style.display = parts.length ? "flex" : "none";
  };

  let trendCrosshairValueVisible = false;
  const onCross = (...args: unknown[]) => {
    const crosshair = args[0] as { paneId?: string } | null;
    const showTrendValue = !!crosshair?.paneId && chart.getIndicators({ paneId: crosshair.paneId })
      .some(indicator => indicator.name === "ZY_TREND_HISTOGRAM");
    if (showTrendValue !== trendCrosshairValueVisible) {
      trendCrosshairValueVisible = showTrendValue;
      chart.setStyles({ crosshair: { horizontal: { text: {
        show: showTrendValue, color: cssv("--text") || "#F5F5F7", size: 12,
        backgroundColor: cssv("--panel-3") || "#2D2D31", borderSize: 1,
        borderColor: cssv("--text-muted") || "#888", borderRadius: 4,
      } } } });
    }
    // 框选模式下已有区间卡：不再叠一张十字光标卡（两张同风格浮卡会互相打架）
    if (rangeMode && lastSel) { tip.style.display = "none"; return; }
    const ch = args[0] as { x?: number; y?: number } | null;
    if (!ch || ch.x == null || ch.y == null) { tip.style.display = "none"; return; }
    const list = chart.getDataList() as { timestamp: number; open: number; high: number; low: number; close: number; volume?: number; amount?: number; date?: string }[];
    // v10 crosshair 事件只带坐标，经 convertFromPixel 反查数据索引（策影同款）
    const hit = chart.convertFromPixel([{ x: ch.x }]) as unknown;
    const di = (Array.isArray(hit) ? hit[0] : hit)?.dataIndex as number | undefined;
    chart.overrideIndicator({ name: "ZY_TREND_HISTOGRAM", extendData: di ?? list.length - 1 });
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

  /* ── 框选区间统计（策影鼠标框选移植）：拖拽一段 → 涨跌幅 / 振幅 / 量额 / 资金 ──
   *  · 框选模式（工具栏「框选」）：左键直接拖，无需修饰键；期间禁用图表平移
   *  · 非框选模式：保留 Shift + 拖拽的快捷手势（老路子，不破坏习惯）
   *  · 卡片刻意与十字光标卡（.kl-tip）同语言：紧凑分组行 + 半透明毛玻璃，少遮挡
   *  · 结果通过 yc:kl-range 事件抛给行情页 → 右列资金卡同步（kline.ts 不认标的）
   */
  const sel = document.createElement("div");
  sel.className = "kl-selbox";
  sel.style.display = "none";
  el.appendChild(sel);
  const selTip = document.createElement("div");
  selTip.className = "kl-seltip";
  selTip.style.display = "none";
  el.appendChild(selTip);
  let selX0: number | null = null;
  let downX = 0;                        // 按下点（判定「点击」还是「拖拽」，用于点空白撤选中）
  let selFund: RangeFund | null = null;
  const ymd = (t: number): string => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  /** 像素 x → 数据索引（越界返回 undefined） */
  const diOfX = (x: number): number | undefined => {
    const hit = chart.convertFromPixel([{ x }]) as unknown;
    return (Array.isArray(hit) ? hit[0] : hit)?.dataIndex as number | undefined;
  };
  const kv = (k: string, v: string, c = "") => `<span>${k}<b class="num ${c}">${v}</b></span>`;

  /** 资金行（右列接口回填后追加；指数无个股资金流 → 只报覆盖天数与原因） */
  const fundHtml = (): string => {
    if (!lastSel) return "";
    if (!selFund) return `<div class="st-g fund"><span>资金<b class="num">统计中…</b></span></div>`;
    if (!selFund.available)
      return `<div class="st-g fund"><span>主力净流入<b class="num" style="color:var(--faint)">—</b></span>` +
        `<span style="color:var(--faint);font-size:10px">指数无资金流</span></div>`;
    const yi = (v: number | null | undefined) => v == null ? "—" : fmtYi(v, 2);
    const m = selFund.net_main, cls = (m ?? 0) >= 0 ? "up" : "down";
    return `<div class="st-g fund"><span>主力净流入<b class="num ${cls}">${m == null ? "—" : (m > 0 ? "+" : "") + yi(m)}</b></span>` +
      `<span>覆盖<b class="num">${selFund.covered}天</b></span></div>` +
      `<div class="st-g fund"><span>超大<b class="num">${yi(selFund.net_super)}</b></span>` +
      `<span>大单<b class="num">${yi(selFund.net_large)}</b></span></div>` +
      `<div class="st-g fund"><span>中单<b class="num">${yi(selFund.net_medium)}</b></span>` +
      `<span>小单<b class="num">${yi(selFund.net_small)}</b></span></div>`;
  };

  const drawSelTip = (): void => {
    const s = lastSel;
    if (!s) { selTip.style.display = "none"; return; }
    const cls = s.changePct >= 0 ? "up" : "down";
    selTip.innerHTML =
      `<div class="t">区间 ${s.days} 根 · ${s.startDate} → ${s.endDate}</div>` +
      `<div class="grp">${kv("涨跌", `${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(2)}%`, cls)}` +
      `${kv("振幅", s.amp.toFixed(2) + "%")}${kv("阳/阴", `${s.upN}/${s.downN}`)}</div>` +
      `<div class="grp">${kv("高", fmt(s.high))}${kv("低", fmt(s.low))}${kv("收盘", fmt(s.close), cls)}</div>` +
      `<div class="grp">${kv("成交额", fmtYi(s.amount, 2))}${kv("日均", fmtYi(s.avgAmount, 2))}${kv("量", fmtVol(s.volume / 100) + "手")}</div>` +
      `<div class="st-sep"></div>` + fundHtml() +
      `<div class="st-f">${rangeMode ? "继续拖拽调整区间 · 点击空白关闭" : "Shift + 拖拽框选 · 点击空白关闭"}</div>`;
    selTip.style.display = "block";
    tip.style.display = "none";          // 区间卡优先：收起停留在图表上的十字光标卡
    placeSelTip();
  };

  /** 卡片定位：贴选区右缘（越界翻左），纵向钉在图表上部，避让顶部图例 */
  const placeSelTip = (): void => {
    if (!lastSel || selTip.style.display === "none") return;
    const r = el.getBoundingClientRect();
    const x1 = Math.max(lastSel.x0, lastSel.x1), x0 = Math.min(lastSel.x0, lastSel.x1);
    const tw = selTip.offsetWidth, th = selTip.offsetHeight;
    const flip = x1 + tw + 12 > r.width;
    selTip.style.left = `${Math.max(4, flip ? x0 - tw - 12 : x1 + 12)}px`;
    selTip.style.top = `${Math.max(8, Math.min(r.height - th - 8, 46))}px`;
  };

  const clearSel = (notify: boolean): void => {
    lastSel = null; selFund = null;
    selTip.style.display = "none";
    sel.style.display = "none";
    if (notify) document.dispatchEvent(new CustomEvent("yc:kl-range", { detail: null }));
  };

  /** 图表面板上叠着齿轮 / 指标 / 导航等按钮：点在它们身上不算「点 K 线」，
   *  否则打开成交量设置就会把已选中的那根清掉，右侧资金卡也跟着变空 */
  const onWidget = (event: MouseEvent): boolean =>
    event.target instanceof Element
    && !!event.target.closest("button, .kl-nav, .kl-ipanel, .kl-more");

  const onSelDown = (e: MouseEvent) => {
    // 只认左键；框选模式或 Shift 手势才进入拖拽，否则视为"点空白关卡片"
    if (e.button !== 0 || onWidget(e)) return;
    downX = e.clientX;
    if (!rangeMode && !e.shiftKey) {
      // 非框选模式：只在这里关区间卡；单根选中交给 mouseup 的 pickAtIndex 统一裁决
      // （在这里先清会把「再点同一根取消」变成先清空再重选，toggle 永远失效）
      if (lastSel) clearSel(true);
      return;
    }
    e.preventDefault(); e.stopPropagation();                     // 拦截 v10 平移，进入框选
    const r = el.getBoundingClientRect();
    selX0 = e.clientX;
    sel.style.left = `${e.clientX - r.left}px`; sel.style.top = "0px";
    sel.style.width = "0px"; sel.style.height = `${r.height}px`;
    sel.style.display = "block";
  };
  const onSelMove = (e: MouseEvent) => {
    if (selX0 == null) return;
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect();
    const a = Math.min(selX0, e.clientX) - r.left, b = Math.max(selX0, e.clientX) - r.left;
    sel.style.left = `${a}px`; sel.style.width = `${b - a}px`;
  };
  const onSelUp = (e: MouseEvent) => {
    if (selX0 == null) {
      if (onWidget(e)) return;                 // 落在按钮上：不参与单根命中
      // 点击（非拖拽）→ 按 x 列命中单根：点在这根 K 线所在的列上就算选中，
      // 不像原生 onCandleBarClick 那样要求精确落在实体矩形里（间隙/空白高度点不中）
      // 落在未来空白区（无对应 bar）则撤掉选中
      if (pickMode && e.button === 0 && Math.abs(e.clientX - downX) < 5) {
        const r = el.getBoundingClientRect();
        pickAtIndex(diOfX(e.clientX - r.left));
      }
      return;
    }
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect();
    const x0 = Math.min(selX0, e.clientX) - r.left, x1 = Math.max(selX0, e.clientX) - r.left;
    selX0 = null;
    // 框选模式下 mousedown 被拦截（stopPropagation），原生点击事件收不到：
    // 位移过小视为「点了一根 K 线」，手动补一次单根选中，两种模式手感一致
    if (x1 - x0 < 6) { if (pickMode) pickAtIndex(diOfX(x1)); drawSelBand(); return; }
    const diOf = diOfX;
    const i0 = diOf(x0), i1 = diOf(x1);
    const list = chart.getDataList() as { timestamp: number; open: number; high: number; low: number; close: number; volume?: number; amount?: number }[];
    if (i0 == null || i1 == null || !list.length) { drawSelBand(); return; }
    const a = Math.max(0, Math.min(i0, i1)), b = Math.min(list.length - 1, Math.max(i0, i1));
    const seg = list.slice(a, b + 1);
    if (seg.length < 2) { drawSelBand(); return; }
    const s = seg[0], t = seg[seg.length - 1];
    // 区间涨跌基准 = 首根前一日收盘（与资金流区间同口径，策影同款），首根无前行时退回开盘
    const base = a > 0 ? list[a - 1].close : s.open;
    const hi = Math.max(...seg.map((x) => x.high)), lo = Math.min(...seg.map((x) => x.low));
    const amt = seg.reduce((q, x) => q + (x.amount ?? 0), 0);
    const vol = seg.reduce((q, x) => q + (x.volume ?? 0), 0);
    const upN = seg.filter((x) => x.close >= x.open).length;
    lastSel = {
      startDate: ymd(s.timestamp), endDate: ymd(t.timestamp), days: seg.length,
      changePct: base ? (t.close - base) / base * 100 : 0,
      amp: base ? (hi - lo) / base * 100 : 0,
      high: hi, low: lo, close: t.close,
      amount: amt, avgAmount: amt / seg.length, volume: vol,
      upN, downN: seg.length - upN, x0, x1,
    };
    selFund = null;
    drawSelBand();                // 松手后保留选区图形（关闭框选时才清）
    drawSelTip();
    clearPickFn(true);            // 框出一段 → 单根选中让位（右卡只表达一个口径）
    document.dispatchEvent(new CustomEvent("yc:kl-range", { detail: { ...lastSel } }));
  };
  el.addEventListener("mousedown", onSelDown, true);
  el.addEventListener("mousemove", onSelMove, true);
  el.addEventListener("mouseup", onSelUp, true);

  /* ── 底部 K 线控制条（众赢同款）：顶部细时间刻度 + 条内年份段 + 滑块窗口 + 两端翻页箭头 ──
   *  · 时间刻度只保留一条（图表自带 x 轴已隐藏，避免多窗格各自画轴 → 视觉上「两个时间轴」）
   *  · 年份段按全量数据的年份边界划分，条内标 2021 / 2022 … 直观看出总年份跨度
   *  · 滑块拖动 = 平移可见区间，点轨道任意位置 = 直接跳到该处
   *  必须挂到面板(.klp / .sd-chart 父级)下沿：klinecharts 的 canvas 是 100% 高，
   *  放在图表容器内会被挤出可视区 */
  const nav = document.createElement("div");
  nav.className = "kl-nav";
  nav.innerHTML =
    `<div class="kl-nav-ruler"></div>` +
    `<div class="kl-nav-btns"><button data-j="first" title="跳到最早">⇤</button>` +
    `<button data-j="prev" title="向前一页">‹</button></div>` +
    `<div class="kl-nav-track"><div class="kl-nav-win" title="拖动平移可见区间"></div>` +
    `<div class="kl-nav-yrs"></div></div>` +
    `<div class="kl-nav-btns r"><button data-j="next" title="向后一页">›</button>` +
    `<button data-j="last" title="回到最新">⇥</button></div>`;
  (el.parentElement ?? el).appendChild(nav);
  const navRuler = nav.querySelector(".kl-nav-ruler") as HTMLElement;
  const navTrack = nav.querySelector(".kl-nav-track") as HTMLElement;
  const navWin = nav.querySelector(".kl-nav-win") as HTMLElement;
  const navYears = nav.querySelector(".kl-nav-yrs") as HTMLElement;

  // 快速跳转（策影 navJump 同款：first / ±0.8 页 / last）
  // klinecharts 的 scrollToDataIndex(idx) 是把第 idx 根贴到「右边界」，所以翻页锚点要用右边界索引
  nav.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-j]");
    if (!b) return;
    const list = chart.getDataList();
    const r = chart.getVisibleRange?.() as { from: number; to: number } | undefined;
    if (!list.length || !r) return;
    const vis = Math.max(1, Math.round(r.to - r.from));
    const right = Math.max(0, Math.round(r.to) - 1);
    try {
      if (b.dataset.j === "first") chart.scrollToDataIndex(0, 0);
      else if (b.dataset.j === "last") chart.scrollToRealTime(0);
      else if (b.dataset.j === "prev") chart.scrollToDataIndex(Math.max(0, Math.round(right - vis * 0.8)), 0);
      else if (b.dataset.j === "next") chart.scrollToDataIndex(Math.min(list.length - 1, Math.round(right + vis * 0.8)), 0);
    } catch { /* 忽略 */ }
  });

  /** 可见区间时长：同日分钟线用「X小时Y分」，日线及以上按自然日历差（年 > 月 > 天） */
  const navSpan = (s0: string, s1: string, n: number): string => {
    const a = new Date(s0.replace(" ", "T")), b = new Date(s1.replace(" ", "T"));
    if (isNaN(+a) || isNaN(+b)) return `${n} 根`;
    if (s0.includes(" ") && s1.includes(" ") && a.toDateString() === b.toDateString()) {
      const mins = Math.max(1, Math.round((+b - +a) / 60000));
      return mins >= 60 ? `${Math.floor(mins / 60)}小时${mins % 60}分` : `${mins}分`;
    }
    let y = b.getFullYear() - a.getFullYear();
    let m = b.getMonth() - a.getMonth();
    let d = b.getDate() - a.getDate();
    if (d < 0) { m -= 1; d += new Date(b.getFullYear(), b.getMonth(), 0).getDate(); }
    if (m < 0) { y -= 1; m += 12; }
    if (y > 0) return `${y}年${m}个月`;
    if (m > 0) return `${m}个月${d}天`;
    return d > 0 ? `${d}天` : `${n} 根`;
  };

  /** 日期标尺：按轨道宽度均分 3~8 个刻度；同日分钟线标 HH:MM，其余标 YYYY/MM */
  const navRulerDraw = (list: { date?: string }[]) => {
    navRuler.innerHTML = "";
    const w = navTrack.clientWidth;
    if (!w || list.length < 2) return;
    const s0 = list[0]?.date || "", s1 = list[list.length - 1]?.date || "";
    const intraday = s0.includes(" ") && s0.slice(0, 10) === s1.slice(0, 10);
    const n = Math.max(3, Math.min(8, Math.floor(w / 120)));
    for (let k = 0; k < n; k++) {
      const raw = list[Math.round((k / (n - 1)) * (list.length - 1))]?.date || "";
      if (raw.length < 7) continue;
      const s = document.createElement("span");
      s.textContent = intraday && raw.includes(" ")
        ? raw.slice(11, 16)
        : `${raw.slice(0, 4)}/${raw.slice(5, 7)}`;
      if (k === 0) { s.style.left = "0"; s.style.transform = "none"; }
      else if (k === n - 1) { s.style.left = "auto"; s.style.right = "0"; s.style.transform = "none"; }
      else s.style.left = `${(k / (n - 1)) * 100}%`;
      navRuler.appendChild(s);
    }
  };

  /** 年份段：按全量数据年份边界在条内画分隔线 + 年份标（覆盖总年份跨度；过窄的段只留线不标字） */
  const navYearDraw = (list: { date?: string }[]) => {
    navYears.innerHTML = "";
    const w = navTrack.clientWidth;
    const L = list.length;
    if (!w || L < 2) return;
    const marks: { year: string; i: number }[] = [];
    let prev = "";
    for (let i = 0; i < L; i++) {
      const y = (list[i]?.date || "").slice(0, 4);
      if (!/^\d{4}$/.test(y)) continue;
      if (y !== prev) { marks.push({ year: y, i }); prev = y; }
    }
    marks.forEach((m, k) => {
      const left = (m.i / (L - 1)) * 100;
      const next = k + 1 < marks.length ? (marks[k + 1].i / (L - 1)) * 100 : 100;
      if (m.i > 0) {                       // 年界竖线（首年不画，避免贴边）
        const line = document.createElement("u");
        line.className = "kl-nav-yrline";
        line.style.left = `${left}%`;
        navYears.appendChild(line);
      }
      if (((next - left) / 100) * w < 40) return;   // 段太窄：放不下 4 位年份（11px 字号约 34px 宽）
      const lab = document.createElement("i");
      lab.className = "kl-nav-yr";
      lab.style.left = `${left}%`;
      lab.textContent = m.year;
      navYears.appendChild(lab);
    });
  };

  /** 按可见区间刷新滑块位置/宽度 + 悬停提示（可见区间自然时长） */
  const navUpdateWin = () => {
    const list = chart.getDataList() as { date?: string }[];
    const r = chart.getVisibleRange?.() as { from: number; to: number } | undefined;
    if (!list.length || !r) return;
    const L = list.length;
    const from = Math.max(0, Math.floor(r.from)), to = Math.min(L, Math.ceil(r.to));
    const cnt = Math.max(1, to - from);
    navWin.style.left = `${(from / L) * 100}%`;
    navWin.style.width = `${Math.max(2, (cnt / L) * 100)}%`;
    const d = (i: number) => list[Math.max(0, Math.min(L - 1, i))]?.date || "";
    const s0 = d(from), s1 = d(to - 1);
    if (s0 && s1) {
      navWin.title = `${s0} ~ ${s1} · ${cnt} 根 · ${navSpan(s0, s1, cnt)}`;
      nav.title = `全量 ${list[0]?.date ?? s0} ~ ${list[L - 1]?.date ?? s1}`;
    }
  };
  const navDraw = () => {
    const list = chart.getDataList() as { date?: string }[];
    nav.style.display = list.length > 1 ? "" : "none";
    navRulerDraw(list);
    navYearDraw(list);
    navUpdateWin();
  };
  const onVisChange = () => { requestAnimationFrame(navUpdateWin); };
  try { chart.subscribeAction("onVisibleRangeChange", onVisChange as never); } catch { /* 忽略 */ }

  // 点轨道空白处：把可见窗口中心对到点击位置（右边界 = 中心 + 半窗）
  navTrack.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest(".kl-nav-win")) return;
    const list = chart.getDataList();
    const r = chart.getVisibleRange?.() as { from: number; to: number } | undefined;
    const rect = navTrack.getBoundingClientRect();
    if (!list.length || !r || !rect.width) return;
    const cnt = Math.max(1, Math.round(r.to - r.from));
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const right = Math.round(f * list.length + cnt / 2) - 1;
    try { chart.scrollToDataIndex(Math.max(0, Math.min(list.length - 1, right)), 0); } catch { /* 忽略 */ }
    navUpdateWin();
  });

  // 滑块拖拽：只平移不缩放（策影同款），pointer capture 跟手
  const navDrag = { x: 0, right: 0 };
  navWin.addEventListener("pointerdown", (e) => {
    const r = chart.getVisibleRange?.() as { from: number; to: number } | undefined;
    if (!r) return;
    navDrag.x = e.clientX; navDrag.right = Math.max(0, Math.round(r.to) - 1);
    navWin.setPointerCapture(e.pointerId);
    navWin.style.cursor = "grabbing";
  });
  navWin.addEventListener("pointermove", (e) => {
    if (!navWin.hasPointerCapture?.(e.pointerId)) return;
    const L = chart.getDataList().length;
    const w = navTrack.getBoundingClientRect().width;
    if (!L || !w) return;
    const nf = Math.max(0, Math.min(L - 1,
      navDrag.right + ((e.clientX - navDrag.x) / w) * L));
    try { chart.scrollToDataIndex(Math.round(nf), 0); } catch { /* 忽略 */ }
    navUpdateWin();
  });
  const navDragEnd = (e: PointerEvent) => {
    if (navWin.hasPointerCapture?.(e.pointerId)) navWin.releasePointerCapture(e.pointerId);
    navWin.style.cursor = "";
  };
  navWin.addEventListener("pointerup", navDragEnd);
  navWin.addEventListener("pointercancel", navDragEnd);

  /* ── 单根选中（点击蜡烛）：图上高亮该根，行情页把右列资金卡切到该交易日 ──
   *  · 用 v10 原生 onCandleBarClick（内部已区分「点击」与「拖拽平移」，不用自己判位移）
   *  · 唯一真相是「日期」而不是索引：盘中每 12s 重灌数据，索引会漂，日期不会
   *  · 与框选互斥：选中单根即撤区间、框出一段即撤单根（右卡同时只表达一个口径） */
  const pick = document.createElement("div");
  pick.className = "kl-pick";
  pick.style.display = "none";
  pick.innerHTML = "<b></b>";
  el.appendChild(pick);
  // 操作提示（悬停可见）：激活/取消路径都说清楚
  el.title = "框选模式下左键拖拽统计区间；开启「单选」后点击 K 线选中单根（再点取消 · ESC 关闭）";
  let pickDate: string | null = null;

  const drawPick = (): void => {
    if (!pickDate) { pick.style.display = "none"; return; }
    const list = chart.getDataList() as { date?: string }[];
    const i = list.findIndex((b) => (b.date ?? "") === pickDate);
    if (i < 0) { pick.style.display = "none"; return; }
    const px = chart.convertToPixel({ dataIndex: i }) as unknown;
    const x = (Array.isArray(px) ? px[0] : px)?.x as number | undefined;
    if (x == null) { pick.style.display = "none"; return; }
    const bs = chart.getBarSpace?.() as { bar: number } | undefined;
    const w = Math.max(2, Math.round(bs?.bar ?? 6));
    pick.style.display = "block";
    pick.style.left = `${Math.round(x - w / 2)}px`;
    pick.style.width = `${w}px`;
    // 高度到导航条上沿：选中带不压住缩略图
    pick.style.height = `${Math.max(40, el.clientHeight - nav.offsetHeight)}px`;
    pick.querySelector("b")!.textContent = pickDate;
  };

  /** 撤掉单根选中（notify=true 同步通知行情页退回当日口径） */
  const clearPickFn = (notify: boolean): void => {
    const had = pickDate != null;
    pickDate = null;
    pick.style.display = "none";
    pick.querySelector("b")!.textContent = "";    // 别留下上次的日期标签
    if (notify && had) document.dispatchEvent(new CustomEvent("yc:kl-pick", { detail: null }));
  };

  /** 持久选区带：框选松手后保留图形，跟随缩放/导航重绘；只有关闭框选模式才消失 */
  const drawSelBand = (): void => {
    if (!lastSel) { sel.style.display = "none"; return; }
    const list = chart.getDataList() as { date?: string }[];
    const i0 = list.findIndex((b) => (b.date ?? "") === lastSel!.startDate);
    const i1 = list.findIndex((b) => (b.date ?? "") === lastSel!.endDate);
    if (i0 < 0 || i1 < 0) { sel.style.display = "none"; return; }
    const p0 = chart.convertToPixel({ dataIndex: i0 }) as unknown;
    const p1 = chart.convertToPixel({ dataIndex: i1 }) as unknown;
    const xa = (Array.isArray(p0) ? p0[0] : p0)?.x as number | undefined;
    const xb = (Array.isArray(p1) ? p1[0] : p1)?.x as number | undefined;
    if (xa == null || xb == null) { sel.style.display = "none"; return; }
    const bs = chart.getBarSpace?.() as { bar: number } | undefined;
    const w = Math.max(2, Math.round(bs?.bar ?? 6));
    sel.style.left = `${Math.round(Math.min(xa, xb) - w / 2)}px`;
    sel.style.width = `${Math.round(Math.abs(xb - xa) + w)}px`;
    sel.style.top = "0px";
    sel.style.height = `${el.clientHeight}px`;
    sel.style.display = "block";
  };

  /** 选中第 di 根（越界=撤选中）；同一根重复点不重发，免得白拉一次资金接口 */
  const pickAtIndex = (di: number | undefined): void => {
    const list = chart.getDataList() as {
      timestamp: number; open: number; high: number; low: number; close: number;
      volume?: number; amount?: number; date?: string;
    }[];
    if (di == null || di < 0 || di >= list.length) { clearPickFn(true); return; }
    const bar = list[di];
    const date = bar.date ?? ymd(bar.timestamp);
    if (date === pickDate) { clearPickFn(true); return; }      // 再点同一根 = 取消选中（toggle）
    const prev = di > 0 ? list[di - 1] : null;
    const base = prev?.close ?? bar.open;
    pickDate = date;
    drawPick();
    clearSel(false);                               // 单根与区间互斥（右卡的区间口径由行情页撤）
    document.dispatchEvent(new CustomEvent("yc:kl-pick", {
      detail: {
        date, index: di,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        prevClose: prev?.close ?? null,
        changePct: base ? (bar.close - base) / base * 100 : 0,
        amp: base ? (bar.high - bar.low) / base * 100 : 0,
        amount: bar.amount ?? 0, volume: bar.volume ?? 0,
      } as PickBar,
    }));
  };

  /* ESC 分层取消：单根选中 → 进行中的框选拖拽 → 已成立的区间统计（策影同款手感） */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (pickDate) { clearPickFn(true); return; }
    if (selX0 != null) { selX0 = null; sel.style.display = "none"; return; }
    if (lastSel) clearSel(true);
  });

  const onBarClick = (...args: unknown[]) => {
    if (!pickMode) return;                       // 未开启单选模式：点击不选中单根
    pickAtIndex((args[0] as { dataIndex?: number } | null | undefined)?.dataIndex);
  };
  // 原生精确点击（点在蜡烛实体上）与上面的按列判定互为补充：重复点同一根会被去重
  try { chart.subscribeAction("onCandleBarClick", onBarClick as never); } catch { /* 忽略 */ }
  // 选中带/选区带跟着视窗走：缩放/滚动/可见范围变化都重算像素位置
  const onViewRefresh = () => requestAnimationFrame(() => { drawPick(); drawSelBand(); });
  try { chart.subscribeAction("onVisibleRangeChange", onViewRefresh as never); } catch { /* 忽略 */ }
  try { chart.subscribeAction("onZoom", onViewRefresh as never); } catch { /* 忽略 */ }
  try { chart.subscribeAction("onScroll", onViewRefresh as never); } catch { /* 忽略 */ }

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

  const volumeSettings = mountVolumeSettings(chart, el);
  const mainCostSettings = mountMainCostSettings(chart, el);
  const maSettings = mountMASettings(chart, el, () => drawLegend(legendInds));

  let dataLen = 0;                     // 上一次灌入的 bar 数（判断「增量刷新」还是「换数据源」）

  /** 默认视图锚点：末根完整落在价格轴左侧，中间留一道窄缝。
   *  先写死 offset 再 scrollToRealTime —— scrollToRealTime 的目标位移就是
   *  initialOffsetRightDistance / barSpace，等于把这道缝还原成「设计值」，
   *  不受上一次 scrollToDataIndex 留下的 diff=0 影响。 */
  const snapLatest = (): void => {
    try { chart.setOffsetRightDistance(RIGHT_GAP_PX); } catch { /* 忽略 */ }
    try { chart.scrollToRealTime(0); } catch { /* 忽略 */ }
  };

  const handle: KlineChartHandle = {
    chart,
    setData: (bars: Bar[], keepView = false, floatShares: number | null = null, focusDate?: string, symbol?: string) => {
      const list = bars.map((b) => ({
        timestamp: toTs(b.date), open: b.open, high: b.high, low: b.low,
        close: b.close, volume: b.volume ?? 0, amount: b.amount ?? 0,
        date: b.date, floatShares,
        // 涨停标记：蜡烛画实心红，成交量柱同步画实心（其余阳线都是空心）
        limitUp: isLimitUp(symbol, b.pct_chg, b.date),
        // 分时 bar 挂昨收（TIME_AVG 的昨收虚线基准用；日线无此字段 → null）
        baseline: (b as Bar & { baseline?: number | null }).baseline ?? null,
      }));
      // 盘中的增量重灌（同标的同周期）不该把视图弹回最右：用户在翻历史时
      // 每 12s 被拽回最新，选中的那根也就跑出屏幕了 —— 记下窗口，重灌后原样恢复
      // 只在「同一份数据的增量刷新」里恢复：切到分时/60 分这类数量级差很大的数据源时
      // 旧范围（例如日线第 1900 根）在新列表里根本不存在，照着恢复会把图拽到空白区
      const vis = keepView && list.length > 0
        ? chart.getVisibleRange?.() as { from: number; to: number } | undefined
        : undefined;
      // 新旧列表得是同一量级（增量刷新差几十根以内）才谈得上恢复；
      // 空 → 分时 267 根、日线 2000 → 60 分 480 这种切换一律回到最新
      const sameScale = dataLen > 0 && Math.abs(list.length - dataLen) <= Math.max(5, dataLen * 0.15);
      const recoverable = sameScale && !!vis && vis.from >= 0 && vis.to <= list.length;
      // v10 的 scrollToDataIndex 把目标索引对到视口**右端**（nav 翻页也这么用），
      // 所以恢复视图要传右边缘那根，而不是 from
      const focusIndex = focusDate ? list.findIndex(bar => bar.date === focusDate) : -1;
      const keepIdx = focusIndex >= 0 ? Math.min(list.length - 1, focusIndex + 8)
        : recoverable ? Math.max(0, Math.round(vis!.to) - 1) : null;
      /* 默认视图（换标的 / 刷新 / 切周期 / 旧视图已贴最新）一律「末根 + 右侧留白」：
       * scrollToDataIndex(n-1) 会把末根槽位右缘顶到主图右边界（diff → 0），
       * 蜡烛实体一半压在价格轴上 —— 这就是「最后一根看不到 / 超出 Y 轴」的来源。
       * 只有用户自己平移出的历史窗口才用 scrollToDataIndex 原样恢复。 */
      const keepLatest = focusIndex >= 0
        ? keepIdx === list.length - 1
        : !keepView || (recoverable && dataLen > 0 && vis!.to >= dataLen);
      dataLen = list.length;
      tip.style.display = "none";                          // 数据重载时收起旧卡片
      // v10 无 applyNewData，经 DataLoader 一次性回填（策影同款）
      chart.setDataLoader({ getBars: (params) => { params.callback(list, false); } });
      // 重灌数据后索引会变，选中带按日期重新定位（盘中轮询 12s 一次，必须跟着走）
      const restoreView = (): void => {
        try {
          if (keepLatest) snapLatest();
          else if (keepIdx != null) chart.scrollToDataIndex(keepIdx, 0);
        } catch { /* 忽略 */ }
      };
      requestAnimationFrame(() => {
        navDraw();
        restoreView();
        drawPick();
      });
      // setDataLoader 的首次回填是异步的：等数据真正就绪后再校一次视图，
      // 否则恢复动作会被后续的加载回调覆盖（视图又跳回默认位置）
      window.setTimeout(() => {
        restoreView();
        if (focusIndex >= 0 && pickMode) pickAtIndex(focusIndex);
        else drawPick();
      }, 160);
    },
    setMain(inds: MainKey[]) {
      // 主图多选叠加（策影同款）：先按实例移除不再选中的，再增量补建缺失的（注册表驱动）
      const defs = inds.map((k) => IND_BY_KEY[k]).filter((d): d is IndDef => !!d && d.where === "main");
      const want = new Set(defs.map((d) => d.kc));
      const mainKcs = IND_DEFS.filter((d) => d.where === "main").map((d) => d.kc);
      chart.getIndicators({ paneId: "candle_pane" }).forEach((i) => {
        if (mainKcs.includes(i.name) && !want.has(i.name))
          chart.removeIndicator({ id: i.id });
      });
      const have = new Set(chart.getIndicators({ paneId: "candle_pane" }).map((i) => i.name));
      for (const d of defs) {
        if (have.has(d.kc)) continue;
        if (d.key === "ma") {
          // 周期/显隐/配色统一读均线设置，默认 5/10/20/30/60/120/250
          const lines = visibleMARows();
          if (!lines.length) continue;
          chart.createIndicator({
            name: "MA", paneId: "candle_pane",
            calcParams: lines.map((line) => line.period), isStack: true,
            createTooltipDataSource: NO_TIP,
            styles: { lines: lines.map((line) => ({ color: line.color })) },
          } as never, true);
        } else if (d.key === "avg") {
          chart.createIndicator({ name: "TIME_AVG", paneId: "candle_pane", isStack: true, createTooltipDataSource: NO_TIP } as never, true);
        } else {
          chart.createIndicator({ name: d.kc, paneId: "candle_pane", isStack: true, createTooltipDataSource: NO_TIP } as never, true);
        }
      }
      requestAnimationFrame(mainCostSettings.sync);
    },
    setLines(fib: boolean, sr: boolean, wave: boolean, box: boolean, pat: boolean) {
      chart.getIndicators({ paneId: "candle_pane" }).forEach((i) => {
        if ((i.name === "ZY_FIB" && !fib) || (i.name === "ZY_SR" && !sr)
          || (i.name === "ZY_WAVE" && !wave) || (i.name === "ZY_BOX" && !box)
          || (i.name === "ZY_PAT" && !pat)) chart.removeIndicator({ id: i.id });
      });
      const have = new Set(chart.getIndicators({ paneId: "candle_pane" }).map((i) => i.name));
      if (fib && !have.has("ZY_FIB")) {
        chart.createIndicator({ name: "ZY_FIB", paneId: "candle_pane", isStack: true, createTooltipDataSource: NO_TIP } as never, true);
      }
      if (sr && !have.has("ZY_SR")) {
        chart.createIndicator({ name: "ZY_SR", paneId: "candle_pane", isStack: true, createTooltipDataSource: NO_TIP } as never, true);
      }
      if (wave && !have.has("ZY_WAVE")) {
        chart.createIndicator({ name: "ZY_WAVE", paneId: "candle_pane", isStack: true, createTooltipDataSource: NO_TIP } as never, true);
      }
      if (box && !have.has("ZY_BOX")) {
        chart.createIndicator({ name: "ZY_BOX", paneId: "candle_pane", isStack: true, createTooltipDataSource: NO_TIP } as never, true);
      }
      if (pat && !have.has("ZY_PAT")) {
        chart.createIndicator({ name: "ZY_PAT", paneId: "candle_pane", isStack: true, createTooltipDataSource: NO_TIP } as never, true);
      }
    },
    setSub(inds: SubKey[]) {
      // 副图多选：全清后按固定顺序重建，每指标一个窗格（注册表驱动）
      chart.getIndicators()
        .filter((i) => i.paneId !== "candle_pane")
        .forEach((i) => chart.removeIndicator({ id: i.id }));
      const up = chartUp(), dn = chartDown();
      for (const k of inds) {
        const d = IND_BY_KEY[k];
        if (!d || d.where !== "sub") continue;
        if (d.key === "vol") {
          // 自研 VOLX：两条可调周期均量线；
          // 禁用大数格式化，轴/图例文本走万/亿；量柱红绿走注册内的 figure styles
          chart.createIndicator({
            name: "VOLX", shouldFormatBigNumber: false,
            calcParams: readVolumeSettings().periods, extendData: readVolumeSettings().visible,
            createTooltipDataSource: subTip(d.label),
            styles: { bars: [{ upColor: up, downColor: dn, noChangeColor: NEUTRAL }] },
          } as never, false);
        } else if (d.key === "macd") {
          chart.createIndicator({ name: "MACDX", shouldFormatBigNumber: false, createTooltipDataSource: subTip(d.label) } as never, false);
        } else if (d.key === "volfs") {
          // 通达信 VOLFS：逐分钟量柱红绿按分钟涨跌（figure styles 内着色），轴文本万/亿
          chart.createIndicator({ name: "VOLFS", shouldFormatBigNumber: false, createTooltipDataSource: subTip(d.label) } as never, false);
        } else if (d.key === "sixseg") {
          // 六分段趋势（K线下方叠加）：趋势线六位置 1..6 台阶线
          chart.createIndicator({ name: "SIXSEG", precision: 0, createTooltipDataSource: subTip(d.label) } as never, false);
        } else if (d.key === "trendhistogram") {
          const id = chart.createIndicator({ name: d.kc, createTooltipDataSource: subTip(d.label) } as never, false);
          const indicator = chart.getIndicators({ id: id! })[0];
          if (indicator) chart.overrideYAxis({ paneId: indicator.paneId, id: indicator.yAxisId, name: "trend_value" });
        } else {
          const id = chart.createIndicator({ name: d.kc, createTooltipDataSource: subTip(d.label) } as never, false);
          if (d.key === "stockoperate" && id) {
            const indicator = chart.getIndicators({ id })[0];
            if (indicator) {
              // 轴刻度只标三根线的位置（95 / 50 / 5，众赢同款），默认 0/20/40… 看不出线在哪
              chart.overrideYAxis({
                paneId: indicator.paneId,
                createTicks: ({ range, bounding }) => [95, 50, 5].map((v) => ({
                  value: v,
                  text: v.toFixed(2),
                  coord: Math.round((1 - (v - range.realFrom) / range.realRange) * bounding.height),
                })),
              });
            }
          }
        }
      }
      // 窗格高度交给智能高度统一分配（含 candle_pane）
      applyHeights();
      requestAnimationFrame(() => { volumeSettings.sync(); mainCostSettings.sync(); });
    },
    setPeriod(p: TipPeriod) {
      period = p;
      // 分时主图换形态：价格曲线（area）替代蜡烛（蜡烛对每分钟假 K 无意义）
      chart.setStyles(periodStyles(p));
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
    setRangeMode(on: boolean) {
      rangeMode = on;
      sel.style.cursor = on ? "crosshair" : "";
      el.style.cursor = on ? "crosshair" : "";
      try { chart.setScrollEnabled(!on); } catch { /* 老版本无此 API 时退化为仅 Shift 手势 */ }
      if (!on) clearSel(true);
    },
    isRangeMode() { return rangeMode; },
    setPickMode(on: boolean) {
      pickMode = on;
      if (!on) clearPickFn(true);        // 关模式即撤选中，右列资金卡退回当日口径
    },
    isPickMode() { return pickMode; },
    setRangeFund(f: RangeFund | null) {
      selFund = f;
      drawSelTip();
    },
    clearRange(notify = true) { clearSel(notify); },
    clearPick(notify = true) { clearPickFn(notify); },
    drawLegend,
    retheme() {
      chart.setStyles(periodStyles(period));
      // 均线颜色取自 CSS 变量；换主题后重建一次，避免白线留在亮色背景上
      if (chart.getIndicators({ paneId: "candle_pane" }).some((i) => i.name === "MA"))
        applyMA(chart, () => drawLegend(legendInds));
      requestAnimationFrame(navDraw);
    },
    resize() {
      chart.resize();
      requestAnimationFrame(() => { applyHeights(); volumeSettings.sync(); mainCostSettings.sync(); maSettings.sync(); navDraw(); drawPick(); });
    },
    destroy() {
      try { chart.unsubscribeAction("onCrosshairChange", onCross as never); } catch { /* 忽略 */ }
      try { chart.unsubscribeAction("onCandleBarClick", onBarClick as never); } catch { /* 忽略 */ }
      try { chart.unsubscribeAction("onVisibleRangeChange", onViewRefresh as never); } catch { /* 忽略 */ }
      try { chart.unsubscribeAction("onZoom", onViewRefresh as never); } catch { /* 忽略 */ }
      try { chart.unsubscribeAction("onScroll", onViewRefresh as never); } catch { /* 忽略 */ }
      el.removeEventListener("mousedown", onSelDown, true);
      el.removeEventListener("mousemove", onSelMove, true);
      el.removeEventListener("mouseup", onSelUp, true);
      sel.remove();
      selTip.remove();
      volumeSettings.destroy();
      mainCostSettings.destroy();
      maSettings.destroy();
      tip.remove();
      legend.remove();
      pick.remove();
      nav.remove();
      dispose(el);
    },
  };
  return handle;
}
