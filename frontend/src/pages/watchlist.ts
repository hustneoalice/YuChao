/* 自选页（localStorage 客户端实现，F04 后端就绪后切换） */
import { marketApi, type SearchHit } from "../api";
import { esc, fmt, fmtChg, fmtYi } from "../fmt";
import { ic } from "../icons";
import { getState, setWlGroup, removeWatch, addWatch, isWatched } from "../store";
import { toast, openModal, closeModals } from "../ui";

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
  const openAdd = () => { openModal("modal-add"); (document.getElementById("add-search") as HTMLInputElement).value = ""; void renderAddList(""); };
  document.getElementById("wl-add")!.addEventListener("click", openAdd);
  document.getElementById("wl-empty-add")!.addEventListener("click", openAdd);
  (document.getElementById("add-search") as HTMLInputElement).addEventListener("input", (e) =>
    void renderAddList((e.target as HTMLInputElement).value));
}

let addSeq = 0;
async function renderAddList(q: string): Promise<void> {
  const seq = ++addSeq;
  const list = document.getElementById("add-list")!;
  if (!q.trim()) {
    list.innerHTML = `<div style="font-size:11.5px;color:var(--faint);padding:8px 10px">输入代码 / 名称搜索行情底座</div>`;
    return;
  }
  let hits: SearchHit[] = [];
  try {
    const r = await marketApi.search(q.trim(), 12);
    hits = r.items;
  } catch { /* 静默 */ }
  if (seq !== addSeq) return;
  const wl = getState().watchlist;
  list.innerHTML = hits.map((u) => {
    const has = wl.some((w) => w.symbol === u.symbol);
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px" class="addrow" data-c="${u.symbol}"><b style="font-size:12.5px">${esc(u.name)}</b><span class="num" style="font-size:11px;color:var(--faint)">${u.symbol}</span>` +
      (has ? `<span class="tag flat" style="margin-left:auto">已添加</span>` : `<button class="hbtn" data-add="${u.symbol}" data-name="${esc(u.name || u.symbol)}" style="height:26px;padding:0 12px;font-size:11.5px;margin-left:auto">+ 加入</button>`) + `</div>`;
  }).join("") || `<div style="font-size:11.5px;color:var(--faint);padding:8px 10px">未找到匹配标的</div>`;
  list.querySelectorAll<HTMLElement>("[data-add]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      addWatch(b.dataset.add!, b.dataset.name || b.dataset.add!);
      toast("已加入自选");
      void renderAddList(q);
    }));
  list.querySelectorAll<HTMLElement>(".addrow[data-c]").forEach((r) =>
    r.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-add]")) return;
      closeModals();
      const sym = r.dataset.c!;
      const hit = hits.find((h) => h.symbol === sym);
      document.dispatchEvent(new CustomEvent("yc:open-stock", { detail: { symbol: sym, name: hit?.name || sym, from: { page: "watchlist", label: "自选股" } } }));
    }));
}

export function isInWatchlist(sym: string): boolean { return isWatched(sym); }
