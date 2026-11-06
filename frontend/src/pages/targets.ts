/* 目标页：全市场多条件叠加选股（策影目标页同源口径）。
 * 指标层（均线/量比/六分段/涨停次数…）服务端后台定时预计算落表，端点只读；
 * 条件层由 GET /market/targets/conditions 下发元数据驱动条件栏渲染——
 * 后端 screening.CONDITIONS 新增指标（如主力吸筹）后前端自动出现，
 * 勾选/改阈值即时重筛（毫秒级），数据更新才重算指标层。 */
import { marketApi, type Bar, type TargetCond, type TargetItem, type TargetSpark } from "../api";
import { esc, fmt, fmtChg } from "../fmt";
import { SEGFULL, sixSegmentSeries } from "../indicators";
import { createPager, slicePage, type Pager } from "../pager";
import { createDataTable, type DataTable, type DataTableCol } from "../table";
import { chartDown, chartUp, trendPalette } from "./kline";

/* 后端不可达时的兜底登记（与 screening.CONDITIONS 同构，仅为首屏不空） */
const FALLBACK_CONDS: TargetCond[] = [
  { key: "trend", label: "趋势柱线", kind: "trend", default_on: false,
    title: "STICKV 负转正或持续在零轴上方，可独立筛选或与其他条件同时满足" },
  { key: "vol", label: "40日均量", kind: "value", op: ">=", default: 1.0,
    min: 0.0, max: 10.0, step: 0.1, unit: "x", default_on: true,
    title: "当日成交量 / 40日均量 不小于阈值" },
  { key: "short", label: "短线趋势橙", kind: "flag", default_on: true,
    title: "收盘站上 MA10（K 线短线趋势通道填橙同判定）" },
  { key: "mid", label: "中线趋势橙", kind: "flag", default_on: true,
    title: "收盘站上 MA45（K 线中线趋势通道填橙同判定）" },
  { key: "up20", label: "20日内涨停", kind: "flag", default_on: true,
    title: "近 20 个交易日有过涨停（主板 10% / 创业科创 20%）" },
  { key: "money", label: "钱袋子", kind: "value", op: "<=", default: 5,
    min: 0, max: 60, step: 1, unit: "日", default_on: false,
    title: "近 N 个交易日内出现过钱袋子（ZigZag 低点，反弹 6% 确认）；数值为距今天数，越小越新鲜" },
];

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}

function clampVal(c: TargetCond, v: number): number {
  const lo = c.min ?? -Infinity, hi = c.max ?? Infinity;
  return Math.min(hi, Math.max(lo, v));
}

let meta: TargetCond[] = FALLBACK_CONDS;
let conds: Record<string, boolean> = {};
let tvals: Record<string, number> = {};
let metaLoaded = false;

function applyMeta(list: TargetCond[]): void {
  meta = list.length ? list : FALLBACK_CONDS;
  const savedC = readJSON<Record<string, boolean>>("yc_tgt_conds", {});
  const savedV = readJSON<Record<string, number>>("yc_tgt_vals", {});
  conds = {};
  tvals = {};
  for (const c of meta) {
    conds[c.key] = typeof savedC[c.key] === "boolean" ? savedC[c.key] : c.default_on;
    if (c.kind === "value") {
      const v = Number(savedV[c.key]);
      tvals[c.key] = Number.isFinite(v) ? clampVal(c, v) : Number(c.default ?? 0);
    }
  }
}

async function ensureMeta(): Promise<void> {
  if (metaLoaded) return;
  metaLoaded = true;
  try {
    applyMeta(await marketApi.targetConds());
  } catch { applyMeta(FALLBACK_CONDS); }
}

let timer: ReturnType<typeof setInterval> | null = null;
let revision = 0;
let trend = { mode: "cross", recent: 5, stillAbove: true, aboveDays: 1 };
try {
  const saved = JSON.parse(localStorage.getItem("yc_tgt_trend") || "null");
  if (saved && ["cross", "above"].includes(saved.mode) && [saved.recent, saved.aboveDays].every(n => Number.isInteger(n) && n >= 1 && n <= 250) && typeof saved.stillAbove === "boolean") trend = saved;
} catch { /* 损坏设置回默认 */ }
let totalHits = 0;

/* ── 行内缩略图 ──
 * 上：K 线 + 中线趋势（MA45，站上=橙/跌破=蓝）；下：趋势柱线 STICKV。
 * 三挡范围（小 30 / 中 60 / 大 120 日）；开关与范围本地记忆，默认开启。
 * 数据按（代码 + 范围 + 数据日）缓存，翻页/排序只补新出现的行。 */
type SparkRange = "small" | "medium" | "large";
const SPARK_BARS: Record<SparkRange, number> = { small: 30, medium: 60, large: 120 };
const SPARK_LABEL: Record<SparkRange, string> = { small: "小（30 日）", medium: "中（60 日）", large: "大（120 日）" };
let sparkOn = true;
let sparkRange: SparkRange = "medium";
try {
  const saved = JSON.parse(localStorage.getItem("yc_tgt_spark") || "null");
  if (saved && typeof saved.on === "boolean" && ["small", "medium", "large"].includes(saved.range)) {
    sparkOn = saved.on;
    sparkRange = saved.range;
  }
} catch { /* 损坏设置回默认 */ }
const sparkCache = new Map<string, TargetSpark | null>();
let sparkDay = "";
let sparkSeq = 0;

/* 分页（通用组件）：指标层一次算完返回全量，前端切片渲染 */
let pager: Pager | null = null;
let tbl: DataTable<TargetItem> | null = null;
let tableHasTrend = false;
let items: TargetItem[] = [];
let scanned = 0;
/* 数据断更时非空：空态区改用这句话，避免"没有满足条件"把断更当成筛选结果 */
let staleMsg = "";

function condsParam(): string {
  return meta.filter((d) => conds[d.key]).map((d) => d.key).join(",");
}

/* 数值条件的阈值只随启用条件下发；未勾选的不参与判定 */
function valuesParam(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of meta) if (d.kind === "value" && conds[d.key]) out[d.key] = tvals[d.key];
  return out;
}

async function load(resetPage = false): Promise<void> {
  const request = ++revision;
  const st = document.getElementById("tgt-status")!;
  st.textContent = "计算中…";
  try {
    const r = await marketApi.targets(condsParam(), 10000, trend, valuesParam());
    if (request !== revision) return;
    totalHits = r.total_hits;
    items = r.items;
    scanned = r.scanned;
    staleMsg = r.stale ? (r.message || "数据未更新，暂不计算") : "";
    if (r.as_of && r.as_of !== sparkDay) { sparkCache.clear(); sparkDay = r.as_of; }
    if (resetPage) pager?.reset();
    drawPage();
    const at = r.computed_at || "";
    /* 数据断更：后端直接拒绝计算，这里如实显示原因，不展示空榜误导 */
    if (r.stale) {
      st.textContent = r.message || "数据未更新，暂不计算";
      st.style.color = "var(--warn)";
      return;
    }
    st.style.color = "";
    /* 日线断更时，钱袋/地雷仍是旧口径；必须写明，避免与"数据截至"混淆 */
    const moneyDay = items.reduce((m, t) => (t.money_date && t.money_date > m ? t.money_date : m), "");
    const moneyNote = moneyDay && moneyDay !== r.as_of ? `｜钱袋/地雷基于日线 ${moneyDay}` : "";
    st.textContent = at
      ? `计算于 ${at}｜数据截至 ${r.as_of}${r.provisional ? "（含实时快照）" : ""}${moneyNote}`
      : (r.as_of ? `数据截至 ${r.as_of}${r.provisional ? "（今日日线还没入库，按实时行情暂估）" : ""}${moneyNote}` : "");
  } catch {
    if (request !== revision) return;
    st.textContent = "计算失败，稍后自动重试";
  }
}

/* 主题色（retheme 后由 drawPage 刷新，列渲染取用） */
const PAL = { o: "", b: "" };

/* 六分段图形标尺：6 格＝趋势线六位置（1 超跌 → 2 反弹 → 3 突破 → 4 超涨 → 5 回踩 → 6 跌破），
   亮格按操作建议着色（参与 / 谨慎 / 回避），旁边留段名；比纯文字 tag 一眼看出「在哪个位置」 */
const SEG_NAMES = ["超跌", "反弹", "突破", "超涨", "回踩", "跌破"];
const SEG_ACTIONS = ["不参与", "禁止参与", "积极参与", "小仓谨慎", "积极参与", "禁止参与"];
const SEG_TIER = ["no", "no", "go", "hold", "go", "no"];
function segMeter(seg: number, name?: string | null): string {
  const n = Math.max(1, Math.min(6, seg || 1));
  const tint = ["var(--down)", "var(--down)", "var(--up)", "var(--accent)", "var(--up)", "var(--down)"][n - 1];
  const cells = SEG_NAMES
    .map((s, i) => `<i class="${i + 1 === n ? `on ${SEG_TIER[i]}` : ""}" title="第${i + 1}段 · ${SEGFULL[i + 1]}（${SEG_ACTIONS[i]}）"></i>`)
    .join("");
  return `<span class="seg6" title="六分段理论：围绕日线短线趋势线（MA7 快 / MA10 慢）的六个位置。1 趋势线超跌 → 2 反弹趋势线 → 3 趋势线突破 → 4 趋势线超涨 → 5 回踩趋势线 → 6 趋势线跌破">
    <span class="seg6-cells">${cells}</span>
    <small style="color:${tint}">第${n}段 · ${esc(name || SEG_NAMES[n - 1])}</small></span>`;
}

/* ── 六分段理论示意图（真实日 K） ──
 * 拉一只流动性好的票的真实日 K，自动挑「最近一个完整六段循环」的窗口（1 趋势线超跌 → …
 * → 6 趋势线跌破，各段首次依序出现），各段首次出现处拉线标注众赢原话位置名 + 操作建议。
 * 段位判定与表内「六分段」列同口径；行情未就绪时占位，取回后自动重绘。 */
const SEG_TINTS = ["var(--down)", "var(--down)", "var(--up)", "var(--accent)", "var(--up)", "var(--down)"];
const SEG_SAMPLE = { symbol: "002472.SZ", name: "双环传动", bars: [] as Bar[], at: 0, loading: false };
const SEG_SAMPLE_TTL = 5 * 60 * 1000;

let segMapOn = true;
try { segMapOn = localStorage.getItem("yc_tgt_segmap") !== "0"; } catch { /* 默认展开 */ }

function segSampleBars(): Bar[] {
  const s = SEG_SAMPLE;
  if (s.bars.length && Date.now() - s.at < SEG_SAMPLE_TTL) return s.bars;
  if (!s.loading) {
    s.loading = true;
    void marketApi.kline({ symbol: s.symbol, adjust: "qfq", limit: 220 })
      .then((k) => {
        s.bars = k.bars || [];
        s.at = Date.now();
        s.loading = false;
        renderSegMap();
      })
      .catch(() => { s.loading = false; });
  }
  return s.bars;
}

/** 最近一个「1→6 各段首次依序出现」的窗口，前后各留几根 K 作上下文 */
function segCycle(): { bars: Bar[]; segs: number[]; base: number; label: string } | null {
  const raw = segSampleBars();
  if (raw.length < 40) return null;
  const all = sixSegmentSeries(raw);
  for (let start = raw.length - 1; start >= 0; start--) {
    if (all[start] !== 1) continue;
    let want = 2, end = -1;
    for (let i = start + 1; i < raw.length; i++) {
      if (all[i] !== want) continue;
      if (++want === 7) { end = i; break; }
    }
    if (end < 0 || end - start < 18) continue;
    const a = Math.max(0, start - 4), b = Math.min(raw.length, end + 3);
    return {
      bars: raw.slice(a, b), segs: all.slice(a, b), base: start - a,
      label: `${SEG_SAMPLE.name} ${SEG_SAMPLE.symbol.slice(0, 6)} · ${raw[a].date} → ${raw[b - 1].date}`,
    };
  }
  return null;
}

function segMapSvg(): string {
  const data = segCycle();
  if (!data) {
    return `<div class="segmap-load${SEG_SAMPLE.loading ? "" : " retry"}">` +
      `${SEG_SAMPLE.loading ? "正在加载真实日 K 行情…" : "行情暂不可用，稍后自动重试"}</div>`;
  }
  const pal = trendPalette();
  const { bars, segs, base } = data;
  const n = bars.length;
  const X0 = 26, X1 = 566, Y0 = 16, Y1 = 232, TX = 592;
  const PW = X1 - X0, PH = Y1 - Y0, step = PW / n;
  const xAt = (i: number): number => X0 + (i + 0.5) * step;
  let lo = Infinity, hi = -Infinity;
  bars.forEach((b) => { lo = Math.min(lo, b.low); hi = Math.max(hi, b.high); });
  const pad = (hi - lo) * 0.05 || 0.1;
  lo -= pad; hi += pad;
  const yAt = (v: number): number => Y1 - ((v - lo) / (hi - lo)) * PH;
  const bw = Math.min(9, step * 0.62);

  /* 1) 真实 K 线：影线用 high/low，实体用开盘/收盘，阳/阴随主题涨跌色 */
  const candles = bars.map((b, i) => {
    const up = b.close >= b.open, x = xAt(i);
    const col = up ? "var(--up)" : "var(--down)";
    return `<line x1="${x.toFixed(1)}" y1="${yAt(b.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${yAt(b.low).toFixed(1)}"` +
      ` style="stroke:${col}" stroke-width="1" opacity=".7"/>` +
      `<rect x="${(x - bw / 2).toFixed(1)}" y="${Math.min(yAt(b.open), yAt(b.close)).toFixed(1)}"` +
      ` width="${bw.toFixed(1)}" height="${Math.max(1.2, Math.abs(yAt(b.open) - yAt(b.close))).toFixed(1)}"` +
      ` rx="1" style="fill:${col}" opacity=".85"/>`;
  }).join("");

  /* 2) 短线操盘：MA7 快 / MA10 慢，收盘站上慢线填多头色（与 K 线页趋势通道同判定） */
  const sma = (p: number): (number | null)[] => {
    let sum = 0;
    return bars.map((b, i) => {
      sum += b.close;
      if (i >= p) sum -= bars[i - p].close;
      return i >= p - 1 ? sum / p : null;
    });
  };
  const fast = sma(7), slow = sma(10);
  let channel = "";
  for (let i = 0; i < n; i++) {
    const f = fast[i], s = slow[i];
    if (f == null || s == null) continue;
    const c = bars[i].close >= s ? pal.fr : pal.sr;
    const x = xAt(i);
    channel += `<rect x="${(x - bw / 2 + 1).toFixed(1)}" y="${Math.min(yAt(f), yAt(s)).toFixed(1)}"` +
      ` width="${(bw - 2).toFixed(1)}" height="${Math.max(1, Math.abs(yAt(f) - yAt(s))).toFixed(1)}"` +
      ` style="fill:rgb(${c.join(",")})" opacity=".22"/>`;
  }
  /* 2.5) 短线趋势柱：收盘相对 MA10（慢线）的偏离，叠在 K 线之下——红多头 / 绿空头 */
  let trendBars = "";
  for (let i = 0; i < n; i++) {
    const s = slow[i];
    if (s == null) continue;
    const y1 = yAt(s), y2 = yAt(bars[i].close);
    const col = bars[i].close >= s ? "var(--up)" : "var(--down)";
    trendBars += `<rect x="${(xAt(i) - bw / 2).toFixed(1)}" y="${Math.min(y1, y2).toFixed(1)}"` +
      ` width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y2 - y1)).toFixed(1)}"` +
      ` rx="1" style="fill:${col}" opacity=".16"/>`;
  }
  const trendLine = (arr: (number | null)[], color: string): string => {
    let d = "", out = "";
    arr.forEach((v, i) => {
      if (v == null) { if (d) { out += d; d = ""; } return; }
      d += `${d ? " L" : "M"}${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`;
    });
    return out + d ? `<path d="${out + d}" style="stroke:${color}" stroke-width="1.6" fill="none"/>` : "";
  };

  /* 3) 六段分别拉线：钉在该段首次出现的收盘，右侧标注段名 + 操作含义 */
  const marks: { seg: number; idx: number; x: number; y: number }[] = [];
  for (let i = 1; i <= 6; i++) {
    const idx = segs.indexOf(i, base);
    if (idx >= 0) marks.push({ seg: i, idx, x: xAt(idx), y: yAt(bars[idx].close) });
  }
  // 右侧固定按 1→6 自上而下排，阅读顺序即理论循环顺序；拉线从各段首次出现点连过去
  const leads = marks.map((m) => {
    const ly = Y0 + 12 + (m.seg - 1) * ((PH - 26) / 5);
    const tint = SEG_TINTS[m.seg - 1];
    return `<line x1="${(m.x + 3).toFixed(1)}" y1="${m.y.toFixed(1)}" x2="${TX - 6}" y2="${ly.toFixed(1)}"` +
      ` style="stroke:${tint}" stroke-width="1" stroke-dasharray="4 3" opacity=".55"/>` +
      `<circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="3" style="fill:${tint}"/>` +
      `<text x="${TX}" y="${(ly + 3.5).toFixed(1)}">` +
      `<tspan style="fill:${tint}" font-weight="600">${m.seg} · ${SEGFULL[m.seg]}</tspan>` +
      `<tspan dx="7" style="fill:var(--faint)" font-size="10">${SEG_ACTIONS[m.seg - 1]}</tspan></text>`;
  }).join("");

  /* 4) 窗口末根所在段：圈最后一根收盘，标签压在点的左侧，避免伸进右侧说明栏 */
  const lx = xAt(n - 1), ly = yAt(bars[n - 1].close);
  const cur = segs[n - 1] || 1;
  const last = `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.6" fill="none"` +
    ` style="stroke:var(--accent)" stroke-width="1.4"/>` +
    `<text x="${(lx - 7).toFixed(1)}" y="${(ly - 7).toFixed(1)}" text-anchor="end"` +
    ` style="fill:var(--accent)" font-size="10.5">当前 · ${SEGFULL[cur]}</text>`;

  return `<svg viewBox="0 0 880 250" role="img"` +
    ` aria-label="六分段理论示意图：真实日 K 走完超跌、反弹、突破、超涨、回踩、跌破六个位置">` +
    `${channel}${trendBars}${candles}${trendLine(fast, pal.fast)}${trendLine(slow, pal.slow)}${leads}${last}</svg>` +
    `<div class="segmap-note">${esc(data.label)} · 日K（前复权）｜六段按众赢短线操盘 MA7 / MA10 判定` +
    `（取最近一个完整六段循环）</div>`;
}

function applySegMapState(): void {
  const body = document.getElementById("tgt-segmap-body");
  const btn = document.getElementById("tgt-segmap-btn");
  if (!body) return;
  body.style.display = segMapOn ? "" : "none";
  if (btn) {
    btn.textContent = segMapOn ? "收起" : "展开";
    btn.setAttribute("aria-expanded", String(segMapOn));
  }
}

function renderSegMap(): void {
  const body = document.getElementById("tgt-segmap-body");
  if (!body) return;
  const pal = trendPalette();
  const lg = document.getElementById("tgt-segmap-lg");
  if (lg) {
    lg.innerHTML = `<i style="background:${pal.fast}"></i>快线 MA7` +
      `<i style="background:${pal.slow}"></i>慢线 MA10` +
      `<i class="fill" style="background:rgba(${pal.fr.join(",")},.32)"></i>站上慢线 = 多头` +
      `<i class="fill" style="background:linear-gradient(90deg,var(--up) 50%,var(--down) 50%)"></i>趋势柱 = 收盘 vs MA10`;
  }
  body.innerHTML = segMapSvg();
  applySegMapState();
}

const TGT_COLS: DataTableCol<TargetItem>[] = [
  { label: "#", width: 34, mono: true, render: (_t, i) => `<span style="color:var(--faint)">${i + 1}</span>` },
  { label: "代码", mono: true, sort: "symbol", render: (t) => t.symbol },
  { label: "名称", sort: "name", render: (t) => `<span style="font-weight:600">${esc(t.name || t.symbol)}</span>` },
  { label: "近况", width: 150, title: "上方：K 线 + 中线趋势（站上 MA45 为橙、跌破为蓝）；下方：趋势柱线。鼠标悬停可放大查看",
    render: (t) => `<canvas class="tgt-spark" data-sym="${esc(t.symbol)}" style="width:132px;height:56px"></canvas>` },
  { label: "现价", num: true, sort: "close", render: (t) => fmt(t.close ?? 0) },
  { label: "涨跌幅", num: true, sort: (t) => t.pct_chg ?? null, render: (t) => {
      const ch = t.pct_chg ?? 0;
      return `<span class="${ch >= 0 ? "up" : "down"}">${fmtChg(ch)}%</span>`; } },
  { label: "STICKV", num: true, sort: t => t.trend_value ?? null, render: t => t.trend_value == null ? "—" : `<span class="${t.trend_value > 0 ? "up" : "down"}">${t.trend_value.toFixed(2)}</span>${t.trend_provisional ? '<small> 盘中暂定</small>' : ''}` },
  { label: "最近转正", sort: t => t.trend_cross_date ?? "", render: t => t.trend_cross_date ?? "—" },
  { label: "距今交易日", num: true, sort: t => t.trend_cross_ago ?? null, render: t => t.trend_cross_ago == null ? "—" : t.trend_cross_ago === 0 ? "当日" : `${t.trend_cross_ago}日前` },
  { label: "连续上方", num: true, sort: t => t.trend_above_days, render: t => t.trend_value == null ? "—" : `${t.trend_above_days}日` },
  { label: "负柱收敛", num: true, title: "STICKV 连续为负且逐日收窄的天数（绿柱缩短，提前捕捉上穿零轴）",
    sort: t => t.neg_run ?? 0, render: t => t.neg_run
      ? `<span class="tag ${t.neg_run >= 3 ? "acc" : "p1"}">${t.neg_run}日</span>`
      : `<span style="color:var(--faint)">—</span>` },
  { label: "距零轴", num: true, title: "当前负柱幅度 |STICKV|，越小越贴近零轴",
    sort: t => t.neg_abs ?? null,
    render: t => t.neg_abs == null ? `<span style="color:var(--faint)">—</span>` : t.neg_abs.toFixed(1) },
  { label: "40日均量", num: true, title: "当日成交量 / 40日均量", sort: (t) => t.vol_ratio,
    render: (t) => `<span style="color:${t.vol_hit ? PAL.o : "var(--dim)"}">${t.vol_ratio == null ? "—" : `${t.vol_ratio.toFixed(2)}x`}</span>` },
  { label: "短线趋势", sort: (t) => (t.short_orange ? 1 : 0), render: (t) =>
      `<span style="color:${t.short_orange ? PAL.o : PAL.b}">●</span> ${t.short_orange ? "橙" : "蓝"}` },
  { label: "中线趋势", sort: (t) => (t.mid_orange ? 1 : 0), render: (t) =>
      `<span style="color:${t.mid_orange ? PAL.o : PAL.b}">●</span> ${t.mid_orange ? "橙" : "蓝"}` },
  { label: "20日涨停", num: true, title: "近 20 个交易日涨停次数", sort: (t) => t.limit_up_cnt,
    render: (t) => t.limit_up_20d ? `<span class="tag acc">${t.limit_up_cnt}次</span>` : `<span style="color:var(--faint)">—</span>` },
  { label: "钱袋子", num: true, title: "近 20 日钱袋（ZigZag 低点，反弹 6% 确认）的信号日期 · 出现次数；越新鲜越靠前，适合打底仓/波段低吸",
    sort: (t) => t.money_ago ?? 9999,
    render: (t) => t.money_date == null ? `<span style="color:var(--faint)">—</span>` :
      `<span style="color:${(t.money_ago ?? 9) <= 3 ? PAL.o : "var(--text)"}">${t.money_date.slice(5)}</span>` +
      ((t.money_cnt ?? 0) > 1 ? `<small style="color:var(--faint)"> · ${t.money_cnt}次</small>` : "") },
  { label: "六分段", sort: "seg", title: "六分段理论：围绕日线短线趋势线（MA7 快 / MA10 慢）的六个位置，1 趋势线超跌 → 2 反弹趋势线 → 3 趋势线突破 → 4 趋势线超涨 → 5 回踩趋势线 → 6 趋势线跌破；亮格为当前所在位置",
    render: (t) => (t.seg ? segMeter(t.seg, t.seg_name) : `<span style="color:var(--faint)">—</span>`) },
  { label: "短线状态", sort: (t) => (t.pullback ? 0 : 1), render: (t) =>
      `<span style="font-size:11.5px;color:${t.short_orange ? PAL.o : PAL.b}">${t.pullback ? "回调中" : "上行"} · ${t.short_orange ? "橙" : "蓝"}</span>` },
];

function drawPage(): void {
  const empty = document.getElementById("tgt-empty")!;
  const wantTrend = !!(conds["trend"] || conds["negshrink"] || conds["nearzero"]);
  if (!pager) pager = createPager(document.getElementById("tgt-pager")!, "targets", drawPage);
  if (tableHasTrend !== wantTrend) { tbl = null; tableHasTrend = wantTrend; }
  const columns = (wantTrend ? TGT_COLS : TGT_COLS.filter(column =>
    !["STICKV", "最近转正", "距今交易日", "连续上方", "负柱收敛", "距零轴"].includes(column.label)))
    .filter(column => column.label !== "近况" || sparkOn);
  if (!tbl) tbl = createDataTable(document.getElementById("tgt-wrap")!, columns, {
    rowKey: (t) => t.symbol,
    onRow: (t) => document.dispatchEvent(new CustomEvent("yc:open-stock", {
      detail: { symbol: t.symbol, name: t.name || t.symbol,
        trendFocus: wantTrend ? { date: t.trend_cross_date ?? t.trend_data_date } : undefined,
        from: { page: "targets", label: "目标监控" } } })),
  });
  pager.update(items.length);
  const start = (pager.page - 1) * pager.size;
  const pageRows = slicePage(pager, tbl.sort(items));
  const pal = trendPalette();
  PAL.o = `rgb(${pal.fr.join(",")})`;
  PAL.b = `rgb(${pal.sr.join(",")})`;
  tbl.render(pageRows, start);
  void fillSparks(pageRows);
  document.getElementById("tgt-hits")!.textContent =
    `命中 ${totalHits} / 扫描 ${scanned} 只${totalHits > items.length ? ` · 显示前 ${items.length} 只` : ""}`;
  document.getElementById("tgt-empty-conds")!.textContent =
    String(meta.filter((d) => conds[d.key]).length);
  /* 断更时不是"没命中"，是没算：换成原因说明，并收起引导按钮 */
  const title = empty.querySelector("b")!;
  const sub = empty.querySelector("span") as HTMLElement;
  const acts = empty.querySelector<HTMLElement>(".tgt-empty-acts");
  title.textContent = staleMsg ? "数据未更新，暂不计算" : "没有满足当前勾选条件的标的";
  sub.style.display = staleMsg ? "none" : "";
  if (acts) acts.style.display = staleMsg ? "none" : "";
  empty.style.display = items.length ? "none" : "grid";
}

/* ── 缩略图绘制 ── */
const sparkKeyOf = (symbol: string): string => `${symbol}|${sparkRange}|${sparkDay}`;

/** 补拉当前页缺失的缩略图数据，然后逐格绘制（失败静默，不影响列表） */
async function fillSparks(rows: TargetItem[]): Promise<void> {
  if (!sparkOn) return;
  const seq = ++sparkSeq;
  const missing = [...new Set(rows.map((r) => r.symbol))]
    .filter((s) => !sparkCache.has(sparkKeyOf(s)));
  /* 后端单请求 ≤60 只：每页 100/200 条时按块补拉，避免超出上限只画前 60 行 */
  for (let i = 0; i < missing.length; i += 60) {
    const part = missing.slice(i, i + 60);
    try {
      const res = await marketApi.targetSparks(part.join(","), SPARK_BARS[sparkRange]);
      const got = new Set<string>();
      for (const it of res.items) { sparkCache.set(sparkKeyOf(it.symbol), it); got.add(it.symbol); }
      for (const s of part) if (!got.has(s)) sparkCache.set(sparkKeyOf(s), null);
    } catch {
      return;                       // 下次重绘（轮询/翻页）再试
    }
    if (seq !== sparkSeq) return;
  }
  if (seq !== sparkSeq) return;
  document.getElementById("tgt-wrap")!
    .querySelectorAll<HTMLCanvasElement>("canvas.tgt-spark").forEach((cv) => {
      const d = sparkCache.get(sparkKeyOf(cv.dataset.sym || ""));
      if (d) paintSpark(cv, d);
    });
}

/** 一张缩略图：上半 K 线 + MA45 双色趋势线，下半趋势柱线（零轴上红下绿） */
function paintSpark(cv: HTMLCanvasElement, d: TargetSpark, big = false): void {
  const W = Math.max(40, Math.round(cv.clientWidth || (big ? 380 : 132)));
  const H = Math.max(30, Math.round(cv.clientHeight || (big ? 170 : 56)));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const n = d.close.length;
  if (!n) return;

  const up = chartUp(), down = chartDown(), pal = trendPalette();
  const styles = getComputedStyle(document.documentElement);
  const axis = styles.getPropertyValue("--axis").trim() || "rgba(128,128,128,.25)";
  const padX = 1, padTop = 2, gap = 3;
  const histH = Math.max(9, Math.round(H * 0.28));
  const topH = Math.max(12, H - padTop - histH - gap);
  const step = (W - padX * 2) / n;
  const bw = Math.max(1, Math.min(step * 0.72, big ? 4 : 3));
  const xAt = (i: number): number => padX + (i + 0.5) * step;

  let lo = Infinity, hi = -Infinity;
  for (const v of d.low) if (v < lo) lo = v;
  for (const v of d.high) if (v > hi) hi = v;
  for (const v of d.ma45) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
  const span = Math.max(hi - lo, hi * 0.002, 0.01);
  const yAt = (v: number): number => padTop + topH - ((v - lo) / span) * topH * 0.96 - topH * 0.02;

  /* K 线：阳线红 / 阴线绿（跟随主题涨跌色） */
  for (let i = 0; i < n; i++) {
    const color = d.close[i] >= d.open[i] ? up : down;
    const x = xAt(i);
    if (big) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yAt(d.high[i]));
      ctx.lineTo(x, yAt(d.low[i]));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const top = yAt(Math.max(d.open[i], d.close[i]));
    const bottom = yAt(Math.min(d.open[i], d.close[i]));
    ctx.fillStyle = color;
    ctx.fillRect(x - bw / 2, top, bw, Math.max(1, bottom - top));
  }

  /* 中线趋势：MA45 线按「站上=橙 / 跌破=蓝」逐段着色 */
  ctx.lineWidth = big ? 1.6 : 1;
  for (let i = 1; i < n; i++) {
    const a = d.ma45[i - 1], b = d.ma45[i];
    if (a == null || b == null) continue;
    ctx.strokeStyle = d.strong[i] ? pal.fast : pal.slow;
    ctx.beginPath();
    ctx.moveTo(xAt(i - 1), yAt(a));
    ctx.lineTo(xAt(i), yAt(b));
    ctx.stroke();
  }

  /* 趋势柱线：与零轴比，红正绿负；上下列之间一条细分割线 */
  const sepY = padTop + topH + gap / 2;
  ctx.strokeStyle = axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, sepY);
  ctx.lineTo(W, sepY);
  ctx.stroke();

  const values = d.trend.filter((v): v is number => v != null);
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));
  const zeroY = padTop + topH + gap + histH / 2;
  for (let i = 0; i < n; i++) {
    const v = d.trend[i];
    if (v == null) continue;
    const bh = Math.max(1, Math.abs(v) / maxAbs * (histH / 2 - 1));
    ctx.fillStyle = v >= 0 ? up : down;
    ctx.fillRect(xAt(i) - bw / 2, v >= 0 ? zeroY - bh : zeroY, bw, bh);
  }
  ctx.strokeStyle = axis;
  ctx.beginPath();
  ctx.moveTo(0, zeroY);
  ctx.lineTo(W, zeroY);
  ctx.stroke();
}

/* ── 悬停放大卡片 ── */
let sparkPop: HTMLDivElement | null = null;
let sparkPopCv: HTMLCanvasElement | null = null;
let sparkPopCap: HTMLDivElement | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

function hideSparkPop(): void {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  if (sparkPop) sparkPop.style.display = "none";
}

function placeSparkPop(ev: MouseEvent): void {
  if (!sparkPop || sparkPop.style.display === "none") return;
  const pad = 14;
  const w = sparkPop.offsetWidth || 396, h = sparkPop.offsetHeight || 220;
  const left = Math.min(ev.clientX + pad, window.innerWidth - w - 8);
  const top = Math.min(ev.clientY + pad, window.innerHeight - h - 8);
  sparkPop.style.left = `${Math.max(8, left)}px`;
  sparkPop.style.top = `${Math.max(8, top)}px`;
}

function showSparkPop(cv: HTMLCanvasElement, ev: MouseEvent): void {
  const symbol = cv.dataset.sym || "";
  const d = sparkCache.get(sparkKeyOf(symbol));
  if (!d) return;
  if (!sparkPop) {
    sparkPop = document.createElement("div");
    sparkPop.className = "tgt-spark-pop";
    sparkPop.innerHTML = `<canvas></canvas><div class="cap"></div>`;
    document.body.appendChild(sparkPop);
    sparkPopCv = sparkPop.querySelector("canvas")!;
    sparkPopCap = sparkPop.querySelector(".cap")!;
  }
  sparkPop.style.display = "block";
  paintSpark(sparkPopCv!, d, true);
  const row = items.find((t) => t.symbol === symbol);
  const last = d.close.length ? d.close[d.close.length - 1] : null;
  const tv = d.trend[d.trend.length - 1];
  sparkPopCap!.innerHTML =
    `<b>${esc(row?.name || symbol)}</b> <span class="num" style="color:var(--faint)">${esc(symbol)}</span>` +
    `<span style="color:var(--faint)"> · ${esc(d.dates[0] || "")} ~ ${esc(d.dates[d.dates.length - 1] || "")}</span>` +
    (last == null ? "" : ` · 最新 <b class="num">${fmt(last)}</b>`) +
    (tv == null ? "" : ` · 趋势柱线 <b class="${tv > 0 ? "up" : "down"}">${tv.toFixed(1)}</b>`);
  placeSparkPop(ev);
}


/* 条件分组：按语义收纳，避免七项平铺成一条长栏 */
const COND_GROUPS: [string, string[]][] = [
  ["量能", ["vol"]],
  ["价格结构", ["short", "mid", "up20"]],
  ["信号", ["trend", "negshrink", "nearzero", "money"]],
];
/* 钱袋子阈值用自然语言，避免「≤5 日」这种要心算的口径 */
const MONEY_PILLS: [string, number][] = [["今日", 0], ["3日", 3], ["5日", 5], ["10日", 10]];

function presetKeys(): Record<string, string[]> {
  return {
    all: meta.filter((d) => d.default_on).map((d) => d.key),
    money: ["money"],
    trend: ["trend"],
    none: [],
  };
}

function applyPreset(p: string): void {
  const keys = presetKeys()[p];
  if (!keys) return;
  for (const d of meta) conds[d.key] = keys.includes(d.key);
  localStorage.setItem("yc_tgt_conds", JSON.stringify(conds));
  renderConds();
  void load(true);
}

function condControl(d: TargetCond): string {
  const on = !!conds[d.key];
  const chip = `<button type="button" class="chip${on ? " on" : ""}" aria-pressed="${on}" data-c="${d.key}" title="${esc(d.title || "")}">${esc(d.label)}</button>`;
  if (d.kind !== "value") return chip;
  if (d.key === "money") {
    const cur = Number(tvals[d.key]);
    return `<span class="tgt-val${on ? "" : " off"}">${chip}<span class="tgt-money-seg" role="group" aria-label="钱袋子时间范围">` +
      MONEY_PILLS.map(([label, v]) => `<i data-mv="${v}" class="${cur === v ? "on" : ""}">${label}</i>`).join("") +
      `</span></span>`;
  }
  const unit = d.unit ? ` ${esc(d.unit)}` : "";
  return `<span class="tgt-val${on ? "" : " off"}">${chip}<label>${d.op === "<=" ? "≤" : "≥"}` +
    `<input type="number" data-v="${d.key}" aria-label="${esc(d.label)}阈值"` +
    `${d.min == null ? "" : ` min="${d.min}"`}${d.max == null ? "" : ` max="${d.max}"`}` +
    ` step="${d.step ?? "any"}" value="${tvals[d.key]}"${on ? "" : " disabled"}>${unit}</label></span>`;
}

function renderConds(): void {
  const el = document.getElementById("tgt-conds")!;
  const onKeys = meta.filter((d) => conds[d.key]).map((d) => d.key);
  const presets = presetKeys();
  const active = Object.keys(presets).find(
    (p) => presets[p].slice().sort().join(",") === onKeys.slice().sort().join(","));
  const known = new Set(COND_GROUPS.flatMap(([, keys]) => keys));
  const groups = [...COND_GROUPS, ["其它", meta.filter((d) => !known.has(d.key)).map((d) => d.key)] as [string, string[]]]
    .map(([label, keys]) => {
      const ds = meta.filter((d) => keys.includes(d.key));
      if (!ds.length) return "";
      return `<div class="tgt-grp"><span class="tgt-grp-label">${label}</span><div class="tgt-grp-body">${ds.map(condControl).join("")}</div></div>`;
    }).join("");
  const conflict = !!conds["money"] && (!!conds["short"] || !!conds["mid"]);
  el.innerHTML =
    `<div class="tgt-presets">` +
    ([["all", "全部条件"], ["money", "只看钱袋"], ["trend", "只看趋势"], ["none", "清空"]] as [string, string][])
      .map(([p, label]) => `<button type="button" class="tgt-preset${active === p ? " on" : ""}" data-p="${p}" aria-pressed="${active === p}">${label}</button>`).join("") +
    `<button type="button" class="tgt-preset" disabled title="地雷信号尚未接入数据层">只看地雷 <i>待接入</i></button>` +
    `<span class="tgt-preset-count">已启用 <b>${onKeys.length}</b>/${meta.length}</span></div>` +
    groups +
    `<div class="tgt-grp-hint">所有勾选条件同时满足 · ST 已剔除 · 未勾选不参与判定</div>` +
    (conflict ? `<div class="tgt-conflict">钱袋子是低点确认，价格通常在 MA10 下方，与趋势橙方向相反；叠加后命中极少。<button type="button" class="tgt-conflict-fix" data-p="money">只保留钱袋</button></div>` : "");
  if (conds["trend"]) {
    el.insertAdjacentHTML("beforeend", `<div class="tgt-trend-set">
      <label>趋势柱线 <select id="tgt-trend-mode"><option value="cross" ${trend.mode === "cross" ? "selected" : ""}>负转正</option><option value="above" ${trend.mode === "above" ? "selected" : ""}>零轴上方</option></select></label>
      ${trend.mode === "cross" ? `<label>最近 <select id="tgt-trend-recent">${[1,3,5,10,20].map(n => `<option value="${n}" ${trend.recent === n ? "selected" : ""}>${n}</option>`).join('')}<option value="custom" ${![1,3,5,10,20].includes(trend.recent) ? "selected" : ""}>自定义</option></select> 个交易日</label>
      <label>天数 <input aria-label="最近交易日数" id="tgt-trend-days" type="number" min="1" max="250" step="1" value="${trend.recent}"></label>
      <label><input id="tgt-trend-still" type="checkbox" ${trend.stillAbove ? "checked" : ""}>当前仍在零轴上方</label>` :
      `<label>连续至少 <input aria-label="连续上方交易日数" id="tgt-trend-days" type="number" min="1" max="250" step="1" value="${trend.aboveDays}"> 个交易日</label>`}
      <span class="tgt-trend-hint">${trend.mode === "cross" ? "前值≤0、当日>0；窗口包含最新数据日" : "STICKV>0，零值不计入连续天数"} · 日K前复权</span></div>`);
    const save = () => { localStorage.setItem("yc_tgt_trend", JSON.stringify(trend)); renderConds(); void load(true); };
    el.querySelector<HTMLSelectElement>('#tgt-trend-mode')!.onchange = event => { trend.mode = (event.target as HTMLSelectElement).value; save(); };
    const recent = el.querySelector<HTMLSelectElement>('#tgt-trend-recent');
    if (recent) recent.onchange = () => { if (recent.value === "custom") { el.querySelector<HTMLInputElement>('#tgt-trend-days')!.focus(); return; } trend.recent = Number(recent.value); save(); };
    const days = el.querySelector<HTMLInputElement>('#tgt-trend-days')!;
    days.onchange = () => { if (!days.reportValidity()) return; if (trend.mode === "cross") trend.recent = Number(days.value); else trend.aboveDays = Number(days.value); save(); };
    const still = el.querySelector<HTMLInputElement>('#tgt-trend-still');
    if (still) still.onchange = () => { trend.stillAbove = still.checked; save(); };
  }
  /* 行内缩略图：开关 + 三挡范围（默认开启，本地记忆，不参与筛选） */
  el.insertAdjacentHTML("beforeend",
    `<div class="tgt-trend-set tgt-spark-set">` +
    `<label><input type="checkbox" id="tgt-spark-on" ${sparkOn ? "checked" : ""}> 显示缩略图</label>` +
    `<label>范围 <select id="tgt-spark-range">${(Object.keys(SPARK_BARS) as SparkRange[])
      .map((k) => `<option value="${k}" ${sparkRange === k ? "selected" : ""}>${SPARK_LABEL[k]}</option>`).join("")}</select></label>` +
    `<span class="tgt-trend-hint">上：K 线 + 中线趋势（橙=站上 MA45）· 下：趋势柱线 · 鼠标悬停放大</span></div>`);
  const saveSpark = (): void =>
    localStorage.setItem("yc_tgt_spark", JSON.stringify({ on: sparkOn, range: sparkRange }));
  el.querySelector<HTMLInputElement>("#tgt-spark-on")!.onchange = (event) => {
    sparkOn = (event.target as HTMLInputElement).checked;
    saveSpark();
    hideSparkPop();
    tbl = null;                       // 列增减需重建表格
    drawPage();
  };
  el.querySelector<HTMLSelectElement>("#tgt-spark-range")!.onchange = (event) => {
    sparkRange = (event.target as HTMLSelectElement).value as SparkRange;
    saveSpark();
    hideSparkPop();
    drawPage();
  };
  /* 快捷预设：一键切换条件组合（默认全条件 / 只看钱袋 / 只看趋势 / 清空） */
  el.querySelectorAll<HTMLElement>("[data-p]").forEach((b) =>
    b.addEventListener("click", () => applyPreset(b.dataset.p!)));
  /* 钱袋子时间范围：点选即启用并重筛 */
  el.querySelectorAll<HTMLElement>(".tgt-money-seg i").forEach((b) =>
    b.addEventListener("click", () => {
      tvals["money"] = Number(b.dataset.mv);
      conds["money"] = true;
      localStorage.setItem("yc_tgt_vals", JSON.stringify(tvals));
      localStorage.setItem("yc_tgt_conds", JSON.stringify(conds));
      renderConds();
      void load(true);
    }));
  el.querySelectorAll<HTMLElement>(".chip[data-c]").forEach((c) =>
    c.addEventListener("click", () => {
      const k = c.dataset.c!;
      conds[k] = !conds[k];
      localStorage.setItem("yc_tgt_conds", JSON.stringify(conds));
      renderConds();
      void load(true);                   // 改条件 → 即时重筛（指标层只读，毫秒级）
    }));
  /* 数值阈值：失焦/回车提交，clamp 回登记范围后即时重筛 */
  el.querySelectorAll<HTMLInputElement>("input[data-v]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const d = meta.find((x) => x.key === inp.dataset.v);
      if (!d || !inp.reportValidity()) return;
      const v = Number(inp.value);
      if (!Number.isFinite(v)) return;
      tvals[d.key] = clampVal(d, v);
      inp.value = String(tvals[d.key]);
      localStorage.setItem("yc_tgt_vals", JSON.stringify(tvals));
      void load(true);
    });
  });
}

export function loadTargets(): void {
  void ensureMeta().then(() => {
    renderConds();
    void load();
  });
  if (!timer) {                          // 驻留轮询：数据更新（缓存键变化）即出新结果
    timer = setInterval(() => {
      if (document.getElementById("page-targets")?.classList.contains("on")) void load();
    }, 60_000);
  }
}

export function initTargets(): void {
  document.getElementById("tgt-refresh")!.addEventListener("click", () => void load());
  document.getElementById("tgt-export")!.addEventListener("click", () => void exportExcel());
  /* 空结果引导：直接切到最可能的预设，避免在七个条件里反复试 */
  document.getElementById("tgt-empty-money")!.addEventListener("click", () => applyPreset("money"));
  document.getElementById("tgt-empty-clear")!.addEventListener("click", () => applyPreset("none"));
  /* 六分段示意图：静态内容只在启动渲染一次，展开/收起状态本地记忆 */
  renderSegMap();
  document.getElementById("tgt-segmap-btn")!.addEventListener("click", () => {
    segMapOn = !segMapOn;
    localStorage.setItem("yc_tgt_segmap", segMapOn ? "1" : "0");
    applySegMapState();
  });
  /* 缩略图悬停放大：事件委托，表格重绘后无需重新绑定 */
  const wrap = document.getElementById("tgt-wrap")!;
  const canvasOf = (target: EventTarget | null): HTMLCanvasElement | null =>
    target instanceof Element ? target.closest<HTMLCanvasElement>("canvas.tgt-spark") : null;
  wrap.addEventListener("mouseover", (ev) => {
    const cv = canvasOf(ev.target);
    if (!cv) return;
    hideSparkPop();
    hoverTimer = setTimeout(() => showSparkPop(cv, ev), 160);
  });
  wrap.addEventListener("mousemove", (ev) => {
    if (canvasOf(ev.target)) placeSparkPop(ev);
    else hideSparkPop();
  });
  wrap.addEventListener("mouseout", (ev) => {
    if (canvasOf(ev.target)) hideSparkPop();
  });
  wrap.addEventListener("scroll", hideSparkPop, { passive: true });
}

/* 导出当前条件命中的全量列表（后端生成 xlsx，前端按响应头文件名落地） */
async function exportExcel(): Promise<void> {
  const btn = document.getElementById("tgt-export") as HTMLButtonElement;
  const st = document.getElementById("tgt-status")!;
  if (btn.disabled) return;
  btn.disabled = true;
  st.textContent = "正在生成 Excel…";
  try {
    const res = await marketApi.targetExport(condsParam(), trend, valuesParam());
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const name = m ? decodeURIComponent(m[1]) : "目标监控.xlsx";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    st.textContent = `已导出 ${name}（命中 ${totalHits} 只）`;
  } catch {
    st.textContent = "导出失败，请稍后重试";
  } finally {
    btn.disabled = false;
  }
}
