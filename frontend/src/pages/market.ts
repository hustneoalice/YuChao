/* 行情页：个股头 + klinecharts K线 + 右列功能卡 */
import { marketApi, type Bar, type IndexQuote, type Quote } from "../api";
import { cssv, esc, fmt, fmtChg, fmtYi } from "../fmt";
import { sma, bollSeries, kdjSeries, atrSeries, sixSegment } from "../indicators";
import { ic } from "../icons";
import { CARD_DEFS, addWatch, getState, isWatched, notifyLocal, setCardPref, subscribe } from "../store";
import { openModal, toast } from "../ui";
import { openWatchPanel } from "../watch";
import { TRENDS, mountKline, setTrendPalette, trendPaletteKey, type KlineChartHandle, type MainKey, type SubKey } from "./kline";

export const SEG6 = ["超卖", "低位", "弱势", "回升", "强势", "超买"];
export const SEGNAME = ["", "超卖", "低位", "弱势", "回升", "强势", "超买"];

export interface CurStock { symbol: string; name: string }
/** 多周期布局：single 单屏 / h 左右双列 / v 上下两层 / quad 四宫格（策影同款） */
export type KLayout = "single" | "h" | "v" | "quad";
type PKey = "t" | "60" | "d" | "w" | "m" | "q";

const P_LABEL: Record<PKey, string> = { t: "分时", "60": "60分", d: "日", w: "周", m: "月", q: "季" };
/** 各布局的面板周期槽位（默认：左右/上下=日+周，四宫格=日周月季） */
const LAYOUT_PANELS: Record<KLayout, PKey[]> = {
  single: ["d"], h: ["d", "w"], v: ["d", "w"], quad: ["d", "w", "m", "q"],
};
/** 副图仅左右布局保留（上下/四宫格格子里只显主图，塞副图太挤） */
const SUB_OK: Record<KLayout, boolean[]> = {
  single: [true], h: [true, true], v: [false, false], quad: [false, false, false, false],
};

export const mk = {
  cur: null as CurStock | null,
  bars: [] as Bar[],
  quote: null as Quote | null,
  layout: (localStorage.getItem("yc_klayout") as KLayout) || "single",
  panels: ["d"] as PKey[],   // 每个面板的周期（按 LAYOUT_PANELS 槽位）
  active: 0,                 // 焦点面板（chartbar 周期段/观察档作用于它）
  mainInds: ["ma", "short", "mid"] as MainKey[], // 默认趋势预设：MA + 短/中线趋势
  subInds: ["vol", "macd"] as SubKey[],  // 副图多选，每指标一个窗格
  minuteData: null as { date: string; prevClose: number | null; bars: Bar[] } | null,
  m60: null as Bar[] | null, // 60 分钟K（腾讯实时拉取，不落库）
  from: null as { page: string; label: string } | null,
};
if (!LAYOUT_PANELS[mk.layout]) mk.layout = "single";
mk.panels = [...LAYOUT_PANELS[mk.layout]];

/* K线偏好持久化（F04：本地 + sync.ts 云同步）——主/副图指标集合 */
const KMAIN_OK: MainKey[] = ["ma", "boll", "short", "mid", "avg"];
const KSUB_OK: SubKey[] = ["vol", "macd", "kdj", "rsi", "obv"];
function readInds<T extends string>(key: string, ok: T[], fb: T[]): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "") as unknown;
    if (Array.isArray(v)) {
      const f = v.filter((x): x is T => typeof x === "string" && ok.includes(x as T));
      if (v.length === 0 || f.length) return f;   // 空数组合法（极简预设）
    }
  } catch { /* 忽略坏值 */ }
  return fb;
}
mk.mainInds = readInds("yc_kmain", KMAIN_OK, mk.mainInds);
mk.subInds = readInds("yc_ksub", KSUB_OK, mk.subInds);

function saveKPrefs(): void {
  localStorage.setItem("yc_kmain", JSON.stringify(mk.mainInds));
  localStorage.setItem("yc_ksub", JSON.stringify(mk.subInds));
  notifyLocal("prefs");
}

/* ── 载入 ── */
export async function openStock(s: CurStock, from?: { page: string; label: string } | null): Promise<void> {
  mk.cur = s;
  mk.from = from ?? null;
  localStorage.setItem("yc_last_symbol", `${s.symbol}|${s.name}`);
  renderBackbar();
  updateWatchBtn();
  document.dispatchEvent(new CustomEvent("yc:goto-page", { detail: "market" }));
  // K线先渲染不等 quote（实时快照慢/被掐时不再拖住首屏），
  // quote 到达后单独刷新右列（基本信息卡/资金流/估值等）
  try {
    const k = await marketApi.kline({ symbol: s.symbol, limit: 2000 });
    if (mk.cur?.symbol !== s.symbol) return;   // 用户已切到别的标的，丢弃过期回包
    mk.bars = k.bars;
    mk.quote = null;
    mk.minuteData = null;                      // 换标的：分时/60分缓存作废，切到时重拉
    mk.m60 = null;
    renderKline();
    renderRight();
    showBriefing();
  } catch (e) {
    toast((e as Error).message || "K线加载失败");
    return;
  }
  try {
    const q = await marketApi.quote(s.symbol);
    if (mk.cur?.symbol !== s.symbol || !q) return;
    mk.quote = q;
    renderRight();
  } catch { /* 实时兜底失败：保持日线数据展示 */ }
  startPoll();
}

/* ── 盘中轮询（策影 WebSocket「原地更新最后一根」的轮询版）：
   12s 拉 quote → 右列刷新 + K 线末根局部更新（不重拉全量序列）。
   后端 kline 已合并今日 bar（守卫 _merge_live_bar），这里只负责盘中跳动；
   行情日 < 末根日（盘前昨收快照）时不动 K 线，与策影 _quote_is_today 同思路。 ── */
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollBusy = false;

function stopPoll(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollTick(): Promise<void> {
  if (pollBusy || document.hidden || !mk.cur) return;
  const s = mk.cur;
  pollBusy = true;
  try {
    const q = await marketApi.quote(s.symbol);
    if (mk.cur?.symbol !== s.symbol || !q) return;
    mk.quote = q;
    renderRight();
    // 分时/60分面板：今日浮根只属于日线序列，分钟周期不合并（右列刷新即可）
    if (mk.panels[mk.active] === "t" || mk.panels[mk.active] === "60") return;
    const rtDate = (q.rt_time || q.date || "").slice(0, 10);
    if (!q.rt_price || !rtDate || !mk.bars.length) return;
    const last = mk.bars[mk.bars.length - 1];
    const lastDate = last.date.slice(0, 10);
    if (rtDate > lastDate) {
      // quote 先于 kline 到位：直接补今日浮根（字段为 quote 合并后的实时段）
      mk.bars.push({
        date: rtDate,
        open: q.open ?? last.close,
        high: q.high ?? q.rt_price,
        low: q.low ?? q.rt_price,
        close: q.rt_price,
        volume: q.volume ?? null, amount: q.amount ?? null,
      });
      renderKline();
    } else if (rtDate === lastDate) {
      last.close = q.rt_price;
      last.high = Math.max(last.high, q.rt_price);
      last.low = Math.min(last.low, q.rt_price);
      if (q.open) last.open = q.open;
      if (q.volume != null) last.volume = q.volume;
      if (q.amount != null) last.amount = q.amount;
      renderKline();
    }
  } catch { /* 实时兜底失败：静默降级 */ } finally {
    pollBusy = false;
  }
}

function startPoll(): void {
  stopPoll();
  pollTimer = setInterval(pollTick, 12000);
}

/* ── K线下方资讯/研报面板（东财直连，后端 TTL 缓存；会话内按 symbol+tab 缓存） ── */
type BriefTab = "news" | "reports" | "indrep";
let briefTab: BriefTab = "news";
const briefCache = new Map<string, string>(); // key → 渲染好的 HTML

function briefKey(sym: string, t: BriefTab): string {
  return `${sym}|${t}`;
}

function showBriefing(): void {
  const s = mk.cur!;
  const panel = document.getElementById("brief-panel")!;
  panel.hidden = false;
  briefCache.clear();
  drawBrief("加载中…");
  void loadBrief(s.symbol, briefTab);
  // 600ms 后预取另两个 tab（策影同款：错开 K 线首屏，切 tab 零等待）
  window.setTimeout(() => {
    if (mk.cur?.symbol !== s.symbol) return;
    for (const t of ["news", "reports", "indrep"] as BriefTab[]) {
      if (t !== briefTab && !briefCache.has(briefKey(s.symbol, t))) void loadBrief(s.symbol, t);
    }
  }, 600);
}

async function loadBrief(sym: string, t: BriefTab): Promise<void> {
  try {
    const html = t === "news" ? await briefNews(sym)
      : t === "reports" ? await briefReports(sym)
      : await briefIndrep(sym);
    if (mk.cur?.symbol !== sym) return; // 已切股
    briefCache.set(briefKey(sym, t), html);
    if (t === briefTab) drawBrief(html);
  } catch {
    if (t === briefTab) drawBrief(`<div class="bempty">加载失败，稍后重试</div>`);
  }
}

function drawBrief(html: string): void {
  document.getElementById("brief-body")!.innerHTML = html;
}

const briefNews = async (sym: string): Promise<string> => {
  const { items } = await marketApi.news(sym);
  if (!items.length) return `<div class="bempty">暂无相关资讯</div>`;
  return items.map((n) =>
    `<a class="bitem" href="${n.url}" target="_blank" rel="noopener">` +
    `<div class="bt">${n.title || n.summary}</div>` +
    `<div class="bm"><span>${n.source || "未知来源"}</span><i>·</i><span class="num">${n.time}</span></div></a>`
  ).join("");
};

const briefReports = async (sym: string): Promise<string> => {
  const { items } = await marketApi.reports(sym);
  return renderReportList(items);
};

const briefIndrep = async (sym: string): Promise<string> => {
  const r = await marketApi.industryReports(sym);
  if (!r.industry) return `<div class="bempty">暂无行业归属信息</div>`;
  if (r.skipped) return `<div class="bempty">${r.industry} · 近期暂无收录的行业研报</div>`;
  return `<div class="bsec">${r.industry} · 近 1 年研报</div>` + renderReportList(r.items);
};

function renderReportList(items: { date: string; org: string; rating: string; title: string; url: string }[]): string {
  if (!items.length) return `<div class="bempty">近 1 年暂无研报</div>`;
  return items.map((r) =>
    `<a class="bitem" href="${r.url}" target="_blank" rel="noopener">` +
    `<div class="bt">${r.title}</div>` +
    `<div class="bm"><span class="tag acc">${r.org || "未知机构"}</span>` +
    (r.rating ? `<span class="tag up">${r.rating}</span>` : "") +
    `<span class="num" style="margin-left:auto">${r.date}</span></div></a>`
  ).join("");
}

export function refreshCur(): void {
  if (mk.cur && document.getElementById("page-market")!.classList.contains("on")) void openStock(mk.cur, mk.from);
}

function renderBackbar(): void {
  const b = document.getElementById("btn-back") as HTMLElement;
  if (mk.from) { b.hidden = false; document.getElementById("back-label")!.textContent = mk.from.label; }
  else b.hidden = true;
}

/* ── 工具栏加自选按钮：未自选一键入「默认」组；已自选点击打开分组管理面板 ── */
function updateWatchBtn(): void {
  const b = document.getElementById("kl-watch");
  const t = document.getElementById("kl-watch-t");
  if (!b || !t) return;
  const on = mk.cur ? isWatched(mk.cur.symbol) : false;
  b.classList.toggle("on", on);
  t.textContent = on ? "已自选" : "加自选";
}

export function initMarket(): void {
  initRcolResize();
  initLayoutSeg();
  // 加自选：一键入默认组；已自选 → 分组管理面板（换分组 / 新建 / 移除）
  document.getElementById("kl-watch")!.addEventListener("click", () => {
    const s = mk.cur;
    if (!s) return;
    if (!isWatched(s.symbol)) {
      addWatch(s.symbol, s.name, "默认");
      toast("已加入自选 · 默认（再次点击可改分组）");
    } else openWatchPanel(s.symbol, s.name);
  });
  subscribe(updateWatchBtn);   // 自选增删/分组变更（含云同步回放）→ 按钮态同步
  // 实时价轮询：行情页可见时每 20s 静默刷新当前股 quote（后端 10s 缓存兜东财限流）
  window.setInterval(async () => {
    if (!mk.cur || !document.getElementById("page-market")!.classList.contains("on")) return;
    try {
      const q = await marketApi.quote(mk.cur.symbol);
      if (mk.cur?.symbol !== q.symbol) return;
      mk.quote = q;
      renderRight();
    } catch { /* 静默，下轮再试 */ }
  }, 20000);
  // 资讯/研报 tab 切换（点击已选 tab 不重复请求，走缓存）
  document.getElementById("brief-panel")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-bt]");
    if (!b) return;
    briefTab = b.dataset.bt as BriefTab;
    document.querySelectorAll("#brief-panel .brief-tabs button").forEach((x) =>
      x.classList.toggle("on", x === b));
    const sym = mk.cur?.symbol;
    if (sym && briefCache.has(briefKey(sym, briefTab))) drawBrief(briefCache.get(briefKey(sym, briefTab))!);
    else if (sym) { drawBrief("加载中…"); void loadBrief(sym, briefTab); }
  });
  document.getElementById("btn-back")!.addEventListener("click", () => {
    if (!mk.from) return;
    document.dispatchEvent(new CustomEvent("yc:goto-page", { detail: mk.from.page }));
    mk.from = null;
    renderBackbar();
  });
  document.getElementById("kl-period")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (!b) return;
    // 周期只重聚合不重拉数据：作用于焦点面板（多周期时各面板头也可单独切）
    toggleSeg("kl-period", b);
    setPanelPeriod(mk.active, b.dataset.p as PKey);
  });
  // 布局切换：单屏 / 左右 / 上下 / 四宫格（上下、四宫格只显主图，左右可带副图）
  document.getElementById("kl-layout")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-ly]");
    if (!b) return;
    mk.layout = b.dataset.ly as KLayout;
    localStorage.setItem("yc_klayout", mk.layout);
    notifyLocal("prefs");
    toggleSeg("kl-layout", b);
    mk.active = 0;
    mk.panels = [...LAYOUT_PANELS[mk.layout]];
    renderKline();
    syncPeriodSeg(mk.panels[0]);
  });
  // 面板交互：点选焦点 / 面板头周期菜单开合 / 菜单内切周期
  document.getElementById("kl-panels")!.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const klp = t.closest<HTMLElement>(".klp");
    if (!klp) return;
    const i = Number(klp.dataset.pi);
    if (t.closest(".klp-p")) { klp.classList.toggle("pmenu-open"); return; }
    const pp = t.closest<HTMLElement>("button[data-pp]");
    if (pp) {
      klp.classList.remove("pmenu-open");
      setPanelPeriod(i, pp.dataset.pp as PKey);
      return;
    }
    if (i !== mk.active) {
      mk.active = i;
      document.querySelectorAll("#kl-panels .klp").forEach((x) =>
        x.classList.toggle("active", x === klp));
      syncPeriodSeg(mk.panels[i]);
    }
  });
  // 指数 ticker：初始 + 30s 轮询；点击跳转该指数K线
  void loadTicker();
  window.setInterval(() => void loadTicker(), 30000);
  document.getElementById("tickerbar")!.addEventListener("click", (e) => {
    const it = (e.target as HTMLElement).closest<HTMLElement>(".tk-item");
    if (!it) return;
    void openStock({ symbol: it.dataset.sym!, name: it.dataset.name || it.dataset.sym! });
  });
  document.getElementById("kl-main-ind")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (b) { // 多选 toggle：主图指标可任意叠加
      b.classList.toggle("on");
      mk.mainInds = [...document.querySelectorAll<HTMLElement>("#kl-main-ind button.on")]
        .map((x) => x.dataset.mi as MainKey);
      saveKPrefs();
      syncIndUI();
      renderKline();
    }
  });
  document.getElementById("kl-sub-ind")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (b) { // 多选 toggle：副图每指标一个窗格
      b.classList.toggle("on");
      mk.subInds = [...document.querySelectorAll<HTMLElement>("#kl-sub-ind button.on")]
        .map((x) => x.dataset.si as SubKey);
      saveKPrefs();
      syncIndUI();
      renderKline();
    }
  });
  // 观察档位 / 缩放 / 重置（策影工具条同款：纯视图操作，不重载数据）
  document.getElementById("kl-view")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (!b) return;
    const n = Number(b.dataset.v);
    toggleSeg("kl-view", b);
    activeKl()?.viewBars(n);
  });
  document.getElementById("kl-zin")!.addEventListener("click", () => activeKl()?.zoom(1.25));
  document.getElementById("kl-zout")!.addEventListener("click", () => activeKl()?.zoom(0.8));
  document.getElementById("kl-vreset")!.addEventListener("click", () => {
    document.querySelectorAll("#kl-view button").forEach((x) => x.classList.remove("on"));
    activeKl()?.resetView();
  });
  // 智能高度开关（策影同款）：主图/副图 3.6:1 自适应分配，持久化 + 云同步
  const autoBtn = document.getElementById("kl-auto")!;
  if (localStorage.getItem("yc_autoh") === "0") autoBtn.classList.remove("on");
  autoBtn.addEventListener("click", () => {
    const on = !autoBtn.classList.contains("on");
    autoBtn.classList.toggle("on", on);
    localStorage.setItem("yc_autoh", on ? "1" : "0");
    kls.forEach((k) => k?.applyHeights());
    notifyLocal("prefs");
  });
  // 指标管理面板：开关 + 分组多选（与 chartbar seg 同源互通）+ 预设方案
  const ipanel = document.getElementById("kl-ipanel")!;
  document.getElementById("kl-ipanel-btn")!.addEventListener("click", (e) => {
    e.stopPropagation();
    ipanel.hidden = !ipanel.hidden;
    if (!ipanel.hidden) {                  // 弹在「指标」按钮正下方（右对齐）
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      ipanel.style.top = `${r.bottom + 6}px`;
      ipanel.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
      ipanel.style.left = "auto";
    }
  });
  document.addEventListener("click", (e) => {
    if (!ipanel.hidden && !(e.target as HTMLElement).closest("#kl-ipanel,#kl-ipanel-btn")) ipanel.hidden = true;
  });
  ipanel.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (!b) return;
    if (b.dataset.pre) {                                   // 预设：标准 / 趋势 / 极简
      const pre: Record<string, { m: MainKey[]; s: SubKey[] }> = {
        default: { m: ["ma"], s: ["vol", "macd"] },
        trend: { m: ["ma", "short", "mid"], s: ["vol"] },
        bare: { m: [], s: ["vol"] },
      };
      const p = pre[b.dataset.pre];
      mk.mainInds = [...p.m]; mk.subInds = [...p.s];
      saveKPrefs();
      syncIndUI();
      renderKline();
      return;
    }
    if (b.dataset.tpl) {                                   // 趋势通道配色 A/B/C/D
      setTrendPalette(b.dataset.tpl);
      syncIndUI();
      renderKline();
      notifyLocal("prefs");
      return;
    }
    const group = b.dataset.mi ? "main" : "sub";
    b.classList.toggle("on");
    if (group === "main")
      mk.mainInds = [...ipanel.querySelectorAll<HTMLElement>(".iprow button[data-mi].on")].map((x) => x.dataset.mi as MainKey);
    else
      mk.subInds = [...ipanel.querySelectorAll<HTMLElement>(".iprow button[data-si].on")].map((x) => x.dataset.si as SubKey);
    saveKPrefs();
    syncIndUI();
    renderKline();
  });
  window.addEventListener("resize", () => {
    clearTimeout((window as unknown as { _rz?: number })._rz);
    (window as unknown as { _rz?: number })._rz = window.setTimeout(() => {
      if (document.getElementById("page-market")!.classList.contains("on")) klResize();
    }, 160);
  });
  // 主题 / 涨跌方向 / 强调色变化 → 各面板图表重上色；右列卡重渲染；
  // 登录态变化 → applyRcolW 按 new user 记忆重放卡片栏宽度
  subscribe(() => {
    kls.forEach((k) => k?.retheme());
    kls.forEach((k) => k?.drawLegend(mk.mainInds));
    applyRcolW();
    renderRight();
  });
  // 云设置回放（sync.ts applyPrefs 触发）：layout/指标从 localStorage 重读热应用
  document.addEventListener("yc:kprefs", () => {
    const l = localStorage.getItem("yc_klayout") as KLayout | null;
    if (l && LAYOUT_PANELS[l] && l !== mk.layout) {
      mk.layout = l;
      mk.panels = [...LAYOUT_PANELS[l]];
      initLayoutSeg();
      mk.active = 0;
      renderKline();
      syncPeriodSeg(mk.panels[0]);
    }
    mk.mainInds = readInds("yc_kmain", KMAIN_OK, mk.mainInds);
    mk.subInds = readInds("yc_ksub", KSUB_OK, mk.subInds);
    syncIndUI();
    renderKline();
  });
}

/** 布局段按持久化状态点亮（boot 时 seg 默认 on 在单屏） */
function initLayoutSeg(): void {
  document.querySelectorAll<HTMLElement>("#kl-layout button").forEach((b) =>
    b.classList.toggle("on", b.dataset.ly === mk.layout));
}

/* ── 指数 ticker 滚动条（策影同款 marquee：30px/s 匀速，悬停暂停，点击跳转K线） ── */
let tkOffset = 0, tkPaused = false;

async function loadTicker(): Promise<void> {
  const track = document.getElementById("tk-track")!;
  let r: { items: IndexQuote[]; total_amount?: number };
  try {
    r = await marketApi.indices();
  } catch { return; }
  const items = r.items ?? [];
  if (!items.length) {
    track.innerHTML = `<span class="tk-empty">指数行情暂不可用</span>`;
    return;
  }
  const item = (i: IndexQuote) => {
    const up = (i.pct ?? 0) >= 0, cls = up ? "up" : "down";
    return `<span class="tk-item" data-sym="${i.symbol}" data-name="${i.name}" title="查看 ${i.name} K线">` +
      `<b>${i.name}</b><span class="num tk-code">${i.symbol}</span>` +
      `<span class="num ${cls}">${i.price != null ? fmt(i.price) : "--"}</span>` +
      `<span class="num ${cls}">${i.chg != null ? fmtChg(i.chg) : ""}</span>` +
      `<span class="num ${cls} tk-pct">${i.pct != null ? fmtChg(i.pct * 100) + "%" : ""}</span></span>`;
  };
  const half = items.map(item).join("") +
    `<span class="tk-total" title="沪市 + 深市指数成交额合计"><b>两市成交</b>` +
    `<span class="num acc">${fmtYi(r.total_amount ?? 0, 0)}</span></span>`;
  track.innerHTML = `<div class="tk-half">${half}</div><div class="tk-half">${half}</div>`;
  startTicker();
}

function startTicker(): void {
  const bar = document.getElementById("tickerbar")!;
  if (bar.dataset.run === "1") return;      // rAF 循环只起一次，换内容复用
  bar.dataset.run = "1";
  bar.addEventListener("mouseenter", () => { tkPaused = true; });
  bar.addEventListener("mouseleave", () => { tkPaused = false; });
  let last = performance.now();
  const anim = (now: number) => {
    const track = document.getElementById("tk-track");
    const half = (track?.scrollWidth ?? 0) / 2;
    if (track && half > 0 && !tkPaused && !document.body.classList.contains("mobile")) {
      tkOffset -= ((now - last) / 1000) * 30;   // 30px/s 匀速左移，无缝循环
      if (-tkOffset >= half) tkOffset += half;
      track.style.transform = `translateX(${tkOffset.toFixed(1)}px)`;
    }
    last = now;
    requestAnimationFrame(anim);
  };
  requestAnimationFrame(anim);
}

function toggleSeg(id: string, btn: HTMLElement): void {
  document.querySelectorAll(`#${id} button`).forEach((x) => x.classList.toggle("on", x === btn));
}

/** 指标显影双源同步：mk.mainInds/subInds → chartbar seg 与指标面板 chips 的 on 态 */
function syncIndUI(): void {
  const mset = new Set(mk.mainInds), sset = new Set(mk.subInds);
  document.querySelectorAll<HTMLElement>("#kl-main-ind button").forEach((x) =>
    x.classList.toggle("on", mset.has(x.dataset.mi as MainKey)));
  document.querySelectorAll<HTMLElement>("#kl-sub-ind button").forEach((x) =>
    x.classList.toggle("on", sset.has(x.dataset.si as SubKey)));
  document.querySelectorAll<HTMLElement>("#kl-ipanel button[data-mi]").forEach((x) =>
    x.classList.toggle("on", mset.has(x.dataset.mi as MainKey)));
  document.querySelectorAll<HTMLElement>("#kl-ipanel button[data-si]").forEach((x) =>
    x.classList.toggle("on", sset.has(x.dataset.si as SubKey)));
  // 通道配色选中态（单选）+ 短/中线趋势色点跟随当前调色板
  const key = trendPaletteKey();
  const pal = TRENDS[key];
  document.querySelectorAll<HTMLElement>("#kl-ipanel button[data-tpl]").forEach((x) =>
    x.classList.toggle("on", x.dataset.tpl === key));
  document.querySelectorAll<HTMLElement>("#kl-ipanel button[data-mi='short'],#kl-ipanel button[data-mi='mid']")
    .forEach((x) => x.style.setProperty("--ic", x.dataset.mi === "short" ? pal.fast : pal.slow));
}

/** 日线聚合为周/月 */
export function aggDaily(daily: Bar[], n: number): Bar[] {
  const out: Bar[] = [];
  let bucket: Bar[] = [];
  for (const b of daily) {
    bucket.push(b);
    if (bucket.length === n) {
      const o = bucket[0], l = bucket[bucket.length - 1];
      out.push({
        date: l.date, open: o.open, high: Math.max(...bucket.map((x) => x.high)),
        low: Math.min(...bucket.map((x) => x.low)), close: l.close,
        volume: bucket.reduce((s, x) => s + (x.volume || 0), 0),
        amount: bucket.reduce((s, x) => s + (x.amount || 0), 0),
      });
      bucket = [];
    }
  }
  if (bucket.length) {
    const o = bucket[0], l = bucket[bucket.length - 1];
    out.push({
      date: l.date, open: o.open, high: Math.max(...bucket.map((x) => x.high)),
      low: Math.min(...bucket.map((x) => x.low)), close: l.close,
      volume: bucket.reduce((s, x) => s + (x.volume || 0), 0),
      amount: bucket.reduce((s, x) => s + (x.amount || 0), 0),
    });
  }
  return out;
}

/** 周期 → 聚合根数（季 ≈ 65 个交易日，一年四根看大趋势）；t/60 不聚合直接用拉取数据 */
const P_N: Record<PKey, number> = { t: 1, "60": 1, d: 1, w: 5, m: 20, q: 65 };

export function barsFor(p: PKey): Bar[] {
  if (p === "t") return mk.minuteData?.bars ?? [];
  if (p === "60") return mk.m60 ?? [];
  const n = P_N[p] ?? 1;
  return n === 1 ? mk.bars : aggDaily(mk.bars, n);
}

/** 分时/60分数据按需拉取（后端 TTL 缓存 30s/120s，重复切回不打接口） */
export async function ensurePeriodData(p: PKey): Promise<void> {
  const s = mk.cur;
  if (!s) return;
  try {
    if (p === "t" && !mk.minuteData) {
      const d = await marketApi.minute(s.symbol);
      if (mk.cur?.symbol !== s.symbol) return;
      mk.minuteData = { date: d.date, prevClose: d.prev_close ?? null, bars: d.bars as Bar[] };
    } else if (p === "60" && !mk.m60) {
      const k = await marketApi.kline({ symbol: s.symbol, freq: "60" });
      if (mk.cur?.symbol !== s.symbol) return;
      mk.m60 = k.bars;
    }
  } catch (e) {
    toast((e as Error).message || "分钟数据加载失败");
  }
}

/* ── K线（klinecharts 10 · 策影同款配置，见 kline.ts）——多周期面板引擎 ── */
let kls: (KlineChartHandle | null)[] = [];

/** 焦点面板句柄（chartbar 周期段/观察档/缩放作用于它） */
function activeKl(): KlineChartHandle | null {
  return kls[mk.active] ?? kls[0] ?? null;
}

/** 供外部（侧栏拖拽/窗口 resize）触发的图表重排 */
export function klResize(): void {
  kls.forEach((k) => k?.resize());
}

function currentLayout(): KLayout {
  return document.body.classList.contains("mobile") ? "single" : mk.layout;
}

/** 按布局重建面板 DOM 与图表实例（签名不变则复用，避免闪烁） */
function ensurePanelDom(): void {
  const box = document.getElementById("kl-panels")!;
  const ly = currentLayout();
  const slots = LAYOUT_PANELS[ly];
  const sig = `${ly}|${slots.join(",")}`;
  if (box.dataset.sig === sig) return;
  kls.forEach((k) => k?.destroy());
  kls = [];
  box.dataset.sig = sig;
  box.className = `kl-panels ly-${ly}`;
  box.innerHTML = slots.map((p, i) =>
    `<div class="klp${i === mk.active ? " active" : ""}" data-pi="${i}">` +
    `<div class="klp-bar"><b class="klp-name"></b>` +
    `<span class="klp-p" title="切换周期">${P_LABEL[p]}</span>` +
    `<span class="klp-menu">` +
    (["t", "60", "d", "w", "m", "q"] as PKey[]).map((k) => `<button data-pp="${k}">${P_LABEL[k]}</button>`).join("") +
    `</span></div><div class="klp-main"></div></div>`).join("");
  kls = [...box.querySelectorAll<HTMLElement>(".klp-main")].map((el) => mountKline(el));
}

/** 应用单个面板：周期聚合 + 指标（副图仅左右布局）+ 数据 + 图内图例 */
function applyPanel(i: number): void {
  const kl = kls[i];
  if (!kl || !mk.cur) return;
  const p = mk.panels[i] ?? "d";
  kl.setPeriod(p === "q" ? "m" : p);           // 季线按月线引擎聚 65 根；t/60 原样透传
  // 分时主图固定为均价线（MA/趋势通道对每分钟假 K 线无意义），其余周期走默认预设
  kl.setMain(p === "t" ? ["avg"] : mk.mainInds);
  kl.setSub(SUB_OK[currentLayout()]?.[i] ? (p === "t" ? ["vol"] : mk.subInds) : []);
  kl.setData(barsFor(p));
  kl.drawLegend(p === "t" ? ["avg"] : (SUB_OK[currentLayout()]?.[i] ? [...mk.mainInds] : mk.mainInds));
  const box = document.querySelector<HTMLElement>(`.klp[data-pi="${i}"]`);
  if (box) box.querySelector(".klp-name")!.textContent = mk.cur.name || mk.cur.symbol;
}

export function renderKline(): void {
  const empty = document.getElementById("kl-empty")!;
  if (!mk.cur || !mk.bars.length) {
    empty.style.display = "grid";
    kls.forEach((k) => k?.setData([]));
    return;
  }
  empty.style.display = "none";
  ensurePanelDom();
  kls.forEach((_, i) => applyPanel(i));
  // 分时/60分面板：换标的后缓存已清，按需补拉（策略图面：先空后满）
  const need = mk.panels.find((p) => (p === "t" && !mk.minuteData) || (p === "60" && !mk.m60));
  if (need) void ensurePeriodData(need).then(() => {
    mk.panels.forEach((p, i) => { if (p === need) applyPanel(i); });
  });
}

/** 焦点面板周期同步到 chartbar 周期段（季线段里没有 → 全灭） */
function syncPeriodSeg(p: PKey): void {
  document.querySelectorAll<HTMLElement>("#kl-period button").forEach((b) =>
    b.classList.toggle("on", b.dataset.p === p));
}

/** 切某面板周期（面板头 / chartbar 段共用；分时/60分先按需拉数据再渲染） */
function setPanelPeriod(i: number, p: PKey): void {
  if (mk.panels[i] === p) { syncPeriodSeg(p); return; }
  mk.panels[i] = p;
  applyPanel(i);                               // 先渲染（缓存命中即刻有数据）
  void ensurePeriodData(p).then(() => {
    if (mk.panels[i] === p) applyPanel(i);     // 数据到达后重渲（未命中缓存时）
  });
  document.querySelector<HTMLElement>(`.klp[data-pi="${i}"] .klp-p`)
    ?.replaceChildren(P_LABEL[p]);          // 面板头周期徽章同步
  if (i === mk.active) syncPeriodSeg(p);
}

/* ── 右列功能卡 ── */
function spark(seq: number[], w: number, h: number, color: string): string {
  if (seq.length < 2) return "";
  const mn = Math.min(...seq), mx = Math.max(...seq);
  const r = mx - mn || 1, step = w / (seq.length - 1);
  const pts = seq.map((v, i) => (i * step).toFixed(1) + "," + (h - 2 - ((v - mn) / r) * (h - 4)).toFixed(1)).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="spk" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function mbar(items: [string, number, string][]): string {
  const mx = Math.max(...items.map((i) => Math.abs(i[1])), 1);
  return `<div class="mbar">` + items.map((i) =>
    `<div class="mbl"><span>${i[0]}</span><div class="mbt"><i style="width:${Math.max(4, Math.abs(i[1]) / mx * 100).toFixed(0)}%;background:${i[2]}"></i></div><b class="num ${i[1] >= 0 ? "up" : "down"}">${i[1] > 0 ? "+" : ""}${fmt(i[1])}</b></div>`).join("") + `</div>`;
}

/* ── 自选股卡片（首个多标的卡）：与左侧自选页同源 store.watchlist，
   增删/云同步 emit → renderRight 自动重渲；行情走 /market/quotes 批量快照 ── */
const wlQ = new Map<string, Quote>(); // symbol → 批量快照（盘中由 12s 轮询带动刷新）
let wlQAt = 0;                        // 上次拉取时刻（节流 ≈ 后端 10s 快照缓存）
let wlQSig = "";                      // 上次拉取代码集签名（自选变更 → 绕过节流立即刷）
let wlQBusy = false;

function redrawWatchBody(): void {
  const el = document.querySelector<HTMLElement>('#rightcol .rcard[data-cid="watch"] .fbody');
  if (!el) return;
  const list = el.querySelector<HTMLElement>(".wl-list");
  const top = list?.scrollTop ?? 0;          // 原地刷新保留滚动位置
  el.innerHTML = cardBody("watch", getState().cards.watch?.mode ?? "simple");
  const nl = el.querySelector<HTMLElement>(".wl-list");
  if (nl) nl.scrollTop = top;
}

async function refreshWlQuotes(): Promise<void> {
  const symbols = getState().watchlist.map((w) => w.symbol);
  const sig = symbols.join(",");
  if (!symbols.length) { wlQ.clear(); wlQSig = sig; return; }
  if (wlQBusy || (sig === wlQSig && Date.now() - wlQAt < 9000)) return;
  wlQBusy = true;
  try {
    const keep = new Set(symbols);
    for (const k of [...wlQ.keys()]) if (!keep.has(k)) wlQ.delete(k);
    // 后端单次 ≤50 只：超出分批串行拉
    for (let i = 0; i < symbols.length; i += 50) {
      const r = await marketApi.quotes(symbols.slice(i, i + 50));
      for (const q of r.items) wlQ.set(q.symbol, q);
    }
    wlQAt = Date.now();
    wlQSig = sig;
    redrawWatchBody();
  } catch { /* 静默：保留旧快照 */ } finally {
    wlQBusy = false;
  }
}

function cardBody(cid: string, mode: string): string {
  const s = mk.cur;
  if (!s) return "";
  const bars = mk.bars;                    // 卡片统计基准固定日线
  const q = mk.quote;
  const closes = mk.bars.map((b) => b.close);
  const shortSeq = closes.slice(-10), midSeq = closes.slice(-30);
  const chg = q?.pct_chg ?? 0;
  if (cid === "info") {
    // 策影 BasicInfoCard 同款：名称代码 + 3 列字段网格（缺值整格不渲染）+ 概念 chips
    const last = bars[bars.length - 1];
    if (!last) return `<div class="bempty">暂无基本信息</div>`;
    const prev = bars.length > 1 ? bars[bars.length - 2].close : last.open;
    const rtLive = q?.rt_price != null;
    const price = rtLive ? q!.rt_price! : last.close;
    const chgPct = q?.pct_chg ?? (prev ? (last.close - prev) / prev * 100 : 0);
    const chgBase = rtLive && q?.rt_prev_close != null ? q!.rt_prev_close! : prev;
    const chgAbs = chgBase ? price - chgBase : 0;
    const cls = chgPct >= 0 ? "up" : "down";
    const val = q?.valuation;
    const fmtCap = (v?: number | null): string | null =>
      v == null || !isFinite(v) ? null : v >= 1e12 ? fmt(v / 1e12, 2) + "万亿" : fmtYi(v, 0);
    const row = (l: string, v: string | null, vc = "") =>
      v == null ? "" : `<div class="bi-r"><span>${l}</span><b class="num ${vc}">${v}</b></div>`;
    const rows = [
      // 行式键值（不用格子形式）：每行「标签 …… 值」右对齐，两列排布
      row("最新价", fmt(price), cls),
      row("涨跌幅", `${fmtChg(chgAbs)} <i>${fmtChg(chgPct)}%</i>`, cls),
      row("行业", q?.industry || (s.symbol.includes(".") ? "指数" : null)),
      row("换手", q?.turnover_rate != null ? fmt(q.turnover_rate) + "%" : null),
      row("总市值", fmtCap(val?.total_mv)), row("流通市值", fmtCap(val?.circ_mv)),
      row("PE(TTM)", val?.pe_ttm != null ? (val.pe_ttm > 0 ? fmt(val.pe_ttm) : "亏损") : null),
      row("PB", val?.pb != null && val.pb > 0 ? fmt(val.pb) : null),
    ].join("");
    const cons = (q?.concept ?? "").split(/[,，、;；\s]+/).map((x) => x.trim()).filter(Boolean);
    return `<div class="bi-name"><b>${esc(q?.name || s.name)}</b><span class="num">${s.symbol}</span></div>` +
      `<div class="bi-rows">${rows}</div>` +
      (cons.length ? `<div class="bi-cons">${cons.slice(0, 6).map((c) => `<span class="sh-con">${esc(c)}</span>`).join("")}` +
        (cons.length > 6 ? `<span class="sh-con more" title="${esc(cons.slice(6).join("、"))}">+${cons.length - 6}</span>` : "") + `</div>` : "");
  }
  if (cid === "watch") {
    const wl = getState().watchlist;
    if (!wl.length)
      return `<div class="bempty">暂无自选股<br><span style="color:var(--faint)">从左侧「自选」页或顶栏搜索添加</span><br>` +
        `<button class="hbtn primary" data-wl-add style="margin-top:10px;height:28px;padding:0 14px;font-size:11.5px">${ic("plus", 12)}添加自选</button></div>`;
    const det = mode === "detailed";
    const rows = wl.map((w, i) => {
      const wq = wlQ.get(w.symbol);
      const ch = wq?.pct_chg ?? 0;
      const up = ch >= 0;
      const price = wq ? (wq.rt_price ?? wq.close ?? null) : null;
      return `<div class="wl-r${det ? " det" : ""}" data-go-stock="${w.symbol}" data-go-name="${esc(w.name)}" title="打开 ${esc(w.name)}">` +
        `<span class="wl-i num">${i + 1}</span>` +
        `<div class="wl-nm"><b>${esc(w.name)}</b><span class="num">${w.symbol}</span></div>` +
        (det ? `<span class="num wl-d">${fmtYi(wq?.amount ?? null, 1)}</span>` +
          `<span class="num wl-d">${wq?.turnover_rate != null ? fmt(wq.turnover_rate) + "%" : "—"}</span>` : "") +
        `<b class="num wl-p">${price != null ? fmt(price) : "—"}</b>` +
        (wq ? `<b class="num ${up ? "up" : "down"}">${fmtChg(ch)}%</b>` : `<b class="num" style="color:var(--faint)">—</b>`) +
        `</div>`;
    }).join("");
    return `<div class="wl-list">${rows}</div>`;
  }
  if (cid === "signals") {
    const segI = sixSegment(mk.bars, mk.bars.length - 1);
    if (mode === "simple") {
      return `<div class="csimple"><div class="st"><b>${SEGNAME[segI]}</b> · 六分段判定<br><span style="font-size:10px;color:var(--faint)">短线 ${shortSeq[shortSeq.length - 1] > shortSeq[0] ? "上行" : "下行"} · 中线 ${midSeq[midSeq.length - 1] > midSeq[0] ? "上行" : "下行"}</span></div><div class="minifig">${spark(midSeq, 64, 22, "var(--p1)")}</div></div>`;
    }
    return `<div style="font-size:11px;color:var(--faint)">六分段 · ${SEGNAME[segI]}</div>` +
      `<div class="sixseg" id="rc-six">${Array.from({ length: 6 }, (_, k2) => `<i class="${k2 <= segI - 1 ? "on" : ""}${k2 === segI - 1 ? " cur" : ""}"></i>`).join("")}</div>` +
      `<div class="sixlab"><span>超卖</span><span>超买</span></div>` +
      `<div class="tr2">${spark(shortSeq, 96, 26, "var(--up)")}${spark(midSeq, 96, 26, "var(--p1)")}</div>` +
      `<div style="display:flex;gap:8px;margin-top:8px">` +
      `<div style="flex:1;background:var(--panel-2);border-radius:9px;padding:7px 9px"><div style="font-size:10px;color:var(--faint)">短线趋势</div><div style="font-size:13px;font-weight:650;color:${shortSeq[shortSeq.length - 1] > shortSeq[0] ? "var(--up)" : "var(--down)"}">${shortSeq[shortSeq.length - 1] > shortSeq[0] ? "上行" : "下行"}</div></div>` +
      `<div style="flex:1;background:var(--panel-2);border-radius:9px;padding:7px 9px"><div style="font-size:10px;color:var(--faint)">中线趋势</div><div style="font-size:13px;font-weight:650;color:var(--p1)">${midSeq[midSeq.length - 1] > midSeq[0] ? "上行" : "下行"}</div></div></div>`;
  }
  if (cid === "moneyflow") {
    const cf = q?.capital_flow;
    const items: [string, number, string][] = [
      ["超大单", (cf?.net_super ?? 0) / 1e8, "var(--up)"],
      ["大单", (cf?.net_large ?? 0) / 1e8, "var(--up)"],
      ["中单", (cf?.net_medium ?? 0) / 1e8, "var(--down)"],
      ["小单", (cf?.net_small ?? 0) / 1e8, "var(--down)"],
    ];
    const main = (cf?.net_main ?? 0) / 1e8;
    if (mode === "simple") {
      return `<div class="csimple"><div class="st"><b class="num ${main >= 0 ? "up" : "down"}">${main > 0 ? "+" : ""}${fmt(main)}亿</b> 主力净流入<br><span style="font-size:10px;color:var(--faint)">超大单 +${fmt(items[0][1])} / 小单 ${fmt(items[3][1])}</span></div><div class="minifig">${mbar(items)}</div></div>`;
    }
    return `<div style="display:flex;align-items:baseline;gap:8px"><span style="font-size:20px;font-weight:700" class="num ${main >= 0 ? "up" : "down"}">${main > 0 ? "+" : ""}${fmt(main)}亿</span><span style="font-size:10.5px;color:var(--faint)">主力净流入${cf ? " · " + cf.date : "（无资金流数据）"}</span></div>` +
      `<div class="flowbars">` + items.map((f) =>
        `<div class="f"><div class="bar"><i style="height:${Math.round(Math.abs(f[1]) / 1.3 * 100)}%;background:${f[2]};opacity:.8"></i></div><div class="v num ${f[1] >= 0 ? "up" : "down"}">${f[1] > 0 ? "+" : ""}${fmt(f[1])}</div><div class="t">${f[0]}</div></div>`).join("") + `</div>`;
  }
  if (cid === "indicators") {
    const closesN = bars.map((b) => b.close);
    const ma20 = sma(bars, 20);
    const i = bars.length - 1;
    const bl = bollSeries(bars);
    const kd = kdjSeries(bars);
    const atr = atrSeries(bars);
    const row = (k: string, v: string, cls = "") => `<div class="mbl"><span>${k}</span><div class="mbt"></div><b class="num ${cls}">${v}</b></div>`;
    const ma20v = ma20[i];
    const pos = ma20v != null ? (closesN[i] > ma20v ? "上方" : "下方") : "—";
    const posCls = ma20v != null && closesN[i] > ma20v ? "up" : "down";
    if (mode === "simple") {
      return `<div class="csimple"><div class="st"><b>MA20 ${pos}</b> · KDJ ${fmt(kd.k[i] ?? 0, 0)}<br><span style="font-size:10px;color:var(--faint)">ATR14 ${fmt(atr[i] ?? 0)} · BOLL 带宽 ${ma20v != null ? fmt(((bl.up[i]! - bl.low[i]!) / ma20v) * 100, 1) + "%" : "—"}</span></div><div class="minifig">${spark(closesN.slice(-20), 64, 22, "var(--accent)")}</div></div>`;
    }
    return row("MA5", fmt(sma(bars, 5)[i] ?? 0)) + row("MA20", fmt(ma20v), posCls) +
      row("KDJ K", fmt(kd.k[i] ?? 0, 1)) + row("KDJ J", fmt(kd.j[i] ?? 0, 1)) +
      row("BOLL 上", fmt(bl.up[i] ?? 0)) + row("BOLL 下", fmt(bl.low[i] ?? 0)) +
      row("ATR14", fmt(atr[i] ?? 0));
  }
  if (cid === "valuation") {
    const v = q?.valuation;
    if (!v) return `<div style="font-size:11.5px;color:var(--faint)">暂无估值数据（daily_valuation 未覆盖）</div>`;
    const row = (k: string, val: number | null | undefined, digits = 2) =>
      `<div class="mbl"><span>${k}</span><div class="mbt"></div><b class="num">${fmt(val, digits)}</b></div>`;
    if (mode === "simple") {
      return `<div class="csimple"><div class="st"><b>PE ${fmt(v.pe_ttm, 1)}</b> · PB ${fmt(v.pb, 2)}<br><span style="font-size:10px;color:var(--faint)">总市值 ${fmtYi(v.total_mv, 0)} · 流通 ${fmtYi(v.circ_mv, 0)}</span></div><div class="minifig"></div></div>`;
    }
    return row("PE-TTM", v.pe_ttm) + row("PB", v.pb) + row("PS-TTM", v.ps_ttm) +
      row("总市值(亿)", v.total_mv != null ? v.total_mv / 1e8 : null) + row("流通市值(亿)", v.circ_mv != null ? v.circ_mv / 1e8 : null) +
      `<div style="font-size:10px;color:var(--faint)">数据日期 ${v.date}</div>`;
  }
  if (cid === "corepick") {
    void chg;
    return `<div style="font-size:11.5px;color:var(--faint)"><span class="tag flat" style="font-size:10px">档案</span> 在「核心标」页查看 ${s.name} 的追涨 / 低吸信号与 VIP 因子明细</div><button class="hbtn" data-ic-go-core style="height:26px;padding:0 10px;font-size:11px;margin-top:6px">前往核心标</button>`;
  }
  return "";
}

function cardHead(def: { id: string; name: string; icon: string }): string {
  const p = getState().cards[def.id];
  const mono = def.id === "moneyflow" ? (mk.cur?.symbol || "") : def.id === "corepick" ? "池档案" : def.id === "watch" ? `${getState().watchlist.length}只` : "OPEN";
  return `<div class="rh">${ic(def.icon, 14)}<h4>${def.name}</h4><span class="mono" style="margin-left:auto">${mono}</span>` +
    `<span class="cbar"><span class="cseg"><button class="cbtn${p.mode === "simple" ? " on" : ""}" data-mode="simple" title="简单模式">${ic("list", 12)}</button><button class="cbtn${p.mode === "detailed" ? " on" : ""}" data-mode="detailed" title="详细模式">${ic("faders-horizontal", 12)}</button></span>` +
    `<button class="cbtn" data-fold title="折叠 / 展开">${ic("caret-up", 12)}</button>` +
    `<span class="drag" draggable="true" title="拖动排序">${ic("dots-six-vertical", 13)}</span></span></div>`;
}

/* 右列功能卡宽度：默认 366（原 244 × 1.5），拖拽可调，按登录用户分别记忆 */
const RCOL_MIN = 280, RCOL_MAX = 560;
const rcolKey = () => `yc_rcol_w:${getState().user?.id || "guest"}`;
export function applyRcolW(): void {
  const w = Number(localStorage.getItem(rcolKey()));
  if (w >= RCOL_MIN && w <= RCOL_MAX)
    document.documentElement.style.setProperty("--rcol-w", `${w}px`);
}
function initRcolResize(): void {
  applyRcolW();
  const grip = document.getElementById("rcol-grip")!;
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    grip.classList.add("on");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: MouseEvent) => {
      // 右缘贴窗口右边（页面留白 16px + 余量 2px），指针位置即目标宽度
      const w = Math.min(RCOL_MAX, Math.max(RCOL_MIN,
        document.documentElement.clientWidth - ev.clientX - 18));
      document.documentElement.style.setProperty("--rcol-w", `${w}px`);
      localStorage.setItem(rcolKey(), String(w));
      clearTimeout((window as unknown as { _rz?: number })._rz);
      (window as unknown as { _rz?: number })._rz = window.setTimeout(klResize, 120);
    };
    const up = () => {
      grip.classList.remove("on");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

export function renderRight(): void {
  const el = document.getElementById("rightcol");
  if (!el || !mk.cur) return;
  const st = getState();
  const defs = [...CARD_DEFS].sort((a, b) => st.cards[a.id].order - st.cards[b.id].order);
  let html = "";
  for (const def of defs) {
    const p = st.cards[def.id];
    if (!p.on) continue;
    html += `<div class="rcard" data-cid="${def.id}">${cardHead(def)}` +
      `<div class="fbody${p.mode === "simple" && def.id === "signals" ? "" : ""}${false ? " hide" : ""}">${cardBody(def.id, p.mode)}</div></div>`;
  }
  html += `<div class="cmpl">仅提供基于公开数据的规则化分析，不构成投资建议 · 指标为开源口径前端计算，VIP 明细服务端脱敏返回</div>`;
  el.innerHTML = html;
  el.querySelectorAll<HTMLElement>("[data-vip-open]").forEach((b) =>
    b.addEventListener("click", () => openModal("modal-vip")));
  el.querySelectorAll<HTMLElement>("[data-ic-go-core]").forEach((b) =>
    b.addEventListener("click", () => document.dispatchEvent(new CustomEvent("yc:goto-page", { detail: "corepicks" }))));
  el.querySelectorAll<HTMLElement>("[data-wl-add]").forEach((b) =>
    b.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("yc:goto-page", { detail: "watchlist" }));
      window.setTimeout(() => document.getElementById("wl-add")?.click(), 60);
    }));
  el.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      setCardPref(b.closest(".rcard")!.getAttribute("data-cid")!, { mode: b.dataset.mode as "simple" | "detailed" });
    }));
  el.querySelectorAll<HTMLElement>("[data-fold]").forEach((b) =>
    b.addEventListener("click", () => {
      const card = b.closest(".rcard")!;
      const body = card.querySelector(".fbody") as HTMLElement;
      body.classList.toggle("hide");
      b.innerHTML = ic(body.classList.contains("hide") ? "caret-down" : "caret-up", 12);
    }));
  // 拖拽排序
  el.querySelectorAll<HTMLElement>(".drag").forEach((h) => {
    h.addEventListener("dragstart", (e) => {
      const card = h.closest(".rcard") as HTMLElement;
      e.dataTransfer!.setData("text/plain", card.dataset.cid!);
      e.dataTransfer!.effectAllowed = "move";
      card.classList.add("dragging");
    });
    h.addEventListener("dragend", () => {
      el.querySelectorAll(".rcard").forEach((r) => r.classList.remove("dragging", "drop-before", "drop-after"));
    });
  });
  el.querySelectorAll<HTMLElement>(".rcard").forEach((card) => {
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      el.querySelectorAll(".rcard").forEach((r) => r.classList.remove("drop-before", "drop-after"));
      const r = card.getBoundingClientRect();
      card.classList.add((e.clientY - r.top) > r.height / 2 ? "drop-after" : "drop-before");
    });
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      const id = e.dataTransfer!.getData("text/plain");
      const to = card.dataset.cid!;
      if (id && id !== to) {
        const st2 = getState();
        const fromOrder = st2.cards[id].order;
        void fromOrder;
        let toOrder = st2.cards[to].order;
        if (card.classList.contains("drop-after")) toOrder += 0.5;
        else toOrder -= 0.5;
        setCardPref(id, { order: toOrder });
        toast("卡片顺序已更新");
      }
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-before", "drop-after"));
  });
  el.querySelectorAll<HTMLElement>("[data-go-stock]").forEach((r) =>
    r.addEventListener("click", () => {
      const sym = r.dataset.goStock!;
      void openStock({ symbol: sym, name: r.dataset.goName || sym });
    }));
  // 自选股卡片：行情快照按需拉取（节流 + 自选变更即刷）
  void refreshWlQuotes();
}
