/* 自选页（localStorage 客户端实现，F04 后端就绪后切换） */
import { marketApi } from "../api";
import { esc, fmt, fmtChg, fmtYi } from "../fmt";
import { ic } from "../icons";
import { getState, setWlGroup, removeWatch, addWatch, isWatched } from "../store";
import { toast, openModal, closeModals } from "../ui";
import { stockSearch, type StockSearchHandle } from "../searchbox";
import { refreshSparksIn, sparkSvg } from "../sparks";
import type { TargetItem } from "../api";
import { trendPalette } from "./kline";

let filter: "all" | "up" | "down" = "all";
const chgCache = new Map<string, number>();
const amtCache = new Map<string, number>();

/* ── 目标视图（策影目标页同源口径）：四条件独立勾选 + 六分段 + 回调 ── */
type TgtView = "list" | "target";
type TgtCond = "vol" | "short" | "mid" | "up20";
const TGT_CONDS: { k: TgtCond; label: string; title: string }[] = [
  { k: "vol", label: "40日均量", title: "当日成交量 ≥ 40日均量" },
  { k: "short", label: "短线趋势橙", title: "收盘站上 MA10（K 线短线趋势通道填橙同判定）" },
  { k: "mid", label: "中线趋势橙", title: "收盘站上 MA45（K 线中线趋势通道填橙同判定）" },
  { k: "up20", label: "20日内涨停", title: "近 20 个交易日有过涨停（主板 10% / 创业科创 20%）" },
];
let wlView: TgtView = (localStorage.getItem("yc_wlview") as TgtView) || "list";
let tgtConds: Record<TgtCond, boolean> = { vol: true, short: true, mid: true, up20: true };
try {
  const raw = localStorage.getItem("yc_tgt_conds");
  if (raw) tgtConds = { ...tgtConds, ...(JSON.parse(raw) as Partial<Record<TgtCond, boolean>>) };
} catch { /* 损坏即回默认全勾 */ }
const tgtCache = new Map<string, TargetItem>();

function drawChips(): void {
  const wl = getState().watchlist;
  const groups = ["全部", ...Array.from(new Set(wl.map((w) => w.group)))];
  const el = document.getElementById("wl-groups")!;
  el.innerHTML = groups.map((g) =>
    `<span class="chip${getState().wlGroup === g ? " on" : ""}" data-g="${esc(g)}">${esc(g)}</span>`).join("") +
    `<span class="chip" id="wl-newgrp" style="border-style:dashed">${ic("plus", 11)}新建分组</span>`;
  el.querySelectorAll<HTMLElement>(".chip[data-g]").forEach((c) =>
    c.addEventListener("click", () => setWlGroup(c.dataset.g!)));
  el.querySelector("#wl-newgrp")!.addEventListener("click", () => {
    const g = prompt("分组名称：");
    if (g && g.trim()) { toast(`分组「${g.trim()}」已创建，添加自选时可选`); }
  });
}

export async function fetchChg(symbols: string[]): Promise<void> {
  const todo = symbols.filter((s) => !chgCache.has(s));
  const results = await Promise.allSettled(
    todo.map(async (s) => ({ s, q: await marketApi.quote(s) })));
  for (const r of results) {
    if (r.status === "fulfilled") {
      chgCache.set(r.value.s, r.value.q.pct_chg ?? 0);
      amtCache.set(r.value.s, r.value.q.amount ?? 0);
      document.getElementById("wl-price-" + r.value.s) &&
        renderRows(); // 简单做法：任一到达即重绘
    }
  }
}

function renderRows(): void {
  const wl = getState().watchlist;
  const g = getState().wlGroup;
  let rows = wl.filter((w) => g === "全部" || !g || w.group === g);
  rows = rows.filter((w) =>
    filter === "all" || (filter === "up" ? (chgCache.get(w.symbol) ?? 0) >= 0 : (chgCache.get(w.symbol) ?? 0) < 0));
  document.getElementById("wl-title")!.textContent = !g || g === "全部" ? "全部自选" : g;
  document.getElementById("wl-count")!.textContent = `共 ${rows.length} 只`;
  const body = document.getElementById("wl-body")!;
  body.innerHTML = rows.map((w, i) => {
    const ch = chgCache.get(w.symbol) ?? 0;
    const up = ch >= 0;
    const segI = 3; // 信号标签需核心标数据，此处展示中性
    return `<tr data-stock="${w.symbol}"><td class="num" style="color:var(--faint)">${i + 1}</td><td class="num">${w.symbol}</td><td><span style="font-weight:600">${esc(w.name)}</span></td>` +
      `<td class="n num" id="wl-price-${w.symbol}">${fmt(0)}</td>` +
      `<td class="n num ${up ? "up" : "down"}">${fmtChg(ch)}%</td>` +
      `<td class="n">${sparkSvg(w.symbol, 72, 22)}</td>` +
      `<td class="n num" style="color:var(--faint)">${fmtYi(amtCache.get(w.symbol) ?? null, 1)}</td>` +
      `<td><span class="tag ${segI >= 4 ? "acc" : segI <= 1 ? "flat" : "p1"}">${["", "超卖", "低位", "看盘", "回升", "强势", "超买"][segI]}</span></td>` +
      `<td><span style="font-size:11.5px;color:var(--dim)">${esc(w.group)}</span></td>` +
      `<td><button class="icbtn" data-del="${w.symbol}" title="移除" style="width:26px;height:26px">${ic("trash", 13)}</button></td></tr>`;
  }).join("");
  body.querySelectorAll<HTMLElement>("tr[data-stock]").forEach((tr) =>
    tr.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-del]")) return;
      const sym = tr.dataset.stock!;
      const w = wl.find((x) => x.symbol === sym)!;
      document.dispatchEvent(new CustomEvent("yc:open-stock", { detail: { symbol: sym, name: w.name, from: { page: "watchlist", label: "自选股" } } }));
    }));
  body.querySelectorAll<HTMLElement>("[data-del]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      removeWatch(b.dataset.del!);
      toast("已移出自选");
    }));
  document.getElementById("wl-empty")!.style.display = rows.length ? "none" : "grid";
  void loadPrices(rows.map((r) => r.symbol));
  void refreshSparksIn(document.getElementById("wl-body")!);
}

async function loadPrices(symbols: string[]): Promise<void> {
  await Promise.allSettled(symbols.map(async (sym) => {
    const q = await marketApi.quote(sym);
    const td = document.getElementById("wl-price-" + sym);
    if (td) td.textContent = fmt(q.close ?? 0);
    chgCache.set(sym, q.pct_chg ?? 0);
    amtCache.set(sym, q.amount ?? 0);
  }));
}

function renderConds(): void {
  const el = document.getElementById("tgt-conds")!;
  el.innerHTML = TGT_CONDS.map((d) =>
    `<span class="chip${tgtConds[d.k] ? " on" : ""}" data-c="${d.k}" title="${esc(d.title)}">${esc(d.label)}</span>`).join("") +
    `<span style="font-size:11.5px;color:var(--faint)">命中全部勾选条件 · ST 已剔除</span>`;
  el.querySelectorAll<HTMLElement>(".chip[data-c]").forEach((c) =>
    c.addEventListener("click", () => {
      const k = c.dataset.c as TgtCond;
      tgtConds[k] = !tgtConds[k];
      localStorage.setItem("yc_tgt_conds", JSON.stringify(tgtConds));
      renderConds();
      void renderTargets();
    }));
}

function condsMet(t: TargetItem): boolean {
  return (!tgtConds.vol || t.vol_hit) && (!tgtConds.short || t.short_orange) &&
    (!tgtConds.mid || t.mid_orange) && (!tgtConds.up20 || t.limit_up_20d);
}

async function renderTargets(): Promise<void> {
  const wl = getState().watchlist;
  const body = document.getElementById("tgt-body")!;
  const empty = document.getElementById("tgt-empty")!;
  document.getElementById("wl-title")!.textContent = "目标监控";
  if (!wl.length) {
    body.innerHTML = "";
    document.getElementById("wl-count")!.textContent = "共 0 只";
    empty.style.display = "grid";
    return;
  }
  const symbols = wl.map((w) => w.symbol);
  try {                                   // 与 K 线图表同源公式的服务端批量计算
    const items = await marketApi.targets(symbols);
    tgtCache.clear();
    for (const t of items) tgtCache.set(t.symbol, t);
  } catch { /* 网络失败保留上次快照 */ }
  // 涨跌幅与列表页共用 chgCache；缺失时补拉一次，完成后重绘（有缓存不再拉取，无循环）
  const missing = symbols.filter((s) => !chgCache.has(s));
  if (missing.length) {
    void Promise.allSettled(missing.map(async (s) => {
      const q = await marketApi.quote(s);
      chgCache.set(s, q.pct_chg ?? 0);
      amtCache.set(s, q.amount ?? 0);
    })).then(() => { if (wlView === "target") void renderTargets(); });
  }
  const rows = wl.map((w) => tgtCache.get(w.symbol)).filter((t): t is TargetItem => !!t);
  const hits = rows.filter(condsMet);
  document.getElementById("wl-count")!.textContent = `命中 ${hits.length} / 共 ${rows.length} 只`;
  empty.style.display = hits.length ? "none" : "grid";
  const pal = trendPalette();
  const ORANGE = `rgb(${pal.fr.join(",")})`, BLUE = `rgb(${pal.sr.join(",")})`;
  const ordered = [...hits, ...rows.filter((t) => !condsMet(t))];     // 命中在前
  body.innerHTML = ordered.map((t, i) => {
    const hit = condsMet(t);
    const ch = chgCache.get(t.symbol) ?? 0;
    const dot = (on: boolean) => `<span style="color:${on ? ORANGE : BLUE}">●</span> ${on ? "橙" : "蓝"}`;
    const state = `${t.pullback ? "回调中" : "上行"} · ${t.short_orange ? "橙" : "蓝"}`;
    return `<tr data-stock="${t.symbol}" style="${hit ? "" : "opacity:.55"}">` +
      `<td class="num" style="color:var(--faint)">${i + 1}</td>` +
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
    tr.addEventListener("click", () => {
      const w = wl.find((x) => x.symbol === tr.dataset.stock);
      document.dispatchEvent(new CustomEvent("yc:open-stock", {
        detail: { symbol: tr.dataset.stock, name: w?.name || tr.dataset.stock,
          from: { page: "watchlist", label: "目标监控" } } }));
    }));
}

function applyWlView(): void {
  const list = wlView === "list";
  document.getElementById("wl-listwrap")!.style.display = list ? "" : "none";
  document.getElementById("wl-filter")!.style.display = list ? "" : "none";
  document.getElementById("wl-target")!.style.display = list ? "none" : "flex";
  document.querySelectorAll("#wl-view button").forEach((b) =>
    b.classList.toggle("on", (b as HTMLElement).dataset.v === wlView));
  if (list) renderRows();
  else { renderConds(); void renderTargets(); }
}

export function renderWatchlist(): void {
  drawChips();
  if (wlView === "target") { renderConds(); void renderTargets(); }
  else renderRows();
}

export function initWatchlist(): void {
  document.getElementById("wl-filter")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (!b) return;
    filter = b.dataset.f as "all" | "up" | "down";
    document.querySelectorAll("#wl-filter button").forEach((x) => x.classList.toggle("on", x === b));
    renderRows();
  });
  document.getElementById("wl-view")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (!b) return;
    wlView = b.dataset.v as TgtView;
    localStorage.setItem("yc_wlview", wlView);
    applyWlView();
  });
  /* 添加自选弹窗：共享搜索组件（与顶栏一致：代码/名称/拼音模糊 + 最近搜索历史 + 涨跌幅），
     行尾「+ 加入」直加自选；点行打开个股 */
  const addSearch: StockSearchHandle = stockSearch({
    input: document.getElementById("add-search") as HTMLInputElement,
    list: document.getElementById("add-list")!,
    limit: 12,
    tail: (u) => {
      const has = getState().watchlist.some((w) => w.symbol === u.symbol);
      return has ? `<span class="tag flat" style="flex:none">已添加</span>` :
        `<button class="hbtn" data-sb-tail="${u.symbol}" data-sb-name="${esc(u.name || u.symbol)}" style="height:26px;padding:0 12px;font-size:11.5px;flex:none">+ 加入</button>`;
    },
    onTail: (u) => {
      addWatch(u.symbol, u.name || u.symbol);
      toast("已加入自选");
      addSearch.redraw();
    },
    onPick: (u) => {
      closeModals();
      document.dispatchEvent(new CustomEvent("yc:open-stock", { detail: { symbol: u.symbol, name: u.name || u.symbol, from: { page: "watchlist", label: "自选股" } } }));
    },
  });
  const openAdd = () => {
    openModal("modal-add");
    (document.getElementById("add-search") as HTMLInputElement).value = "";
    addSearch.redraw();        // 清空输入 → 重显最近搜索历史
  };
  document.getElementById("wl-add")!.addEventListener("click", openAdd);
  document.getElementById("wl-empty-add")!.addEventListener("click", openAdd);
}

export function isInWatchlist(sym: string): boolean { return isWatched(sym); }
