/* 目标页：全市场四条件扫描（策影目标页同源口径）。
 * 指标层（均线/量比/六分段/涨停次数）服务端一次算好按数据日缓存；
 * 条件层前端勾选 → 传参即时重筛；数据更新后缓存键变化自动重算。
 * 页面打开时加载，驻留期间 60s 轮询（数据更新即新结果）。 */
import { marketApi, type TargetItem } from "../api";
import { esc, fmt, fmtChg } from "../fmt";
import { createPager, slicePage, type Pager } from "../pager";
import { createDataTable, type DataTable, type DataTableCol } from "../table";
import { trendPalette } from "./kline";

type Cond = "vol" | "short" | "mid" | "up20";
const CONDS: { k: Cond; label: string; title: string }[] = [
  { k: "vol", label: "40日均量", title: "当日成交量 ≥ 40日均量" },
  { k: "short", label: "短线趋势橙", title: "收盘站上 MA10（K 线短线趋势通道填橙同判定）" },
  { k: "mid", label: "中线趋势橙", title: "收盘站上 MA45（K 线中线趋势通道填橙同判定）" },
  { k: "up20", label: "20日内涨停", title: "近 20 个交易日有过涨停（主板 10% / 创业科创 20%）" },
];
let conds: Record<Cond, boolean> = { vol: true, short: true, mid: true, up20: true };
try {
  const raw = localStorage.getItem("yc_tgt_conds");
  if (raw) conds = { ...conds, ...(JSON.parse(raw) as Partial<Record<Cond, boolean>>) };
} catch { /* 损坏回默认全勾 */ }
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

/* 分页（通用组件）：指标层一次算完返回全量，前端切片渲染 */
let pager: Pager | null = null;
let tbl: DataTable<TargetItem> | null = null;
let items: TargetItem[] = [];
let scanned = 0;

function condsParam(): string {
  return CONDS.filter((d) => conds[d.k]).map((d) => d.k).join(",");
}

async function load(resetPage = false): Promise<void> {
  if (busy) return;
  busy = true;
  const st = document.getElementById("tgt-status")!;
  st.textContent = "计算中…";
  try {
    const r = await marketApi.targets(condsParam(), 500);
    items = r.items;
    scanned = r.scanned;
    if (resetPage) pager?.reset();
    drawPage();
    st.textContent = r.as_of ? `数据截至 ${r.as_of}` : "";
  } catch {
    st.textContent = "计算失败，稍后自动重试";
  } finally {
    busy = false;
  }
}

/* 主题色（retheme 后由 drawPage 刷新，列渲染取用） */
const PAL = { o: "", b: "" };

const TGT_COLS: DataTableCol<TargetItem>[] = [
  { label: "#", width: 34, mono: true, render: (_t, i) => `<span style="color:var(--faint)">${i + 1}</span>` },
  { label: "代码", mono: true, sort: "symbol", render: (t) => t.symbol },
  { label: "名称", sort: "name", render: (t) => `<span style="font-weight:600">${esc(t.name || t.symbol)}</span>` },
  { label: "现价", num: true, sort: "close", render: (t) => fmt(t.close ?? 0) },
  { label: "涨跌幅", num: true, sort: (t) => t.pct_chg ?? null, render: (t) => {
      const ch = t.pct_chg ?? 0;
      return `<span class="${ch >= 0 ? "up" : "down"}">${fmtChg(ch)}%</span>`; } },
  { label: "40日均量", num: true, title: "当日成交量 / 40日均量", sort: (t) => t.vol_ratio,
    render: (t) => `<span style="color:${t.vol_hit ? PAL.o : "var(--dim)"}">${t.vol_ratio == null ? "—" : `${t.vol_ratio.toFixed(2)}x`}</span>` },
  { label: "短线趋势", sort: (t) => (t.short_orange ? 1 : 0), render: (t) =>
      `<span style="color:${t.short_orange ? PAL.o : PAL.b}">●</span> ${t.short_orange ? "橙" : "蓝"}` },
  { label: "中线趋势", sort: (t) => (t.mid_orange ? 1 : 0), render: (t) =>
      `<span style="color:${t.mid_orange ? PAL.o : PAL.b}">●</span> ${t.mid_orange ? "橙" : "蓝"}` },
  { label: "20日涨停", num: true, title: "近 20 个交易日涨停次数", sort: (t) => t.limit_up_cnt,
    render: (t) => t.limit_up_20d ? `<span class="tag acc">${t.limit_up_cnt}次</span>` : `<span style="color:var(--faint)">—</span>` },
  { label: "六分段", sort: "seg", render: (t) =>
      `<span class="tag ${t.seg >= 4 ? "acc" : t.seg <= 1 ? "flat" : "p1"}">第${t.seg}段·${esc(t.seg_name)}</span>` },
  { label: "短线状态", sort: (t) => (t.pullback ? 0 : 1), render: (t) =>
      `<span style="font-size:11.5px;color:${t.short_orange ? PAL.o : PAL.b}">${t.pullback ? "回调中" : "上行"} · ${t.short_orange ? "橙" : "蓝"}</span>` },
];

function drawPage(): void {
  const empty = document.getElementById("tgt-empty")!;
  if (!pager) pager = createPager(document.getElementById("tgt-pager")!, "targets", drawPage);
  if (!tbl) tbl = createDataTable(document.getElementById("tgt-wrap")!, TGT_COLS, {
    onRow: (t) => document.dispatchEvent(new CustomEvent("yc:open-stock", {
      detail: { symbol: t.symbol, name: t.name || t.symbol,
        from: { page: "targets", label: "目标监控" } } })),
  });
  pager.update(items.length);
  const start = (pager.page - 1) * pager.size;
  const pageRows = slicePage(pager, tbl.sort(items));
  const pal = trendPalette();
  PAL.o = `rgb(${pal.fr.join(",")})`;
  PAL.b = `rgb(${pal.sr.join(",")})`;
  tbl.render(pageRows, start);
  document.getElementById("tgt-hits")!.textContent =
    `命中 ${items.length} / 扫描 ${scanned} 只`;
  empty.style.display = items.length ? "none" : "grid";
}

function renderConds(): void {
  const el = document.getElementById("tgt-conds")!;
  el.innerHTML = CONDS.map((d) =>
    `<span class="chip${conds[d.k] ? " on" : ""}" data-c="${d.k}" title="${esc(d.title)}">${esc(d.label)}</span>`).join("") +
    `<span style="font-size:11.5px;color:var(--faint)">ST 已剔除 · 未勾选条件不参与判定</span>`;
  el.querySelectorAll<HTMLElement>(".chip[data-c]").forEach((c) =>
    c.addEventListener("click", () => {
      const k = c.dataset.c as Cond;
      conds[k] = !conds[k];
      localStorage.setItem("yc_tgt_conds", JSON.stringify(conds));
      renderConds();
      void load(true);                   // 改条件 → 即时重筛（指标层缓存，毫秒级）
    }));
}

export function loadTargets(): void {
  renderConds();
  void load();
  if (!timer) {                          // 驻留轮询：数据更新（缓存键变化）即出新结果
    timer = setInterval(() => {
      if (document.getElementById("page-targets")?.classList.contains("on")) void load();
    }, 60_000);
  }
}

export function initTargets(): void {
  document.getElementById("tgt-refresh")!.addEventListener("click", () => void load());
}
