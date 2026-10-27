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

/** 六分段判定：以 60 日窗口内 close 分位 0–1 → 1..6 段 */
export function sixSegment(bars: Bar[], i: number, win = 60): number {
  const start = Math.max(0, i - win + 1);
  const slice = bars.slice(start, i + 1);
  const c = bars[i].close;
  let below = 0;
  for (const b of slice) if (b.close < c) below++;
  const q = below / slice.length;      // 0 = 最低位, 1 = 最高位
  return Math.min(6, Math.floor(q * 6) + 1);
}
