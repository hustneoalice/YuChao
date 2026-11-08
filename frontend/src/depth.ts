/* 盘口（对标众赢「盘口」tab）：基本信息 + 五档买卖盘 + 分时成交明细
 *  · 原「基本信息 / 盘口数据 / 五档盘口」三卡合并为一张紧凑面板（信息集中）
 *  · 数据源：/market/depth（腾讯 qt 五档） + /market/trades（东财 details 逐笔）
 *  · 卡片独立轮询 5s；离开页面或切换标的后自停（isConnected 守卫）
 *  · 价格红涨绿跌按昨收判定；逐笔按买卖方向着色（主买红 / 主卖绿）
 */
import { marketApi, type DepthQuote, type Quote, type TradeItem } from "./api";
import { esc, fmt, fmtYi } from "./fmt";

interface DepthSt { data: DepthQuote | null; error: string; busy: boolean }
interface TradesSt { items: TradeItem[]; error: string; busy: boolean }

const depthStates = new Map<string, DepthSt>();
const tradeStates = new Map<string, TradesSt>();

const POLL = 5000;

function dstate(symbol: string): DepthSt {
  let s = depthStates.get(symbol);
  if (!s) { s = { data: null, error: "", busy: false }; depthStates.set(symbol, s); }
  return s;
}
function tstate(symbol: string): TradesSt {
  let s = tradeStates.get(symbol);
  if (!s) { s = { items: [], error: "", busy: false }; tradeStates.set(symbol, s); }
  return s;
}

const pnlClass = (v: number | null | undefined): string =>
  v == null || v === 0 ? "" : v > 0 ? "up" : "down";

/** 委托金额（元）→ 万/亿 */
function amtWan(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (v >= 1e8) return fmt(v / 1e8, 2) + "亿";
  return fmt(v / 1e4, 1) + "万";
}

/** 委托量（手）→ 万手 */
function fmtLots(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (v >= 1e4) return fmt(v / 1e4, 1) + "万手";
  return fmt(v, 0) + "手";
}

/** 逐笔手数 → 众赢同款紧凑写法（2K / 1.2万） */
function fmtLotsK(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (v >= 1e4) return fmt(v / 1e4, 1) + "万";
  if (v >= 1e3) return fmt(v / 1e3, 1) + "K";
  return fmt(v, 0);
}

/** 成交量（股）→ 万股 / 亿股 */
function volShares(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (v >= 1e8) return fmt(v / 1e8, 2) + "亿股";
  return fmt(v / 1e4, 0) + "万股";
}

/** 市值（元）→ 亿 / 万亿 */
function capYi(v: number | null | undefined): string {
  if (v == null || !isFinite(v) || v <= 0) return "—";
  return v >= 1e12 ? fmt(v / 1e12, 2) + "万亿" : fmtYi(v, 0);
}

/* ── 名称 / 行业 / 概念 / 现价 ── */
function headHtml(d: DepthQuote, q: Quote | null): string {
  const chgCls = pnlClass(d.pct);
  const cons = (q?.concept ?? "").split(/[,，、;；\s]+/).map((x) => x.trim())
    .filter((c) => c && c !== q?.industry);   // 概念里常回带行业名，避免和行业 chip 重复
  const ind = q?.industry ? `<span class="ind">${esc(q.industry)}</span>` : "";
  const shown = cons.slice(0, 5).map((c) => `<span>${esc(c)}</span>`).join("");
  const more = cons.length > 5
    ? `<span class="more" role="button" tabindex="0">+${cons.length - 5} 更多</span>` : "";
  // 全量概念挂 data 属性，hover/点击时用固定定位浮层展示（不受卡片 overflow 裁剪）
  const dataCons = cons.length ? ` data-cons='${esc(JSON.stringify(cons)).replace(/"/g, "&quot;")}'` : "";
  const rz = d.margin === true
    ? `<span class="dp-tag rz" title="两融标的：支持融资买入">融资融券</span>`
    : d.margin === false
      ? `<span class="dp-tag no" title="非两融标的：不支持融资买入">非两融</span>`
      : "";
  const chgTxt = d.pct == null ? "" : (d.pct > 0 ? "+" : "") + fmt(d.pct) + "%";
  return `<div class="dp-head">
      <div class="dp-last ${chgCls}">${fmt(d.price)}</div>
      ${d.pct == null ? "" : `<div class="dp-chg ${chgCls}"><i class="dp-arrow ${chgCls}"></i>` +
        `${d.chg != null ? (d.chg > 0 ? "+" : "") + fmt(d.chg) : ""}<span>${chgTxt}</span></div>`}
      <div class="dp-time">${esc(d.time || "")}</div>
    </div>
    ${rz || ind || shown ? `<div class="dp-con"${dataCons}>${rz}${ind}${shown}${more}</div>` : ""}`;
}

/** 卡片标题行的紧凑摘要：名称 + 代码（随盘口轮询刷新，涨跌幅放在正文价格之后） */
export function headSubHtml(symbol: string, name: string): string {
  return `<span class="rh-nm" title="${esc(name)}">${esc(name)}</span>` +
    `<span class="rh-cd num">${esc(symbol.split(".")[0])}</span>`;
}

/* ── 概念浮层：默认只露前 5 个，hover 概念行 / 点「更多」展开全量 ── */
let conPop: HTMLElement | null = null;
let conPinned = false;
let conAnchor: HTMLElement | null = null;

function ensureConPop(): HTMLElement {
  if (conPop) return conPop;
  conPop = document.createElement("div");
  conPop.className = "dp-conpop";
  conPop.hidden = true;
  document.body.append(conPop);
  conPop.addEventListener("mouseleave", () => { if (!conPinned) hideConPop(); });
  const closeOutside = (e: Event): void => {
    if (!conPinned) return;
    const t = e.target as HTMLElement;
    if (t.closest?.(".dp-conpop, .dp-con")) return;
    hideConPop();
  };
  document.addEventListener("pointerdown", closeOutside, true);
  document.addEventListener("click", closeOutside, true);
  window.addEventListener("resize", hideConPop);
  window.addEventListener("scroll", hideConPop, true);
  return conPop;
}

function hideConPop(): void {
  conPinned = false;
  conAnchor = null;
  if (conPop) conPop.hidden = true;
}

function showConPop(anchor: HTMLElement): void {
  const raw = anchor.dataset.cons;
  if (!raw) return;
  let names: string[] = [];
  try { names = JSON.parse(raw) as string[]; } catch { return; }
  if (!names.length) return;
  const el = ensureConPop();
  conAnchor = anchor;
  el.innerHTML = names.map((n) => `<span>${esc(n)}</span>`).join("");
  el.hidden = false;
  el.style.visibility = "hidden";
  const w = Math.min(430, Math.max(280, anchor.offsetWidth));
  el.style.width = `${w}px`;
  const r = anchor.getBoundingClientRect();
  const h = el.offsetHeight;
  const below = r.bottom + 6;
  const top = below + h > window.innerHeight - 8 ? r.top - h - 6 : below;
  el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(8, top)}px`;
  el.style.visibility = "visible";
}

function bindConPop(card: HTMLElement): void {
  card.addEventListener("mouseover", (e) => {
    const con = (e.target as HTMLElement).closest<HTMLElement>(".dp-con");
    if (con && con !== conAnchor) showConPop(con);
  });
  card.addEventListener("mouseout", (e) => {
    const con = (e.target as HTMLElement).closest<HTMLElement>(".dp-con");
    if (!con || conPinned) return;
    const to = e.relatedTarget as HTMLElement | null;
    if (to?.closest?.(".dp-conpop")) return;
    hideConPop();
  });
  card.addEventListener("click", (e) => {
    const more = (e.target as HTMLElement).closest<HTMLElement>(".dp-con .more");
    if (!more) return;
    const con = more.closest<HTMLElement>(".dp-con")!;
    if (conPinned && conAnchor === con) { hideConPop(); return; }
    conPinned = true;
    showConPop(con);
  });
}

/* ── 关键字段网格（2 列 · 标签左值右，对标众赢盘口左栏） ── */
function overviewGrid(d: DepthQuote, q: Quote | null): string {
  const val = q?.valuation;
  const base = d.prev_close ?? null;
  const rel = (x: number | null | undefined): string =>
    pnlClass(x == null || base == null ? null : x - base);
  const cell = (k: string, v: string, cls = ""): string =>
    `<div class="dp-kv"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  const pe = val?.pe_ttm != null ? (val.pe_ttm > 0 ? fmt(val.pe_ttm) : "亏损") : "—";
  const pb = val?.pb != null && val.pb > 0 ? fmt(val.pb) : "—";
  const items = [
    cell("最高", fmt(d.high), rel(d.high)),
    cell("开盘", fmt(d.open), rel(d.open)),
    cell("最低", fmt(d.low), rel(d.low)),
    cell("昨收", fmt(base)),
    cell("振幅", d.amplitude != null ? fmt(d.amplitude) + "%" : "—"),
    cell("涨停", (d.limit_up ?? 0) > 0 ? fmt(d.limit_up) : "—", "up"),
    cell("量比", fmt(d.vol_ratio)),
    cell("跌停", (d.limit_down ?? 0) > 0 ? fmt(d.limit_down) : "—", "down"),
    cell("换手", d.turnover_rate != null ? fmt(d.turnover_rate) + "%" : "—"),
    cell("市盈率", pe),
    cell("成交额", fmtYi(d.amount)),
    cell("市净率", pb),
    cell("成交量", volShares(d.volume)),
    cell("外盘", fmtLots(d.outer_vol), "up"),
    cell("流通市值", capYi(val?.circ_mv)),
    cell("内盘", fmtLots(d.inner_vol), "down"),
    cell("总市值", capYi(val?.total_mv)),
    cell("均价", fmt(d.avg_price), rel(d.avg_price)),
  ];
  return `<div class="dp-kpis">${items.join("")}</div>`;
}

/* ── 五档买卖盘 ── */
function bookRows(d: DepthQuote, detailed: boolean): string {
  const levels = [...d.asks.map((x, i) => ({ ...x, label: ["卖一", "卖二", "卖三", "卖四", "卖五"][i] })).reverse(),
    ...d.bids.map((x, i) => ({ ...x, label: ["买一", "买二", "买三", "买四", "买五"][i] }))];
  const maxVol = Math.max(1, ...levels.map((x) => x.volume));
  const side = (label: string): string => (label.startsWith("卖") ? "ask" : "bid");
  return levels.map((x) => {
    const pct = Math.max(2, Math.round(x.volume / maxVol * 100));
    const cls = pnlClass(x.price - (d.prev_close ?? x.price));
    return `<div class="dp-row ${side(x.label)}">
      <i class="dp-bar" style="width:${pct}%"></i>
      <span class="dp-sd">${x.label}</span>
      <span class="dp-px ${cls}">${fmt(x.price)}</span>
      <span class="dp-vv">${fmt(x.volume, 0)}</span>
      ${detailed ? `<span class="dp-amt">${amtWan(x.amount)}</span>` : ""}
    </div>`;
  }).join("");
}

function depthHtml(symbol: string, detailed: boolean, preview: boolean, q: Quote | null): string {
  const s = dstate(symbol);
  if (s.error) return `<div class="bempty">${esc(s.error)}</div>`;
  const d = s.data;
  if (!d) return `<div class="bempty">${s.busy ? "盘口加载中…" : "加载盘口…"}</div>`;
  const head = headHtml(d, q);
  const grid = overviewGrid(d, q);
  if (!d.applicable || (!d.bids.length && !d.asks.length)) {
    return `${head}${grid}<div class="dp-sec">买卖五档</div>
      <div class="bempty">暂无五档盘口（非交易时段 / 指数）</div>`;
  }
  const ratio = d.bid_ask_ratio;
  const rCls = pnlClass(ratio);
  const bt = d.bid_total || 0;
  const at = d.ask_total || 0;
  const bidPct = bt + at ? bt / (bt + at) * 100 : 50;
  const bar = `<div class="dp-ratio" title="委买 ${fmt(bidPct, 1)}% · 委卖 ${fmt(100 - bidPct, 1)}%">
    <i class="rb" style="width:${fmt(bidPct, 1)}%"></i><i class="ra" style="width:${fmt(100 - bidPct, 1)}%"></i>
  </div>`;
  const foot = `<div class="dp-foot">
    <span>委比 <b class="${rCls}">${ratio != null ? (ratio > 0 ? "+" : "") + fmt(ratio) + "%" : "—"}</b></span>
    <span>委差 <b class="${pnlClass(d.bid_ask_diff)}">${d.bid_ask_diff > 0 ? "+" : ""}${fmt(d.bid_ask_diff, 0)}</b></span>
  </div>`;
  return `${head}${grid}
    <div class="dp-sec">买卖五档</div>
    <div class="dp-book">${bookRows(d, detailed)}</div>
    ${bar}
    ${foot}
    ${preview ? "" : `<div class="dp-note">五档单位：手${detailed ? " / 金额：元" : ""}　更新 ${esc(d.time || "")}</div>`}`;
}

export function orderbookBody(symbol: string, mode: string, q: Quote | null = null): string {
  return depthHtml(symbol, mode === "detailed", false, q);
}

/* ── 成交明细（时间 / 价格 / 手数 / 方向，对标众赢「分时差价」） ── */
function tradesHtml(symbol: string, detailed: boolean): string {
  const s = tstate(symbol);
  if (s.error) return `<div class="bempty">${esc(s.error)}</div>`;
  if (!s.items.length) return `<div class="bempty">${s.busy ? "成交明细加载中…" : "暂无逐笔成交（非交易时段）"}</div>`;
  const rows = s.items.map((t) => {
    const cls = t.direction === 1 ? "up" : t.direction === 2 ? "down" : "dim";
    const amt = detailed && t.price != null ? `<span class="dp-am">${amtWan(t.price * t.volume * 100)}</span>` : "";
    return `<div class="dp-tr ${cls}">
      <span class="dp-tt">${esc(t.time)}</span>
      <span class="dp-tp">${fmt(t.price)}</span>
      <span class="dp-tv">${fmtLotsK(t.volume)}</span>
      ${amt}
      <span class="dp-td">${t.direction === 1 ? "B" : t.direction === 2 ? "S" : "—"}</span>
    </div>`;
  }).join("");
  return `<div class="dp-trades">
    <div class="dp-tr dp-th"><span class="dp-tt">时间</span><span class="dp-tp">价格</span><span class="dp-tv">手数</span>${detailed ? `<span class="dp-am">金额</span>` : ""}<span class="dp-td">方向</span></div>
    ${rows}
  </div>`;
}

export function tradesBody(symbol: string, mode: string): string {
  return tradesHtml(symbol, mode === "detailed");
}

/* ── 轮询绑定：只刷新本卡片，不触发整列重绘 ── */
function poll(card: HTMLElement, run: () => Promise<boolean>, paint: () => string): void {
  let alive = true;
  let timer: number | undefined;
  const tick = async (): Promise<void> => {
    if (!card.isConnected) { alive = false; if (timer) window.clearInterval(timer); return; }
    const ok = await run();
    if (!alive || !card.isConnected) return;
    if (ok) {
      const body = card.querySelector<HTMLElement>(".fbody");
      if (body) body.innerHTML = paint();
    }
  };
  void tick();
  timer = window.setInterval(() => void tick(), POLL);
}

export function bindOrderbook(card: HTMLElement, symbol: string, mode: string, getQuote: () => Quote | null, name = ""): void {
  bindConPop(card);
  poll(card,
    async () => {
      const s = dstate(symbol);
      if (s.busy) return false;
      s.busy = true;
      try {
        s.data = await marketApi.depth(symbol);
        s.error = "";
        return true;
      } catch (e) {
        s.error = (e as Error).message || "盘口加载失败";
        return true;
      } finally { s.busy = false; }
    },
    () => {
      // 名称/代码在标题行，随盘口轮询同步刷新，避免头部数据滞后
      const d = dstate(symbol).data;
      const sub = card.querySelector<HTMLElement>("[data-head-sub]");
      if (d && sub) sub.innerHTML = headSubHtml(symbol, d.name || getQuote()?.name || name || symbol);
      return depthHtml(symbol, mode === "detailed", false, getQuote());
    });
}

/** 打开个股即预取首屏五档：切到盘口卡直接有数，不用等 5s 轮询 */
export function prefetchDepth(symbol: string): Promise<void> {
  const s = dstate(symbol);
  if (s.data || s.busy) return Promise.resolve();
  s.busy = true;
  return marketApi.depth(symbol)
    .then((d) => { s.data = d; s.error = ""; })
    .catch((e) => { s.error = (e as Error).message || "盘口加载失败"; })
    .finally(() => { s.busy = false; });
}

/** 打开个股即预取首屏逐笔：切到成交明细卡直接有数 */
export function prefetchTrades(symbol: string): Promise<void> {
  const s = tstate(symbol);
  if (s.items.length || s.busy) return Promise.resolve();
  s.busy = true;
  return marketApi.trades(symbol, 20)
    .then((res) => { s.items = res.items || []; s.error = ""; })
    .catch((e) => { s.error = (e as Error).message || "成交明细加载失败"; })
    .finally(() => { s.busy = false; });
}

export function bindTrades(card: HTMLElement, symbol: string, mode: string): void {
  poll(card,
    async () => {
      const s = tstate(symbol);
      if (s.busy) return false;
      s.busy = true;
      try {
        const res = await marketApi.trades(symbol, 20);
        s.items = res.items || [];
        s.error = "";
        return true;
      } catch (e) {
        s.error = (e as Error).message || "成交明细加载失败";
        return true;
      } finally { s.busy = false; }
    },
    () => tradesHtml(symbol, mode === "detailed"));
}
