/* 自选页（localStorage 客户端实现，F04 后端就绪后切换） */
import { marketApi } from "../api";
import { esc, fmt, fmtChg, fmtP, fmtYi } from "../fmt";
import { ic } from "../icons";
import { getState, setWlGroups, toggleWlGroup, inWlFilter, removeWatch, addWatch, isWatched, addWatchGroup, allWatchGroups,
  getWatchNotes, setWatchGroups } from "../store";
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

/** 从任意文本提取 6 位代码（避开长数字串里的片段），去重保序 */
function bulkCodes(text: string): string[] {
  const out: string[] = [];
  const re = /\d{6}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + 6;
    if (m.index > 0 && /\d/.test(text[m.index - 1])) continue;  // 长数字串的尾段
    if (end < text.length && /\d/.test(text[end])) continue;    // 长数字串的前段
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/* 市场徽标：手机端隐去代码列后，用「沪A / 深A / 创A / 科A」补足标的归属 */
function mktTag(sym: string): string {
  if (/^68[89]/.test(sym)) return "科A";
  if (/^30/.test(sym)) return "创A";
  if (/^6/.test(sym)) return "沪A";
  if (/^[048]/.test(sym)) return "深A";
  if (/^[89]/.test(sym)) return "北交";
  return "";
}

/* 行情视图：指数摘要 + 涨跌分布 + 概念/行业板块（对齐券商行情页） */
let mktLoaded = false;

function renderMktIdx(items: import("../api").IndexQuote[], br: import("../api").BreadthOut): void {
  const box = document.getElementById("mkt-idx");
  if (!box) return;
  const pick = ["上证指数", "深证成指", "创业板指"]
    .map((n) => items.find((i) => i.name === n))
    .filter((i): i is import("../api").IndexQuote => !!i);
  const up = br?.up ?? 0, down = br?.down ?? 0;
  const total = Math.max(1, up + down + (br?.flat ?? 0));
  box.innerHTML =
    `<div class="mkt-idxrow">` + pick.map((i) => {
      const cls = (i.pct ?? 0) >= 0 ? "up" : "down";
      return `<div class="mkt-idx-c"><span class="n">${esc(i.name)}</span>` +
        `<span class="v num ${cls}">${i.price != null ? fmt(i.price) : "--"}</span>` +
        `<span class="p num ${cls}">${i.chg != null ? fmtChg(i.chg) + "  " : ""}${i.pct != null ? fmtChg(i.pct * 100) + "%" : ""}</span></div>`;
    }).join("") + `</div>` +
    `<div class="mkt-bar"><i class="u" style="flex:${up / total * 100}"></i><i class="d" style="flex:${down / total * 100}"></i></div>` +
    `<div class="mkt-bar-x"><span class="up">${up} ↑</span><span class="down">${down} ↓</span></div>`;
}

function renderBlocks(id: string, rows: import("../api").ZyBlockRow[]): void {
  const box = document.getElementById(id);
  if (!box) return;
  box.innerHTML = rows.map((b) => {
    const cls = (b.avg_change ?? 0) >= 0 ? "up" : "down";
    const lc = (b.leader_change ?? 0) >= 0 ? "up" : "down";
    return `<div class="mkt-blk"><b>${esc(b.block_name)}</b>` +
      `<span class="pc num ${cls}">${b.avg_change != null ? fmtChg(b.avg_change) + "%" : "—"}</span>` +
      `<span class="ld">${esc(b.leader || "—")} ${b.leader_change != null ? `<em class="num ${lc}">${fmtChg(b.leader_change)}%</em>` : ""}</span></div>`;
  }).join("") || `<div class="mkt-none">暂无板块数据</div>`;
}

async function loadMkt(force = false): Promise<void> {
  if (mktLoaded && !force) return;
  mktLoaded = true;
  try {
    const [idx, br, con, ind] = await Promise.all([
      marketApi.indices(), marketApi.breadth(),
      marketApi.zyBlocks({ type_code: 2, sort: "-avg_change", page: 1, size: 6 }),
      marketApi.zyBlocks({ type_code: 4, sort: "-avg_change", page: 1, size: 6 }),
    ]);
    renderMktIdx(idx.items ?? [], br);
    renderBlocks("mkt-concepts", con.items ?? []);
    renderBlocks("mkt-industry", ind.items ?? []);
  } catch { /* 保持占位，切回自选不受影响 */ }
}

function initMktSwitch(): void {
  const sw = document.getElementById("wl-switch");
  if (!sw) return;
  sw.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn) return;
    const v = btn.dataset.v;
    sw.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === btn));
    (document.getElementById("wl-self") as HTMLElement).hidden = v !== "self";
    (document.getElementById("wl-mkt") as HTMLElement).hidden = v !== "mkt";
    (document.getElementById("wl-add") as HTMLElement).style.display = v === "self" ? "" : "none";
    if (v === "mkt") void loadMkt();
  });
  const more = (): void => { document.dispatchEvent(new CustomEvent("yc:goto-page", { detail: "panview" })); };
  document.getElementById("mkt-more-c")?.addEventListener("click", more);
  document.getElementById("mkt-more-i")?.addEventListener("click", more);
  document.querySelectorAll(".mkt-tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".mkt-tabs button").forEach((x) => x.classList.toggle("on", x === b));
      const off = (b as HTMLElement).dataset.off;
      const box = document.getElementById("mkt-idx")!;
      if (off) {
        box.innerHTML = `<div class="mkt-none">港股 / 沪深港通 数据暂未接入，当前先看 A 股</div>`;
      } else {
        void loadMkt(true);
      }
    });
  });
}

/* 顶部指数卡（自选页，对标券商自选页的指数摘要），桌面隐藏 */
async function loadIdxCards(): Promise<void> {
  const box = document.getElementById("wl-idx");
  if (!box) return;
  let items: import("../api").IndexQuote[] = [];
  try { items = (await marketApi.indices()).items ?? []; } catch { return; }
  const pick = ["上证指数", "深证成指", "创业板指"]
    .map((n) => items.find((i) => i.name === n))
    .filter((i): i is import("../api").IndexQuote => !!i);
  if (!pick.length) return;
  box.innerHTML = pick.map((i) => {
    const cls = (i.pct ?? 0) >= 0 ? "up" : "down";
    return `<div class="wl-idx-c"><span class="n">${esc(i.name)}</span>` +
      `<span class="v num ${cls}">${i.price != null ? fmt(i.price) : "--"}</span>` +
      `<span class="p num ${cls}">${i.pct != null ? fmtChg(i.pct * 100) + "%" : ""}</span></div>`;
  }).join("");
}

const WL_COLS: DataTableCol<WatchItem>[] = [
  { label: "#", width: 34, mono: true, pri: 3, render: (_w, i) => `<span style="color:var(--faint)">${i + 1}</span>` },
  { label: "代码", mono: true, pri: 2, sort: "symbol", render: (w) => w.symbol },
  { label: "名称", pri: 1, sort: "name", render: (w) => `<span style="font-weight:600">${esc(w.name)}</span><span class="mkt">${mktTag(w.symbol)}</span>` },
  { label: "现价", num: true, pri: 1, sort: (w) => priceCache.get(w.symbol) ?? null,
    render: (w) => fmtP(priceCache.get(w.symbol) ?? null, w.symbol) },
  { label: "涨跌幅", num: true, pri: 1, sort: (w) => chgCache.get(w.symbol) ?? null, render: (w) => {
      const ch = chgCache.get(w.symbol);
      // 行情未到达先占「—」：不要先摆 0.00 / +0.00% 再跳变
      if (ch == null) return `<span style="color:var(--faint)">—</span>`;
      return `<span class="${ch >= 0 ? "up" : "down"}">${fmtChg(ch)}%</span>`; } },
  { label: "走势", num: true, pri: 2, render: (w) => sparkSvg(w.symbol, 72, 22) },
  { label: "成交额", num: true, pri: 3, sort: (w) => amtCache.get(w.symbol) ?? null,
    render: (w) => `<span style="color:var(--faint)">${fmtYi(amtCache.get(w.symbol) ?? null, 1)}</span>` },
  { label: "信号", pri: 3, render: () => `<span class="tag p1">看盘</span>` },
  { label: "标注", width: 62, pri: 2, sort: (w) => getWatchNotes(w.symbol).length,
    render: (w) => noteChipHtml(w.symbol) },
  { label: "分组", pri: 3, sort: (w) => w.groups.join("、"),
    render: (w) => `<span style="font-size:11.5px;color:var(--dim)">${esc(w.groups.join("、"))}</span>` },
  { label: "", key: "移除", width: 52, pri: 1, render: (w) =>
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
    tblKey: "watchlist",
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
  // 已有缓存的票不重复拉；首屏只请求缺行情的那部分
  const todo = symbols.filter((s) => !priceCache.has(s));
  if (!todo.length) return;
  let changed = false;
  // 行情接口统一回 6 位代码，自选池可能存带后缀的写法：按代码前缀映射回原 key
  const keyOf = new Map<string, string>();
  for (const s of todo) keyOf.set(s.split(".")[0], s);
  try {
    // 一次批量拿回（后端单次 ≤50 只，超出分批串行），避免逐票请求串行排队
    for (let i = 0; i < todo.length; i += 50) {
      const r = await marketApi.quotes(todo.slice(i, i + 50));
      for (const q of r.items) {
        const key = keyOf.get(q.symbol) ?? q.symbol;
        priceCache.set(key, q.close ?? 0);
        chgCache.set(key, q.pct_chg ?? 0);
        amtCache.set(key, q.amount ?? 0);
        changed = true;
      }
      primeQuotes(r.items);                                    // 点表格切票时顶部价格秒上屏
    }
  } catch { /* 拉取失败：保持「—」占位，下次进入再试 */ }
  if (changed) renderRows();                                   // 批量到达后一次重绘，不逐票闪
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
    const sel = document.getElementById("add-bulk-group") as HTMLSelectElement | null;
    if (sel) sel.innerHTML = allWatchGroups().map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join("");
    const ta = document.getElementById("add-bulk") as HTMLTextAreaElement | null;
    if (ta) ta.value = "";
    const hint = document.getElementById("add-bulk-hint");
    if (hint) hint.textContent = "";
  };
  /* 批量粘贴导入：整段文本（含 Excel 名称/表头）里只认 6 位代码，去重保序后批量加自选；
     已在自选里的就补分组，不会重复添加。 */
  const bulkImport = async (): Promise<void> => {
    const ta = document.getElementById("add-bulk") as HTMLTextAreaElement | null;
    const sel = document.getElementById("add-bulk-group") as HTMLSelectElement | null;
    const hint = document.getElementById("add-bulk-hint");
    const btn = document.getElementById("add-bulk-ok") as HTMLButtonElement | null;
    const codes = bulkCodes(ta?.value || "");
    if (!codes.length) {
      if (hint) hint.textContent = "没有识别到 6 位代码";
      return;
    }
    const group = sel?.value || "默认";
    if (btn) { btn.disabled = true; btn.textContent = "导入中…"; }
    // 名称走一次批量快照；取不到的用代码本身兜底，不影响入库
    const names = new Map<string, string>();
    try {
      const r = await marketApi.quotes(codes);
      (r.items ?? []).forEach((q) => {
        const code = (q.symbol || "").replace(/\D/g, "").slice(-6);
        if (code && q.name) names.set(code, q.name);
      });
    } catch { /* 名称拉取失败不阻塞导入 */ }
    // ETF 等品种的批量快照可能没有名称：再按代码查一次本地搜索库补齐
    for (const code of codes) {
      if (names.get(code)) continue;
      try {
        const r = await marketApi.search(code, 5, ["stock", "fund"], false);
        const hit = r.items.find((i) => i.symbol === code);
        if (hit?.name) names.set(code, hit.name);
      } catch { /* 单个失败用代码兜底 */ }
    }
    let added = 0, merged = 0, skipped = 0;
    codes.forEach((code) => {
      if (addWatch(code, names.get(code) || code, group)) { added++; return; }
      const w = getState().watchlist.find((x) => x.symbol === code);
      if (w && !w.groups.includes(group)) { setWatchGroups(code, [...w.groups, group]); merged++; }
      else skipped++;
    });
    if (btn) { btn.disabled = false; btn.textContent = "批量导入"; }
    if (ta) ta.value = "";
    const parts = [`新增 ${added} 只`];
    if (merged) parts.push(`${merged} 只补入「${group}」`);
    if (skipped) parts.push(`${skipped} 只已存在`);
    const msg = `识别 ${codes.length} 个代码：${parts.join("，")}`;
    if (hint) hint.textContent = msg;
    toast(msg);
    renderWatchlist();
    addSearch.redraw();
  };
  document.getElementById("add-bulk-ok")!.addEventListener("click", () => { void bulkImport(); });
  document.getElementById("wl-add")!.addEventListener("click", openAdd);
  document.getElementById("wl-empty-add")!.addEventListener("click", openAdd);
  // 标注：hover 浮层 + 编辑弹窗（委托绑定，表格重绘后仍生效）
  bindNoteHover(document.getElementById("wl-wrap")!);
  initNoteEditor();
  document.addEventListener("yc:notes-changed", () => renderRows());
  void loadIdxCards();
  initMktSwitch();
}

export function isInWatchlist(sym: string): boolean { return isWatched(sym); }
