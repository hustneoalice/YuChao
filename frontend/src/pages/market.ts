import { estimateFloatShares } from "../volume-activity";
/* 行情页：个股头 + klinecharts K线 + 右列功能卡 */
import { marketApi, type Bar, type Kline, type FundFlowRange, type IndexQuote, type Quote } from "../api";
import { cssv, esc, fmt, fmtChg, fmtVol, fmtYi, fmtYiS } from "../fmt";
import { sma, bollSeries, kdjSeries, atrSeries, sixSegment, SEGNAME, SEGACTION, SEGFULL } from "../indicators";
export { SEGNAME };
import { ic } from "../icons";
import { CARD_DEFS, RIGHT_TABS, addWatch, addWatchGroup, allWatchGroups, getState, inWlFilter, isVip, isWatched, notifyLocal, removeWatch, setCardPref, subscribe, toggleWatchGroup, toggleWlGroup, type RightTabId } from "../store";
import { openModal, multiPick, toast } from "../ui";
import { bindNoteHover, hideNotePop, initNoteEditor, noteChipHtml, openNoteModal } from "../note-ui";
import { openGroupPanel, openWatchPanel } from "../watch";
import { stockSearch, type StockSearchHandle } from "../searchbox";
import { refreshSparksIn, sparkSvg } from "../sparks";
import { TRENDS, setTrendPalette, trendPaletteKey, IND_DEFS, IND_CATS, IND_BY_KEY, type KlineChartHandle, type MainKey, type SubKey, type RangeFund, type RangeStats, type PickBar } from "./kline";
import { createChartPanel, quoteHeadHtml, type ChartPanelHandle } from "../chartpanel";
import { createIntraday, type IntradayHandle } from "../intraday";
import { shareholderBody, bindShareholders, prefetchShareholders } from "../shareholders";
import { bindChips, chipBody, isIndexSymbol, prefetchChips } from "../chips";
import { bindOrderbook, bindTrades, headSubHtml, orderbookBody, tradesBody, prefetchDepth, prefetchTrades } from "../depth";

export const SEG6 = ["超跌", "反弹", "突破", "超涨", "回踩", "跌破"];

export interface CurStock { symbol: string; name: string; trendFocus?: { date?: string } }
/** 多周期布局：single 单屏 / h 左右双列 / v 上下两层 / quad 四格（策影同款） */
export type KLayout = "single" | "h" | "v" | "quad";
type PKey = "t" | "60" | "d" | "w" | "m" | "q";

const P_LABEL: Record<PKey, string> = { t: "分时", "60": "60分", d: "日", w: "周", m: "月", q: "季" };
/** 各布局的面板周期槽位（默认：左右/上下=日+周，四格=日周月季） */
const LAYOUT_PANELS: Record<KLayout, PKey[]> = {
  single: ["d"], h: ["d", "w"], v: ["d", "w"], quad: ["d", "w", "m", "q"],
};
/** 副图仅左右布局保留（上下/四格格子里只显主图，塞副图太挤） */
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
  lineFib: localStorage.getItem("yc_kfib") === "1",  // 黄金分割（智能画线，主图叠加）
  lineSR: localStorage.getItem("yc_ksr") === "1",    // 支撑压力（智能画线，主图叠加）
  lineWave: localStorage.getItem("yc_kwave") === "1", // 浪型结构（艾略特 1-5 浪，主图叠加）
  lineBox: localStorage.getItem("yc_kbox") === "1",   // 箱体区间（横向震荡，主图叠加）
  linePat: localStorage.getItem("yc_kpat") === "1",   // 反转形态（W底/M头/头肩，主图叠加）
  minuteData: null as { date: string; prevClose: number | null; bars: Bar[] } | null,
  m60: null as Bar[] | null, // 60 分钟K（腾讯实时拉取，不落库）
  from: null as { page: string; label: string } | null,
  /* 框选区间（K 线拖拽 → 右列资金卡同步）：null = 未框选，卡片走当日口径 */
  range: null as (RangeStats & { fund: RangeFund | null; loading: boolean; note: string | null }) | null,
  /* 单根选中（点击蜡烛 → 右列资金卡切该交易日）：与 range 互斥，null = 未选中 */
  pick: null as (PickBar & { fund: RangeFund | null; loading: boolean; note: string | null }) | null,
};
if (!LAYOUT_PANELS[mk.layout]) mk.layout = "single";
mk.panels = [...LAYOUT_PANELS[mk.layout]];

/* K线偏好持久化（F04：本地 + sync.ts 云同步）——主/副图指标集合 */
const KMAIN_OK: string[] = IND_DEFS.filter((d) => d.where === "main").map((d) => d.key);
const KSUB_OK: string[] = IND_DEFS.filter((d) => d.where === "sub").map((d) => d.key);
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

/* ── 指标方案：内置方案一键切换 + 自定义方案增删（localStorage yc_klpresets）── */
type Preset = { main: MainKey[]; sub: SubKey[] };
const PRESETS: Record<string, Preset> = {
  标准: { main: ["ma", "short", "mid"], sub: ["vol", "macd"] },
  趋势: { main: ["ema", "boll", "short"], sub: ["macd", "dmi", "sixseg"] },
  量价: { main: ["ma"], sub: ["vol", "obv", "vr"] },
  动量: { main: ["ma"], sub: ["kdj", "rsi", "wr", "cci"] },
  波段: { main: ["boll"], sub: ["kdj", "macd", "atr"] },
  极简: { main: [], sub: ["vol"] },
};
function readCustomPresets(): Record<string, Preset> {
  try {
    const v = JSON.parse(localStorage.getItem("yc_klpresets") || "{}") as unknown;
    if (v && typeof v === "object") return v as Record<string, Preset>;
  } catch { /* 坏值忽略 */ }
  return {};
}
/** ★ 常显指标（工具栏两行只渲染这个集合）：localStorage 持久化，坏键/缺失回退默认项 */
const IND_FAV_DEF = ["ma", "boll", "vol", "macd", "kdj", "rsi", "qyjj"];
function readIndFavs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("yc_indfav") || "") as unknown;
    if (Array.isArray(v)) return v.filter((k): k is string => typeof k === "string" && !!IND_BY_KEY[k]);
  } catch { /* 无值/坏值走默认 */ }
  return [...IND_FAV_DEF];
}
function writeIndFavs(favs: string[]): void {
  localStorage.setItem("yc_indfav", JSON.stringify([...new Set(favs)]));
}

/* 绘图工具（主图叠加）：也进「＋更多」配置，★ 常显到工具栏绘图行；独立存储避免与指标键冲突 */
const LINE_DEFS = [
  { key: "fib", label: "黄金分割", desc: "自动识别高低点，绘制 0.236 / 0.382 / 0.5 / 0.618 / 0.786" },
  { key: "sr", label: "支撑压力", desc: "按成交量峰与枢轴，绘制近端支撑 / 压力带" },
  { key: "wave", label: "浪型结构", desc: "艾略特波浪：三条铁律校验后标出 0-5 推动浪与 A-B-C 调整浪" },
  { key: "box", label: "箱体区间", desc: "自动框出横盘震荡箱体：下沿缩量企稳、上沿滞涨、放量突破/跌破" },
  { key: "pat", label: "转折形态", desc: "只认最经典的转折结构：W底/M头/头肩底/头肩顶，放量突破或跌破颈线才算确认" },
] as const;
type LineKey = (typeof LINE_DEFS)[number]["key"];
const LINE_BY_KEY = Object.fromEntries(LINE_DEFS.map((d) => [d.key, d])) as
  Record<LineKey, (typeof LINE_DEFS)[number]>;
const LINE_FAV_DEF: string[] = LINE_DEFS.map((d) => d.key);

function readLineFavs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("yc_linefav") || "") as unknown;
    if (Array.isArray(v))
      return v.filter((k): k is string => typeof k === "string" && !!LINE_BY_KEY[k as LineKey]);
  } catch { /* 无值/坏值走默认 */ }
  return [...LINE_FAV_DEF];
}
function writeLineFavs(keys: string[]): void {
  localStorage.setItem("yc_linefav", JSON.stringify([...new Set(keys)]));
}
function lineOn(key: string): boolean {
  return key === "fib" ? mk.lineFib : key === "sr" ? mk.lineSR
    : key === "wave" ? mk.lineWave : key === "box" ? mk.lineBox : mk.linePat;
}
/** 切换绘图叠加开关：写 mk + 本地记忆（与旧按钮 data-line 同一套口径） */
function toggleLine(key: string): void {
  if (key === "sr") mk.lineSR = !mk.lineSR;
  else if (key === "wave") mk.lineWave = !mk.lineWave;
  else if (key === "box") mk.lineBox = !mk.lineBox;
  else if (key === "pat") mk.linePat = !mk.linePat;
  else mk.lineFib = !mk.lineFib;
  localStorage.setItem(`yc_k${key}`, lineOn(key) ? "1" : "0");
}
/** 应用方案：过滤合法键 → 写状态 → 持久化 → K 线与面板同步（所见即所得） */
function applyPreset(p: Preset): void {
  mk.mainInds = (p.main || []).filter((k) => KMAIN_OK.includes(k));
  mk.subInds = (p.sub || []).filter((k) => KSUB_OK.includes(k));
  saveKPrefs();
  syncIndUI();
  renderIpanel();
  renderKline();
}

/* ── 切换丝滑三件套（策影的驻留缓存打底，三点超越：hover 预取 / SWR 静默回验 / 在途中止）──
 * kcache：K线 LRU（30 只）。命中即渲染 0ms 等待，后台再静默回验拿新末根。
 * qcache：行情快照 5s TTL——预取/回切共用，热 quote 直接先上屏。
 * hover 预取：列表行悬停 120ms → 预热 K线+行情，点下去时大概率已是热数据。 */
const KCACHE_MAX = 30;
const kcache = new Map<string, Kline>();                       // Map 插入序 = LRU 序
const qcache = new Map<string, { q: Quote; at: number }>();
/** 列表批量报价的快照（自选卡/自选页/成分股表都已拉过一次）：切过去先用它秒上屏，再后台校准 */
const qprime = new Map<string, { q: Quote; at: number }>();
const QPRIME_TTL = 60_000;
let curCtl: AbortController | null = null;                     // 切换即中止上一只在途请求
let barsSym = "";                                              // mk.bars 当前归属的标的（换标的后旧K线不可用于新标的价格）

/** 列表拿到批量报价后调用：给切换铺一条「立刻有数」的底 */
export function primeQuotes(items: Quote[]): void {
  const now = Date.now();
  for (const q of items) if (q?.symbol) qprime.set(q.symbol, { q, at: now });
  while (qprime.size > 240) qprime.delete(qprime.keys().next().value!);
}
function qprimeGet(sym: string): Quote | null {
  const e = qprime.get(sym);
  if (!e) return null;
  if (Date.now() - e.at > QPRIME_TTL) { qprime.delete(sym); return null; }
  return e.q;
}

function kcacheGet(sym: string): Kline | null {
  const k = kcache.get(sym);
  if (!k) return null;
  kcache.delete(sym); kcache.set(sym, k);                      // touch 提到 LRU 头
  return k;
}
function kcachePut(sym: string, k: Kline): void {
  kcache.set(sym, k);
  if (kcache.size > KCACHE_MAX) kcache.delete(kcache.keys().next().value!);
}
function qcacheGet(sym: string): Quote | null {
  const c = qcache.get(sym);
  if (!c) return null;
  if (Date.now() - c.at > 5000) { qcache.delete(sym); return null; }
  return c.q;
}
/** 预热一只票（K线 + 行情入缓存），失败静默。列表 hover 与邻股切换共用。 */
export function warmStock(symbol: string): void {
  if (document.hidden || kcache.has(symbol)) {
    // K线已热：只补 5s 内会过期的行情
    if (!qcache.has(symbol)) void marketApi.quote(symbol).then((q) => { if (q) qcache.set(symbol, { q, at: Date.now() }); }).catch(() => {});
    return;
  }
  void marketApi.kline({ symbol, limit: 2000 }).then((k) => kcachePut(symbol, k)).catch(() => {});
  void marketApi.quote(symbol).then((q) => { if (q) qcache.set(symbol, { q, at: Date.now() }); }).catch(() => {});
}

/* 侧栏预取：用户还在看 K 线时，后台把筹码/股东/60分/盘口/逐笔拉好，
   切卡即出数。300ms 防抖：方向键连续切票时只预取最后一只。 */
let panelsTimer = 0;
function schedulePanels(symbol: string): void {
  window.clearTimeout(panelsTimer);
  panelsTimer = window.setTimeout(() => {
    if (mk.cur?.symbol !== symbol) return;
    void Promise.allSettled([
      prefetchChips(symbol), prefetchShareholders(symbol), prefetchTrend60(symbol),
      prefetchDepth(symbol), prefetchTrades(symbol),
    ]).then(() => { if (mk.cur?.symbol === symbol) renderRight(); });
  }, 300);
}

/* ── 载入 ── */
export async function openStock(s: CurStock, from?: { page: string; label: string } | null): Promise<void> {
  mk.cur = s;
  const hit = kcacheGet(s.symbol);
  const hotQ = qcacheGet(s.symbol);
  mk.quote = hotQ ?? qprimeGet(s.symbol);                      // 先换/清 quote：goPage 同步重绘时不会沿用上一只的价格
  if (s.trendFocus) {
    mk.layout = "single";
    mk.panels = ["d"];
    mk.active = 0;
    if (!mk.subInds.includes("trendhistogram")) mk.subInds = [...mk.subInds, "trendhistogram"];
  }
  mk.from = from ?? null;
  // 换标的：框选区间 / 单根选中 / 连线测量都作废（选区属于上一只票，跨标的同步资金是错误的）
  mk.range = null;
  mk.pick = null;
  kls.forEach((k) => { k?.clearRange(false); k?.clearPick(false); k?.clearMeasure(); });
  localStorage.setItem("yc_last_symbol", `${s.symbol}|${s.name}`);
  renderBackbar();
  updateWatchBtn();
  document.dispatchEvent(new CustomEvent("yc:goto-page", { detail: "market" }));
  curCtl?.abort();                                             // 在途旧请求作废（保护服务端也防乱序）
  const ctl = new AbortController();
  curCtl = ctl;
  schedulePanels(s.symbol);                                    // 侧栏筹码/股东/60分/盘口/逐笔后台预取
  let barsReady = !!hit;                                       // 新标的 K线是否已上屏（决定能否用 quoteView 算价）
  /** 行情快照到达即刷顶部信息条；K线未就绪先存着，等 K线渲染时一并上屏 */
  const applyQuote = (q: Quote | null): void => {
    if (mk.cur?.symbol !== s.symbol || !q) return;
    qcache.set(s.symbol, { q, at: Date.now() });
    mk.quote = q;
    if (!barsReady) {
      renderKlpBar();                                          // 只刷顶部信息条；右列等K线上屏后再整卡重绘
      return;
    }
    if (mk.subInds.includes("volumeactivity")) renderKline();  // 该副图吃实时成交额，需重画
    else renderKlpBar();
    renderRight();
  };
  // quote 与 K线并行拉取：不再等 K线完成才请求快照（否则顶部价格要等下一轮 12s 轮询）
  if (!hotQ) void marketApi.quote(s.symbol, { signal: ctl.signal }).then(applyQuote).catch(() => {});
  if (hit) {
    // 缓存命中：立即整屏渲染，然后 SWR 静默回验（末根可能被盘中轮询推进过）
    mk.bars = hit.bars;
    barsSym = s.symbol;
    mk.minuteData = null;
    minuteAt = 0;
    mk.m60 = null;
    barsReady = true;
    renderKline();
    renderRight();
    showBriefing();
    startPoll();
    marketApi.kline({ symbol: s.symbol, limit: 2000 }, { signal: ctl.signal })
      .then((k) => {
        kcachePut(s.symbol, k);
        if (mk.cur?.symbol !== s.symbol) return;               // 用户又切走了：只留缓存
        mk.bars = k.bars;
        barsSym = s.symbol;
        renderKline();
      })
      .catch(() => {});
    return;
  }
  // K线先渲染不等 quote（实时快照慢/被掐时不再拖住首屏），
  // quote 到达后单独刷新右列（基本信息卡/资金流/估值等）
  try {
    const k = await marketApi.kline({ symbol: s.symbol, limit: 2000 }, { signal: ctl.signal });
    kcachePut(s.symbol, k);                                    // 过期回包也入缓存（回切免费）
    if (mk.cur?.symbol !== s.symbol) return;                   // 用户已切到别的标的，丢弃过期回包
    mk.bars = k.bars;
    barsSym = s.symbol;
    mk.minuteData = null;                      // 换标的：分时/60分缓存作废，切到时重拉
    minuteAt = 0;
    mk.m60 = null;
    barsReady = true;
    renderKline();
    renderRight();
    showBriefing();
  } catch (e) {
    if ((e as Error).name === "AbortError") return;            // 被新切换中止：静默
    toast((e as Error).message || "K线加载失败");
    return;
  }
  startPoll();
}

/* ── 盘中轮询（策影 WebSocket「原地更新最后一根」的轮询版）：
   12s 拉 quote → 右列刷新 + K 线末根局部更新（不重拉全量序列）。
   后端 kline 已合并今日 bar（守卫 _merge_live_bar），这里只负责盘中跳动；
   行情日 < 末根日（盘前昨收快照）时不动 K 线，与策影 _quote_is_today 同思路。 ── */
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollBusy = false;
/** 上次分时数据刷新时刻（与全景 30s 重载对齐；后端 minute 有 30s TTL） */
let minuteAt = 0;

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
    qcache.set(s.symbol, { q, at: Date.now() });               // 喂缓存：切走再切回时热 quote 秒上屏
    mk.quote = q;
    renderKlpBar();                                            // 顶部现价/涨跌幅跟快照立即跳动
    renderRight();
    // 分时面板：与全景一致随轮询静默刷新（全景 30s 重载；后端 minute 有 30s TTL）
    if (mk.panels.includes("t") && Date.now() - minuteAt > 25_000) {
      minuteAt = Date.now();
      try {
        const d = await marketApi.minute(s.symbol);
        if (mk.cur?.symbol === s.symbol) {
          mk.minuteData = { date: d.date, prevClose: d.prev_close ?? null,
            bars: d.bars.map((b) => ({ ...b, baseline: d.prev_close ?? undefined })) as Bar[] };
          mk.panels.forEach((p, i) => { if (p === "t") applyPanel(i); });
        }
      } catch { /* 分时刷新失败：保留上一帧 */ }
    }
    // 今日尚无真实成交（盘前腾讯 qdate 已切到今天，但 open 仍为 0）：
    // 只刷新右列，绝不动 K 线 —— 否则会补出 open/high/low=0 的假今日 bar
    if (!q.rt_live) return;
    // 分时/60分面板：今日浮根只属于日线序列，分钟周期不合并（右列刷新即可）
    if (mk.panels[mk.active] === "t" || mk.panels[mk.active] === "60") return;
    // 行情归属日优先用 rt_date（腾讯 p[30]）：盘前/周末仍是上一交易日，
    // 用 rt_time（本次抓取时刻）会把昨收当成今天，补出一根假今日 K 线
    const rtDate = (q.rt_date || q.rt_time || q.date || "").slice(0, 10);
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
/** 资讯/研报折叠态：每次进页面都默认折叠，只留 tab 标题条（看得出有几块内容），
 *  高度还给 K 线。不落本地存储——展开只是本次临时查看，刷新后回到默认折叠 */
let briefCollapsed = true;
const briefCache = new Map<string, string>(); // key → 渲染好的 HTML
/** initMarket 接上的「研报高度」同步动作（showBriefing 在模块顶层，拿不到手柄引用） */
let briefShownHook: (() => void) | null = null;

function briefKey(sym: string, t: BriefTab): string {
  return `${sym}|${t}`;
}

function showBriefing(): void {
  const s = mk.cur!;
  const panel = document.getElementById("brief-panel")!;
  panel.hidden = false;
  briefShownHook?.();                    // 露出拖拽手柄并回填已保存的高度
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

/* ── 收藏按钮（心形）+ 快捷分组浮层：
   未收藏一键进「默认」并弹出分组面板；已收藏点击可换组 / 新建组 / 移出，无需开弹窗 ── */
let watchPop: HTMLElement | null = null;

function closeWatchPop(): void {
  watchPop?.remove();
  watchPop = null;
  document.getElementById("kl-watch")?.setAttribute("aria-expanded", "false");
}

function updateWatchBtn(): void {
  const b = document.getElementById("kl-watch");
  if (!b) return;
  const on = mk.cur ? isWatched(mk.cur.symbol) : false;
  b.classList.toggle("on", on);
  b.title = on ? "已收藏 · 点击展开分组设置" : "收藏 · 点击展开分组设置";
  // 心形 + 下拉小三角：让「可展开分组」这一层交互可被看出来
  b.innerHTML = ic(on ? "heart-filled" : "heart", 13) + '<i class="caret"></i>';
  b.setAttribute("aria-expanded", watchPop ? "true" : "false");
  renderKlpBar();                      // 收藏状态变化 → 信息条「标注」入口显隐同步
}

function openWatchPop(): void {
  const s = mk.cur;
  if (!s) return;
  closeWatchPop();
  const pop = document.createElement("div");
  pop.className = "wpop";
  pop.style.visibility = "hidden";

  // 多选：点分组 = 加入/移出该组；取消最后一个分组即整体移出自选
  const toggleG = (g: string) => {
    const w = getState().watchlist.find((x) => x.symbol === s.symbol);
    if (!w) { addWatch(s.symbol, s.name, g); toast(`已收藏 · ${g}`); }
    else {
      const on = toggleWatchGroup(s.symbol, g);
      if (!isWatched(s.symbol)) {
        toast("已移出自选");
      } else {
        const now = getState().watchlist.find((x) => x.symbol === s.symbol)?.groups ?? [];
        toast(`${on ? "已加入" : "已移出"}「${g}」· 当前：${now.join(" / ")}`);
      }
    }
    draw();
  };

  const draw = () => {
    const w = getState().watchlist.find((x) => x.symbol === s.symbol);
    const gsel = w?.groups ?? [];
    pop.innerHTML =
      `<div class="wpop-head"><b>${esc(s.name)}</b><span class="num">${s.symbol}</span></div>` +
      `<div class="wpop-tip">${gsel.length ? `已选：${esc(gsel.join(" / "))}` : "尚未收藏（点分组即加入）"}</div>` +
      `<div class="wpop-list">${allWatchGroups().map((g) =>
        `<button class="wpop-g${gsel.includes(g) ? " on" : ""}" data-g="${esc(g)}">` +
        `<span>${esc(g)}</span>${gsel.includes(g) ? ic("check", 12) : ""}</button>`).join("")}</div>` +
      `<div class="wpop-new"><input class="field" placeholder="新建分组名称"><button class="hbtn" data-act="new">新建</button></div>`;
  };

  pop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const gEl = t.closest<HTMLElement>("[data-g]");
    if (gEl) { toggleG(gEl.dataset.g!); return; }
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "new") {
      const inp = pop.querySelector("input") as HTMLInputElement;
      const name = inp.value.trim();
      if (!name) { inp.focus(); return; }
      addWatchGroup(name);
      toggleG(name);
    }
  });
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const inp = e.target as HTMLInputElement;
      if (inp.tagName === "INPUT") {
        const name = inp.value.trim();
        if (name) { addWatchGroup(name); toggleG(name); }
      }
    }
  });

  draw();
  document.body.appendChild(pop);
  watchPop = pop;
  // 锚定在心形按钮下方；越界自动回收到视口内
  const a = document.getElementById("kl-watch")!.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const left = Math.max(8, Math.min(a.left, innerWidth - pr.width - 8));
  const top = a.bottom + 6 + pr.height > innerHeight - 8 ? Math.max(8, a.top - pr.height - 6) : a.bottom + 6;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.visibility = "visible";
  document.getElementById("kl-watch")?.setAttribute("aria-expanded", "true");
}

export function initMarket(): void {
  initRcolResize();
  initLayoutSeg();
  // 列表行 hover 预取（全局委托：自选/目标/成分/核心标共用 table 组件的 tr[data-key]）：
  // 悬停 120ms 才预热——扫过不触发，停留才拉；点下去时 K线大概率已在缓存里，切换 0 等待
  let hoverT: ReturnType<typeof setTimeout> | null = null;
  document.addEventListener("mouseover", (ev) => {
    if (document.hidden) return;
    const tr = (ev.target as HTMLElement | null)?.closest?.("tr[data-key], [data-go-stock]") as HTMLElement | null;
    if (!tr) return;
    const sym = tr.dataset.key || tr.dataset.goStock || "";
    if (!/^\d{6}(\.[A-Z]{2})?$/.test(sym)) return;             // 只预热股票键；板块等其它键跳过
    if (hoverT) clearTimeout(hoverT);
    hoverT = setTimeout(() => { hoverT = null; warmStock(sym); }, 120);
  });
  // 收藏：未收藏一键入「默认」，已收藏直接开快捷分组浮层；浮层开着再点则收起
  document.getElementById("kl-watch")!.addEventListener("click", () => {
    const s = mk.cur;
    if (!s) return;
    if (watchPop) { closeWatchPop(); return; }
    if (!isWatched(s.symbol)) {
      addWatch(s.symbol, s.name, "默认");
      toast("已收藏 · 默认（可在此处换个分组）");
    }
    openWatchPop();
  });
  // 浮层关闭：点外部 / Esc / 切标的 / 切页 / 窗口尺寸变化
  document.addEventListener("pointerdown", (e) => {
    if (!watchPop) return;
    const t = e.target as HTMLElement;
    if (t.closest(".wpop") || t.closest("#kl-watch")) return;
    closeWatchPop();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeWatchPop(); });
  document.addEventListener("yc:open-stock", () => closeWatchPop());
  document.addEventListener("yc:goto-page", () => closeWatchPop());
  window.addEventListener("resize", () => closeWatchPop());
  subscribe(updateWatchBtn);   // 自选增删/分组变更（含云同步回放）→ 按钮态同步
  updateWatchBtn();
  // 标注：信息条内悬停看全部、点击编辑（事件委托在稳定的容器上）
  const notesEl = document.getElementById("kl-notes")!;
  bindNoteHover(notesEl);
  initNoteEditor();
  notesEl.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("[data-note]") as HTMLElement | null;
    if (!t) return;
    hideNotePop();
    openNoteModal(t.dataset.note!);
  });
  document.addEventListener("yc:notes-changed", () => { if (mk.cur) renderKlpBar(); });
  // 实时价轮询：行情页可见时每 20s 静默刷新当前股 quote（后端 10s 缓存兜东财限流）
  window.setInterval(async () => {
    if (!mk.cur || !document.getElementById("page-market")!.classList.contains("on")) return;
    try {
      const q = await marketApi.quote(mk.cur.symbol);
      if (mk.cur?.symbol !== q.symbol) return;
      mk.quote = q;
      renderRight();
      document.querySelectorAll<HTMLElement>(".klp").forEach(renderKlpBar); // 顶栏信息条同步实时价
    } catch { /* 静默，下轮再试 */ }
  }, 20000);
  // 资讯/研报：折叠开关 + tab 切换（点击已选 tab 不重复请求，走缓存）
  document.getElementById("brief-panel")!.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("#brief-fold")) { applyBriefFold(!briefCollapsed); return; }
    const b = t.closest<HTMLButtonElement>("button[data-bt]");
    if (!b) return;
    if (briefCollapsed) applyBriefFold(false);   // 折叠态点 tab 直接展开
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
  // 布局切换：单屏 / 左右 / 上下 / 四格（上下、四格只显主图，左右可带副图）
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
  // 面板交互：点选焦点（周期切换统一在 chartbar 周期段）
  document.getElementById("kl-panels")!.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const klp = t.closest<HTMLElement>(".klp");
    if (!klp) return;
    const i = Number(klp.dataset.pi);
    if (i !== mk.active) {
      mk.active = i;
      document.querySelectorAll("#kl-panels .klp").forEach((x) =>
        x.classList.toggle("active", x === klp));
      syncPeriodSeg(mk.panels[i]);
      // 框选/单选/连线模式跟着焦点面板走（同一时刻只有一个面板可操作）
      if (document.getElementById("kl-range")?.classList.contains("on")) setKlRangeMode(true);
      if (document.getElementById("kl-pick-mode")?.classList.contains("on")) setKlPickMode(true);
      if (document.getElementById("kl-measure")?.classList.contains("on")) setKlMeasureMode(true);
    }
  });
  // 框选按钮：开=左键直接拖拽统计（图表平移暂停），关=恢复平移并清空区间
  document.getElementById("kl-range")!.addEventListener("click", () => {
    const on = !document.getElementById("kl-range")!.classList.contains("on");
    if (on) { setKlMeasureMode(false); setKlPickMode(false); }   // 框选与单选/连线互斥
    setKlRangeMode(on);
  });
  // 单选 K 线：勾选后才开启「鼠标点击选中单根」，不勾选时点击只移十字光标
  document.getElementById("kl-pick-mode-cb")!.addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    if (on) { setKlMeasureMode(false); setKlRangeMode(false); }   // 单选与框选/连线互斥
    setKlPickMode(on);
  });
  // 连线测量：点第一根吸附最低点 → 点第二根吸附最高点 → 测算区间涨跌幅
  document.getElementById("kl-measure")!.addEventListener("click", () => {
    const on = !document.getElementById("kl-measure")!.classList.contains("on");
    if (on) { setKlRangeMode(false); setKlPickMode(false); }       // 连线与框选/单选互斥
    setKlMeasureMode(on);
  });
  document.addEventListener("yc:kl-range", onKlRange);
  document.addEventListener("yc:kl-pick", onKlPick);
  // 副图窗格右上角 ✕：单独关闭该副图，指标面板 chips / 更多面板同步取消选中
  document.addEventListener("yc:kl-close-sub", (e) => {
    const key = (e as CustomEvent<{ key?: SubKey }>).detail?.key;
    if (!key || !mk.subInds.includes(key)) return;
    mk.subInds = mk.subInds.filter((x) => x !== key);
    saveKPrefs();
    syncIndUI();
    renderKline();
  });
  // 指数 ticker：初始 + 30s 轮询；点击跳转该指数K线
  void loadTicker();
  window.setInterval(() => void loadTicker(), 30000);
  document.getElementById("tickerbar")!.addEventListener("click", (e) => {
    const it = (e.target as HTMLElement).closest<HTMLElement>(".tk-item");
    if (!it || it.dataset.noGo !== undefined) return;   // 海外指数仅展示
    void openStock({ symbol: it.dataset.sym!, name: it.dataset.name || it.dataset.sym! });
  });
  // 观察档位 / 缩放 / 重置（策影工具条同款：纯视图操作，不重载数据）
  // 主/副图快捷组已移除：指标显影统一走「指标」面板（28 指标 6 分类 + 方案，所见即所得）
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
  /* 面板内的点击会触发重渲染（如切换分类 tab），被点的节点在冒泡到 document 时已脱离 DOM，
     closest 查不到祖先、面板就被误判为「点了外面」而关闭。捕获阶段先记下落点，冒泡阶段只认这个标记。 */
  let clickInPanel = false;
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    clickInPanel = !!(t.closest?.("#kl-ipanel,#kl-ipanel-btn,#kl-more,#kl-indbar"));
  }, true);
  document.addEventListener("click", (e) => {
    if (!ipanel.hidden && !clickInPanel) ipanel.hidden = true;
    // 「更多」面板：点击面板与「＋更多」按钮之外的区域时关闭
    const more = document.getElementById("kl-more");
    if (more && !more.hidden && !clickInPanel) more.hidden = true;
  });
  // 更多面板搜索：输入即过滤（列表重渲染保住焦点）；Esc 清空
  document.querySelector<HTMLInputElement>("#kl-more input")?.addEventListener("input", () => renderIndMore());
  document.querySelector<HTMLInputElement>("#kl-more input")?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      (e.target as HTMLInputElement).value = "";
      renderIndMore();
    }
  });
  /* ── 图表/研报分界手柄 ──
     拖拽调的是「研报面板」高度：图表保持 flex:1 自动吃掉剩余空间，底部行情条 flex:none
     永远贴底（旧版给 chartbox 定高，一直拖就把行情条顶出视口）。研报装不下时由
     .brief-body 内部滚动。高度写 yc_briefh，并随 prefs 云同步（登录后跨端记住）。 */
  const vgrip = document.getElementById("kl-vgrip")!;
  const chartbox = vgrip.closest<HTMLElement>(".chartbox")!;
  const briefPanel = document.getElementById("brief-panel")!;
  const klcol = briefPanel.parentElement as HTMLElement;
  const ticker = document.getElementById("tickerbar")!;

  const BRIEF_MIN = 108;   // 露出 tab 行 + 一行条目
  const CHART_MIN = 300;   // 图表最小可用高度

  const colGap = (): number =>
    (parseFloat(getComputedStyle(klcol).rowGap || "8") || 8) * 2;   // chartbox|brief|ticker

  /** 研报可用的最大高度：给图表留足 CHART_MIN */
  const briefMax = (): number => {
    const avail = klcol.clientHeight - ticker.offsetHeight - colGap();
    return Math.max(BRIEF_MIN, Math.round(avail - CHART_MIN));
  };

  /** px 落值；null = 回默认（CSS clamp） */
  const applyBriefH = (px: number | null): void => {
    briefPanel.style.height = px == null ? "" : `${Math.round(px)}px`;
    // 图表恒为 flex:1（吃掉 brief 之外的空间）；旧版「图表定高」的内联写法必须撤掉，
    // 否则底部行情条会被顶出视口
    chartbox.style.flex = "1";
    chartbox.style.minHeight = "0";
    chartbox.style.height = "";
    vgrip.hidden = briefPanel.hidden || briefCollapsed;   // 研报没显示 / 折叠时没有可拖的东西
  };
  /** 折叠/展开资讯研报：折叠只留 tab 标题条，展开回填上次高度（仅本次会话生效） */
  function applyBriefFold(collapsed: boolean): void {
    briefCollapsed = collapsed;
    briefPanel.classList.toggle("collapsed", collapsed);
    const fold = document.getElementById("brief-fold")!;
    fold.setAttribute("aria-expanded", String(!collapsed));
    const label = collapsed ? "展开资讯 / 研报" : "折叠资讯 / 研报";
    fold.title = label;
    fold.setAttribute("aria-label", label);
    if (collapsed) briefPanel.style.height = "";
    else applyBriefH(savedBriefH());
    vgrip.hidden = briefPanel.hidden || collapsed;
  }
  const savedBriefH = (): number | null => {
    const n = Number(localStorage.getItem("yc_briefh"));
    return Number.isFinite(n) && n >= BRIEF_MIN ? n : null;
  };
  localStorage.removeItem("yc_klh");    // 旧口径（图表高度）作废，避免两套互相打架
  applyBriefH(savedBriefH());
  briefShownHook = () => {             // 研报首次出现时：折叠则只露标题条，展开则回填高度
    if (briefCollapsed) { briefPanel.style.height = ""; vgrip.hidden = true; }
    else applyBriefH(savedBriefH());
  };
  applyBriefFold(briefCollapsed);       // 同步折叠态（默认折叠）

  vgrip.addEventListener("pointerdown", (e) => {
    if (briefPanel.hidden) return;
    e.preventDefault();
    vgrip.setPointerCapture(e.pointerId);
    vgrip.classList.add("on");
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const h0 = briefPanel.offsetHeight, y0 = e.clientY;
    const maxH = briefMax();
    let last = h0;
    const onMove = (ev: PointerEvent): void => {
      last = Math.round(Math.min(maxH, Math.max(BRIEF_MIN, h0 - (ev.clientY - y0))));
      applyBriefH(last);
    };
    const onUp = (ev: PointerEvent): void => {
      vgrip.removeEventListener("pointermove", onMove);
      vgrip.removeEventListener("pointerup", onUp);
      vgrip.removeEventListener("pointercancel", onUp);
      vgrip.classList.remove("on");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onMove(ev);
      localStorage.setItem("yc_briefh", String(last));
      notifyLocal("prefs");            // 登录用户 → 云端偏好，换设备也记得
    };
    vgrip.addEventListener("pointermove", onMove);
    vgrip.addEventListener("pointerup", onUp);
    vgrip.addEventListener("pointercancel", onUp);
  });
  vgrip.addEventListener("dblclick", () => {
    applyBriefH(null);
    localStorage.setItem("yc_briefh", "0");   // 哨兵 0 = 默认，云同步也能表达「清掉」
    notifyLocal("prefs");
  });
  // 视口变化：原高度可能已经超过上限（窗口变矮），收回合法区间
  window.addEventListener("resize", () => {
    if (briefCollapsed) return;         // 折叠态交给 CSS 自适应，别把高度又钉回去
    const h = savedBriefH();
    if (h == null) return;
    const capped = Math.min(h, briefMax());
    if (capped !== h) { localStorage.setItem("yc_briefh", String(capped)); applyBriefH(capped); }
  });
  renderIpanel();
  // 指标/方案/配色点击处理：常显两行（#kl-indbar）与方案浮层（#kl-ipanel）共用一套委托
  const indClick = (e: Event): void => {
    const t = e.target as HTMLElement;
    // 绘图按钮的 ×（必须在 data-line 之前：× 也在按钮里）
    if (t.closest("i[data-xline]")) {
      const k = t.closest<HTMLElement>("i[data-xline]")!.dataset.xline!;
      writeLineFavs(readLineFavs().filter((x) => x !== k));
      notifyLocal("prefs");              // 常显集合随云同步跨端一致
      renderIndBar();
      renderIndMore();
      return;
    }
    if (t.closest("button[data-line]")) {                  // 智能画线：黄金分割 / 支撑压力 / 浪型 / 箱体 / 形态
      toggleLine((t.closest("button[data-line]") as HTMLElement).dataset.line || "fib");
      notifyLocal("prefs");
      renderIndBar();
      applyLines();
      return;
    }
    if (t.closest("i[data-pdel]")) {                       // 删除自定义方案
      const name = t.closest("i")!.dataset.pdel!;
      const map = readCustomPresets();
      if (map[name] && confirm(`删除自定义方案「${name}」？`)) {
        delete map[name];
        localStorage.setItem("yc_klpresets", JSON.stringify(map));
        renderIpanel();
      }
      return;
    }
    // ★ 常显标：切换常显集合（不在 button 里，必须放在下方 button 短路检查之前）
    if (t.closest("i[data-fav]")) {
      const k = t.closest("i")!.dataset.fav!;
      const favs = new Set(readIndFavs());
      if (favs.has(k)) favs.delete(k); else favs.add(k);
      writeIndFavs([...favs]);
      notifyLocal("prefs");              // ★ 常显集合也走云端偏好：换浏览器/换端一致
      renderIpanel();
      return;
    }
    // 绘图 ★：常显到工具栏绘图行（与上面指标 ★ 平行的独立集合）
    if (t.closest("i[data-lfav]")) {
      const k = t.closest<HTMLElement>("i[data-lfav]")!.dataset.lfav!;
      const favs = new Set(readLineFavs());
      if (favs.has(k)) favs.delete(k); else favs.add(k);
      writeLineFavs([...favs]);
      notifyLocal("prefs");
      renderIndBar();
      renderIndMore();
      return;
    }
    // 特色指标锁定行：必须先于下面的显影切换，否则点击会直接叠加上图
    if (t.closest(".imr.vip-locked")) {
      openModal("modal-vip");
      return;
    }
    // 更多面板「绘图」行：整行点击 = 叠加/取消绘图
    const lrow = t.closest<HTMLElement>(".imr[data-lrow]");
    if (lrow) {
      toggleLine(lrow.dataset.lrow!);
      notifyLocal("prefs");
      renderIndBar();
      renderIndMore();
      applyLines();
      return;
    }
    // 更多面板行（.imr）：整行点击 = 显影切换
    const imr = t.closest<HTMLElement>(".imr[data-mi], .imr[data-si]");
    if (imr) {
      const k = imr.dataset.mi ?? imr.dataset.si!;
      const s = new Set(imr.dataset.mi ? mk.mainInds : mk.subInds);
      s.has(k) ? s.delete(k) : s.add(k);
      if (imr.dataset.mi) mk.mainInds = [...s]; else mk.subInds = [...s];
      saveKPrefs();
      syncIndUI();
      renderKline();
      return;
    }
    const b = t.closest("button") as HTMLElement | null;
    if (!b) return;
    if (b.dataset.psave) {                                 // 当前组合存为自定义方案
      const name = (prompt("方案名称（将保存当前主/副图指标组合）", `我的方案${Object.keys(readCustomPresets()).length + 1}`) || "").trim();
      if (!name) return;
      if (PRESETS[name]) { toast("与内置方案重名，请换个名字"); return; }
      const map = readCustomPresets();
      map[name] = { main: [...mk.mainInds], sub: [...mk.subInds] };
      localStorage.setItem("yc_klpresets", JSON.stringify(map));
      toast(`已保存方案「${name}」`);
      renderIpanel();
      return;
    }
    if (b.dataset.pre) {                                   // 方案：内置 + 自定义，一键切换
      const p = { ...PRESETS, ...readCustomPresets() }[b.dataset.pre];
      if (p) applyPreset(p);
      return;
    }
    if (b.dataset.tpl) {                                   // 趋势通道配色 A/B/C/D
      setTrendPalette(b.dataset.tpl);
      syncIndUI();
      renderKline();
      notifyLocal("prefs");
      return;
    }
    if (b.dataset.more) {                                  // 「＋更多」：开合配置面板
      const more = document.getElementById("kl-more")!;
      more.hidden = !more.hidden;
      if (!more.hidden) {
        renderIndMore();
        more.querySelector<HTMLInputElement>("input")?.focus();
      }
      return;
    }
    if (b.dataset.mtab) {                                  // 更多面板：tab 分类切换
      localStorage.setItem(MORE_TAB_LS, b.dataset.mtab);
      renderIndMore();
      return;
    }
    if (t.dataset.xshow || t.closest("i[data-xshow]")) {   // chip 悬停 ×：移出常显（显影不变）
      const k = ((t.closest<HTMLElement>("i[data-xshow]") ?? t) as HTMLElement).dataset.xshow;
      if (k) {
        writeIndFavs(readIndFavs().filter((x) => x !== k));
        notifyLocal("prefs");           // 同 ★：常显集合变了就推云端
        renderIndBar();
      }
      return;
    }
    const group = b.dataset.mi ? "main" : "sub";
    b.classList.toggle("on");
    if (group === "main")
      mk.mainInds = [...document.querySelectorAll<HTMLElement>("#kl-indbar button[data-mi].on, #kl-ipanel button[data-mi].on")].map((x) => x.dataset.mi as MainKey);
    else
      mk.subInds = [...document.querySelectorAll<HTMLElement>("#kl-indbar button[data-si].on, #kl-ipanel button[data-si].on")].map((x) => x.dataset.si as SubKey);
    saveKPrefs();
    syncIndUI();
    renderIpanel();
    renderKline();
  };
  ipanel.addEventListener("click", indClick);
  document.getElementById("kl-indbar")!.addEventListener("click", indClick);
  document.getElementById("kl-more")!.addEventListener("click", indClick);
  window.addEventListener("resize", () => {
    clearTimeout((window as unknown as { _rz?: number })._rz);
    (window as unknown as { _rz?: number })._rz = window.setTimeout(() => {
      if (document.getElementById("page-market")!.classList.contains("on")) klResize();
    }, 160);
  });
  // 主题 / 涨跌方向 / 强调色变化 → 各面板图表重上色；右列卡重渲染；
  // 登录态变化 → applyRcolW 按 new user 记忆重放卡片栏宽度
  subscribe(() => {
    sanitizeVipInds();                       // 登出/体验到期：特色指标立即收起
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
    // 研报高度也随 prefs 回来（换设备登录后同一套版面）；折叠态不写内联高度，
    // 否则 CSS 的 auto 会被 108px 覆盖，看起来像一块「展开的空白面板」
    if (!briefCollapsed) {
      const bh = Number(localStorage.getItem("yc_briefh"));
      applyBriefH(Number.isFinite(bh) && bh >= BRIEF_MIN ? Math.min(bh, briefMax()) : null);
    }
    syncIndUI();
    renderIpanel();
    renderKline();
  });
  sanitizeVipInds();                       // 启动即清：未登录/免费不落特色指标（默认预设也不含）
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
    const aSym = i.symbol.includes(".");   // 海外指数（usDJI/hkHSI）无 K 线跳转，仅展示
    return `<span class="tk-item" data-sym="${i.symbol}" data-name="${i.name}" title="${aSym ? `查看 ${i.name} K线` : `${i.name} · 海外指数`}"${aSym ? "" : ' data-no-go'}>` +
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

/** 指标显影双源同步：mk.mainInds/subInds → 常显两行 + 方案浮层 chips 的 on 态 */
function syncIndUI(): void {
  const mset = new Set(mk.mainInds), sset = new Set(mk.subInds);
  const sel = "#kl-indbar, #kl-ipanel";               // 常显两行 + 方案/配色浮层
  document.querySelectorAll<HTMLElement>(`${sel} button[data-mi]`).forEach((x) =>
    x.classList.toggle("on", mset.has(x.dataset.mi as MainKey)));
  document.querySelectorAll<HTMLElement>(`${sel} button[data-si]`).forEach((x) =>
    x.classList.toggle("on", sset.has(x.dataset.si as SubKey)));
  // 通道配色选中态（单选）+ 短/中线趋势色点跟随当前调色板
  const key = trendPaletteKey();
  const pal = TRENDS[key];
  document.querySelectorAll<HTMLElement>(`${sel} button[data-tpl]`).forEach((x) =>
    x.classList.toggle("on", x.dataset.tpl === key));
  document.querySelectorAll<HTMLElement>(`${sel} button[data-mi='short'],${sel} button[data-mi='mid']`)
    .forEach((x) => x.style.setProperty("--ic", x.dataset.mi === "short" ? pal.fast : pal.slow));
  renderIndBar();
  renderIndMore();
}

/** 指标渲染：常显两行（主图叠加 / 副图窗格）+ 方案浮层（内置+自定义+存为方案）+ ★常用标 */
function renderIpanel(): void {
  const pres = document.getElementById("ip-presets");
  if (!pres) return;
  const custom = readCustomPresets();
  const sig = JSON.stringify([mk.mainInds, mk.subInds]);
  const isOn = (p: Preset) => JSON.stringify([p.main, p.sub]) === sig;
  // 方案卡第二行：主/副图指标名，选方案前就能看清里面装了什么（设计图同款）
  const names = (keys: (MainKey | SubKey)[]) => keys.map((k) => IND_BY_KEY[k]?.label ?? k).join("+");
  const metaOf = (p: Preset) => `主 ${names(p.main) || "仅K线"} · 副 ${names(p.sub) || "无"}`;
  const card = (n: string, p: Preset) =>
    `<button class="preset${isOn(p) ? " on" : ""}" data-pre="${esc(n)}" title="应用方案「${esc(n)}」：${esc(metaOf(p))}">` +
    `<b>${esc(n)}</b><span>${esc(metaOf(p))}</span></button>`;
  const cards: string[] = Object.entries(PRESETS)
    .map(([n, p]) => card(n, p))
    .concat(Object.entries(custom).map(([n, p]) =>
      `<span class="presetwrap">${card(n, p)}<i class="pdel" data-pdel="${esc(n)}" title="删除方案">×</i></span>`))
    .concat([`<button class="preset psave" data-psave="1" title="把当前主/副图指标组合保存为自定义方案">` +
      `<b>＋存方案</b><span>保存当前组合</span></button>`]);
  pres.innerHTML = cards.join("");
  renderIndBar();
  renderIndMore();
}

/** 分类色点：chip/更多列表共用（分类归属一眼可辨） */
const CAT_IC: Record<string, string> = { main: "#FF9F43", trend: "#F2C94C", mom: "#4DD0E1", vol: "#EF5350", swing: "#7E57C2", volat: "#26C6DA" };

/* ── VIP 特色指标（体验期/VIP 解锁，免费到期灰显锁定） ── */
const VIP_KEYS = ["short", "mid", "qyjj", "strongpullback", "trendhistogram",
  "stockoperate", "accumulation", "volumeactivity"];
const vipLocked = (key: string): boolean => VIP_KEYS.includes(key) && !isVip();
/** 免费/体验到期：把已叠加的特色指标从显影集合清掉（默认预设也不落 VIP 指标） */
function sanitizeVipInds(): void {
  if (isVip()) return;
  const before = mk.mainInds.length + mk.subInds.length;
  mk.mainInds = mk.mainInds.filter((k) => !VIP_KEYS.includes(k));
  mk.subInds = mk.subInds.filter((k) => !VIP_KEYS.includes(k));
  if (mk.mainInds.length + mk.subInds.length !== before) {
    saveKPrefs();
    toast("体验期已结束，特色指标已收起");
  }
}
/** 更多面板 tab（全部 / 主图叠加 / 副图 / 6 分类 / 绘图），选中持久化。
 *  「副图」把全部副图指标归到一处，内部仍按趋势/动量/量能等分组。 */
const MORE_TAB_LS = "yc_kl_more_tab";
function moreTab(): string {
  const v = localStorage.getItem(MORE_TAB_LS);
  const ids = ["all", ...IND_CATS.map((c) => c.cat), "sub", "lines"];
  return ids.includes(v || "") ? (v as string) : "all";
}

/** 常显两行（#ip-inds）：只渲染 yc_indfav 常显集合；chip 点击=显影切换、悬停 × =移出常显；
 *  副图行尾「＋更多」开配置面板（搜索 + 全量 33 指标）。 */
function renderIndBar(): void {
  const inds = document.getElementById("ip-inds");
  if (!inds) return;
  const mset = new Set(mk.mainInds), sset = new Set(mk.subInds);
  const favs = readIndFavs();
  const chipOf = (d: (typeof IND_DEFS)[number]) =>
    `<button style="--ic:${CAT_IC[d.cat] || "transparent"}" data-${d.where === "main" ? "mi" : "si"}="${d.key}" title="${esc(d.desc)}（${d.where === "main" ? "主图" : "副图"}）· 点击显影/隐藏" ${(d.where === "main" ? mset : sset).has(d.key) ? 'class="on"' : ""}>${d.label}` +
    `<i class="x" data-xshow="${d.key}" title="移出常显（不影响当前显影）">×</i></button>`;
  const main = favs.map((k) => IND_BY_KEY[k]).filter((d) => d?.where === "main");
  const sub = favs.map((k) => IND_BY_KEY[k]).filter((d) => d?.where === "sub");
  const lines = readLineFavs().map((k) => LINE_BY_KEY[k as LineKey]);
  const lineOf = (d: (typeof LINE_DEFS)[number]) =>
    `<button data-line="${d.key}" class="${lineOn(d.key) ? "on" : ""}" title="${esc(d.desc)} · 点击叠加/取消">${d.label}` +
    `<i class="x" data-xline="${d.key}" title="移出常显（不影响当前绘图）">×</i></button>`;
  const hint = `<span class="ipempty">在「＋更多」里勾选 ★ 常显</span>`;
  // 单行布局：主图组 + 分割线 + 副图组 + 分割线 + 画线组 + 「＋更多」
  inds.innerHTML =
    `<div class="iprow"><span class="ipk">主图</span>${main.map(chipOf).join("") || hint}</div>` +
    `<i class="barsep"></i>` +
    `<div class="iprow"><span class="ipk">副图</span>${sub.map(chipOf).join("") || hint}</div>` +
    `<i class="barsep"></i>` +
    `<div class="iprow"><span class="ipk">绘图</span>${lines.map(lineOf).join("") || hint}</div>` +
    `<button class="imore-open" data-more="1" title="全部指标 / 绘图工具：搜索 / 配置常显 / 临时叠加">＋更多</button>`;
}

/** 更多面板列表（#kl-more-list）：tab 分类过滤 + 搜索叠加；点行=显影切换，★=常显切换。
 *  VIP 特色指标：行尾金色皇冠；免费（体验到期）灰显锁定，点击弹 VIP 开通。
 *  搜索框/底注是 index.html 静态壳，这里只填列表（保住输入焦点）。 */
function renderIndMore(): void {
  const list = document.getElementById("kl-more-list");
  const tabsEl = document.getElementById("kl-more-tabs");
  if (!list) return;
  const q = (document.querySelector<HTMLInputElement>("#kl-more input")?.value || "").trim().toLowerCase();
  const tab = moreTab();
  if (tabsEl) {
    // 「副图」紧跟主图，其余按分类；末位是绘图工具
    const tabs = [{ id: "all", label: "全部" }, { id: "main", label: IND_CATS[0].label }, { id: "sub", label: "副图" }]
      .concat(IND_CATS.slice(1).map((c) => ({ id: c.cat, label: c.label })))
      .concat([{ id: "lines", label: "绘图" }]);
    tabsEl.innerHTML = `<span class="seg im-tabs-seg">` +
      tabs.map((t) => `<button class="${tab === t.id ? "on" : ""}" data-mtab="${t.id}">${t.label}</button>`).join("") +
      `</span>`;
  }
  const mset = new Set(mk.mainInds), sset = new Set(mk.subInds);
  const favs = new Set(readIndFavs());
  const lfavs = new Set(readLineFavs());
  const inTab = (d: (typeof IND_DEFS)[number]): boolean =>
    tab === "all" ? true : tab === "sub" ? d.where === "sub" : d.cat === tab;
  const hit = (d: (typeof IND_DEFS)[number]) =>
    inTab(d) && (!q || d.label.toLowerCase().includes(q) || d.desc.toLowerCase().includes(q) || d.key.includes(q) || d.kc.toLowerCase().includes(q));
  const row = (d: (typeof IND_DEFS)[number]) => {
    const isOn = (d.where === "main" ? mset : sset).has(d.key);
    const vip = VIP_KEYS.includes(d.key);
    const locked = vipLocked(d.key);
    return `<div class="imr${isOn ? " on" : ""}${locked ? " vip-locked" : ""}" data-${d.where === "main" ? "mi" : "si"}="${d.key}" title="${esc(d.desc)} · 点击${isOn ? "移除显影" : "叠加显影"}${locked ? "（VIP 特色指标）" : ""}">` +
      `<i class="dot" style="--ic:${CAT_IC[d.cat] || "transparent"}"></i><b>${d.label}</b>` +
      (vip ? `<i class="im-vip" title="VIP 特色指标${locked ? " · 开通后解锁" : ""}">◆</i>` : "") +
      `<span class="im-desc">${esc(d.desc)}</span>` +
      `<i class="star${favs.has(d.key) ? " on" : ""}" data-fav="${d.key}" title="${favs.has(d.key) ? "取消常显" : "常显到工具栏"}">★</i></div>`;
  };
  // 绘图工具：与指标同款交互（行=叠加/取消，★=常显到工具栏绘图行）；绘图不设 VIP 锁
  const lineHit = (d: (typeof LINE_DEFS)[number]) =>
    (tab === "all" || tab === "lines") && (!q || d.label.toLowerCase().includes(q) || d.desc.toLowerCase().includes(q) || d.key.includes(q));
  const lineRow = (d: (typeof LINE_DEFS)[number]) => {
    const isOn = lineOn(d.key);
    return `<div class="imr${isOn ? " on" : ""}" data-lrow="${d.key}" title="${esc(d.desc)} · 点击${isOn ? "取消叠加" : "叠加到主图"}">` +
      `<i class="dot" style="--ic:#7E57C2"></i><b>${d.label}</b>` +
      `<span class="im-desc">${esc(d.desc)}</span>` +
      `<i class="star${lfavs.has(d.key) ? " on" : ""}" data-lfav="${d.key}" title="${lfavs.has(d.key) ? "取消常显" : "常显到工具栏"}">★</i></div>`;
  };
  // 「副图」要看全部副图指标，分组遍历所有分类；其余 tab 只遍历命中的分类
  const indHtml = IND_CATS.filter(({ cat }) => tab === "all" || tab === "sub" || cat === tab)
    .map(({ cat, label }) => {
      const defs = IND_DEFS.filter((d) => d.cat === cat && hit(d));
      return defs.length ? `<div class="im-cat">${label}</div>${defs.map(row).join("")}` : "";
    }).join("");
  const lineHtml = (tab === "all" || tab === "lines")
    ? LINE_DEFS.filter(lineHit).map(lineRow).join("") : "";
  list.innerHTML = (indHtml + (lineHtml ? `<div class="im-cat">绘图</div>${lineHtml}` : ""))
    || `<div class="im-none">没有匹配「${esc(q)}」的指标 / 绘图工具</div>`;
}

/** 日线 → 自然周/月/季线：确定性重采样（开=首根、高=max、低=min、收=末根、量额求和）。
 *  分桶按自然边界（ISO 周 / 自然月 / 自然季），与通达信/众赢同口径；
 *  bar 日期取桶内最后一个交易日（周线=该周最后交易日、月线=月末、季线=季末）。 */
export type AggBucket = "w" | "m" | "q";

function bucketKey(date: string, k: AggBucket): string {
  if (k === "w") {
    // ISO 周按该周周四归属年份：跨年周（12/29~1/4）不会被拆成两根
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const y = d.getUTCFullYear();
    const w = Math.ceil(((d.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
    return `${y}W${String(w).padStart(2, "0")}`;
  }
  if (k === "m") return date.slice(0, 7);
  return `${date.slice(0, 4)}Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
}

export function aggDaily(daily: Bar[], k: AggBucket): Bar[] {
  const out: Bar[] = [];
  let key = "";
  let o: Bar | null = null, l: Bar | null = null;
  let hi = 0, lo = 0, vol = 0, amt = 0;
  const flush = () => {
    if (o && l) out.push({
      date: l.date, open: o.open, high: hi, low: lo, close: l.close,
      volume: vol, amount: amt,
    });
  };
  for (const b of daily) {
    const kb = bucketKey(b.date, k);
    if (kb !== key) {
      flush();
      key = kb; o = b; hi = b.high; lo = b.low; vol = 0; amt = 0;
    }
    hi = Math.max(hi, b.high); lo = Math.min(lo, b.low);
    vol += b.volume || 0; amt += b.amount || 0;
    l = b;
  }
  flush();
  return out;
}

export function barsFor(p: PKey): Bar[] {
  if (p === "t") return mk.minuteData?.bars ?? [];
  if (p === "60") return mk.m60 ?? [];
  return p === "d" ? mk.bars : aggDaily(mk.bars, p);
}

/** 分时/60分数据按需拉取（后端 TTL 缓存 30s/120s，重复切回不打接口） */
export async function ensurePeriodData(p: PKey): Promise<void> {
  const s = mk.cur;
  if (!s) return;
  try {
    if (p === "t" && (!mk.minuteData || !mk.minuteData.bars.length)) {
      const d = await marketApi.minute(s.symbol);
      if (mk.cur?.symbol !== s.symbol) return;
      mk.minuteData = { date: d.date, prevClose: d.prev_close ?? null,
        bars: d.bars.map((b) => ({ ...b, baseline: d.prev_close ?? undefined })) as Bar[] };
      minuteAt = Date.now();
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
/** 智能画线开关应用到全部 K 线实例（四格/双图各自一份） */
function applyLines(): void {
  kls.forEach((k) => k?.setLines(mk.lineFib, mk.lineSR, mk.lineWave, mk.lineBox, mk.linePat));
}
/* 面板外壳（与全景右下角同一个 chartpanel 控件；行情页关头部，信息条全局共享） */
let chartPanels: ChartPanelHandle[] = [];
/* 分时面板：与全景右下角同一套独立 canvas 分时图（左涨跌幅/右价格/均价/昨收虚线/量柱） */
const intras: (IntradayHandle | null)[] = [];
const intraEls: HTMLElement[] = [];

/** 焦点面板句柄（chartbar 周期段/观察档/缩放作用于它） */
function activeKl(): KlineChartHandle | null {
  return kls[mk.active] ?? kls[0] ?? null;
}

/** 供外部（侧栏拖拽/窗口 resize）触发的图表重排 */
export function klResize(): void {
  kls.forEach((k) => k?.resize());
  intras.forEach((k) => k?.resize());
}

/* ── 框选区间统计（策影鼠标框选移植）──
   图表只负责"选出哪一段 + 价格/量额"，标的与资金在这里补齐：
   kline.ts 抛 yc:kl-range → 本次会话拉 /market/fundflow → 回填浮窗卡片 + 右列资金卡。
   指数没有个股资金流（后端 available=false），前端降级为「仅成交额」，不当错误。 */
let rangeToken = 0;

/** 框选模式开关：同时只作用于焦点面板，其余面板恢复平移 */
function setKlRangeMode(on: boolean): void {
  kls.forEach((k, i) => k?.setRangeMode(on && i === mk.active));
  document.getElementById("kl-range")?.classList.toggle("on", on);
  if (!on) {
    mk.range = null;
    renderRight();
  }
}

/** 单选 K 线模式开关：同样只作用于焦点面板；未勾选时点击不选中单根 */
function setKlPickMode(on: boolean): void {
  kls.forEach((k, i) => k?.setPickMode(on && i === mk.active));
  document.getElementById("kl-pick-mode")?.classList.toggle("on", on);
  const cb = document.getElementById("kl-pick-mode-cb") as HTMLInputElement | null;
  if (cb) cb.checked = on;
}

/** 连线测量模式开关：只作用于焦点面板；开=点第一根取最低、点第二根取最高，算涨跌幅 */
function setKlMeasureMode(on: boolean): void {
  kls.forEach((k, i) => k?.setMeasureMode(on && i === mk.active));
  document.getElementById("kl-measure")?.classList.toggle("on", on);
}

async function fetchRangeFund(rs: RangeStats): Promise<void> {
  const s = mk.cur;
  if (!s) return;
  const token = ++rangeToken;
  try {
    const r: FundFlowRange = await marketApi.fundflow({
      symbol: s.symbol, start: rs.startDate, end: rs.endDate, limit: 800,
    });
    if (token !== rangeToken || !mk.range) return;
    const t = r.totals;
    mk.range.fund = {
      available: r.available && !!t,
      covered: r.covered,
      net_main: t?.net_main ?? null, net_super: t?.net_super ?? null,
      net_large: t?.net_large ?? null, net_medium: t?.net_medium ?? null,
      net_small: t?.net_small ?? null,
    };
    mk.range.note = r.note ?? null;
    mk.range.loading = false;
    activeKl()?.setRangeFund(mk.range.fund);   // 浮窗卡片补资金行
    renderRight();                             // 右列资金卡切区间口径
  } catch (e) {
    if (token !== rangeToken || !mk.range) return;
    mk.range.loading = false;
    mk.range.fund = null;
    mk.range.note = (e as Error).message || "资金流拉取失败";
    activeKl()?.setRangeFund(null);
    renderRight();
  }
}

/** 图表框选回调（detail=null 表示清空选区） */
function onKlRange(e: Event): void {
  const d = (e as CustomEvent).detail as RangeStats | null;
  if (!d) {
    if (!mk.range) return;
    mk.range = null;
    renderRight();
    return;
  }
  if (!mk.cur) return;
  mk.pick = null;                              // 区间取代单根（同一张卡只表达一个口径）
  mk.range = { ...d, fund: null, loading: true, note: null };
  renderRight();
  void fetchRangeFund(d);
}

/* ── 资金卡「单日态」：点击某根 K 线 → 该交易日的资金流 ──
   价格侧用被点那根 bar 的口径（不是最新价），资金来自 /market/fundflow 单日；
   分时/60 分周期的资金流是按日采集的，没有对应粒度 —— 只报成交额，不白拉接口。 */
let pickToken = 0;

async function fetchPickFund(date: string): Promise<void> {
  const s = mk.cur;
  if (!s || !mk.pick || mk.pick.date !== date) return;
  const token = ++pickToken;
  try {
    const r: FundFlowRange = await marketApi.fundflow({
      symbol: s.symbol, start: date, end: date, limit: 8,
    });
    if (token !== pickToken || !mk.pick || mk.pick.date !== date) return;
    const it = r.items?.[0] ?? null;
    mk.pick.fund = {
      available: r.available && !!it, covered: it ? 1 : 0,
      net_main: it?.net_main ?? null, net_super: it?.net_super ?? null,
      net_large: it?.net_large ?? null, net_medium: it?.net_medium ?? null,
      net_small: it?.net_small ?? null,
    };
    mk.pick.note = r.note ?? (it ? null : "该日暂无资金流数据（可能非交易日）");
    mk.pick.loading = false;
    renderRight();
  } catch (e) {
    if (token !== pickToken || !mk.pick || mk.pick.date !== date) return;
    mk.pick.loading = false;
    mk.pick.fund = null;
    mk.pick.note = (e as Error).message || "资金流拉取失败";
    renderRight();
  }
}

/** 图表单根选中回调（detail=null 表示取消选中） */
function onKlPick(e: Event): void {
  const d = (e as CustomEvent).detail as PickBar | null;
  if (!d) {
    if (!mk.pick) return;
    mk.pick = null;
    renderRight();
    return;
  }
  if (!mk.cur) return;
  mk.range = null;                             // 单根取代区间
  const intraday = d.date.length > 10;         // 分时/60分：无按日资金流
  mk.pick = {
    ...d, fund: null, loading: !intraday,
    note: intraday ? "分时 / 60 分周期的资金流只有按日口径，切到日线可看该日资金" : null,
  };
  renderRight();
  if (!intraday) void fetchPickFund(d.date);
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
  chartPanels.forEach((p) => p.destroy());
  chartPanels = [];
  intras.forEach((k) => k?.destroy());
  intras.length = 0;
  intraEls.length = 0;
  kls = [];
  panelKey.length = 0;                         // 实例重建：视图窗口记忆作废（新画布从最新开始）
  box.dataset.sig = sig;
  box.className = `kl-panels ly-${ly}`;
  // 面板仅承载图表本体：周期/布局/档位/缩放全部在 chartbar，信息条全局共享
  box.innerHTML = slots.map((p, i) =>
    `<div class="klp${i === mk.active ? " active" : ""}" data-pi="${i}"></div>`).join("");
  box.querySelectorAll<HTMLElement>(".klp").forEach((el, i) => {
    const panel = createChartPanel(el, { head: "none" });
    chartPanels.push(panel);
    kls.push(panel.chart);
    // 分时层：与全景同一套 canvas 分时图，切到「分时」时显示、其余周期隐藏
    const intraEl = document.createElement("div");
    intraEl.className = "klp-intra";
    intraEl.hidden = true;
    el.appendChild(intraEl);
    intraEls[i] = intraEl;
    intras[i] = null;
  });
}

/** 应用单个面板：周期聚合 + 指标（副图仅左右布局）+ 数据 + 图内图例 */
const panelKey: string[] = [];                 // symbol|period：判「同标的重灌」还是「换标的」
function applyPanel(i: number): void {
  const kl = kls[i];
  if (!kl || !mk.cur) return;
  const p = mk.panels[i] ?? "d";
  const isIntra = p === "t";
  // 分时面板：与全景右下角同一套 canvas 分时图（左涨跌幅/右价格/均价线/昨收虚线/量柱），
  // 容器里隐藏 klinecharts 本体；其余周期恢复 K 线并重算尺寸（隐藏期间画布宽高为 0）
  const mount = intraEls[i] ?? null;
  mount?.parentElement?.classList.toggle("intra", isIntra);
  if (mount) mount.hidden = !isIntra;
  if (isIntra) {
    if (!intras[i]) intras[i] = createIntraday(mount!);
    const d = mk.minuteData;
    // 盘前/采集未就绪：分时源给空数组，画时段网格并提示（与全景同一组件的空态）
    if (d && !d.bars.length) intras[i]!.setMessage("今日分时数据尚未生成");
    else intras[i]!.setData(d ? {
      symbol: mk.cur.symbol, date: d.date, prev_close: d.prevClose, bars: d.bars,
    } : null);
    intras[i]!.resize();
    return;
  }
  if (panelKey[i]?.endsWith("|t")) requestAnimationFrame(() => kl.resize());
  kl.setPeriod(p);                             // 季线走自然季聚合，独立周期标签
  // 分时主图固定为均价线（MA/趋势通道对每分钟假 K 线无意义），其余周期走默认预设
  kl.setMain(mk.mainInds);
  kl.setSub(SUB_OK[currentLayout()]?.[i] ? mk.subInds : []);
  kl.setLines(mk.lineFib, mk.lineSR, mk.lineWave, mk.lineBox, mk.linePat);
  // 同标的同周期的重灌（盘中 12s 轮询）保留视图窗口，换标的/切周期才回到最新
  const key = `${mk.cur.symbol}|${p}`;
  const keep = panelKey[i] === key;
  panelKey[i] = key;
  // 仅个股使用换手率反推股本，指数换手率不代表股票流通股本。
  const symParts = mk.cur.symbol.split(".");
  const code = symParts[0];
  const market = (symParts[1] ?? mk.quote?.market ?? (code.startsWith("6") ? "sh" : /^(0|3)/.test(code) ? "sz" : "bj")).toLowerCase();
  const stock = market === "sh" ? /^(600|601|603|605|688|689)/.test(code)
    : market === "sz" ? /^(000|001|002|003|300|301)/.test(code)
    : market === "bj" && /^(4|8|92)/.test(code);
  kl.setData(barsFor(p), keep, stock ? (estimateFloatShares(mk.bars) ?? estimateFloatShares(mk.quote ? [mk.quote] : [])) : null,
    p === "d" ? mk.cur.trendFocus?.date : undefined, mk.cur.symbol);
  if (p === "d") delete mk.cur.trendFocus;
  kl.drawLegend(SUB_OK[currentLayout()]?.[i] ? [...mk.mainInds] : mk.mainInds);
}

/** 个股信息条（chartbox 最顶，东财网页头部同款）：名称+代码+行业 | 现价 涨跌幅 | 开 高 低 昨收。
 *  多面板共享一条（同标的只显一次）；HTML 由 chartpanel.quoteHeadHtml 统一渲染。 */
function renderKlpBar(): void {
  const s = mk.cur, q = mk.quote;
  const bar = document.getElementById("kl-symbar");
  const head = document.getElementById("kl-head");
  if (!bar || !head || !s) return;
  bar.hidden = false;
  // 现价/涨跌幅：今日已有成交（rt_live）才用实时价；盘前回到上一交易日收盘口径
  const bars = barsSym === s.symbol ? mk.bars : [];          // 换标的后旧K线不参与新标的价格计算
  const view = quoteView(q, bars);
  head.innerHTML = quoteHeadHtml({
    name: s.name || s.symbol,
    code: s.symbol,
    industry: q?.industry,
    price: view.price,
    pct: view.pct,
    open: view.open,
    high: view.high,
    low: view.low,
    prevClose: view.base,
  }, "full", true);
  // 标注入口：已收藏才显示；有标注时常显最新一条，悬停看全部，点击编辑
  const notesEl = document.getElementById("kl-notes");
  if (notesEl) notesEl.innerHTML = noteChipHtml(s.symbol, "bar");
}

export function renderKline(): void {
  const empty = document.getElementById("kl-empty")!;
  if (!mk.cur || !mk.bars.length) {
    empty.style.display = "grid";
    kls.forEach((k) => k?.setData([]));
    document.getElementById("kl-symbar")?.setAttribute("hidden", "");
    return;
  }
  empty.style.display = "none";
  ensurePanelDom();
  kls.forEach((_, i) => applyPanel(i));
  // 布局/周期切换可能重建面板实例：框选/单选/连线态跟着按钮态恢复（否则按钮亮着但鼠标行为没生效）
  if (document.getElementById("kl-range")?.classList.contains("on")) setKlRangeMode(true);
  const pickCb = document.getElementById("kl-pick-mode-cb") as HTMLInputElement | null;
  if (pickCb?.checked) setKlPickMode(true);
  if (document.getElementById("kl-measure")?.classList.contains("on")) setKlMeasureMode(true);
  renderKlpBar();
  // 分时/60分面板：换标的后缓存已清，按需补拉（策略图面：先空后满）
  const need = mk.panels.find((p) =>
    (p === "t" && (!mk.minuteData || !mk.minuteData.bars.length)) || (p === "60" && !mk.m60));
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
  // 切周期 → 单根选中/框选区间/连线测量失效（日线的「某一天」在周线/分时上没有对应 bar）
  if (mk.pick || mk.range) {
    mk.pick = null;
    mk.range = null;
    kls.forEach((k) => { k?.clearPick(false); k?.clearRange(false); });
    renderRight();
  }
  kls.forEach((k) => k?.clearMeasure());
  applyPanel(i);                               // 先渲染（缓存命中即刻有数据）
  void ensurePeriodData(p).then(() => {
    if (mk.panels[i] === p) applyPanel(i);     // 数据到达后重渲（未命中缓存时）
  });
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
/* ── 资金流卡通用件 ──
   约定：进红退绿（cn 口径下 --up 红 / --down 绿，随 data-dir 切换自动翻转），
   数值恒带符号、恒以亿为单位；条形以零轴为中心左负右正 —— 方向与量级一眼可读。 */
type FlowItem = [string, number | null];

/** 方向色：正=流入(红) 负=流出(绿)；不到半个显示单位（50 万）视作持平（中性色） */
function flowCls(v: number | null | undefined): string {
  if (v == null || !isFinite(v) || Math.abs(v) < 5e5) return "";
  return v > 0 ? "up" : "down";
}

/** 四档明细是否可信：新浪资金流有些交易日只回主力合计（分档全 0）。
 *  四档代数和与主力差太远，就说明分档没覆盖 —— 此时别摆一排 0.00亿 冒充明细。 */
function flowDetailOk(items: FlowItem[], main: number | null): boolean {
  if (main == null || Math.abs(main) < 1e7) return true;          // 主力本身就小，分档为 0 无伤
  const sum = items.reduce((s, [, v]) => s + (v ?? 0), 0);
  return Math.abs(sum - main) <= Math.abs(main) * 0.3;
}

/** 分档缺口的说明行（与 rg-note 同一语言，不额外造样式） */
const FLOW_DETAIL_MISSING = `<div class="rg-note">目前只有主力合计数据，四档明细暂未提供</div>`;

/** 四档净额：名称 | 零轴双向条 | 带符号净额 */function flowRows(items: FlowItem[]): string {
  const mx = Math.max(...items.map((i) => Math.abs(i[1] ?? 0)), 1e4);
  return `<div class="mf-rows">` + items.map(([k, v]) => {
    // 半幅 50%（最长的一条正好触边）；非零但极小的一档给 1.5% 保底，避免「有金额却看不到条」
    const raw = Math.abs(v ?? 0) / mx * 50;
    const dir = flowCls(v);
    const w = dir ? Math.max(1.5, raw) : 0;                      // 持平档不画条（免得留一根灰刺）
    const style = `${(v ?? 0) > 0 ? "left:50%" : "right:50%"};width:${w.toFixed(1)}%`;
    return `<div class="mf-row"><span>${k}</span>` +
      `<div class="mf-track"><i class="${dir}" style="${style}"></i></div>` +
      `<b class="num ${dir}">${fmtYiS(v)}</b></div>`;
  }).join("") + `</div>`;
}

/** 简版迷你图：四档按绝对值占比的堆叠条（红=净流入档 绿=净流出档） */
function flowStack(items: FlowItem[], w = 78, h = 8): string {
  const sum = items.reduce((s, i) => s + Math.abs(i[1] ?? 0), 0) || 1;
  const segs = items.map(([, v]) => {
    const p = Math.abs(v ?? 0) / sum * 100;
    return p < 1 ? "" : `<i style="width:${p.toFixed(1)}%;background:var(--${(v ?? 0) >= 0 ? "up" : "down"})"></i>`;
  }).join("");
  return `<div class="mf-stack" style="width:${w}px;height:${h}px">${segs}</div>`;
}

/** 大数：主体与单位分开（单位小一号，避免「+7.22亿」整体压过标签） */
function mfLead(label: string, text: string, cls = ""): string {
  const m = text.match(/^(.*?)(万亿|亿|元|%|倍)?$/);
  const [body, unit] = m ? [m[1], m[2] ?? ""] : [text, ""];
  return `<div class="mf-lead"><div class="mf-k">${label}</div>` +
    `<div class="mf-v ${cls}">${body}${unit ? `<i>${unit}</i>` : ""}</div></div>`;
}

/* ── 自选股卡片（首个多标的卡）：与左侧自选页同源 store.watchlist，
   增删/云同步 emit → renderRight 自动重渲；行情走 /market/quotes 批量快照 ── */
const wlQ = new Map<string, Quote>(); // symbol → 批量快照（盘中由 12s 轮询带动刷新）
let wlQAt = 0;                        // 上次拉取时刻（节流 ≈ 后端 10s 快照缓存）
let wlQSig = "";                      // 上次拉取代码集签名（自选变更 → 绕过节流立即刷）
let wlQBusy = false;

/* ── 自选卡内嵌搜索：与顶栏同源组件（stockSearch：模糊 + 历史 + 涨跌幅回填）。
   行尾 + 一键入「默认」组，已加 → 打开分组管理面板；点行打开个股 ── */
let wlSearch: StockSearchHandle | null = null;

function mountWatchSearch(): void {
  const box = document.querySelector<HTMLElement>('#rightcol .rcard[data-cid="watch"] .rh .wl-search');
  const input = box?.querySelector<HTMLInputElement>("input");
  const drop = box?.querySelector<HTMLElement>(".wl-drop");
  if (!box || !input || !drop) return;
  wlSearch = stockSearch({
    input, list: drop, limit: 8,
    kinds: ["stock"],                 // 自选卡搜索只收个股
    scope: '.rcard[data-cid="watch"]',
    setVisible: (v) => box.classList.toggle("open", v),
    tail: (u) => isWatched(u.symbol)
      ? `<button class="sb-tail on" data-sb-tail="${u.symbol}" data-sb-name="${esc(u.name || "")}" title="已自选 · 点击管理分组">${ic("check", 11)}</button>`
      : `<button class="sb-tail" data-sb-tail="${u.symbol}" data-sb-name="${esc(u.name || "")}" title="加入自选（默认分组）">${ic("plus", 11)}</button>`,
    onTail: (u, btn) => {
      const name = u.name || u.symbol;
      if (isWatched(u.symbol)) { openWatchPanel(u.symbol, name); return; }
      addWatch(u.symbol, name, "默认");
      toast(`已将 ${name} 加入自选 · 默认`);
      btn.classList.add("on");               // 就地变已加态，不重绘下拉
      btn.innerHTML = ic("check", 11);
      btn.title = "已自选 · 点击管理分组";
    },
    onPick: (u) => {
      input.value = "";
      box.classList.remove("open");
      void openStock({ symbol: u.symbol, name: u.name || u.symbol });
    },
  });
}

/* 轮询 renderRight（12s/20s）不打断搜索输入：重建前存值，重建后回填并重放搜索 */
function keepWatchSearch(): { val: string; focus: boolean } | null {
  const inp = document.querySelector<HTMLInputElement>('#rightcol .rcard[data-cid="watch"] .wl-search input');
  if (!inp) return null;
  return { val: inp.value, focus: document.activeElement === inp };
}

function restoreWatchSearch(kept: { val: string; focus: boolean } | null): void {
  if (!kept) return;
  const inp = document.querySelector<HTMLInputElement>('#rightcol .rcard[data-cid="watch"] .wl-search input');
  if (!inp) return;
  inp.value = kept.val;
  if (kept.focus) { inp.focus(); inp.setSelectionRange(kept.val.length, kept.val.length); }
  if (kept.val.trim()) inp.dispatchEvent(new Event("input"));   // 重放下拉结果
}

/** 自选卡分组胶囊：默认单选互斥；Ctrl/⌘/Shift 或按住 Tab 才多选 */
function bindWlGroupChips(scope: HTMLElement): void {
  scope.querySelectorAll<HTMLElement>("[data-wl-g]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();                     // 不触发行的打开个股
      toggleWlGroup(b.dataset.wlG!, multiPick(e));
      renderRight();
    }));
  scope.querySelectorAll<HTMLElement>("[data-wl-gm]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      openGroupPanel();
    }));
}

/** 自选列表行的点击绑定：打开个股 / 移出自选。
   refreshWlQuotes 会原地替换 .wl-list（不重绘整卡），此处必须重放绑定，
   否则刷新后快照一回来，新行就点不动。 */
function bindWatchRows(scope: HTMLElement): void {
  scope.querySelectorAll<HTMLElement>("[data-go-stock]").forEach((r) =>
    r.addEventListener("click", () => {
      const sym = r.dataset.goStock!;
      void openStock({ symbol: sym, name: r.dataset.goName || sym });
    }));
  scope.querySelectorAll<HTMLElement>("[data-wl-del]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();                     // 不触发行的打开个股
      removeWatch(b.dataset.wlDel!);
      toast("已移出自选");
    }));
}

function redrawWatchBody(): void {
  const el = document.querySelector<HTMLElement>('#rightcol .rcard[data-cid="watch"] .fbody');
  if (!el) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = cardBody("watch", getState().cards.watch?.mode ?? "simple");
  const nl = tmp.querySelector<HTMLElement>(".wl-list");
  const ol = el.querySelector<HTMLElement>(".wl-list");
  if (nl && ol) {
    const top = ol.scrollTop;
    ol.replaceWith(nl);                        // 原地只换列表：搜索框与下拉不被打断
    nl.scrollTop = top;
  } else {
    el.innerHTML = tmp.innerHTML;
    mountWatchSearch();
  }
  const list = el.querySelector<HTMLElement>(".wl-list");
  if (list) { bindWlGroupChips(list); bindWatchRows(list); void refreshSparksIn(list); }
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
      primeQuotes(r.items);                                    // 顺手铺缓存：点自选卡切票时价格秒上屏
    }
    wlQAt = Date.now();
    wlQSig = sig;
    redrawWatchBody();
  } catch { /* 静默：保留旧快照 */ } finally {
    wlQBusy = false;
  }
}

/* ── 资金卡「区间态」：K 线框选后接管卡片正文（策影 fundPanelMode='range' 同款） ──
   口径：涨跌幅/成交额来自图表选区（与浮窗卡片一致），资金来自 /market/fundflow 合计；
   指数 available=false → 只报成交额并注明原因，不伪装成 0 流入。 */
/* ── 资金卡「单日态」：点击某根 K 线后接管卡片正文 ──
   价格侧全部取被点那根 bar（不是最新价），资金来自该交易日的 capital_flow；
   与区间态共用一套视觉语言（rg-head / mf-hd / rg-kv2 / flowRows）。 */
function moneyflowPickBody(pk: NonNullable<typeof mk.pick>, mode: string): string {
  const cls = pk.changePct >= 0 ? "up" : "down";
  const f = pk.fund;
  const main = f?.net_main ?? null;
  const items: FlowItem[] = [
    ["超大单", f?.net_super ?? null],
    ["大单", f?.net_large ?? null],
    ["中单", f?.net_medium ?? null],
    ["小单", f?.net_small ?? null],
  ];
  const head = `<div class="rg-head"><span class="rg-tag">单日</span>` +
    `<b class="num">${esc(pk.date)}</b>` +
    `<button class="cbtn rg-x" data-pick-clear title="取消选中，回到当日资金">${ic("x", 11)}</button></div>`;
  const ratio = main != null && pk.amount ? main / pk.amount * 100 : null;
  if (mode === "simple") {
    const fundLine = pk.loading ? "资金查询中…"
      : f?.available ? `主力 <b class="num ${flowCls(main)}">${fmtYiS(main)}</b>`
      : pk.note ? `<span style="color:var(--faint)">该日无资金流</span>`
      : `成交额 <b class="num">${pk.amount ? fmtYi(pk.amount, 1) : "—"}</b>`;
    return head +
      `<div class="csimple"><div class="st">` +
      `<div class="mf-k">日涨跌</div>` +
      `<div class="mf-line"><b class="num ${cls}">${pk.changePct >= 0 ? "+" : ""}${pk.changePct.toFixed(2)}%</b>` +
      `<span>${fundLine}</span></div></div>` +
      `<div class="minifig">${f?.available && flowDetailOk(items, main) ? flowStack(items) : ""}</div></div>`;
  }
  const kv = (k: string, v: string) => `<div class="rg-kv"><span>${k}</span><b class="num">${v}</b></div>`;
  const price =
    `<div class="mf-hd">` +
    mfLead("日涨跌", `${pk.changePct >= 0 ? "+" : ""}${pk.changePct.toFixed(2)}%`, cls) +
    `<div class="mf-meta"><div>振幅 <b class="num">${pk.amp.toFixed(2)}%</b></div>` +
    `<div>收 <b class="num ${cls}">${fmt(pk.close)}</b></div></div></div>` +
    `<div class="rg-kv2">${kv("开", fmt(pk.open))}${kv("昨收", pk.prevClose != null ? fmt(pk.prevClose) : "—")}` +
    // 早期日线可能缺 amount（复权表口径），缺就报 "—"，不摆 0.0亿 冒充
    `${kv("成交额", pk.amount ? fmtYi(pk.amount, 1) : "—")}${kv("量", fmtVol(pk.volume / 100) + "手")}</div>` +
    `<div class="rg-split"></div>`;
  let fund: string;
  if (pk.loading) {
    fund = `<div class="rg-note">资金流查询中…</div>`;
  } else if (!f || !f.available) {
    // 后端 note 是区间口径的措辞（「区间内」「区间资金」），单日卡里换成该日
    const note = (pk.note || "该标的无个股资金流（指数口径）")
      .replace("区间内", "该日").replace("区间资金", "单日资金");
    fund = `<div class="rg-note">${esc(note)}</div>`;
  } else {
    fund = `<div class="mf-hd">` + mfLead("主力净流入", fmtYiS(main), flowCls(main)) +
      `<div class="mf-meta">${ratio != null ? `<div>占成交额 <b class="num">${ratio.toFixed(2)}%</b></div>` : ""}</div></div>` +
      (flowDetailOk(items, main) ? flowRows(items) : FLOW_DETAIL_MISSING);
  }
  return head + price + fund;
}

function moneyflowRangeBody(rg: NonNullable<typeof mk.range>, mode: string): string {
  const cls = rg.changePct >= 0 ? "up" : "down";
  const f = rg.fund;
  const main = f?.net_main ?? null;
  const items: FlowItem[] = [
    ["超大单", f?.net_super ?? null],
    ["大单", f?.net_large ?? null],
    ["中单", f?.net_medium ?? null],
    ["小单", f?.net_small ?? null],
  ];
  const head = `<div class="rg-head"><span class="rg-tag">区间 ${rg.days} 根</span>` +
    `<b class="num">${rg.startDate} → ${rg.endDate}</b>` +
    `<button class="cbtn rg-x" data-range-clear title="清除区间，回到当日资金">${ic("x", 11)}</button></div>`;
  if (mode === "simple") {
    const fundLine = rg.loading ? "资金统计中…"
      : f?.available ? `主力 <b class="num ${flowCls(main)}">${fmtYiS(main)}</b>`
      : `成交额 <b class="num">${fmtYi(rg.amount, 1)}</b>`;
    return head +
      `<div class="csimple"><div class="st">` +
      `<div class="mf-k">区间涨跌 · ${rg.days} 根</div>` +
      `<div class="mf-line"><b class="num ${cls}">${rg.changePct >= 0 ? "+" : ""}${rg.changePct.toFixed(2)}%</b>` +
      `<span>${fundLine}</span></div></div>` +
      `<div class="minifig">${f?.available && flowDetailOk(items, main) ? flowStack(items) : ""}</div></div>`;
  }
  /* 价格侧：涨跌做成大字（视觉锚点），振幅/阳阴退成右侧小字，
     最高最低与成交额做成两列键值 —— 不再是六行等权信息流 */
  const kv = (k: string, v: string) =>
    `<div class="rg-kv"><span>${k}</span><b class="num">${v}</b></div>`;
  const price =
    `<div class="mf-hd">` +
    mfLead("区间涨跌", `${rg.changePct >= 0 ? "+" : ""}${rg.changePct.toFixed(2)}%`, cls) +
    `<div class="mf-meta"><div>振幅 <b class="num">${rg.amp.toFixed(2)}%</b></div>` +
    `<div>阳 / 阴 <b class="num">${rg.upN} / ${rg.downN}</b></div></div></div>` +
    `<div class="rg-kv2">${kv("最高", fmt(rg.high))}${kv("最低", fmt(rg.low))}` +
    `${kv("成交额", fmtYi(rg.amount, 1))}${kv("日均", fmtYi(rg.avgAmount, 1))}</div>` +
    `<div class="rg-split"></div>`;
  let fund: string;
  if (rg.loading) {
    fund = `<div class="rg-note">资金流统计中…</div>`;
  } else if (!f || !f.available) {
    fund = `<div class="rg-note">${esc(rg.note || "该标的无个股资金流（指数口径），区间资金请参考成交额")}</div>`;
  } else {
    // 覆盖天数只在有缺口时才提示（与卡片头的「N 根」重复时反而添乱）
    const gap = f.covered < rg.days ? `<div>覆盖 ${f.covered} 天</div>` : "";
    fund = `<div class="mf-hd">` + mfLead("主力净流入", fmtYiS(main), flowCls(main)) +
      `<div class="mf-meta">${gap}</div></div>` +
      (flowDetailOk(items, main) ? flowRows(items) : FLOW_DETAIL_MISSING);
  }
  return head + price + fund;
}

/** 头部/基本信息卡口径：只有 rt_live（今日已有成交）才用实时价 vs 昨收；
    盘前腾讯 09:00 后已把 qdate 与昨收切到今天，直接混用实时价与库内涨跌幅会
    出现「最新价≈昨收、涨跌幅却是昨天」的错位。盘前一律回到上一交易日收盘口径。 */
function quoteView(q: Quote | null, bars: Bar[]) {
  const last = bars.length ? bars[bars.length - 1] : null;
  const prevBar = bars.length > 1 ? bars[bars.length - 2].close : null;
  const live = !!q?.rt_live && q.rt_price != null;
  const price = live ? q!.rt_price! : (last?.close ?? q?.close ?? null);
  const base = live ? (q?.rt_prev_close ?? prevBar) : prevBar;
  const pct = price != null && base ? (price / base - 1) * 100 : (q?.pct_chg ?? null);
  return {
    live, price, pct, base,
    chgAbs: price != null && base ? price - base : null,
    open: live ? q?.open : last?.open,
    high: live ? q?.high : last?.high,
    low: live ? q?.low : last?.low,
  };
}

/* ── 趋势卡（多周期）：60分 / 日 / 周 短线多空 + 近 N 根趋势柱（红多头 / 绿空头） ── */
const trend60: { symbol: string; bars: Bar[] } = { symbol: "", bars: [] };
/** 60分 K 按标的缓存（打开个股即预取，切到趋势卡直接出柱线） */
const trend60Cache = new Map<string, Bar[]>();
const trendPending = new Map<string, Promise<void>>();

export function prefetchTrend60(symbol: string): Promise<void> {
  if (trend60Cache.has(symbol) || (trend60.symbol === symbol && trend60.bars.length)) {
    return Promise.resolve();
  }
  const pending = trendPending.get(symbol);
  if (pending) return pending;
  const req = marketApi.kline({ symbol, freq: "60" }).then((k) => {
    trend60Cache.set(symbol, k.bars);
    while (trend60Cache.size > 24) trend60Cache.delete(trend60Cache.keys().next().value!);
    if (mk.cur?.symbol === symbol) { trend60.symbol = symbol; trend60.bars = k.bars; }
  }).catch(() => { /* 预取失败：切到趋势卡时 bindTrend 会重试 */ })
    .finally(() => { trendPending.delete(symbol); });
  trendPending.set(symbol, req);
  return req;
}

/** 每根 K 的收盘相对 MA(n) 偏离%（柱线高度与红绿由此得出） */
function trendDevs(list: Bar[], count: number, n = 10): number[] {
  const out: number[] = [];
  const from = Math.max(n - 1, list.length - count);
  for (let i = from; i < list.length; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += list[j].close;
    const ma = sum / n;
    if (!ma) continue;
    out.push((list[i].close - ma) / ma * 100);
  }
  return out;
}

function trendRow(label: string, list: Bar[], mode: string): string {
  const devs = trendDevs(list, mode === "detailed" ? 24 : 12);
  const d = devs[devs.length - 1];
  if (d == null) {
    return `<div class="tr-row"><span class="tr-per">${label}</span>` +
      `<span class="tr-none">数据不足</span></div>`;
  }
  const up = d >= 0;
  const hist = devs.map((x) => {
    const h = 2 + Math.min(Math.abs(x) / 1.2, 1) * 14;      // ±1.2% 打满 16px
    return `<i class="${x >= 0 ? "up" : "down"}" style="height:${h.toFixed(1)}px"></i>`;
  }).join("");
  return `<div class="tr-row" title="${label} 收盘相对趋势线偏离">` +
    `<span class="tr-per">${label}</span>` +
    `<b class="tr-state ${up ? "up" : "down"}">${up ? "多头" : "空头"}</b>` +
    `<span class="num tr-dev ${up ? "up" : "down"}">${up ? "+" : ""}${d.toFixed(2)}%</span>` +
    `<div class="tr-hist">${hist}</div></div>`;
}

export function trendBody(symbol: string, mode: string): string {
  const daily = mk.bars;
  if (daily.length < 12) return `<div class="bempty">数据不足</div>`;
  const weekly = aggDaily(daily, "w");
  const m60 = trend60.symbol === symbol ? trend60.bars : [];
  // 六段位：围绕日线短线趋势线（MA7 快 / MA10 慢）的六个位置，1 超跌 → … → 6 跌破
  const seg = sixSegment(daily, daily.length - 1);
  const segCol = seg === 3 || seg === 5 ? "var(--up)" : seg === 4 ? "var(--accent)" : "var(--down)";
  // 六分段理论：围绕日线短线趋势线的六个位置（众赢原话），当前段亮格 + 操作建议
  const cells = [1, 2, 3, 4, 5, 6].map((n) => `<i class="${n === seg ? "on" : ""}"` +
    ` style="--seg:${n === seg ? segCol : "var(--panel-3)"}"` +
    ` title="第${n}段 · ${SEGFULL[n]}（${SEGACTION[n]}）"></i>`).join("");
  return `<div class="tr-matrix">` +
    `${trendRow("60分", m60, mode)}${trendRow("日", daily, mode)}${trendRow("周", weekly, mode)}` +
    `</div>` +
    `<div class="tr-six"><div class="tr-six-h"><span class="tr-k">六段</span>` +
    `<span class="tr-cells">${cells}</span></div>` +
    `<div class="tr-six-txt"><b style="color:${segCol}">${seg}段 · ${SEGFULL[seg] || SEGNAME[seg]}</b>` +
    `<span>${SEGACTION[seg] || ""}</span></div></div>`;
}

/** 60 分钟 K：优用预取缓存；未命中时补拉，取回后只重铺本卡片 */
export function bindTrend(card: HTMLElement, symbol: string, mode: string): void {
  if (trend60.symbol === symbol) return;
  const paint = (): void => {
    const body = card.querySelector<HTMLElement>(".fbody");
    if (body && card.isConnected && mk.cur?.symbol === symbol) body.innerHTML = trendBody(symbol, mode);
  };
  const cached = trend60Cache.get(symbol);
  if (cached) {
    trend60.symbol = symbol;
    trend60.bars = cached;
    paint();
    return;
  }
  void prefetchTrend60(symbol).then(() => {
    if (mk.cur?.symbol !== symbol) return;
    if (trend60.symbol !== symbol) {
      const hit = trend60Cache.get(symbol);
      if (!hit) return;                          // 拉取失败：保持占位，下次重绘再试
      trend60.symbol = symbol;
      trend60.bars = hit;
    }
    paint();
  });
}

function cardBody(cid: string, mode: string): string {
  const s = mk.cur;
  if (!s) return "";
  if (cid === "shareholders") return shareholderBody(s.symbol, mode);
  if (cid === "chips") return chipBody(s.symbol, mode);
  if (cid === "orderbook") return orderbookBody(s.symbol, mode, mk.quote);
  if (cid === "trades") return tradesBody(s.symbol, mode);
  const bars = mk.bars;                    // 卡片统计基准固定日线
  const q = mk.quote;
  const closes = mk.bars.map((b) => b.close);
  const shortSeq = closes.slice(-10), midSeq = closes.slice(-30);
  const chg = q?.pct_chg ?? 0;
  if (cid === "trend") return trendBody(s.symbol, mode);
  if (cid === "watch") {
    const wl = getState().watchlist;
    const sel = getState().wlGroups;                  // 多选筛选：空 = 全部
    const list = wl.filter(inWlFilter);
    const det = mode === "detailed";
    // 分组胶囊：默认单选（点「全部」恢复）；按住 Ctrl/⌘/Shift/Tab 可多选
    const grpbar = `<div class="wl-grpbar">${["全部", ...allWatchGroups()].map((g) => {
      const on = g === "全部" ? sel.length === 0 : sel.includes(g);
      return `<button class="wl-gchip${on ? " on" : ""}" data-wl-g="${esc(g)}" title="${g === "全部" ? "显示全部自选" : "单选；按住 Ctrl/⌘/Shift/Tab 多选"}">${esc(g)}</button>`;
    }).join("")}<button class="wl-gchip wl-gact" data-wl-gm title="管理分组（新建 / 改名 / 删除）">${ic("gear", 11)}</button></div>`;
    // 行式列表（同花顺自选同款）：序号 | 名称代码(分组) | 当日走势 | (成交额 换手) | 现价 | 涨跌幅 | 移除
    const rows = list.map((w, i) => {
      const wq = wlQ.get(w.symbol);
      const ch = wq?.pct_chg ?? 0;
      const up = ch >= 0;
      const price = wq ? (wq.rt_price ?? wq.close ?? null) : null;
      return `<div class="wl-r${det ? " det" : ""}" data-go-stock="${w.symbol}" data-go-name="${esc(w.name)}" title="打开 ${esc(w.name)}">` +
        `<span class="wl-i num">${i + 1}</span>` +
        `<div class="wl-nm" title="${esc(w.symbol)}"><b>${esc(w.name)}</b><span class="num">${esc(w.symbol.split(".")[0])}</span><i class="wl-g" title="${esc(w.groups.join("、"))}">· ${esc(w.groups.join(" / "))}</i></div>` +
        `<span class="wl-sp">${sparkSvg(w.symbol, 56, 18)}</span>` +
        (det ? `<span class="num wl-d">${fmtYi(wq?.amount ?? null, 1)}</span>` +
          `<span class="num wl-d">${wq?.turnover_rate != null ? fmt(wq.turnover_rate) + "%" : "—"}</span>` : "") +
        `<b class="num wl-p">${price != null ? fmt(price) : "—"}</b>` +
        (wq ? `<b class="num wl-chg ${up ? "up" : "down"}">${fmtChg(ch)}%</b>` : `<b class="num wl-chg" style="color:var(--faint)">—</b>`) +
        `<button class="wl-x" data-wl-del="${w.symbol}" title="移出自选">${ic("x", 10)}</button>` +
        `</div>`;
    }).join("");
    // 搜索框已内嵌进卡片头（cardHead），此处渲染「分组胶囊 + 列表」（固定高度滚动，空态也占位）
    return `<div class="wl-list">${grpbar}${rows || (!wl.length ?
      `<div class="bempty" style="padding:14px 14px 8px">暂无自选股<br><span style="color:var(--faint)">点右上 ＋ 搜索添加，或从自选页管理</span></div>` :
      `<div class="bempty" style="padding:14px 14px 8px">「${esc(sel.join(" + "))}」分组暂无股票<br><span style="color:var(--faint)">在上方取消勾选，或用 ♥ 给个股设置分组</span></div>`)}</div>`;
  }
  if (cid === "signals") {
    const segI = sixSegment(mk.bars, mk.bars.length - 1);
    const segNm = SEGNAME[segI] || "—";
    const segAct = SEGACTION[segI] || "";
    const segCol = segI === 3 || segI === 5 ? "var(--up)" : segI === 4 ? "var(--p1)" : "var(--down)";
    if (mode === "simple") {
      return `<div class="csimple"><div class="st"><b>${segNm}</b> · 六分段判定<br><span style="font-size:10px;color:var(--faint)">${segAct} · 短线 ${shortSeq[shortSeq.length - 1] > shortSeq[0] ? "上行" : "下行"} · 中线 ${midSeq[midSeq.length - 1] > midSeq[0] ? "上行" : "下行"}</span></div><div class="minifig">${spark(midSeq, 64, 22, "var(--p1)")}</div></div>`;
    }
    return `<div style="font-size:11px;color:var(--faint)">六分段 · 趋势线六位置</div>` +
      `<div class="sixseg" id="rc-six">${Array.from({ length: 6 }, (_, k2) => `<i class="${k2 === segI - 1 ? "on cur" : ""}" style="${k2 === segI - 1 ? `background:${segCol}` : ""}"></i>`).join("")}</div>` +
      `<div class="sixlab"><span>超跌</span><span>跌破</span></div>` +
      `<div style="display:flex;align-items:center;gap:6px;margin:2px 0 0"><b style="color:${segCol};font-size:12.5px">${segI}段 · ${segNm}</b>` +
      `<span style="font-size:10.5px;color:var(--faint)">${segAct}</span></div>` +
      `<div class="tr2">${spark(shortSeq, 96, 26, "var(--up)")}${spark(midSeq, 96, 26, "var(--p1)")}</div>` +
      `<div style="display:flex;gap:8px;margin-top:8px">` +
      `<div style="flex:1;background:var(--panel-2);border-radius:9px;padding:7px 9px"><div style="font-size:10px;color:var(--faint)">短线趋势</div><div style="font-size:13px;font-weight:650;color:${shortSeq[shortSeq.length - 1] > shortSeq[0] ? "var(--up)" : "var(--down)"}">${shortSeq[shortSeq.length - 1] > shortSeq[0] ? "上行" : "下行"}</div></div>` +
      `<div style="flex:1;background:var(--panel-2);border-radius:9px;padding:7px 9px"><div style="font-size:10px;color:var(--faint)">中线趋势</div><div style="font-size:13px;font-weight:650;color:var(--p1)">${midSeq[midSeq.length - 1] > midSeq[0] ? "上行" : "下行"}</div></div></div>`;
  }
  if (cid === "moneyflow") {
    // 点击某根 K 线 → 单日口径；拖拽框选 → 区间口径；都没有 → 当日（清区即回当日）
    if (mk.pick) return moneyflowPickBody(mk.pick, mode);
    if (mk.range) return moneyflowRangeBody(mk.range, mode);
    const cf = q?.capital_flow;
    const items: FlowItem[] = [
      ["超大单", cf?.net_super ?? null],
      ["大单", cf?.net_large ?? null],
      ["中单", cf?.net_medium ?? null],
      ["小单", cf?.net_small ?? null],
    ];
    const main = cf?.net_main ?? null;
    // 无资金流（指数 / 未采集）：不摆一排 0.00 冒充数据，改报成交额并给框选入口提示
    if (!cf) {
      const isIdx = (s.symbol || "").includes(".");
      // 数据日期以最后一根日线为准：指数的 quote.date 会被实时快照写成「今天 21:50」，
      // 周末/盘后直接展示会把成交额挂到非交易日上
      const dstr = bars[bars.length - 1]?.date ?? (q?.date ?? "").slice(0, 10);
      return `<div class="mf-hd">` + mfLead("今日成交额", fmtYi(q?.amount, 1)) +
        `<div class="mf-meta"><div>${isIdx ? "指数无个股资金流" : "暂无资金流数据"}</div>` +
        `<div class="num">${dstr}</div></div></div>` +
        `<div class="rg-note">在 K 线上框选一段区间，可统计该区间涨跌幅与成交额${isIdx ? "" : " / 主力净流入"}</div>`;
    }
    /* 资金流入强度：主力净额 / 当日成交额 —— 同样是 7 亿，成交 100 亿与成交 1000 亿的含义完全不同 */
    const amt = q?.amount ?? null;
    const ratio = main != null && amt ? main / amt * 100 : null;
    if (mode === "simple") {
      return `<div class="csimple"><div class="st">` +
        `<div class="mf-k">主力净流入${cf.date ? ` · ${cf.date}` : ""}</div>` +
        `<div class="mf-line"><b class="num ${flowCls(main)}">${fmtYiS(main)}</b>` +
        (ratio != null ? `<span>占成交额 ${ratio.toFixed(2)}%</span>` : "") +
        `</div></div><div class="minifig">${flowDetailOk(items, main) ? flowStack(items) : ""}</div></div>`;
    }
    return `<div class="mf-hd">` + mfLead("主力净流入", fmtYiS(main), flowCls(main)) +
      `<div class="mf-meta">` +
      (ratio != null ? `<div>占成交额 <b class="num">${ratio.toFixed(2)}%</b></div>` : "") +
      `<div class="num">${cf.date || ""}</div></div></div>` +
      (flowDetailOk(items, main) ? flowRows(items) : FLOW_DETAIL_MISSING);
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
      return `<div class="csimple"><div class="st"><b>均线 ${pos}</b> · KDJ ${fmt(kd.k[i] ?? 0, 0)}<br><span style="font-size:10px;color:var(--faint)">ATR ${fmt(atr[i] ?? 0)} · BOLL 带宽 ${ma20v != null ? fmt(((bl.up[i]! - bl.low[i]!) / ma20v) * 100, 1) + "%" : "—"}</span></div><div class="minifig">${spark(closesN.slice(-20), 64, 22, "var(--accent)")}</div></div>`;
    }
    return row("均线（快）", fmt(sma(bars, 5)[i] ?? 0)) + row("均线（慢）", fmt(ma20v), posCls) +
      row("KDJ K", fmt(kd.k[i] ?? 0, 1)) + row("KDJ J", fmt(kd.j[i] ?? 0, 1)) +
      row("BOLL 上", fmt(bl.up[i] ?? 0)) + row("BOLL 下", fmt(bl.low[i] ?? 0)) +
      row("ATR", fmt(atr[i] ?? 0));
  }
  if (cid === "valuation") {
    const v = q?.valuation;
    if (!v) return `<div style="font-size:11.5px;color:var(--faint)">暂无估值数据（全市场估值还没采集到）</div>`;
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

function cardHead(def: { id: string; name: string; icon: string }, canMode = true): string {
  const p = getState().cards[def.id];
  const wlN = getState().watchlist.filter(inWlFilter).length;
  const mono = def.id === "moneyflow" ? (mk.cur?.symbol || "") : def.id === "corepick" ? "池档案" : def.id === "watch" ? `${wlN}只` : "";
  // 盘口卡：名称/代码收进标题行，正文第二行放「价格 + 涨跌幅」，省掉重复的身份行
  const sub = def.id === "orderbook"
    ? `<span class="rh-sub" data-head-sub>${headSubHtml(mk.cur?.symbol || "", mk.cur?.name || "")}</span>`
    : `<span class="mono" style="${def.id === "watch" ? "" : "margin-left:auto"}">${mono}</span>`;
  // 模式切换收成单颗按钮（图标指示点击后进入的模式）；整组控制钮悬停卡片才浮现
  const nextIcon = p.mode === "simple" ? "faders-horizontal" : "list";
  const nextTitle = p.mode === "simple" ? "切换为详细模式" : "切换为简单模式";
  // 自选卡：搜索内嵌进卡片头（名称右侧）+ 行尾「+」新增入口（打开添加弹窗）
  const headSearch = def.id === "watch"
    ? `<span class="wl-search">${ic("magnifying-glass", 12)}` +
      `<input placeholder="搜索代码 / 名称 / 拼音" maxlength="20"><div class="wl-drop"></div></span>` +
      `<button class="cbtn" data-wl-new title="新增自选（搜索 + 选择分组）">${ic("plus", 12)}</button>`
    : "";
  return `<div class="rh">${ic(def.icon, 14)}<h4>${def.name}</h4>${headSearch}${sub}` +
    `<span class="cbar">${canMode ? `<button class="cbtn" data-mode-toggle title="${nextTitle}">${ic(nextIcon, 12)}</button>` : ""}` +
    `<button class="cbtn" data-fold title="折叠 / 展开">${ic("caret-up", 12)}</button>` +
    `<span class="drag" draggable="true" title="拖动排序">${ic("dots-six-vertical", 13)}</span></span></div>`;
}

/** 简单/详细切换只在内容确实随模式变化时出现（指数无五档/逐笔/筹码，点了没反应） */
function modeMatters(cid: string): boolean {
  if (cid === "corepick") return false;                     // 档案卡内容固定，与模式无关
  if (cid === "orderbook" || cid === "trades" || cid === "chips" ||
      cid === "moneyflow" || cid === "shareholders") return !isIndexSymbol(mk.cur?.symbol || "");
  return true;
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

/* ── K线顶部信息条（东财/同花顺网页头部同款布局）：
   名称 代码 | 现价 涨跌额 涨跌幅 | 最高 最低 开盘 昨收 | 成交额 换手 | 总市值 PE(TTM)。
   实时快照（rt_*）优先，无 quote 时退回日线末根（盘前/快照被掐仍有内容） ── */
function renderKlInfo(): void {
  const bar = document.getElementById("kl-info");
  if (!bar) return;
  const s = mk.cur;
  if (!s) { bar.hidden = true; return; }
  bar.hidden = false;
  const q = mk.quote;
  const last = mk.bars.length ? mk.bars[mk.bars.length - 1] : null;
  const live = q?.rt_price != null;
  const price = live ? q!.rt_price! : (last?.close ?? q?.close ?? null);
  const prev = live && q?.rt_prev_close != null ? q!.rt_prev_close
    : (mk.bars.length > 1 ? mk.bars[mk.bars.length - 2].close : last?.open ?? null);
  const chgAbs = price != null && prev ? price - prev : null;
  const chgPct = q?.pct_chg ?? (chgAbs != null && prev ? chgAbs / prev * 100 : null);
  const cls = chgPct == null ? "" : chgPct < 0 ? "down" : "up";
  const rel = (v: number | null | undefined): string =>
    v == null || !prev ? "" : v > prev ? "up" : v < prev ? "down" : "";
  const kv = (k: string, v: number | string | null | undefined, c = ""): string => {
    if (v == null || v === "") return "";
    return `<span class="ki-kv">${k}<b class="num ${c}">${typeof v === "number" ? fmt(v) : v}</b></span>`;
  };
  const hi = q?.high ?? last?.high ?? null;
  const lo = q?.low ?? last?.low ?? null;
  const op = q?.open ?? last?.open ?? null;
  const v = q?.valuation;
  const cap = v?.total_mv != null ? (v.total_mv >= 1e12 ? fmt(v.total_mv / 1e12, 2) + "万亿" : fmtYi(v.total_mv, 0)) : null;
  const amt = q?.amount ?? last?.amount;
  const to = q?.turnover_rate;
  bar.innerHTML =
    `<b class="ki-name">${esc(q?.name || s.name)}</b><span class="num ki-code">${s.symbol}</span>` +
    (price != null ? `<b class="ki-price num ${cls}">${fmt(price)}</b>` +
      (chgPct != null ? `<span class="ki-chg num ${cls}">${chgAbs != null ? fmtChg(chgAbs) + " " : ""}${fmtChg(chgPct)}%</span>` : "") : "") +
    `<span class="ki-sep"></span>` +
    kv("最高", hi, rel(hi)) + kv("最低", lo, rel(lo)) + kv("开盘", op, rel(op)) + kv("昨收", prev) +
    `<span class="ki-sep"></span>` +
    kv("成交额", amt != null ? fmtYi(amt, 1) : null) +
    kv("换手", to != null ? fmt(to) + "%" : null) +
    `<span class="ki-sp"></span>` +
    kv("总市值", cap) +
    kv("PE(TTM)", v?.pe_ttm != null ? (v.pe_ttm > 0 ? fmt(v.pe_ttm, 1) : "亏损") : null);
}

/* ── 右侧抽屉栏目（tab）：一个栏目装多张卡片，当前栏目本地记忆 ── */
/* 栏目顺序变更为「盘口 / 看盘 / 筹码 / 股东」，key 升版一次，旧记忆（默认看盘）作废 */
const RTAB_KEY = "yc_right_tab_v2";
function readRightTab(): RightTabId {
  const v = localStorage.getItem(RTAB_KEY);
  // 默认进入「盘口」：右侧第一栏就是现价/五档/成交明细，看盘卡片仍可一键切回
  return RIGHT_TABS.some((t) => t.id === v) ? v as RightTabId : "depth";
}
let rightTab: RightTabId = readRightTab();

export function renderRight(): void {
  renderKlInfo();
  const el = document.getElementById("rightcol");
  if (!el || !mk.cur) return;
  const kept = keepWatchSearch();            // 轮询重建前保留自选卡搜索态
  const st = getState();
  const defs = [...CARD_DEFS].sort((a, b) => st.cards[a.id].order - st.cards[b.id].order);
  const tabDefs = defs.filter((d) => st.cards[d.id].on && d.tab === rightTab);
  let html = `<nav class="rtabs" role="tablist">` + RIGHT_TABS.map((t) =>
    `<button class="rtab${t.id === rightTab ? " on" : ""}" data-rtab="${t.id}" role="tab" aria-selected="${t.id === rightTab}">${t.name}</button>`
  ).join("") + `</nav>`;
  for (const def of tabDefs) {
    const p = st.cards[def.id];
    html += `<div class="rcard" data-cid="${def.id}">${cardHead(def, modeMatters(def.id))}` +
      `<div class="fbody${p.mode === "simple" && def.id === "signals" ? "" : ""}${false ? " hide" : ""}">${cardBody(def.id, p.mode)}</div></div>`;
  }
  if (!tabDefs.length) {
    html += `<div class="rcard bempty">该栏目暂无启用的卡片，可在「功能卡片」页开启</div>`;
  }
  html += `<div class="cmpl">仅提供基于公开数据的规则化分析，不构成投资建议 · 指标按公开规则计算，VIP 明细由系统处理后返回</div>`;
  el.innerHTML = html;
  el.querySelectorAll<HTMLElement>("[data-rtab]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.rtab as RightTabId;
      if (id === rightTab) return;
      rightTab = id;
      localStorage.setItem(RTAB_KEY, id);
      renderRight();
    }));
  const chipCard = el.querySelector<HTMLElement>('[data-cid="chips"]');
  if (chipCard && mk.cur) {
    const symbol = mk.cur.symbol;
    bindChips(chipCard, symbol, () => {
      if (mk.cur?.symbol === symbol && rightTab === "chips") renderRight();
    });
  }
  const shareholderCard = el.querySelector<HTMLElement>('[data-cid="shareholders"]');
  if (shareholderCard) {
    const symbol = mk.cur.symbol;
    bindShareholders(shareholderCard, symbol, () => {
      if (mk.cur?.symbol === symbol) renderRight();
    });
  }
  const trendCard = el.querySelector<HTMLElement>('[data-cid="trend"]');
  if (trendCard) bindTrend(trendCard, mk.cur.symbol, st.cards.trend.mode);
  // 盘口 tab：盘口（基本信息+五档）/ 成交明细 各自 5s 轮询，只刷新本卡片
  const curSymbol = mk.cur.symbol;
  for (const cid of ["orderbook", "trades"] as const) {
    const card = el.querySelector<HTMLElement>(`[data-cid="${cid}"]`);
    if (!card) continue;
    const mode = st.cards[cid].mode;
    if (cid === "orderbook") bindOrderbook(card, curSymbol, mode, () => mk.quote, mk.cur?.name);
    else bindTrades(card, curSymbol, mode);
  }
  el.querySelectorAll<HTMLElement>("[data-vip-open]").forEach((b) =>
    b.addEventListener("click", () => openModal("modal-vip")));
  el.querySelectorAll<HTMLElement>("[data-ic-go-core]").forEach((b) =>
    b.addEventListener("click", () => document.dispatchEvent(new CustomEvent("yc:goto-page", { detail: "corepicks" }))));
  // 资金卡「清除区间」：撤掉选区与区间口径，回到当日资金
  el.querySelectorAll<HTMLElement>("[data-range-clear]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      mk.range = null;
      kls.forEach((k) => k?.clearRange(false));
      renderRight();
    }));
  // 资金卡「取消单日」：撤掉单根选中（含图上高亮），回到当日资金
  el.querySelectorAll<HTMLElement>("[data-pick-clear]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      mk.pick = null;
      kls.forEach((k) => k?.clearPick(false));
      renderRight();
    }));
  el.querySelectorAll<HTMLElement>("[data-wl-add]").forEach((b) =>
    b.addEventListener("click", () => {
      // 空态引导：聚焦卡内搜索直接添加（不再跳自选页）
      document.querySelector<HTMLInputElement>('#rightcol .rcard[data-cid="watch"] .wl-search input')?.focus();
    }));
  el.querySelectorAll<HTMLElement>("[data-wl-new]").forEach((b) =>
    b.addEventListener("click", () => {
      // 新增入口：打开「添加自选」弹窗（共享搜索 + 分组选择）
      openModal("modal-add");
    }));
  el.querySelectorAll<HTMLElement>("[data-mode-toggle]").forEach((b) =>
    b.addEventListener("click", () => {
      const cid = b.closest(".rcard")!.getAttribute("data-cid")!;
      const cur = getState().cards[cid].mode;
      setCardPref(cid, { mode: cur === "simple" ? "detailed" : "simple" });
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
  bindWatchRows(el);   // 自选行：打开个股 / 移出自选（redrawWatchBody 重绘后也会重放）
  // 自选卡：挂搜索（保留输入态）+ 行内走势就绪缓存即画；行情快照按需拉取（节流 + 自选变更即刷）
  mountWatchSearch();
  restoreWatchSearch(kept);
  const wlList = el.querySelector<HTMLElement>('.rcard[data-cid="watch"] .wl-list');
  if (wlList) { bindWlGroupChips(wlList); void refreshSparksIn(wlList); }
  void refreshWlQuotes();
}

/* ── 聊天指令：指标开关（与手动点指标栏同一套状态 + 持久化） ── */
export function setIndicator(key: string, on: boolean): boolean {
  const isMain = KMAIN_OK.includes(key);
  if (!isMain && !KSUB_OK.includes(key)) return false;
  const arr: string[] = isMain ? mk.mainInds : mk.subInds;
  const i = arr.indexOf(key);
  if (on && i < 0) arr.push(key);
  if (!on && i >= 0) arr.splice(i, 1);
  saveKPrefs();
  syncIndUI();
  renderIpanel();
  renderKline();
  return true;
}

export function indicatorWhere(key: string): "main" | "sub" | null {
  if (KMAIN_OK.includes(key)) return "main";
  if (KSUB_OK.includes(key)) return "sub";
  return null;
}
