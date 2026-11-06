/* 技术指标（开源口径，前端计算；与原型 sma/ema/boll/macd/kdj/atr 一致） */
import type { Bar } from "./api";

export function sma(bars: Bar[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= n) sum -= bars[i - n].close;
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

export function ema(bars: Bar[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (n + 1);
  let prev: number | null = null;
  let seed = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i < n - 1) { seed += bars[i].close; out.push(null); continue; }
    if (i === n - 1) { seed += bars[i].close; prev = seed / n; }
    else prev = bars[i].close * k + prev! * (1 - k);
    out.push(prev);
  }
  return out;
}

export function bollSeries(bars: Bar[], n = 20, k = 2): { mid: (number | null)[]; up: (number | null)[]; low: (number | null)[] } {
  const mid = sma(bars, n);
  const up: (number | null)[] = [], low: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < n - 1) { up.push(null); low.push(null); continue; }
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (bars[j].close - mid[i]!) ** 2;
    const sd = Math.sqrt(s / n);
    up.push(mid[i]! + k * sd);
    low.push(mid[i]! - k * sd);
  }
  return { mid, up, low };
}

export function macdSeries(bars: Bar[], fast = 12, slow = 26, sig = 9) {
  const ef = ema(bars, fast), es = ema(bars, slow);
  const dif = bars.map((_, i) => (ef[i] != null && es[i] != null ? ef[i]! - es[i]! : null));
  const difValid = dif.map((d) => d ?? 0);
  const dea = emaFrom(difValid, sig, dif);
  return { dif, dea, hist: dif.map((d, i) => (d != null && dea[i] != null ? (d - dea[i]!) * 2 : null)) };
}

function emaFrom(vals: number[], n: number, mask: (number | null)[]): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (n + 1);
  let prev: number | null = null, seed = 0, seen = 0, started = false;
  for (let i = 0; i < vals.length; i++) {
    if (mask[i] == null) { out.push(null); continue; }
    seen++;
    if (!started) {
      seed += vals[i];
      if (seen === n) { prev = seed / n; started = true; out.push(prev); }
      else out.push(null);
      continue;
    }
    prev = vals[i] * k + prev! * (1 - k);
    out.push(prev);
  }
  return out;
}

export function kdjSeries(bars: Bar[], n = 9, k1 = 3, d1 = 3) {
  const K: (number | null)[] = [], D: (number | null)[] = [], J: (number | null)[] = [];
  let pk = 50, pd = 50;
  for (let i = 0; i < bars.length; i++) {
    if (i < n - 1) { K.push(null); D.push(null); J.push(null); continue; }
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, bars[j].high); ll = Math.min(ll, bars[j].low); }
    const rsv = hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100;
    pk = (k1 - 1) / k1 * pk + 1 / k1 * rsv;
    pd = (d1 - 1) / d1 * pd + 1 / d1 * pk;
    K.push(pk); D.push(pd); J.push(3 * pk - 2 * pd);
  }
  return { k: K, d: D, j: J };
}

export function atrSeries(bars: Bar[], n = 14): (number | null)[] {
  const out: (number | null)[] = [];
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) trs.push(bars[i].high - bars[i].low);
    else trs.push(Math.max(bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
    if (i < n - 1) { out.push(null); continue; }
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += trs[j];
    out.push(s / n);
  }
  return out;
}

/** 六分段（趋势线六位置）——以「短线操盘」趋势线 MA7 快 / MA10 慢为基准，
 *  按价格站在线的哪一侧、偏离幅度（ATR 自适应）判定所处位置，循环为：
 *  1 超跌 → 2 反弹 → 3 突破 → 4 超涨 → 5 回踩 → 6 跌破 → 1 …
 *   · 线下方深跌（偏离 ≥1.5×ATR%）= 超跌：弱反弹、空间小，不参与
 *   · 线下方但未深跌，且快线仍在慢线下方 = 反弹：反抽趋势线、抛压最重，禁止参与
 *   · 价格站上慢线，且未跌破快线 = 突破：上升趋势打开，积极参与
 *   · 线上方偏离 ≥1.5×ATR% = 超涨：只宜小仓谨慎
 *   · 线上回抽、跌破快线但仍守慢线 = 回踩：获趋势线支撑，损益比最佳，积极参与
 *   · 跌破慢线而快线仍在慢线上方 = 跌破：上升趋势破坏，往往是行情高点，禁止参与
 */
export const SEGNAME = ["", "超跌", "反弹", "突破", "超涨", "回踩", "跌破"];
/** 众赢「股票六分段理论」原话：围绕日线短线趋势线的六个位置（1 起） */
export const SEGFULL = ["", "趋势线超跌位置", "反弹趋势线位置", "趋势线突破位置",
  "趋势线超涨位置", "回踩趋势线位置", "趋势线跌破位置"];
/** 六分段对应的操作建议（0 位占位） */
export const SEGACTION = ["", "不参与", "禁止参与", "积极参与", "小仓谨慎", "积极参与", "禁止参与"];
/** 操作优先级（列表排序用，越大越靠前）：突破 > 回踩 > 超涨 > 跌破 > 反弹 > 超跌 */
export const SEGRANK: Record<number, number> = { 0: 0, 1: 0, 2: 1, 6: 2, 4: 3, 5: 5, 3: 6 };

type SegBar = { close: number; high?: number | null; low?: number | null };

/** 六分段逐 bar 序列（K 线副图 / 目标页明细共用） */
export function sixSegmentSeries(list: SegBar[]): number[] {
  const n = list.length;
  const ma7: (number | null)[] = [], ma10: (number | null)[] = [], atr14: (number | null)[] = [];
  const trs: number[] = [];
  let s7 = 0, s10 = 0, sTr = 0;
  for (let i = 0; i < n; i++) {
    const close = list[i].close;
    s7 += close;
    if (i >= 7) s7 -= list[i - 7].close;
    s10 += close;
    if (i >= 10) s10 -= list[i - 10].close;
    ma7.push(i >= 6 ? s7 / 7 : null);
    ma10.push(i >= 9 ? s10 / 10 : null);
    const high = list[i].high ?? close;
    const low = list[i].low ?? close;
    const prev = i > 0 ? list[i - 1].close : close;
    const tr = Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
    trs.push(tr);
    sTr += tr;
    if (i >= 14) sTr -= trs[i - 14];
    atr14.push(i >= 13 ? sTr / 14 : null);
  }
  return list.map((b, i) => {
    const fast = ma7[i], slow = ma10[i], atr = atr14[i];
    if (fast == null || slow == null || atr == null || !slow) return 0;
    const deep = 1.5 * Math.max(atr / b.close, 0.01);   // 偏离阈值：1.5×ATR%，至少 1%
    const dev = b.close / slow - 1;
    if (b.close >= slow) {
      if (fast > slow && dev >= deep) return 4;        // 超涨（趋势已转多后远离慢线）
      if (fast >= slow && b.close < fast) return 5;    // 回踩快线
      return 3;                                        // 突破 / 上升趋势
    }
    if (fast > slow) return 6;                         // 刚跌破慢线（趋势线跌破）
    return dev <= -deep ? 1 : 2;                       // 超跌 / 反弹
  });
}

/** 六分段判定（取第 i 根 bar 所处的段） */
export function sixSegment(bars: Bar[], i: number): number {
  return sixSegmentSeries(bars.slice(0, i + 1))[i] ?? 0;
}
