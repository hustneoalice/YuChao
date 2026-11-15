/* 训练模式（通达信训练模式同思路）：图表只喂到「当前K线」，一根根往后推；
   盘中买入随手记账，按当前收盘算持仓成本与浮盈。会话按标的存 localStorage（yc_train），
   收起面板或刷新页面都能接着练。与行情页解耦：market.ts 通过 initTrain 注入 host。 */
import type { Bar } from "../api";
import { esc, fmt } from "../fmt";

export interface TrainHost {
  symbol: () => string | null;
  /** 标的名（浮层标题用） */
  name: () => string;
  /** 日线全量 */
  bars: () => Bar[];
  /** 焦点周期的完整K线（未裁切）：日=日线，周/月/季=自然聚合 */
  periodBars: () => Bar[];
  period: () => string;
  /** 分时/60分/120分不参与训练：切回日线 */
  forceDaily: () => void;
  /** 重画图表（视图回到末根） */
  rerender: () => void;
  /** 布局变化后重排（训练隐藏右列时画布宽度变了，必须 resize） */
  relayout: () => void;
  /** 当前图表视图最后一根K线日期（「打开K线后点开始训练」取这个） */
  visibleEnd: () => string | null;
  toast: (msg: string) => void;
}

interface Trade { id: string; date: string; price: number; qty: number; note: string; side?: "buy" | "sell" }
/** step：加减仓刻度（%），建仓价为基准，默认 5；capital：初始资金；posPct：单次买入仓位（%） */
interface Session { start: string; cut: string; trades: Trade[]; step?: number; capital?: number; posPct?: number }
/** 训练存档：一次训练结束后的快照（结束训练时用户确认才存），供翻记录 / 复盘 / 删改 */
export interface TrainArchive {
  id: string; symbol: string; name: string;
  start: string; end: string;
  trades: Trade[]; step: number; capital: number; posPct: number;
  /** 结束时的账户盈亏（%） */
  pnl: number;
  /** 用户可改的名称/备注 */
  note?: string;
  savedAt: number;
}
type Store = Record<string, Session>;

const KEY = "yc_train";
const PLAY_MS = 900;
const STEP_DEFAULT = 5;
const CAP_DEFAULT = 1_000_000;
const POS_DEFAULT = 5;
/** 账户涨幅达到该比例时提示「卖出一半」 */
const SELL_HINT = 5;
/** 持仓浮盈达到该比例时提示「一键清仓」 */
const CLOSE_HINT = 10;
const PERIOD_LABEL: Record<string, string> = { d: "日K", w: "周K", m: "月K", q: "季K" };

let host: TrainHost | null = null;
let panelOpen = false;      // 浮层是否展开（展开≠正在训练：没有会话时是「选起点」态）
let active = false;         // 是否正在训练（true 时图表只喂到 cut）
let sess: Session | null = null;
let curSym = "";
let playTimer: number | null = null;
let priceFor = "";          // 价格输入框上次跟随的K线日期（推进时才重置为收盘价）
let logOpen = false;        // 交易记录：只显示最近 2 笔，点「全部记录」展开
let folded = localStorage.getItem("yc_train_fold") === "1";
if (localStorage.getItem("yc_train_fold") == null && document.body.classList.contains("mobile")) folded = true;

/* ── 会话存取 ── */
function readStore(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}") as unknown;
    if (v && typeof v === "object") return v as Store;
  } catch { /* 坏值当空 */ }
  return {};
}

function writeSession(sym: string, s: Session | null): void {
  const st = readStore();
  if (s) st[sym] = s;
  else delete st[sym];
  try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* 配额满：本次内存态仍可用 */ }
}

function persist(): void {
  if (curSym && sess) writeSession(curSym, sess);
}

/* ── 训练存档（yc_train_arch）── */
const ARCH_KEY = "yc_train_arch";

function readArch(): TrainArchive[] {
  try {
    const v = JSON.parse(localStorage.getItem(ARCH_KEY) || "[]") as unknown;
    if (Array.isArray(v)) return v.filter((a): a is TrainArchive => !!a && typeof a === "object" && "id" in a);
  } catch { /* 坏值当空 */ }
  return [];
}

function writeArch(list: TrainArchive[]): void {
  try { localStorage.setItem(ARCH_KEY, JSON.stringify(list.slice(0, 200))); } catch { /* 配额满忽略 */ }
}

/* ── DOM 小工具 ── */
function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function px(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  return fmt(v, Math.abs(v) < 10 ? 3 : 2);
}

/** 价格取整：≥100 保留 2 位，否则 3 位（ETF 三位小数） */
function roundP(v: number): number {
  return Number(v.toFixed(v >= 100 ? 2 : 3));
}

/** 最后一个日期 ≤ date 的下标（找不到返回 -1） */
function atOrBefore(list: Bar[], date: string): number {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].date <= date) return i;
  return -1;
}

/** 数据窗口变了（换标的/回补）后把会话夹回可见区间 */
function clampSession(s: Session, bars: Bar[]): boolean {
  if (!bars.length) return false;
  const first = bars[0].date, last = bars[bars.length - 1].date;
  let changed = false;
  if (s.start < first) { s.start = first; changed = true; }
  if (s.start > last) { s.start = last; changed = true; }
  if (s.cut < s.start) { s.cut = s.start; changed = true; }
  if (s.cut > last) { s.cut = last; changed = true; }
  return changed;
}

/* ── 资金 / 仓位 ── */
function capitalOf(s: Session | null): number {
  return s && s.capital && s.capital > 0 ? s.capital : CAP_DEFAULT;
}

function posPctOf(s: Session | null): number {
  const p = s && s.posPct && s.posPct > 0 ? s.posPct : POS_DEFAULT;
  return Math.min(100, p);
}

/** 截至当前K线的成交（复盘时存档里的未来记录不能提前计入现金 / 持仓） */
function liveTrades(s: Session): Trade[] {
  return s.trades.filter((t) => t.date <= s.cut);
}

/** 可用现金 = 初始资金 - 买入金额 + 卖出回款（不计手续费） */
function cashOf(s: Session): number {
  return capitalOf(s) + liveTrades(s).reduce((k, t) => k + (t.side === "sell" ? t.price * t.qty : -t.price * t.qty), 0);
}

/** 当前持仓股数 = 买入 - 卖出 */
function heldOf(s: Session): number {
  return liveTrades(s).reduce((k, t) => k + (t.side === "sell" ? -t.qty : t.qty), 0);
}

/** 最近一笔买入 / 卖出（只看已推进到的K线）：卖出「一半」与「接回」都以它为基准 */
function lastBuy(s: Session): Trade | null {
  for (let i = s.trades.length - 1; i >= 0; i--) {
    const t = s.trades[i];
    if (t.date <= s.cut && t.side !== "sell") return t;
  }
  return null;
}

function lastSell(s: Session): Trade | null {
  for (let i = s.trades.length - 1; i >= 0; i--) {
    const t = s.trades[i];
    if (t.date <= s.cut && t.side === "sell") return t;
  }
  return null;
}

/** 按「账户总资产 × 仓位」折算买入股数：够一手按 100 股取整，不够则按整数股（高价股不至于买 0 股） */
function autoQty(price: number, bar: Bar | null): number {
  if (!sess || !(price > 0)) return 0;
  const cash = cashOf(sess);
  const equity = cash + heldOf(sess) * (bar?.close ?? price);
  const amount = Math.min((equity * posPctOf(sess)) / 100, cash);
  return lotOf(amount / price);
}

/** 股数取整：够一手取整百，否则按整数股 */
function lotOf(raw: number): number {
  if (!(raw > 0)) return 0;
  return raw >= 100 ? Math.floor(raw / 100) * 100 : Math.floor(raw);
}

/** 买入金额（元）→ 股数 */
function amtQty(price: number, amt: number): number {
  return price > 0 && amt > 0 ? lotOf(amt / price) : 0;
}

/** 卖出股数输入（股数卖出，留空 = 卖一半） */
function typedSellQty(): number {
  const v = Number(el<HTMLInputElement>("kt-sellqty")?.value) || 0;
  return v > 0 ? Math.floor(v) : 0;
}

/** 金额输入框回显：留空 = 按仓位自动算；填了 = 按金额折算股数。同时刷新卖出框占位（一半） */
function syncQtyAmt(): void {
  if (!sess) return;
  const price = Number(el<HTMLInputElement>("kt-price")?.value) || 0;
  const typedAmt = Number(el<HTMLInputElement>("kt-amt")?.value) || 0;
  const auto = price > 0 ? autoQty(price, null) : 0;
  const qty = typedAmt > 0 ? amtQty(price, typedAmt) : auto;
  const box = el("kt-qty-amt");
  if (box) {
    box.innerHTML = typedAmt > 0
      ? `买入 <b>${fmt(typedAmt, 0)}</b> 元 ≈ <b>${fmt(qty, 0)}</b> 股`
      : `留空按仓位：约 <b>${fmt(qty, 0)}</b> 股 ≈ <b>${fmt(qty * price, 0)}</b> 元`;
  }
  const sq = el<HTMLInputElement>("kt-sellqty");
  const held = heldOf(sess);
  const base = lastBuy(sess)?.qty ?? held;
  const defQty = held > 0 ? Math.min(held, Math.max(1, Math.floor(base / 2))) : 0;
  if (sq && !sq.value) sq.placeholder = defQty > 0 ? String(defQty) : "一半";
  /* 卖出预计回款：按输入股数（留空 = 上次买入的一半）折算金额 */
  const sa = el("kt-sellamt");
  if (sa) {
    const typed = typedSellQty();
    const q = held > 0 ? Math.min(held, typed > 0 ? typed : defQty) : 0;
    sa.innerHTML = q > 0
      ? `卖出 <b>${fmt(q, 0)}</b> 股 ≈ <b>${fmt(q * price, 0)}</b> 元`
      : "当前没有持仓";
  }
}

/** 把输入框里的初始资金 / 仓位写回会话（开始训练、改值、买入前各同步一次） */function readFunds(): void {
  if (!sess) return;
  const cap = Number(el<HTMLInputElement>("kt-cap")?.value);
  const pos = Number(el<HTMLInputElement>("kt-pos-pct")?.value);
  if (cap > 0) sess.capital = cap;
  if (pos > 0) sess.posPct = Math.min(100, pos);
}

/* ── 对外接口（market.ts 用） ── */
/** 训练裁切线：null = 未训练，图表喂全量 */
export function trainCut(): string | null {
  return active && sess ? sess.cut : null;
}

export function trainingActive(): boolean {
  return active;
}

/** 周期切换后刷新浮层进度（N / M 根与周期标签跟着走） */
export function trainRefresh(): void {
  if (active) sync();
}

/** 换标的时同步会话：有存档就续训，没有就回到「选起点」 */
export function trainOnSymbol(sym: string | null): void {
  curSym = sym ?? "";
  priceFor = "";
  stopPlay();
  const amtEl = el<HTMLInputElement>("kt-amt");
  if (amtEl) amtEl.value = "";               // 换标的后金额回到「按仓位自动」
  const sqEl = el<HTMLInputElement>("kt-sellqty");
  if (sqEl) sqEl.value = "";
  sess = sym ? (readStore()[sym] ?? null) : null;
  if (sess) {
    const bars = host?.bars() ?? [];
    if (bars.length && clampSession(sess, bars)) writeSession(curSym, sess);
    const capEl = el<HTMLInputElement>("kt-cap");
    if (capEl) capEl.value = String(capitalOf(sess));
    const posEl = el<HTMLInputElement>("kt-pos-pct");
    if (posEl) posEl.value = String(posPctOf(sess));
  }
  active = panelOpen && !!sess;
  if (active) host?.forceDaily();
  sync();
}

/* ── 浮层 ── */
export function initTrain(h: TrainHost): void {
  if (host) return;
  host = h;
  el("kl-train")?.addEventListener("click", () => (panelOpen ? closePanel() : openPanel()));
  el("kt-x")?.addEventListener("click", closePanel);
  el("kt-fold")?.addEventListener("click", () => {
    folded = !folded;
    try { localStorage.setItem("yc_train_fold", folded ? "1" : "0"); } catch { /* 配额满忽略 */ }
    applyFold();
    host?.relayout();
  });
  el("kt-begin")?.addEventListener("click", () => begin(el<HTMLInputElement>("kt-start")?.value || ""));
  el("kt-here")?.addEventListener("click", () => begin(host?.visibleEnd() || lastDate()));
  el("kt-next")?.addEventListener("click", () => step(1, false));
  el("kt-prev")?.addEventListener("click", () => step(-1, false));
  el("kt-play")?.addEventListener("click", togglePlay);
  el("kt-reset")?.addEventListener("click", resetSession);
  el("kt-buy")?.addEventListener("click", buy);
  el("kt-sell")?.addEventListener("click", sellHalf);
  el("kt-sellin")?.addEventListener("click", sellInput);
  el("kt-close")?.addEventListener("click", closeAll);
  el("kt-end")?.addEventListener("click", endTraining);
  el("kt-arch")?.addEventListener("click", openArchive);
  el("kt-warn")?.addEventListener("click", sellHalf);
  el("kt-warn2")?.addEventListener("click", closeAll);
  el("kt-step")?.addEventListener("change", (e) => {
    if (!sess) return;
    const v = Number((e.target as HTMLSelectElement).value);
    sess.step = v > 0 ? v : STEP_DEFAULT;
    persist();
    sync();
    host?.rerender();
  });
  // 初始资金 / 仓位改了：重算可买股数与账户盈亏
  for (const id of ["kt-cap", "kt-pos-pct"]) {
    el(id)?.addEventListener("change", () => {
      if (!sess) return;
      readFunds();
      persist();
      sync();
    });
  }
  el("kt-note")?.addEventListener("keydown", (e) => { if (e.key === "Enter") buy(); });
  el("kt-amt")?.addEventListener("keydown", (e) => { if (e.key === "Enter") buy(); });
  el("kt-sellqty")?.addEventListener("keydown", (e) => { if (e.key === "Enter") sellInput(); });
  el("kt-sellqty")?.addEventListener("input", syncQtyAmt);
  // 价格 / 金额改动即时刷新预计股数
  for (const id of ["kt-price", "kt-amt"]) el(id)?.addEventListener("input", syncQtyAmt);
  // 快速买入金额：接回上次卖出金额 / 按仓位建仓 / 可用现金全部
  el("kt-amt-chips")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-amt]");
    const inp = el<HTMLInputElement>("kt-amt");
    if (!b || !inp || !sess) return;
    const price = Number(el<HTMLInputElement>("kt-price")?.value) || 0;
    const kind = b.dataset.amt;
    let amt = 0;
    if (kind === "max") {
      amt = price > 0 ? lotOf(cashOf(sess) / price) * price : 0;
    } else if (kind === "build") {
      amt = Math.min((capitalOf(sess) * posPctOf(sess)) / 100, cashOf(sess));
    } else if (kind === "back") {
      const ls = lastSell(sess);
      amt = ls ? Math.min(ls.price * ls.qty, cashOf(sess)) : 0;
    } else {
      amt = Number(kind) || 0;
    }
    inp.value = amt > 0 ? String(Math.round(amt)) : "";
    syncQtyAmt();
  });
  // 快速卖出股数：以上次买入股数为基准（一半 / 1/4），或全部持仓
  el("kt-sell-chips")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-q]");
    const inp = el<HTMLInputElement>("kt-sellqty");
    if (!b || !inp || !sess) return;
    const held = heldOf(sess);
    if (held <= 0) { host?.toast("当前没有持仓"); return; }
    const base = lastBuy(sess)?.qty ?? held;
    const q = b.dataset.q;
    const raw = q === "all" ? held : Math.floor(base / (q === "quarter" ? 4 : 2));
    const qty = Math.min(held, raw > 0 ? raw : held);
    inp.value = String(qty);
    syncQtyAmt();
  });
  // 阶梯价点一行：把成交价填成该价位
  el("kt-lad")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-lad]");
    const inp = el<HTMLInputElement>("kt-price");
    const p = Number(b?.dataset.lad);
    if (!inp || !(p > 0)) return;
    inp.value = String(p);
    if (sess) priceFor = sess.cut;          // 防止下一次 sync 把成交价覆盖回收盘价
    syncQtyAmt();
  });
  initDrag();
  el("kt-list")?.addEventListener("click", (e) => {
    const more = (e.target as HTMLElement).closest<HTMLElement>("[data-kt-more]");
    if (more) {
      logOpen = !logOpen;
      sync();
      return;
    }
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-kt-del]");
    if (!b || !sess) return;
    sess.trades = sess.trades.filter((t) => t.id !== b.dataset.ktDel);
    persist();
    sync();
    host?.rerender();
  });
  // 离开行情页收起训练（会话已落本地，回来重新打开即可续训）
  document.addEventListener("yc:goto-page", (e) => {
    if ((e as CustomEvent).detail !== "market" && panelOpen) closePanel();
  });
  sync();
}

/** 折叠态：只留「上一根/下一根 + 仓位盈亏 + 加减仓提示」（手机版默认折叠） */
function applyFold(): void {
  el("kt-run")?.classList.toggle("fold", folded);
  const btn = el("kt-fold");
  if (btn) {
    btn.textContent = folded ? "⌄" : "⌃";
    btn.title = folded ? "展开详细设置" : "折叠详细设置";
  }
}

/* 拖动标题栏移动浮层：位置记在本地，下次打开/刷新后还原（手机端固定底部，不拖） */const KEY_POS = "yc_train_pos";

function initDrag(): void {
  const panel = el("kl-train-panel");
  const head = panel?.querySelector<HTMLElement>(".kt-h");
  if (!panel || !head) return;
  const parent = panel.parentElement;
  const mobile = () => document.body.classList.contains("mobile");

  const apply = (l: number, t: number): void => {
    const maxL = Math.max(0, (parent?.clientWidth ?? 0) - panel.offsetWidth - 4);
    const maxT = Math.max(0, (parent?.clientHeight ?? 0) - panel.offsetHeight - 4);
    panel.style.left = `${Math.min(Math.max(0, l), maxL)}px`;
    panel.style.top = `${Math.min(Math.max(0, t), maxT)}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  };

  if (!mobile()) {
    try {
      const p = JSON.parse(localStorage.getItem(KEY_POS) || "null") as { l: number; t: number } | null;
      if (p && isFinite(p.l) && isFinite(p.t)) apply(p.l, p.t);
    } catch { /* 坏值忽略 */ }
  }

  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest(".kt-x") || mobile()) return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    ox = panel.offsetLeft; oy = panel.offsetTop;
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  head.addEventListener("pointermove", (e) => {
    if (dragging) apply(ox + e.clientX - sx, oy + e.clientY - sy);
  });
  const end = (): void => {
    if (!dragging) return;
    dragging = false;
    try {
      localStorage.setItem(KEY_POS, JSON.stringify({ l: panel.offsetLeft, t: panel.offsetTop }));
    } catch { /* 配额满忽略 */ }
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
  // 窗口尺寸变化后把浮层夹回可视区
  window.addEventListener("resize", () => {
    if (!panel.hidden && !mobile()) apply(panel.offsetLeft, panel.offsetTop);
  });
}

function openPanel(): void {
  if (!host?.symbol()) { host?.toast("先打开一个标的再训练"); return; }
  // 手机版默认折叠成简洁训练框（用户手动展开/折叠过则沿用记忆）
  if (localStorage.getItem("yc_train_fold") == null && document.body.classList.contains("mobile")) folded = true;
  panelOpen = true;
  const root = el("kl-train-panel");
  if (root) root.hidden = false;
  el("kl-train")?.classList.add("on");
  trainOnSymbol(host.symbol());
  if (!active) {
    const dateEl = el<HTMLInputElement>("kt-start");
    if (dateEl) dateEl.value = host.visibleEnd() || lastDate();
  }
  if (active) host.rerender();
}

function closePanel(): void {
  stopPlay();
  panelOpen = false;
  active = false;
  const root = el("kl-train-panel");
  if (root) root.hidden = true;
  el("kl-train")?.classList.remove("on");
  syncBg();
  host?.rerender();
}

/* ── 训练推进 ── */
function lastDate(): string {
  const bars = host?.bars() ?? [];
  return bars.length ? bars[bars.length - 1].date : "";
}

function begin(date: string): void {
  const h = host;
  if (!h) return;
  const bars = h.bars();
  if (!bars.length) { h.toast("K线还没加载好"); return; }
  if (!date) { h.toast("请输入开始日期"); return; }
  const hit = bars.find((b) => b.date >= date) ?? bars[bars.length - 1];
  if (hit.date !== date) h.toast(`起点对齐到 ${hit.date}`);
  if (hit === bars[bars.length - 1]) h.toast("起点已是最后一根：可以输入更早的日期");
  const sym = h.symbol();
  if (!sym) return;
  sess = {
    start: hit.date, cut: hit.date, trades: [],
    step: sess?.step ?? STEP_DEFAULT,
    capital: Number(el<HTMLInputElement>("kt-cap")?.value) || CAP_DEFAULT,
    posPct: Number(el<HTMLInputElement>("kt-pos-pct")?.value) || POS_DEFAULT,
  };
  curSym = sym;
  active = true;
  priceFor = "";
  h.forceDaily();
  persist();
  sync();
  h.rerender();
}

/** K 线右键「从这根开始训练」：把开始日期设为该根并重建会话（已有交易记录时先确认，避免误清） */
export function trainStartAt(date: string): void {
  const h = host;
  if (!h?.symbol()) { h?.toast("先打开一个标的再训练"); return; }
  if (!panelOpen) openPanel();
  if (active && sess && sess.trades.length &&
    !window.confirm(`从 ${date} 重新开始训练？当前进度与 ${sess.trades.length} 条交易记录会清空`)) return;
  const dateEl = el<HTMLInputElement>("kt-start");
  if (dateEl) dateEl.value = date;
  begin(date);
}

function step(dir: number, quiet: boolean): void {  const h = host;
  if (!h || !sess) return;
  const list = h.periodBars();
  if (!list.length) return;
  const idx = atOrBefore(list, sess.cut);
  const next = idx + dir;
  const floor = Math.max(0, atOrBefore(list, sess.start));
  if (next < floor) { stopPlay(); return; }
  if (next >= list.length) {
    stopPlay();
    if (!quiet) h.toast("已经到最后一根了");
    return;
  }
  const before = reboundNow(sess.cut).pct;
  sess.cut = list[next].date;
  /* 反弹提醒：跨过 8% 提示「逻辑仍成立」，跨过 10% 提示「已被否认」（每段只提醒一次） */
  const after = reboundNow(sess.cut).pct;
  if (after >= 10 && before < 10) h.toast(`反弹 ${after.toFixed(1)}% ≥10%：下跌逻辑已被否认`);
  else if (after >= 8 && before < 8) h.toast(`反弹 ${after.toFixed(1)}%：下跌逻辑仍成立（未破 10%）`);
  persist();
  sync();
  h.rerender();
}

function togglePlay(): void {
  if (playTimer != null) { stopPlay(); return; }
  if (!active) return;
  const btn = el("kt-play");
  if (btn) { btn.classList.add("on"); btn.textContent = "暂停"; }
  playTimer = window.setInterval(() => step(1, true), PLAY_MS);
}

function stopPlay(): void {
  if (playTimer != null) { window.clearInterval(playTimer); playTimer = null; }
  const btn = el("kt-play");
  if (btn) { btn.classList.remove("on"); btn.textContent = "播放"; }
}

function resetSession(): void {
  if (!sess) return;
  if (!window.confirm("重置训练：清空进度与全部买入记录？")) return;
  dropSession();
}

/** 清掉当前会话（不弹确认），回到「选起点」 */
function dropSession(): void {
  stopPlay();
  sess = null;
  active = false;
  priceFor = "";
  if (curSym) writeSession(curSym, null);
  const dateEl = el<HTMLInputElement>("kt-start");
  if (dateEl) dateEl.value = host?.visibleEnd() || lastDate();
  sync();
  host?.rerender();
}

/* ── 结束训练：先问「是否存档」，存档后才能复盘 ── */
let endMask: HTMLElement | null = null;

function closeEndDlg(): void {
  endMask?.remove();
  endMask = null;
}

function endTraining(): void {
  if (!sess) return;
  stopPlay();
  if (!sess.trades.length) {
    if (window.confirm("本次训练还没有交易记录，结束并清空？")) dropSession();
    return;
  }
  closeEndDlg();
  const mask = document.createElement("div");
  mask.className = "kt-mask";
  mask.innerHTML =
    `<div class="kt-box"><b class="kt-box-t">结束训练</b>` +
    `<p>${esc(host?.name() || curSym)} ${sess.start} ~ ${sess.cut}，共 <b>${sess.trades.length}</b> 笔操作。</p>` +
    `<p class="kt-box-sub">存档后可随时翻看每笔买卖并复盘；不存档则本次进度清空。</p>` +
    `<div class="kt-box-btns">` +
    `<button class="cbtn on" data-a="save">存档并结束</button>` +
    `<button class="cbtn" data-a="drop">不存档</button>` +
    `<button class="cbtn" data-a="cancel">继续训练</button>` +
    `</div></div>`;
  mask.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
    if (!act) { if (e.target === mask) closeEndDlg(); return; }
    closeEndDlg();
    if (act === "save") saveArchive();
    else if (act === "drop" && window.confirm("不存档，直接结束并清空本次训练？")) dropSession();
  });
  document.body.appendChild(mask);
  endMask = mask;
}

/** 结束时的账户盈亏（%）：现金 + 持仓按结束那根收盘价 */
function accountPct(s: Session): number {
  const bars = host?.bars() ?? [];
  const bar = [...bars].reverse().find((b) => b.date <= s.cut);
  const equity = cashOf(s) + heldOf(s) * (bar?.close ?? 0);
  return capitalOf(s) > 0 ? (equity / capitalOf(s) - 1) * 100 : 0;
}

function saveArchive(): void {
  if (!sess || !curSym) return;
  const a: TrainArchive = {
    id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    symbol: curSym,
    name: host?.name() || curSym,
    start: sess.start,
    end: sess.cut,
    trades: sess.trades.map((t) => ({ ...t })),
    step: sess.step ?? STEP_DEFAULT,
    capital: capitalOf(sess),
    posPct: posPctOf(sess),
    pnl: accountPct(sess),
    savedAt: Date.now(),
  };
  writeArch([a, ...readArch()]);
  dropSession();
  host?.toast(`已存档 ${a.start} ~ ${a.end} · ${a.trades.length} 笔，可在「存档」里复盘`);
  openArchive();
}

/* ── 存档面板：翻记录 / 复盘 / 改名 / 删除 ── */
let archMask: HTMLElement | null = null;

function closeArchive(): void {
  archMask?.remove();
  archMask = null;
}

function archHtml(a: TrainArchive): string {
  const pct = a.pnl || 0;
  const cls = pct > 0 ? "up" : pct < 0 ? "down" : "";
  const rows = a.trades.length
    ? [...a.trades]
      .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0))
      .map((t) =>
        `<span class="kt-at ${t.side === "sell" ? "sell" : "buy"}">${t.date.slice(5)} ` +
        `${t.side === "sell" ? "卖" : "买"}${px(t.price)}×${fmt(t.qty, 0)}` +
        (t.note ? ` · ${esc(t.note)}` : "") + `</span>`).join("")
    : `<span class="kt-empty">没有交易记录</span>`;
  return `<div class="kt-arch" data-id="${a.id}">
    <div class="kt-arch-t"><b>${esc(a.note || a.name)}</b><i>${a.symbol}</i>
      <em class="${cls}">${pct > 0 ? "+" : ""}${pct.toFixed(2)}%</em></div>
    <div class="kt-arch-d">${a.start} ~ ${a.end} · ${a.trades.length} 笔</div>
    <div class="kt-arch-trades">${rows}</div>
    <div class="kt-arch-btns">
      <button class="cbtn on" data-a="replay">复盘</button>
      <button class="cbtn" data-a="edit">改名/备注</button>
      <button class="cbtn" data-a="del">删除</button>
    </div></div>`;
}

function openArchive(): void {
  closeArchive();
  const list = readArch();
  const mask = document.createElement("div");
  mask.className = "kt-mask";
  mask.innerHTML =
    `<div class="kt-box kt-box-arch">` +
    `<div class="kt-box-h"><b>训练存档</b><button class="kt-x" data-a="close" title="关闭">✕</button></div>` +
    `<div class="kt-arch-list">${list.length ? list.map(archHtml).join("") :
      `<div class="kt-empty">还没有存档：结束训练时选「存档并结束」，之后就能在这里复盘</div>`}</div>` +
    `</div>`;
  mask.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
    if (!act) { if (e.target === mask) closeArchive(); return; }
    if (act === "close") { closeArchive(); return; }
    const id = (e.target as HTMLElement).closest<HTMLElement>(".kt-arch")?.dataset.id;
    const a = readArch().find((x) => x.id === id);
    if (!a) return;
    if (act === "del") {
      if (!window.confirm(`删除存档「${a.note || a.name} ${a.start} ~ ${a.end}」？`)) return;
      writeArch(readArch().filter((x) => x.id !== a.id));
      openArchive();
    } else if (act === "edit") {
      const note = window.prompt("修改名称 / 备注（留空则恢复原名）", a.note || a.name);
      if (note == null) return;
      a.note = note.trim() || undefined;
      writeArch(readArch().map((x) => (x.id === a.id ? a : x)));
      openArchive();
    } else if (act === "replay") {
      const cur = readStore()[a.symbol];
      if (cur?.trades?.length && !window.confirm("该标的还有未结束的训练进度，复盘会覆盖它，继续？")) return;
      closeArchive();
      document.dispatchEvent(new CustomEvent("yc:replay-archive", { detail: { archive: a } }));
    }
  });
  document.body.appendChild(mask);
  archMask = mask;
}

/** 复盘：把存档还原成当前训练会话，从存档起点开始逐根回看（记录只读可看，不影响存档本身） */
export function trainReplay(a: TrainArchive): void {
  const h = host;
  if (!h?.symbol()) { h?.toast("先打开对应标的再复盘"); return; }
  stopPlay();
  curSym = a.symbol;
  sess = {
    start: a.start, cut: a.start,
    trades: a.trades.map((t) => ({ ...t })),
    step: a.step || STEP_DEFAULT,
    capital: a.capital || CAP_DEFAULT,
    posPct: a.posPct || POS_DEFAULT,
  };
  active = true;
  panelOpen = true;
  const root = el("kl-train-panel");
  if (root) root.hidden = false;
  el("kl-train")?.classList.add("on");
  const capEl = el<HTMLInputElement>("kt-cap");
  if (capEl) capEl.value = String(capitalOf(sess));
  const posEl = el<HTMLInputElement>("kt-pos-pct");
  if (posEl) posEl.value = String(posPctOf(sess));
  const dateEl = el<HTMLInputElement>("kt-start");
  if (dateEl) dateEl.value = a.start;
  writeSession(a.symbol, sess);
  h.forceDaily();
  sync();
  h.rerender();
  h.toast(`复盘 ${a.start} ~ ${a.end} · ${a.trades.length} 笔：点「下一根」逐根回看`);
}

function buy(): void {
  const h = host;
  if (!h || !sess) return;
  readFunds();
  const price = Number(el<HTMLInputElement>("kt-price")?.value);
  if (!(price > 0)) { h.toast("价格无效"); return; }
  const amt = Number(el<HTMLInputElement>("kt-amt")?.value) || 0;
  let qty = amt > 0 ? amtQty(price, amt) : autoQty(price, null);
  if (!(qty > 0)) { h.toast("可用资金不足一手"); return; }
  if (price * qty > cashOf(sess) + 0.01) { h.toast("可用现金不足"); return; }
  const noteEl = el<HTMLInputElement>("kt-note");
  sess.trades.push({
    id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    date: sess.cut, price, qty, note: (noteEl?.value || "").trim(), side: "buy",
  });
  if (noteEl) noteEl.value = "";
  persist();
  sync();
  h.rerender();
}

/** 卖出一半持仓：按当前价格成交，回款计入现金 */
function sellHalf(): void {
  const h = host;
  if (!h || !sess) return;
  readFunds();
  const held = heldOf(sess);
  if (held <= 0) { h.toast("当前没有持仓"); return; }
  const price = Number(el<HTMLInputElement>("kt-price")?.value);
  if (!(price > 0)) { h.toast("价格无效"); return; }
  const qty = Math.floor(held / 2);
  if (!(qty > 0)) { h.toast("持仓不足，无法卖出一半"); return; }
  sess.trades.push({
    id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    date: sess.cut, price, qty, note: "卖出一半", side: "sell",
  });
  persist();
  sync();
}

/** 按输入股数卖出；留空则卖一半 */
function sellInput(): void {
  const h = host;
  if (!h || !sess) return;
  readFunds();
  const held = heldOf(sess);
  if (held <= 0) { h.toast("当前没有持仓"); return; }
  const price = Number(el<HTMLInputElement>("kt-price")?.value);
  if (!(price > 0)) { h.toast("价格无效"); return; }
  const typed = typedSellQty();
  const qty = Math.min(held, typed > 0 ? typed : Math.floor(held / 2));
  if (!(qty > 0)) { h.toast("卖出数量为 0"); return; }
  sess.trades.push({
    id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    date: sess.cut, price, qty,
    note: typed > 0 ? "按股数卖出" : "卖出一半",
    side: "sell",
  });
  const sq = el<HTMLInputElement>("kt-sellqty");
  if (sq) sq.value = "";
  persist();
  sync();
}

/** 一键平仓：按当前价格清空全部持仓 */
function closeAll(): void {
  const h = host;
  if (!h || !sess) return;
  readFunds();
  const held = heldOf(sess);
  if (held <= 0) { h.toast("当前没有持仓"); return; }
  const price = Number(el<HTMLInputElement>("kt-price")?.value);
  if (!(price > 0)) { h.toast("价格无效"); return; }
  sess.trades.push({
    id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    date: sess.cut, price, qty: held, note: "一键平仓", side: "sell",
  });
  persist();
  sync();
}

/* ── 面板渲染 ── */
function syncBg(): void {
  const page = document.getElementById("page-market");
  const was = page?.classList.contains("training") ?? false;
  page?.classList.toggle("training", active);
  if (was !== active) host?.relayout();
}

/* 训练起点以来的最大反弹：最低点 → 之后最高价（%）。逐根推进的提醒与面板提示条共用。 */
function reboundNow(cut: string): { pct: number; low: number; high: number } {
  const h = host;
  if (!h || !sess) return { pct: 0, low: 0, high: 0 };
  let low = Infinity, high = 0;
  for (const b of h.bars()) {
    if (b.date < sess.start || b.date > cut) continue;
    if (b.low < low) { low = b.low; high = b.high; }
    else if (b.high > high) high = b.high;
  }
  if (!(low > 0) || high <= 0) return { pct: 0, low: 0, high: 0 };
  return { pct: (high / low - 1) * 100, low, high };
}

function sync(): void {
  const setup = el("kt-setup");
  const run = el("kt-run");
  if (setup) setup.hidden = active;
  if (run) run.hidden = !active;
  applyFold();
  syncBg();
  const status = el("kt-status");
  const h = host;
  if (status) {
    const name = h?.name() || h?.symbol() || "";
    status.textContent = !h?.symbol() ? "" : active ? `${name}` : "选一个起点";
  }
  if (!active || !sess || !h) return;
  const list = h.periodBars();
  const idx = atOrBefore(list, sess.cut);
  const bar = list[Math.max(0, idx)] ?? null;
  const pos = el("kt-pos");
  if (pos) pos.textContent = bar ? `${idx + 1} / ${list.length} 根 · ${PERIOD_LABEL[h.period()] ?? "日K"}` : "—";
  const dateEl = el("kt-date");
  if (dateEl) dateEl.textContent = sess.cut;
  const stepEl = el<HTMLSelectElement>("kt-step");
  if (stepEl) stepEl.value = String(sess.step ?? STEP_DEFAULT);
  /* 进度条：已推进到第几根 */
  const fill = el("kt-fill");
  if (fill) fill.style.width = list.length ? `${(((idx + 1) / list.length) * 100).toFixed(2)}%` : "0%";
  /* 涨跌幅：累计（训练起点 → 当前最低）始终显示；逻辑被否认（重算 / 转跌 / 转涨）
     后追加「阶段」行，跌幅从改写后的新起点重新计算，并给出提示。 */
  const seg = [...trainMarks()].reverse()
    .find((m) => (m.kind === "reset" || m.kind === "flipDown" || m.kind === "flipUp") && m.price != null);
  const cut = sess.cut;
  const highFrom = (from: string): number => {
    let hi = 0;
    for (const b of list) {
      if (b.date < from || b.date > cut) continue;
      if (b.high > hi) hi = b.high;
    }
    return hi;
  };
  const cumHigh = highFrom(sess.start);
  const segHigh = seg ? Math.max(seg.price ?? 0, highFrom(seg.date)) : 0;
  const gapOf = (hi: number): number => (bar && hi > 0 ? (bar.low / hi - 1) * 100 : 0);
  const cumGap = gapOf(cumHigh);
  const segGap = gapOf(segHigh);
  const gap = seg ? segGap : cumGap;
  const dd = el("kt-dd");
  if (dd) {
    const row = (label: string, hi: number, g: number): string =>
      `<div class="kt-dd-r"><span>${label}</span><b>${px(hi)}</b><i>→ ${px(bar?.low ?? 0)}</i>` +
      `<em class="${g < 0 ? "down" : "up"}">${g > 0 ? "+" : ""}${g.toFixed(2)}%</em></div>`;
    /* 反弹提示：训练起点以来最低点 → 之后最高价，≥8% 提醒「逻辑仍成立」，≥10% 提醒「已被否认」 */
    const rb = reboundNow(cut);
    const rbRow = rb.pct >= 8
      ? `<div class="kt-dd-r"><span>反弹</span><b>${px(rb.low)}</b><i>→ ${px(rb.high)}</i>` +
        `<em class="up">+${rb.pct.toFixed(2)}%</em></div>` +
        `<div class="kt-dd-note${rb.pct >= 10 ? " neg" : ""}">${
          rb.pct >= 10 ? "反弹 ≥10% · 下跌逻辑已被否认" : "反弹 ≥8% · 下跌逻辑仍成立（未破 10%）"
        }</div>`
      : "";
    if (!bar || cumHigh <= 0) {
      dd.innerHTML = "";
    } else {
      dd.innerHTML = row("累计", cumHigh, cumGap) +
        (seg ? row("阶段", segHigh, segGap) +
          `<div class="kt-dd-note">逻辑已改写 · 自 ${seg.date.slice(5)} 重新计算</div>` : "") +
        rbRow;
    }
  }
  /* 跌幅阶梯提示：≥20% 建仓10%；20-30 每跌5%加5%；30-35 每跌5%加10%；
     35-40 每跌1%加1%；≥40 单次直接加30%（金额按初始资金折算，受可用现金约束） */
  const hint = el("kt-addhint");
  if (hint) {
    const drop = -gap;
    const cap = capitalOf(sess);
    const cash = cashOf(sess);
    const qtyHeld = heldOf(sess);
    const heldPct = bar && cap ? ((qtyHeld * bar.close) / cap) * 100 : 0;
    let pct = 0, title = "", act = "";
    if (drop >= 40) { pct = 30; title = "跌幅 ≥40% · 单次直接加仓"; act = "直接加"; }
    else if (drop >= 35) { pct = 1; title = "跌幅 35%–40% · 每跌1%加1%"; act = "本次加"; }
    else if (drop >= 30) { pct = 10; title = "跌幅 30%–35% · 每跌5%加10%"; act = "本次加"; }
    else if (drop >= 25) { pct = 5; title = "跌幅 25%–30% · 每跌5%加5%"; act = "本次加"; }
    else if (drop >= 20) { pct = 5; title = "跌幅 20%–25% · 每跌5%加5%"; act = "本次加"; }
    /* 空仓时先按「20% 以上建仓 10%」起步，再按当前档位加仓 */
    if (title && qtyHeld <= 0 && drop >= 20) { act = "建仓"; pct = Math.max(pct, 10); }
    if (!title) {
      hint.hidden = true;
      hint.innerHTML = "";
    } else {
      const need = drop < 25 ? 25 : drop < 30 ? 30 : drop < 35 ? 35 : drop < 40 ? 40 : 0;
      const next = need ? `距下一档 ${need}% 还差 ${(need - drop).toFixed(1)}%` : "已到最高档位";
      const want = (cap * pct) / 100;
      const amt = Math.min(want, cash);
      hint.hidden = false;
      hint.innerHTML =
        `<div class="kt-ah-t">${title}</div>` +
        `<div class="kt-ah-v">${act} <b>${pct}%</b> ≈ <b>${fmt(amt, 0)}</b> 元` +
        (amt < want - 1 ? `<span class="kt-ah-s">（受现金限制）</span>` : "") +
        `</div>` +
        `<div class="kt-ah-s">当前仓位 ${heldPct.toFixed(1)}% · ${next}</div>`;
    }
  }
  const buyDate = el("kt-buy-date");
  if (buyDate) buyDate.textContent = sess.cut.slice(5);
  // 价格默认当前收盘：只在推进到新的K线时重置，避免覆盖手动填的成交价
  const priceEl = el<HTMLInputElement>("kt-price");
  if (priceEl && bar && priceFor !== sess.cut) {
    priceFor = sess.cut;
    priceEl.value = String(bar.close);
  }
  const qtySum = heldOf(sess);
  const buys = liveTrades(sess).filter((t) => t.side !== "sell");
  const buyQty = buys.reduce((s, t) => s + t.qty, 0);
  const cost = buys.reduce((s, t) => s + t.price * t.qty, 0);
  const avg = buyQty ? cost / buyQty : 0;
  const close = bar?.close ?? null;
  const pnl = close != null && qtySum ? (close - avg) * qtySum : 0;
  const pct = close != null && avg ? (close / avg - 1) * 100 : 0;
  const cls = pnl > 0 ? "up" : pnl < 0 ? "down" : "";
  /* 建仓阶梯价：以建仓价（首笔买入）为基准，按刻度自动算出跌一格加仓价 / 涨一格减仓价 */
  const lad = el("kt-lad");
  if (lad) {
    const stepPct = sess.step && sess.step > 0 ? sess.step : STEP_DEFAULT;
    const anchorP = firstTrade()?.price ?? null;
    const baseP = anchorP ?? (close ?? 0);
    if (!(baseP > 0)) {
      lad.innerHTML = "";
    } else {
      const addP = roundP(baseP * (1 - stepPct / 100));
      const cutP = roundP(baseP * (1 + stepPct / 100));
      const wantAmt = Math.min((capitalOf(sess) * posPctOf(sess)) / 100, cashOf(sess));
      const dist = (p: number): string => {
        const c = close ?? 0;
        if (!(c > 0)) return "";
        const d = (p / c - 1) * 100;
        return `距现价 ${d > 0 ? "+" : ""}${d.toFixed(2)}%`;
      };
      const row = (kind: string, label: string, p: number, act: string): string =>
        `<button type="button" class="kt-lad-r ${kind}" data-lad="${p}" title="点击把成交价填为 ${px(p)}">` +
        `<span>${label}</span><b>${px(p)}</b><i>${dist(p)}</i><em>${act}</em></button>`;
      lad.innerHTML =
        row("up", `+${stepPct}% 减仓`, cutP, qtySum > 0 ? `减 ${fmt(Math.floor(qtySum / 2), 0)} 股` : "无持仓") +
        row("base", anchorP ? "建仓价" : "参考价", baseP, qtySum > 0 ? `成本 ${px(avg)}` : "未建仓") +
        row("down", `−${stepPct}% 加仓`, addP, `加 ${fmt(wantAmt, 0)} 元`);
    }
  }
  syncQtyAmt();
  /* 账户盈亏：现金 + 持仓市值（按当前K线收盘价），对比初始资金 */
  const cash = cashOf(sess);
  const cap = capitalOf(sess);
  const equity = cash + qtySum * (close ?? 0);
  const accPct = cap > 0 ? (equity / cap - 1) * 100 : 0;
  /* 已实现盈亏（卖出回款 - 卖出股数按买入均价折算的成本）；累计 = 已实现 + 浮盈。
     减仓后浮盈会变小，但已实现部分留在现金里，累计盈亏不会缩水。 */
  const sells = liveTrades(sess).filter((t) => t.side === "sell");
  const soldQty = sells.reduce((s, t) => s + t.qty, 0);
  const soldAmt = sells.reduce((s, t) => s + t.price * t.qty, 0);
  const realized = soldQty > 0 && buyQty > 0 ? soldAmt - avg * soldQty : 0;
  const totalPnl = realized + pnl;
  const signed = (v: number) => `${v > 0 ? "+" : ""}${fmt(v, 0)}`;
  const dir = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : "");
  /* 状态卡：持仓 / 成本 / 现价 · 浮盈 / 账户 / 可用；底行总资产与累计盈亏 */
  const mini = el("kt-mini");
  if (mini) {
    const cell = (label: string, val: string, c = ""): string =>
      `<div class="kt-cell"><span>${label}</span><b class="${c}">${val}</b></div>`;
    mini.innerHTML =
      cell("持仓", qtySum ? `${fmt(qtySum, 0)} 股` : "—") +
      cell("成本", qtySum ? px(avg) : "—") +
      cell("现价", px(close)) +
      cell("浮盈", qtySum ? `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%` : "—", cls) +
      cell("账户", `${accPct > 0 ? "+" : ""}${accPct.toFixed(2)}%`, dir(accPct)) +
      cell("可用", fmt(cash, 0));
  }
  const acct = el("kt-acct");
  if (acct) {
    acct.innerHTML =
      `<span>总资产 <b>${fmt(equity, 0)}</b></span>` +
      `<span>累计 <b class="${dir(totalPnl)}">${signed(totalPnl)}</b>` +
      `<i>已实现 <b class="${dir(realized)}">${signed(realized)}</b></i></span>`;
  }
  /* 卖出区：以上次买入股数为基准（一半 / 1/4），填入后按股数成交 */
  const lb = lastBuy(sess);
  const ls = lastSell(sess);
  const baseQty = lb?.qty ?? qtySum;
  const halfQty = qtySum > 0 ? Math.min(qtySum, Math.max(1, Math.floor(baseQty / 2))) : 0;
  const qtrQty = qtySum > 0 ? Math.min(qtySum, Math.max(1, Math.floor(baseQty / 4))) : 0;
  const sellHint = el("kt-sellhint");
  if (sellHint) {
    sellHint.textContent = lb
      ? `上次买入 ${fmt(lb.qty, 0)} 股 · 一半 ${fmt(Math.floor(lb.qty / 2), 0)} 股`
      : "";
  }
  const sellChips = el("kt-sell-chips");
  if (sellChips) {
    sellChips.innerHTML =
      `<button type="button" data-q="half"${halfQty <= 0 ? " disabled" : ""}>一半 ${halfQty > 0 ? fmt(halfQty, 0) : ""}</button>` +
      `<button type="button" data-q="quarter"${qtrQty <= 0 ? " disabled" : ""}>1/4 ${qtrQty > 0 ? fmt(qtrQty, 0) : ""}</button>` +
      `<button type="button" data-q="all"${qtySum <= 0 ? " disabled" : ""}>全部 ${qtySum > 0 ? fmt(qtySum, 0) : ""}</button>`;
  }
  /* 买入区：接回上次卖出金额 / 按仓位建仓 / 现金全上 */
  const buildAmt = Math.min((cap * posPctOf(sess)) / 100, cash);
  const backAmt = ls ? Math.round(ls.price * ls.qty) : 0;
  const buyHint = el("kt-buyhint");
  if (buyHint) {
    buyHint.textContent = ls ? `上次卖出 ${fmt(ls.qty, 0)} 股 · ${fmt(backAmt, 0)} 元` : "";
  }
  const amtChips = el("kt-amt-chips");
  if (amtChips) {
    amtChips.innerHTML =
      (backAmt > 0 ? `<button type="button" data-amt="back">接回 ${fmt(backAmt, 0)}</button>` : "") +
      `<button type="button" data-amt="build">建仓 ${posPctOf(sess)}% · ${fmt(buildAmt, 0)}</button>` +
      `<button type="button" data-amt="max">现金 ${fmt(cash, 0)}</button>`;
  }
  /* 账户涨幅 ≥ 5%：提示卖出一半（点提示即执行） */
  const warn = el<HTMLButtonElement>("kt-warn");
  if (warn) {
    const hit = qtySum > 0 && accPct >= SELL_HINT;
    warn.hidden = !hit;
    if (hit) warn.textContent = `账户 +${accPct.toFixed(2)}%（≥${SELL_HINT}%），建议卖出一半 · 点此执行`;
  }
  /* 加减仓提示：本根 K 线触发的档位（与图上标记同源） */
  const sig = el("kt-sig");
  if (sig) {
    const cut = sess.cut;
    const mk = [...trainMarks()].reverse().find((m) => m.date === cut);
    sig.className = mk ? `kt-sig on ${mk.kind}` : "kt-sig";
    sig.textContent = mk ? `本根：${mk.text.replace(/\n/g, " · ")}${mk.sub ? ` · ${mk.sub}` : ""}` : "";
  }
  /* 持仓浮盈 ≥ 10%：提示一键清仓（点提示即执行） */
  const warn2 = el<HTMLButtonElement>("kt-warn2");
  if (warn2) {
    const hit = qtySum > 0 && pct >= CLOSE_HINT;
    warn2.hidden = !hit;
    if (hit) warn2.textContent = `持仓 +${pct.toFixed(2)}%（≥${CLOSE_HINT}%），建议一键清仓 · 点此执行`;
  }
  const sellBtn = el<HTMLButtonElement>("kt-sell");
  if (sellBtn) sellBtn.disabled = qtySum <= 0;
  const sellInBtn = el<HTMLButtonElement>("kt-sellin");
  if (sellInBtn) sellInBtn.disabled = qtySum <= 0;
  const closeBtn = el<HTMLButtonElement>("kt-close");
  if (closeBtn) closeBtn.disabled = qtySum <= 0;
  /* 交易记录：只显示最近 2 笔，更多点「全部记录」展开 */
  const listEl = el("kt-list");
  if (listEl) {
    const rows = [...sess.trades].reverse();
    const shown = logOpen ? rows : rows.slice(0, 2);
    listEl.innerHTML = rows.length
      ? shown.map((t) =>
        `<div class="kt-tr"><span class="kt-td">${t.date.slice(5)}</span>` +
        `<span class="kt-side ${t.side === "sell" ? "sell" : "buy"}">${t.side === "sell" ? "卖" : "买"}</span>` +
        `<b>${px(t.price)}</b><span>×${fmt(t.qty, 0)}</span>` +
        (t.note ? `<i>${esc(t.note)}</i>` : "") +
        `<span class="kt-ta">${fmt(t.price * t.qty, 0)}</span>` +
        `<button class="kt-del" data-kt-del="${t.id}" title="删除这条记录">×</button></div>`).join("") +
        (rows.length > 2
          ? `<button type="button" class="kt-more" data-kt-more="1">${
            logOpen ? "收起记录 ‹" : `共 ${rows.length} 笔 · 全部记录 ›`}</button>`
          : "")
      : `<div class="kt-empty">还没有交易记录</div>`;
  }
}

/* ── K 线加减仓标记（低频主动量化：以当前下跌逻辑的起点为基准，跌一格标加、涨一格标减） ── */
export interface TrainChartMark {
  date: string;
  kind: "build" | "add" | "cut" | "reset" | "flipUp" | "flipDown" | "rebound" | "reboundNeg";
  text: string;
  /** 起点被改写（重算 / 转涨 / 转跌）后的新起点价，跌幅从这里重新算 */
  price?: number;
  /** 实际成交标记：buy = 建仓/加仓（标在K线下方），sell = 减仓（标在上方） */
  tag?: "buy" | "sell";
  /** 标记第二行（如该笔对应的加仓价） */
  sub?: string;
}

/** 建仓价：最早一条买入记录的成交价 */
function firstTrade(): Trade | null {
  const buys = sess?.trades.filter((t) => t.side !== "sell") ?? [];
  if (!buys.length) return null;
  return buys.reduce((a, b) => (b.date < a.date ? b : a));
}

export function trainAnchor(): number | null {
  return active ? (firstTrade()?.price ?? null) : null;
}

/** 上涨/下跌段确认幅度：低点 → 高点（或高点 → 低点）≥ 该值（%）。
 *  成立后若转向，起点改为该极值；收盘突破起点则视为原逻辑被否认，起点改为本段另一端极值。 */
const SWING_CONFIRM = 10;

/** 逐根推演交易逻辑：
 *  · 建仓后先以建仓价为基准，跌一格标「加X%」、涨一格标「减X%」；
 *  · 出现 ≥10% 的上涨段并转跌后，起点切到该高点，进入「下跌逻辑」；
 *  · 下跌逻辑中收盘重新站上起点 → 逻辑被否认，起点改为本段最低点（转涨），涨一格标「减X%」；
 *  · 上涨逻辑中收盘跌破起点 → 逻辑被否认，起点改为本段最高点（转跌），跌一格标「加X%」；
 *  · 任一逻辑中反向走满 10% 且转向，同样把起点改到该极值（重算）。 */
export function trainMarks(): TrainChartMark[] {
  const h = host;
  if (!active || !sess || !h) return [];
  const cut = sess.cut;
  /* 反弹监测（以训练起点为准，未建仓也标）：起点以来最低点 → 之后最高价。
     ≥8% 标「反弹」（下跌逻辑仍成立），≥10% 标「否认」（反弹过强）；创新低后重新起算。 */
  const rebound: TrainChartMark[] = [];
  let rbLow = Infinity, rbHigh = 0, rb8 = false, rb10 = false;
  for (const b of h.bars()) {
    if (b.date < sess.start || b.date > cut) continue;
    if (b.low < rbLow) { rbLow = b.low; rbHigh = b.high; rb8 = false; rb10 = false; }
    else if (b.high > rbHigh) rbHigh = b.high;
    if (!(rbLow > 0) || rbHigh <= 0) continue;
    const rb = (rbHigh / rbLow - 1) * 100;
    if (rb >= 10 && !rb10) {
      rebound.push({ date: b.date, kind: "reboundNeg", text: `反弹 +${rb.toFixed(1)}%`, sub: "下跌逻辑被否认" });
      rb10 = true; rb8 = true;
    } else if (rb >= 8 && !rb8) {
      rebound.push({ date: b.date, kind: "rebound", text: `反弹 +${rb.toFixed(1)}%`, sub: "下跌逻辑仍成立" });
      rb8 = true;
    }
  }
  const first = firstTrade();
  if (!first) return rebound;
  const step = sess.step && sess.step > 0 ? sess.step : STEP_DEFAULT;
  const bars = h.bars().filter((b) => b.date >= first.date && b.date <= cut);
  const out: TrainChartMark[] = [...rebound, { date: first.date, kind: "build", text: "建仓" }];
  /** 枢轴之后到当前根之间的极值 → [价格, 日期]：
      起点/终点必须落在同一根 K 线（高点既是上涨终点，也是下跌起点）。 */
  const extremeAfter = (from: string, upto: number, kind: "high" | "low"): [number, string] => {
    let p = kind === "high" ? -Infinity : Infinity;
    let d = bars[upto].date;
    for (let j = upto; j >= 0 && bars[j].date > from; j--) {
      const v = kind === "high" ? bars[j].high : bars[j].low;
      if (kind === "high" ? v > p : v < p) { p = v; d = bars[j].date; }
    }
    return [p, d];
  };
  const conf = SWING_CONFIRM / 100;
  let anchor = first.price;                 // 阶段一基准：建仓价
  let addLv = 1, cutLv = 1;
  let swingLow = first.price;               // 本轮最低点（用于确认上涨段）
  let peak: number | null = null;           // 已确认的上涨高点，等下一根转跌后切换起点
  let peakDate = "";
  let prevClose = first.price;
  let switched = false;                     // 是否已进入「按逻辑起点」推演
  let dir: "down" | "up" = "down";
  let start = first.price;                  // 当前逻辑起点
  let lo = first.price, hi = first.price;   // 本段极值
  let loDate = first.date, hiDate = first.date;   // 极值所在 K 线（标记落点）
  for (let bi = 0; bi < bars.length; bi++) {
    const b = bars[bi];
    if (b.date === first.date) {
      swingLow = Math.min(swingLow, b.low);
      lo = Math.min(lo, b.low); hi = Math.max(hi, b.high);
      loDate = hiDate = b.date;
      prevClose = b.close;
      continue;
    }
    const loPrev = lo, hiPrev = hi;
    const loDatePrev = loDate, hiDatePrev = hiDate;
    if (b.low < lo) { lo = b.low; loDate = b.date; }
    if (b.high > hi) { hi = b.high; hiDate = b.date; }
    const down = b.close < prevClose, up = b.close > prevClose;

    if (!switched) {
      /* 阶段一：建仓价基准的双向档位 */
      if (peak == null) {
        // 用本根之前的最低点测量：低点在高点之前，才算一段「低点 → 高点」的上涨
        if (b.high / swingLow - 1 >= conf) { peak = b.high; peakDate = b.date; }
        swingLow = Math.min(swingLow, b.low);
      } else if (b.high > peak && b.close >= prevClose) {
        peak = b.high;
        peakDate = b.date;
      }
      if (peak != null && b.date > peakDate && down) {
        // 标记落回高点那根：上一波上涨的终点与下跌逻辑的起点是同一个点
        out.push({ date: peakDate, kind: "reset", text: `重算 ${px(peak)}`, price: peak });
        switched = true;
        dir = "down"; start = peak;
        hi = start; hiDate = peakDate;
        const [nl, nd] = extremeAfter(peakDate, bi, "low");
        if (nl < b.low) { lo = nl; loDate = nd; } else { lo = b.low; loDate = b.date; }
        addLv = 1; cutLv = 1;
        peak = null;
      } else if (b.close <= anchor * (1 - addLv * step / 100)) {
        out.push({ date: b.date, kind: "add", text: `加${addLv * step}%` });
        addLv++;
      } else if (b.close >= anchor * (1 + cutLv * step / 100)) {
        out.push({ date: b.date, kind: "cut", text: `减${cutLv * step}%` });
        cutLv++;
      }
      prevClose = b.close;
      continue;
    }

    if (dir === "down") {
      if (b.close > start) {                       // 下跌逻辑被否认 → 起点改为本段最低点（同一根）
        out.push({ date: loDate, kind: "flipUp", text: `转涨 ${px(lo)}`, price: lo });
        dir = "up"; start = lo;
        const [nh, nd] = extremeAfter(loDate, bi, "high");
        if (nh > b.high) { hi = nh; hiDate = nd; } else { hi = b.high; hiDate = b.date; }
        addLv = 1; cutLv = 1;
      } else {
        if (hiPrev > start && hiPrev / loPrev - 1 >= conf && down) {
          // 强反弹后转跌：反弹高点就是新的下跌起点（标记落回高点那根）
          out.push({ date: hiDatePrev, kind: "reset", text: `重算 ${px(hiPrev)}`, price: hiPrev });
          start = hiPrev; hi = start; hiDate = hiDatePrev;
          const [nl, nd] = extremeAfter(hiDatePrev, bi, "low");
          if (nl < b.low) { lo = nl; loDate = nd; } else { lo = b.low; loDate = b.date; }
          addLv = 1; cutLv = 1;
        }
        if (b.close <= start * (1 - addLv * step / 100)) {
          out.push({ date: b.date, kind: "add", text: `加${addLv * step}%` });
          addLv++;
        }
      }
    } else {
      if (b.close < start) {                       // 上涨逻辑被否认 → 起点改为本段最高点（同一根）
        out.push({ date: hiDate, kind: "flipDown", text: `转跌 ${px(hi)}`, price: hi });
        dir = "down"; start = hi;
        const [nl, nd] = extremeAfter(hiDate, bi, "low");
        if (nl < b.low) { lo = nl; loDate = nd; } else { lo = b.low; loDate = b.date; }
        addLv = 1; cutLv = 1;
      } else {
        if (loPrev < start && 1 - loPrev / hiPrev >= conf && up) {
          // 强回落转涨：回落低点就是新的上涨起点（标记落回低点那根）
          out.push({ date: loDatePrev, kind: "reset", text: `重算 ${px(loPrev)}`, price: loPrev });
          start = loPrev; lo = start; loDate = loDatePrev;
          const [nh, nd] = extremeAfter(loDatePrev, bi, "high");
          if (nh > b.high) { hi = nh; hiDate = nd; } else { hi = b.high; hiDate = b.date; }
          addLv = 1; cutLv = 1;
        }
        if (b.close >= start * (1 + cutLv * step / 100)) {
          out.push({ date: b.date, kind: "cut", text: `减${cutLv * step}%` });
          cutLv++;
        }
      }
    }
    prevClose = b.close;
  }
  /* 实际成交标记（优先于策略信号覆盖同一根）：每笔建仓/加仓/减仓都编号标出成交价，
     买入另标该笔对应的下一档加仓价；卖出标成「第N次减仓」。 */
  let bn = 0, sn = 0;
  for (const t of liveTrades(sess)) {
    if (t.side === "sell") {
      sn++;
      out.push({ date: t.date, kind: "cut", text: `第${sn}次减仓 ${px(t.price)}`, tag: "sell" });
    } else {
      bn++;
      const addP = roundP(t.price * (1 - step / 100));
      out.push({
        date: t.date,
        kind: bn === 1 ? "build" : "add",
        text: `第${bn}次${bn === 1 ? "建仓" : "加仓"} ${px(t.price)}`,
        price: t.price,
        tag: "buy",
        sub: `加仓价 ${px(addP)}`,
      });
    }
  }
  // 稳定排序：同一根里策略信号在前、成交标记在后，绘制时成交标记覆盖
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}
