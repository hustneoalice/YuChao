/* 自选页（localStorage 客户端实现，F04 后端就绪后切换） */
import { marketApi } from "../api";
import { esc, fmt, fmtChg, fmtYi } from "../fmt";
import { ic } from "../icons";
import { getState, setWlGroup, removeWatch, addWatch, isWatched } from "../store";
import { toast, openModal, closeModals } from "../ui";
import { stockSearch, type StockSearchHandle } from "../searchbox";
import { refreshSparksIn, sparkSvg } from "../sparks";

let filter: "all" | "up" | "down" = "all";
const chgCache = new Map<string, number>();
const amtCache = new Map<string, number>();

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
    renderRows();
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
