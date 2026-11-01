/* 自选页（localStorage 客户端实现，F04 后端就绪后切换） */
import { marketApi } from "../api";
import { esc, fmt, fmtChg, fmtYi } from "../fmt";
import { ic } from "../icons";
import { getState, setWlGroup, removeWatch, addWatch, isWatched } from "../store";
import { toast, openModal, closeModals } from "../ui";
import { stockSearch, type StockSearchHandle } from "../searchbox";
import { refreshSparksIn, sparkSvg } from "../sparks";
import { createPager, slicePage, type Pager } from "../pager";
import { createDataTable, type DataTable, type DataTableCol } from "../table";

let filter: "all" | "up" | "down" = "all";
type WatchItem = { symbol: string; name: string; group: string; ts: number };
let wlPager: Pager | null = null;
let wlTbl: DataTable<WatchItem> | null = null;
let wlReset = false;
const priceCache = new Map<string, number>();
const chgCache = new Map<string, number>();
const amtCache = new Map<string, number>();

const WL_COLS: DataTableCol<WatchItem>[] = [
  { label: "#", width: 34, mono: true, render: (_w, i) => `<span style="color:var(--faint)">${i + 1}</span>` },
  { label: "代码", mono: true, sort: "symbol", render: (w) => w.symbol },
  { label: "名称", sort: "name", render: (w) => `<span style="font-weight:600">${esc(w.name)}</span>` },
  { label: "现价", num: true, sort: (w) => priceCache.get(w.symbol) ?? null,
    render: (w) => fmt(priceCache.get(w.symbol) ?? 0) },
  { label: "涨跌幅", num: true, sort: (w) => chgCache.get(w.symbol) ?? null, render: (w) => {
      const ch = chgCache.get(w.symbol) ?? 0;
      return `<span class="${ch >= 0 ? "up" : "down"}">${fmtChg(ch)}%</span>`; } },
  { label: "走势", num: true, render: (w) => sparkSvg(w.symbol, 72, 22) },
  { label: "成交额", num: true, sort: (w) => amtCache.get(w.symbol) ?? null,
    render: (w) => `<span style="color:var(--faint)">${fmtYi(amtCache.get(w.symbol) ?? null, 1)}</span>` },
  { label: "信号", render: () => `<span class="tag p1">看盘</span>` },
  { label: "分组", sort: "group", render: (w) => `<span style="font-size:11.5px;color:var(--dim)">${esc(w.group)}</span>` },
  { label: "", width: 52, render: (w) =>
      `<button class="icbtn" data-del="${w.symbol}" title="移除" style="width:26px;height:26px">${ic("trash", 13)}</button>` },
];

function drawChips(): void {
  const wl = getState().watchlist;
  const groups = ["全部", ...Array.from(new Set(wl.map((w) => w.group)))];
  const el = document.getElementById("wl-groups")!;
  el.innerHTML = groups.map((g) =>
    `<span class="chip${getState().wlGroup === g ? " on" : ""}" data-g="${esc(g)}">${esc(g)}</span>`).join("") +
    `<span class="chip" id="wl-newgrp" style="border-style:dashed">${ic("plus", 11)}新建分组</span>`;
  el.querySelectorAll<HTMLElement>(".chip[data-g]").forEach((c) =>
    c.addEventListener("click", () => { wlReset = true; setWlGroup(c.dataset.g!); }));
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
      priceCache.set(r.value.s, r.value.q.close ?? 0);
      chgCache.set(r.value.s, r.value.q.pct_chg ?? 0);
      amtCache.set(r.value.s, r.value.q.amount ?? 0);
      renderRows(); // 简单做法：任一到达即重绘（表格重建后直接吃缓存）
    }
  }
}

function renderRows(reset = false): void {
  if (reset) wlReset = true;
  const wl = getState().watchlist;
  const g = getState().wlGroup;
  let rows = wl.filter((w) => g === "全部" || !g || w.group === g);
  rows = rows.filter((w) =>
    filter === "all" || (filter === "up" ? (chgCache.get(w.symbol) ?? 0) >= 0 : (chgCache.get(w.symbol) ?? 0) < 0));
  document.getElementById("wl-title")!.textContent = !g || g === "全部" ? "全部自选" : g;
  document.getElementById("wl-count")!.textContent = `共 ${rows.length} 只`;
  if (!wlPager) wlPager = createPager(document.getElementById("wl-pager")!, "watchlist", renderRows);
  if (!wlTbl) wlTbl = createDataTable(document.getElementById("wl-wrap")!, WL_COLS, {
    rowKey: (w) => w.symbol,
    onRow: (w, ev) => {
      const del = (ev.target as HTMLElement).closest("[data-del]") as HTMLElement | null;
      if (del) {                                   // 行内移除按钮
        removeWatch(del.dataset.del!);
        toast("已移出自选");
        return;
      }
      document.dispatchEvent(new CustomEvent("yc:open-stock", {
        detail: { symbol: w.symbol, name: w.name, from: { page: "watchlist", label: "自选股" } } }));
    },
  });
  if (wlReset) { wlPager.reset(); wlReset = false; }
  wlPager.update(rows.length);
  const start = (wlPager.page - 1) * wlPager.size;
  const pageRows = slicePage(wlPager, wlTbl.sort(rows));
  wlTbl.render(pageRows, start);
  document.getElementById("wl-empty")!.style.display = rows.length ? "none" : "grid";
  void loadPrices(pageRows.map((r) => r.symbol));
  void refreshSparksIn(document.getElementById("wl-wrap")!);
}

async function loadPrices(symbols: string[]): Promise<void> {
  await Promise.allSettled(symbols.map(async (sym) => {
    const q = await marketApi.quote(sym);
    priceCache.set(sym, q.close ?? 0);
    chgCache.set(sym, q.pct_chg ?? 0);
    amtCache.set(sym, q.amount ?? 0);
  }));
}

export function renderWatchlist(): void {
  drawChips();
  renderRows();
}

export function initWatchlist(): void {
  document.getElementById("wl-filter")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (!b) return;
    filter = b.dataset.f as "all" | "up" | "down";
    document.querySelectorAll("#wl-filter button").forEach((x) => x.classList.toggle("on", x === b));
    renderRows(true);
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
