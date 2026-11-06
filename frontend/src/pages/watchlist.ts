/* 自选页（localStorage 客户端实现，F04 后端就绪后切换） */
import { marketApi, type Quote } from "../api";
import { esc, fmt, fmtChg, fmtYi } from "../fmt";
import { ic } from "../icons";
import { getState, setWlGroups, toggleWlGroup, inWlFilter, removeWatch, addWatch, isWatched, addWatchGroup, allWatchGroups,
  getWatchNotes } from "../store";
import { bindNoteHover, hideNotePop, initNoteEditor, noteChipHtml, openNoteModal } from "../note-ui";
import { toast, openModal, closeModals, multiPick } from "../ui";
import { openGroupPanel } from "../watch";
import { primeQuotes } from "./market";
import { stockSearch, type StockSearchHandle } from "../searchbox";
import { refreshSparksIn, sparkSvg } from "../sparks";
import { createPager, slicePage, type Pager } from "../pager";
import { createDataTable, type DataTable, type DataTableCol } from "../table";

let filter: "all" | "up" | "down" = "all";
type WatchItem = { symbol: string; name: string; groups: string[]; ts: number };
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
  { label: "标注", width: 62, sort: (w) => getWatchNotes(w.symbol).length,
    render: (w) => noteChipHtml(w.symbol) },
  { label: "分组", sort: (w) => w.groups.join("、"),
    render: (w) => `<span style="font-size:11.5px;color:var(--dim)">${esc(w.groups.join("、"))}</span>` },
  { label: "", width: 52, render: (w) =>
      `<button class="icbtn" data-del="${w.symbol}" title="移除" style="width:26px;height:26px">${ic("trash", 13)}</button>` },
];

function drawChips(): void {
  const groups = ["全部", ...allWatchGroups()];
  const sel = getState().wlGroups;                  // 单选筛选：空 = 全部；多选仅修饰键
  const el = document.getElementById("wl-groups")!;
  el.innerHTML = groups.map((g) =>
    `<span class="chip${(g === "全部" ? sel.length === 0 : sel.includes(g)) ? " on" : ""}" data-g="${esc(g)}" title="${g === "全部" ? "显示全部" : "单选；按住 Ctrl/⌘/Shift/Tab 多选"}">${esc(g)}${g !== "全部" && sel.includes(g) ? ic("check", 10) : ""}</span>`).join("") +
    `<span class="chip" id="wl-newgrp" style="border-style:dashed">${ic("plus", 11)}新建分组</span>` +
    `<span class="chip" id="wl-grp-manage">${ic("gear", 11)}管理分组</span>`;
  el.querySelectorAll<HTMLElement>(".chip[data-g]").forEach((c) =>
    c.addEventListener("click", (e) => {
      wlReset = true;
      toggleWlGroup(c.dataset.g!, multiPick(e));   // 默认单选互斥；修饰键才多选
      drawChips();
      renderRows(true);
    }));
  el.querySelector("#wl-grp-manage")!.addEventListener("click", () => openGroupPanel());
  // 新建分组：就地展开输入框（不依赖 prompt，部分浏览器/内嵌窗口会拦截）
  el.querySelector("#wl-newgrp")!.addEventListener("click", () => {
    const host = el.querySelector("#wl-newgrp")!;
    const box = document.createElement("span");
    box.className = "chip wl-newgrp-edit";
    box.innerHTML = `<input placeholder="分组名称" maxlength="16"><button class="wl-ok" title="创建">${ic("check", 11)}</button>`;
    host.replaceWith(box);
    const inp = box.querySelector("input")!;
    inp.focus();
    let done = false;
    const submit = (commit: boolean): void => {
      if (done) return;
      const g = inp.value.trim();
      if (!commit || !g) { done = true; drawChips(); return; }
      if (!addWatchGroup(g)) { toast(`分组「${g}」已存在`); inp.select(); return; }
      done = true;
      toast(`分组「${g}」已创建`);
      wlReset = true;
      setWlGroups([g]);       // 切到新分组：空列表也能直观看到已创建
      drawChips();            // 立即重画胶囊，新分组马上可点
      renderRows(true);
    };
    box.querySelector("button")!.addEventListener("mousedown", (e) => e.preventDefault());
    box.querySelector("button")!.addEventListener("click", () => submit(true));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(true); }
      else if (e.key === "Escape") { e.preventDefault(); submit(false); }
    });
    inp.addEventListener("blur", () => submit(true));
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
  hideNotePop();                  // 表体重建 → 悬停浮层立即收起，避免残影
  if (reset) wlReset = true;
  const sel = getState().wlGroups;
  let rows = getState().watchlist.filter((w) => inWlFilter(w));   // 多选分组取并集
  rows = rows.filter((w) =>
    filter === "all" || (filter === "up" ? (chgCache.get(w.symbol) ?? 0) >= 0 : (chgCache.get(w.symbol) ?? 0) < 0));
  document.getElementById("wl-title")!.textContent = sel.length ? sel.join(" + ") : "全部自选";
  document.getElementById("wl-count")!.textContent = `共 ${rows.length} 只`;
  if (!wlPager) wlPager = createPager(document.getElementById("wl-pager")!, "watchlist", renderRows);
  if (!wlTbl) wlTbl = createDataTable(document.getElementById("wl-wrap")!, WL_COLS, {
    rowKey: (w) => w.symbol,
    onRow: (w, ev) => {
      const note = (ev.target as HTMLElement).closest("[data-note]") as HTMLElement | null;
      if (note) {                                  // 标注：打开编辑弹窗（不跳个股）
        hideNotePop();
        openNoteModal(note.dataset.note!);
        return;
      }
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
  const got: Quote[] = [];
  await Promise.allSettled(symbols.map(async (sym) => {
    const q = await marketApi.quote(sym);
    got.push(q);
    priceCache.set(sym, q.close ?? 0);
    chgCache.set(sym, q.pct_chg ?? 0);
    amtCache.set(sym, q.amount ?? 0);
  }));
  primeQuotes(got);                                            // 点表格切票时顶部价格秒上屏
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
    kinds: ["stock"],                 // 加自选只搜个股（指数/板块/基金不进自选池）
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
  // 标注：hover 浮层 + 编辑弹窗（委托绑定，表格重绘后仍生效）
  bindNoteHover(document.getElementById("wl-wrap")!);
  initNoteEditor();
  document.addEventListener("yc:notes-changed", () => renderRows());
}

export function isInWatchlist(sym: string): boolean { return isWatched(sym); }
