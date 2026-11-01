/* 目标页：全市场四条件扫描（策影目标页同源口径）。
 * 指标层（均线/量比/六分段/涨停次数）服务端一次算好按数据日缓存；
 * 条件层前端勾选 → 传参即时重筛；数据更新后缓存键变化自动重算。
 * 页面打开时加载，驻留期间 60s 轮询（数据更新即新结果）。 */
import { marketApi, type TargetItem } from "../api";
import { esc, fmt, fmtChg } from "../fmt";
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

/* 分页：指标层一次算完返回全量，前端每页 50 条本地翻页 */
const PAGE_SIZE = 50;
let items: TargetItem[] = [];
let page = 1;
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
    if (resetPage) page = 1;
    drawPage();
    st.textContent = r.as_of ? `数据截至 ${r.as_of}` : "";
  } catch {
    st.textContent = "计算失败，稍后自动重试";
  } finally {
    busy = false;
  }
}

function drawPage(): void {
  const body = document.getElementById("tgt-body")!;
  const empty = document.getElementById("tgt-empty")!;
  const pager = document.getElementById("tgt-pager")!;
  document.getElementById("tgt-hits")!.textContent =
    `命中 ${items.length} / 扫描 ${scanned} 只`;
  empty.style.display = items.length ? "none" : "grid";
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  page = Math.min(Math.max(1, page), pages);
  const start = (page - 1) * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);

  const pal = trendPalette();
  const ORANGE = `rgb(${pal.fr.join(",")})`, BLUE = `rgb(${pal.sr.join(",")})`;
  body.innerHTML = slice.map((t, i) => {
    const ch = t.pct_chg ?? 0;
    const dot = (on: boolean) => `<span style="color:${on ? ORANGE : BLUE}">●</span> ${on ? "橙" : "蓝"}`;
    const state = `${t.pullback ? "回调中" : "上行"} · ${t.short_orange ? "橙" : "蓝"}`;
    return `<tr data-stock="${t.symbol}" data-name="${esc(t.name || t.symbol)}">` +
      `<td class="num" style="color:var(--faint)">${start + i + 1}</td>` +
      `<td class="num">${t.symbol}</td>` +
      `<td><span style="font-weight:600">${esc(t.name || t.symbol)}</span></td>` +
      `<td class="n num">${fmt(t.close ?? 0)}</td>` +
      `<td class="n num ${ch >= 0 ? "up" : "down"}">${fmtChg(ch)}%</td>` +
      `<td class="n num" style="color:${t.vol_hit ? ORANGE : "var(--dim)"}">${t.vol_ratio == null ? "—" : `${t.vol_ratio.toFixed(2)}x`}</td>` +
      `<td>${dot(t.short_orange)}</td><td>${dot(t.mid_orange)}</td>` +
      `<td class="n">${t.limit_up_20d ? `<span class="tag acc">${t.limit_up_cnt}次</span>` : `<span style="color:var(--faint)">—</span>`}</td>` +
      `<td><span class="tag ${t.seg >= 4 ? "acc" : t.seg <= 1 ? "flat" : "p1"}">第${t.seg}段·${esc(t.seg_name)}</span></td>` +
      `<td><span style="font-size:11.5px;color:${t.short_orange ? ORANGE : BLUE}">${state}</span></td></tr>`;
  }).join("");
  body.querySelectorAll<HTMLElement>("tr[data-stock]").forEach((tr) =>
    tr.addEventListener("click", () =>
      document.dispatchEvent(new CustomEvent("yc:open-stock", {
        detail: { symbol: tr.dataset.stock, name: tr.dataset.name,
          from: { page: "targets", label: "目标监控" } } }))));

  pager.innerHTML = items.length === 0 ? "" :
    pages === 1 ? `<span style="font-size:11.5px;color:var(--faint)">共 ${items.length} 条</span>` :
      `<button class="hbtn" id="pg-prev" ${page <= 1 ? "disabled" : ""}>上一页</button>` +
      `<span style="font-size:11.5px;color:var(--dim)">第 ${page} / ${pages} 页 · 共 ${items.length} 条</span>` +
      `<button class="hbtn" id="pg-next" ${page >= pages ? "disabled" : ""}>下一页</button>`;
  pager.querySelector("#pg-prev")?.addEventListener("click", () => { page -= 1; drawPage(); });
  pager.querySelector("#pg-next")?.addEventListener("click", () => { page += 1; drawPage(); });
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
