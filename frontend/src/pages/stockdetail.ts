/* 个股详情页（众赢个股详情布局同源，yuchao 风格）：
 * 左多周期 K 线（60分/日/周/月，mountKline 独立实例）+ 右盘口关键网格。
 * 数据：/market/kline 日线（周/月前端聚合，与行情页 aggDaily 同口径）+
 * /market/snapshot_one（盘口网格：买卖一/内外盘/涨跌停/量比振幅/市值，
 * market_snapshot 派生零上游）+ /market/quote（估值/资金流，失败不阻断）。
 * P2+ 预留：五档全档 / 逐笔成交 / 委比委差，待单票五档采集落地后补位。 */
import { marketApi, type Bar, type BoardRow, type Quote } from "../api";
import { esc, fmt, fmtChg, fmtVol, fmtYi, fmtYiS } from "../fmt";
import { aggDaily } from "./market";
import { mountKline, type KlineChartHandle } from "./kline";
import { openWatchPanel } from "../watch";

type SDPeriod = "60" | "d" | "w" | "m";
const P_N: Record<SDPeriod, number> = { "60": 1, d: 1, w: 5, m: 20 };

let cur: { symbol: string; name: string } | null = null;
let kl: KlineChartHandle | null = null;
let daily: Bar[] = [];
let m60: Bar[] | null = null;
let period: SDPeriod = "d";
let loading = false;

/* ── 数据 ── */

async function loadAll(): Promise<void> {
  if (!cur || loading) return;
  loading = true;
  const sym = cur.symbol;
  try {
    const [k, snap, quote] = await Promise.all([
      marketApi.kline({ symbol: sym, limit: 800 }),
      marketApi.snapshotOne(sym).catch(() => null),
      marketApi.quote(sym).catch(() => null),
    ]);
    if (cur?.symbol !== sym) return;               // 期间已切标的
    daily = k.bars;
    m60 = null;                                    // 换标的重置分钟缓存
    document.getElementById("sd-asof")!.textContent =
      k.bars.length ? `K线截至 ${k.bars[k.bars.length - 1].date}` : "";
    drawQuote(snap, quote);
    drawGrid(snap, quote);
    drawChart();
  } catch {
    document.getElementById("sd-asof")!.textContent = "加载失败";
  } finally {
    loading = false;
  }
}

function barsFor(p: SDPeriod): Bar[] {
  if (p === "60") return m60 ?? [];
  const n = P_N[p];
  return n === 1 ? daily : aggDaily(daily, n);
}

async function switchPeriod(p: SDPeriod): Promise<void> {
  period = p;
  document.querySelectorAll<HTMLElement>("#sd-period button").forEach((b) =>
    b.classList.toggle("on", b.dataset.p === p));
  if (p === "60" && !m60 && cur) {
    const sym = cur.symbol;
    document.getElementById("sd-asof")!.textContent = "60分加载中…";
    try {
      const k = await marketApi.kline({ symbol: sym, freq: "60" });
      if (cur?.symbol !== sym) return;           // 期间已切标的
      m60 = k.bars;
    } catch { /* 失败保持空图 */ }
  }
  drawChart();
}

/* ── 渲染 ── */

function drawChart(): void {
  const bars = barsFor(period);
  if (!kl) kl = mountKline(document.getElementById("sd-chart")!);
  kl.setData(bars);
  kl.setPeriod(period);
  kl.resetView();
}

/** 报价头：快照优先（盘中 5 分钟新鲜度），无快照退日线/实时兜底 */
function drawQuote(snap: BoardRow | null, quote: Quote | null): void {
  const el = document.getElementById("sd-quote")!;
  const price = snap?.current ?? quote?.rt_price ?? quote?.close ?? null;
  const chg = snap?.change_amount ?? (price != null && quote?.rt_prev_close != null
    ? price - quote.rt_prev_close : null);
  const pct = snap?.change_rate ?? (price != null && quote?.rt_prev_close
    ? (price / quote.rt_prev_close - 1) * 100 : quote?.pct_chg ?? null);
  const cls = pct == null ? "" : pct > 0 ? "up" : pct < 0 ? "down" : "";
  const lim = snap?.up_limit ? `<span class="tag p1">涨停 <b class="num">${fmt(snap.up_limit)}</b></span>` : "";
  const dlim = snap?.down_limit ? `<span class="tag flat">跌停 <b class="num">${fmt(snap.down_limit)}</b></span>` : "";
  const time = snap?.updated_at ? `快照 ${snap.updated_at.slice(11, 19)}` : "";
  el.innerHTML =
    `<b class="sd-price num ${cls}">${price == null ? "—" : fmt(price)}</b>` +
    `<span class="num ${cls}">${chg == null ? "—" : fmtChg(chg)}</span>` +
    `<span class="num ${cls}">${pct == null ? "—" : fmtChg(pct) + "%"}</span>` +
    (lim || dlim ? `<span class="sd-lims">${lim}${dlim}</span>` : "") +
    `<span class="sp" style="flex:1"></span>` +
    (time ? `<span style="font-size:11px;color:var(--faint)">${esc(time)}</span>` : "");
}

/** 盘口网格：快照 23 字段精选 + 估值/资金流兜底段（quote 可得时） */
function drawGrid(snap: BoardRow | null, quote: Quote | null): void {
  const el = document.getElementById("sd-grid")!;
  const cell = (label: string, v: string, cls = "", title = "") =>
    `<div class="sd-cell"${title ? ` title="${esc(title)}"` : ""}>` +
    `<span>${esc(label)}</span><b class="num ${cls}">${v}</b></div>`;
  const g: string[] = [
    cell("今开", fmt(snap?.open ?? quote?.open)),
    cell("昨收", fmt(snap?.pre_close ?? quote?.rt_prev_close ?? quote?.close)),
    cell("最高", fmt(snap?.high ?? quote?.high), "up"),
    cell("最低", fmt(snap?.low ?? quote?.low), "down"),
    cell("成交量", fmtVol(snap?.volume ?? quote?.volume), "", "手"),
    cell("成交额", fmtYi(snap?.amount ?? quote?.amount)),
    cell("换手%", fmt(snap?.turnover_rate ?? quote?.turnover_rate)),
    cell("量比", fmt(snap?.vol_ratio)),
    cell("振幅%", fmt(snap?.amplitude)),
    cell("买一价", fmt(snap?.bid1)),
    cell("买一量", fmtVol(snap?.bid1_vol), "", "手"),
    cell("卖一价", fmt(snap?.ask1)),
    cell("卖一量", fmtVol(snap?.ask1_vol), "", "手"),
    cell("外盘", fmtVol(snap?.outer_vol), "up", "主动买入（手）"),
    cell("内盘", fmtVol(snap?.inner_vol), "down", "主动卖出（手）"),
    cell("流通市值", fmtYi(snap?.circ_value)),
    cell("总市值", fmtYi(snap?.market_value)),
  ];
  if (quote?.valuation) {
    g.push(cell("PE(TTM)", fmt(quote.valuation.pe_ttm)));
    g.push(cell("PB", fmt(quote.valuation.pb)));
  }
  if (quote?.capital_flow?.net_main != null) {
    const v = quote.capital_flow.net_main;
    g.push(cell("主力净流入", fmtYiS(v), v > 0 ? "up" : v < 0 ? "down" : "", "当日（元）"));
  }
  el.innerHTML = g.join("");
  document.getElementById("sd-snaptime")!.textContent =
    snap ? "盘中快照" : "无盘中快照 · 日线口径";
}

/* ── 入口 ── */

/** 菜单直达（无标的）：显示空态引导；已打开过则保留当前标的 */
export function ensureStockPage(): void {
  if (!cur) {
    document.getElementById("sd-empty")!.style.display = "grid";
    document.getElementById("sd-body")!.style.display = "none";
  }
}

export function openStockDetail(d: { symbol: string; name?: string }): void {
  cur = { symbol: d.symbol, name: d.name || d.symbol };
  document.getElementById("sd-title")!.textContent = cur.name;
  document.getElementById("sd-code")!.textContent = cur.symbol;
  document.getElementById("sd-empty")!.style.display = "none";
  document.getElementById("sd-body")!.style.display = "flex";
  void loadAll();
}

export function initStockDetail(): void {
  document.getElementById("sd-watch")!.addEventListener("click", () => {
    if (cur) openWatchPanel(cur.symbol, cur.name);
  });
  document.getElementById("sd-period")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-p]");
    if (b) void switchPeriod(b.dataset.p as SDPeriod);
  });
}
