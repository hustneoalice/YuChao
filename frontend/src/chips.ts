/* 筹码分布卡片：按日线换手衰减估算价格筹码
 * 模型：每个交易日先按换手率衰减旧筹码，再把当日成交量按三角分布
 * （峰值在 (O+H+L+C)/4 均价）落到 [low, high] 价格区间。
 * 输出获利比例 / 平均成本 / 90% 成本区间 / 集中度，指数不适用。
 * 与交易所披露口径不同，仅作形态参考。
 */
import { marketApi, type Bar } from "./api";
import { esc, fmt, fmtP, priceDigits } from "./fmt";
import { estimateFloatShares } from "./volume-activity";

export interface ChipBin { price: number; weight: number }
export interface ChipResult {
  bins: ChipBin[];
  close: number;
  /** 获利盘占比 0–1 */
  profit: number;
  avgCost: number;
  low90: number;
  high90: number;
  /** 集中度百分比 */
  concentration: number;
  bars: number;
  date: string;
  step: number;
}

const BINS = 32;
const TTL = 10 * 60 * 1000;
const RETRY = 60 * 1000;

/** 指数没有流通筹码概念，和主流软件一样不显示 */
export function isIndexSymbol(symbol: string): boolean {
  const [code, market] = symbol.split(".");
  if (market === "SH") return /^(000|999)/.test(code);
  if (market === "SZ") return /^399/.test(code);
  return false;
}

export function chipDistribution(rows: readonly Bar[], bins = BINS): ChipResult | null {
  const bars = rows.filter((b) => b.low > 0 && b.high > 0 && b.low <= b.high && (b.volume ?? 0) > 0);
  if (bars.length < 20) return null;
  const min = Math.min(...bars.map((b) => b.low));
  const max = Math.max(...bars.map((b) => b.high));
  if (!(max > min)) return null;
  const step = (max - min) / bins;
  const centers = Array.from({ length: bins }, (_, k) => min + step * (k + 0.5));
  // 换手率缺失时用「成交量 / 流通股本」反推；再缺失用历史有效换手率中位数，最后兜底 1%
  const floatShares = estimateFloatShares(bars);
  const knownRates = bars
    .map((b) => b.turnover_rate)
    .filter((r): r is number => r != null && Number.isFinite(r) && r > 0)
    .sort((a, b) => a - b);
  const medianRate = knownRates.length ? knownRates[Math.floor(knownRates.length / 2)] : 1;
  const fallbackTurn = Math.min(0.95, Math.max(0.0005, medianRate / 100));
  const chips = new Array<number>(bins).fill(0);
  for (const b of bars) {
    let turn = 0;
    if (b.turnover_rate != null && b.turnover_rate > 0) turn = b.turnover_rate / 100;
    else if (floatShares && b.volume) turn = b.volume / floatShares;
    if (!(turn > 0)) turn = fallbackTurn;
    turn = Math.min(0.95, turn);
    for (let k = 0; k < bins; k++) chips[k] *= 1 - turn;
    const peak = Math.min(b.high, Math.max(b.low, (b.open + b.high + b.low + b.close) / 4));
    const add = new Array<number>(bins).fill(0);
    let sum = 0;
    for (let k = 0; k < bins; k++) {
      const c = centers[k];
      if (c < b.low - step / 2 || c > b.high + step / 2) continue;
      const d = c <= peak
        ? (peak > b.low ? (c - b.low) / (peak - b.low) : 1)
        : (b.high > peak ? (b.high - c) / (b.high - peak) : 1);
      add[k] = Math.max(0, Math.min(1, d));
      sum += add[k];
    }
    if (sum > 0) {
      for (let k = 0; k < bins; k++) chips[k] += turn * add[k] / sum;
    } else {
      // 一字板 / 无振幅：当日筹码全部落到最接近均价的一格
      let near = 0, dist = Infinity;
      for (let k = 0; k < bins; k++) {
        const d = Math.abs(centers[k] - peak);
        if (d < dist) { dist = d; near = k; }
      }
      chips[near] += turn;
    }
  }
  const total = chips.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const close = bars[bars.length - 1].close;
  let profit = 0, avgCost = 0;
  for (let k = 0; k < bins; k++) {
    avgCost += chips[k] * centers[k];
    if (centers[k] <= close) profit += chips[k];
  }
  avgCost /= total;
  profit /= total;
  let cum = 0, low90 = centers[0], high90 = centers[bins - 1];
  let gotLow = false;
  for (let k = 0; k < bins; k++) {
    cum += chips[k];
    if (!gotLow && cum >= total * 0.05) { low90 = centers[k]; gotLow = true; }
    if (cum >= total * 0.95) { high90 = centers[k]; break; }
  }
  return {
    bins: centers.map((price, k) => ({ price, weight: chips[k] / total })),
    close, profit, avgCost, low90, high90,
    concentration: high90 + low90 > 0 ? (high90 - low90) / (high90 + low90) * 100 : 0,
    bars: bars.length,
    date: bars[bars.length - 1].date,
    step,
  };
}

interface ChipState {
  data: ChipResult | null; error: string; loading: boolean; at: number; rev: number;
  waiters: Array<() => void>;                       // 正在等首屏数据的卡片（预取完成后统一重绘）
}
const states = new Map<string, ChipState>();
function state(symbol: string): ChipState {
  let s = states.get(symbol);
  if (!s) {
    s = { data: null, error: "", loading: false, at: 0, rev: 0, waiters: [] };
    states.set(symbol, s);
  }
  return s;
}

export function chipBody(symbol: string, mode: string): string {
  if (isIndexSymbol(symbol)) return `<div class="bempty">指数不适用筹码分布</div>`;
  const s = state(symbol);
  if (s.loading) return `<div class="bempty">筹码计算中…</div>`;
  if (s.error) return `<div class="bempty">${esc(s.error)}</div>`;
  const d = s.data;
  if (!d) return `<div class="bempty">加载筹码…</div>`;

  // 山形曲线：价格从低到高（图内自下而上），筹码量自右向左铺开，
  // 现价上下分别用获利盘（红）/ 套牢盘（蓝）裁剪填充，峰谷自然成形。
  const W = 360, H = 300, TOP = 12, BOT = 272, AX = 286, PLOT = 276;
  const pMin = d.bins[0].price;
  const pMax = d.bins[d.bins.length - 1].price;
  const span = pMax - pMin || 1;
  const maxW = Math.max(...d.bins.map((b) => b.weight), 0.0001);
  const px = (w: number): number => AX - w / maxW * PLOT;
  const py = (p: number): number => TOP + (pMax - p) / span * (BOT - TOP);
  const area = `M${AX} ${BOT} L` +
    d.bins.map((b) => `${px(b.weight).toFixed(1)} ${py(b.price).toFixed(1)}`).join(" L") +
    ` L${AX} ${TOP} Z`;
  const yClose = py(d.close);
  const yAvg = py(d.avgCost);

  // 价格刻度取整（整百/整元），避免一串零碎小数
  const raw = span / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const tickStep = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) || 10) * mag;
  const ticks: string[] = [];
  for (let p = Math.ceil(pMin / tickStep) * tickStep; p <= pMax + tickStep * 0.001; p += tickStep) {
    const yy = py(p).toFixed(1);
    ticks.push(`<line x1="10" x2="${AX}" y1="${yy}" y2="${yy}" stroke="var(--grid)"/>` +
      `<text x="${AX + 8}" y="${yy}" dy="3.5" fill="var(--faint)" font-size="10">${fmt(p, tickStep >= 1 ? 0 : priceDigits(symbol))}</text>`);
  }

  const kv = (label: string, value: string, cls = "", wide = false): string =>
    `<div class="chip-kv${wide ? " wide" : ""}"><span>${label}</span><b class="${cls}">${value}</b></div>`;
  return `<div class="chip-kpis">` +
    kv("获利比例", `${(d.profit * 100).toFixed(1)}%`, "up") +
    kv("平均成本", fmtP(d.avgCost, symbol)) +
    kv("90%成本区间", `${fmtP(d.low90, symbol)} – ${fmtP(d.high90, symbol)}`, "", true) +
    (mode === "detailed" ? kv("集中度", `${d.concentration.toFixed(1)}%`) +
      kv("现价", fmtP(d.close, symbol)) : "") +
    `</div>` +
    `<div class="chip-legend"><span><i class="profit"></i>获利盘</span><span><i class="loss"></i>套牢盘</span>` +
    `<span><i class="now"></i>现价 ${fmtP(d.close, symbol)}</span><span><i class="avg"></i>均本 ${fmtP(d.avgCost, symbol)}</span>` +
    `<span class="sp"></span><span class="mono">${d.date} · ${d.bars}日</span></div>` +
    `<svg class="chip-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="筹码分布山形曲线">` +
    `<defs><clipPath id="chip-clip-profit"><rect x="0" y="${yClose.toFixed(1)}" width="${W}" height="${(H - yClose).toFixed(1)}"/></clipPath>` +
    `<clipPath id="chip-clip-loss"><rect x="0" y="0" width="${W}" height="${yClose.toFixed(1)}"/></clipPath></defs>` +
    ticks.join("") +
    `<path d="${area}" fill="var(--p1)" fill-opacity=".55" clip-path="url(#chip-clip-loss)"/>` +
    `<path d="${area}" fill="var(--up)" fill-opacity=".55" clip-path="url(#chip-clip-profit)"/>` +
    `<line x1="10" x2="${AX}" y1="${yClose.toFixed(1)}" y2="${yClose.toFixed(1)}" stroke="var(--accent)" stroke-width="1" stroke-dasharray="5 4" opacity=".85"/>` +
    `<line x1="10" x2="${AX}" y1="${yAvg.toFixed(1)}" y2="${yAvg.toFixed(1)}" stroke="var(--dim)" stroke-width="1" stroke-dasharray="2 3" opacity=".9"/>` +
    `<line x1="${AX}" x2="${AX}" y1="${TOP}" y2="${BOT}" stroke="var(--border)"/>` +
    `</svg>` +
    `<p class="chip-tip">按日线换手衰减估算价格筹码，非交易所披露口径，仅供形态参考。</p>`;
}

const chipFresh = (s: ChipState): boolean =>
  s.data ? Date.now() - s.at < TTL : s.at > 0 && Date.now() - s.at < RETRY;

/** 打开个股即预取（不等用户切到筹码卡）：结果进本地缓存，切过去直接有图 */
export function prefetchChips(symbol: string): Promise<void> {
  if (isIndexSymbol(symbol)) return Promise.resolve();
  const s = state(symbol);
  if (!s.loading && chipFresh(s)) return Promise.resolve();
  return new Promise((resolve) => ensureChips(symbol, resolve));
}

function ensureChips(symbol: string, done?: () => void): void {
  if (isIndexSymbol(symbol)) return;
  const s = state(symbol);
  if (done && !s.waiters.includes(done)) s.waiters.push(done);
  if (s.loading) return;
  const fresh = chipFresh(s);
  if (fresh) {
    s.waiters.length = 0;                           // 已有数据：不回调（否则 redraw→bind→再回调死循环）
    return;
  }
  s.loading = true;
  s.error = "";
  const rev = ++s.rev;
  void (async () => {
    try {
      const res = await marketApi.kline({ symbol, freq: "d", adjust: "qfq", limit: 500 });
      if (s.rev !== rev) return;
      const data = chipDistribution(res.bars);
      if (data) {
        s.data = data;
        s.at = Date.now();
      } else {
        s.data = null;
        s.error = "历史数据不足，无法计算筹码";
        s.at = Date.now();
      }
    } catch (e) {
      if (s.rev !== rev) return;
      s.error = (e as Error).message || "筹码数据加载失败";
      s.at = Date.now();
    } finally {
      if (s.rev === rev) {
        s.loading = false;
        const waiters = s.waiters.splice(0);        // 预取完成 → 同时唤起等这屏的卡片
        for (const fn of waiters) fn();
      }
    }
  })();
}

/** 筹码卡挂载：数据没到就先显示「计算中」，到齐后只重铺本卡片 */
export function bindChips(_root: HTMLElement, symbol: string, redraw: () => void): void {
  ensureChips(symbol, redraw);
}
