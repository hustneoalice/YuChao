/* 板块页：众赢板块体系（行业/概念/题材/地域/风格/雷达）× 当日快照聚合。
 * 三视图：热力图（面积按成交额分档 + 色深 = 均涨）、涨幅榜（全字段排序）、
 * 热度榜（成交额 / 上涨占比 / 领涨高度 / 均涨振幅加权）。
 * 点击任意板块 → 右栏板块脉冲 + 成分股；成分行点击进行情页个股详情。
 * 数据源与全景页「板块」同一套 /market/zy_blocks，只是不再挤在双栏大表里。 */
import { marketApi, type BoardRow, type ZyBlockRow } from "../api";
import { esc, fmt, fmtChg, fmtYi } from "../fmt";
import { createPager, slicePage, type Pager } from "../pager";
import { createDataTable, type DataTable, type DataTableCol } from "../table";
import { toast } from "../ui";

type View = "heat" | "rank" | "hot";

const TYPE_NAMES: Record<number, string> = {
  1: "地域", 2: "概念", 4: "行业", 6: "雷达", 8: "风格", 9: "题材",
};
const VALID_TYPES = [4, 2, 9, 1, 8, 6];

let typeCode = 4;
let view: View = "heat";
try {
  const t = Number(localStorage.getItem("yc_sectype"));
  if (VALID_TYPES.includes(t)) typeCode = t;
  const v = localStorage.getItem("yc_secview");
  if (v === "heat" || v === "rank" || v === "hot") view = v;
} catch { /* 忽略 */ }

let q = "";
let blocks: ZyBlockRow[] = [];
let cur: ZyBlockRow | null = null;
let maxAmt = 1;
const cache = new Map<number, { items: ZyBlockRow[]; as_of: string }>();
let loadSeq = 0;
let memSeq = 0;
let rankPager: Pager | null = null;
let hotPager: Pager | null = null;
let memPager: Pager | null = null;
let rankTbl: DataTable<ZyBlockRow> | null = null;
let memTbl: DataTable<BoardRow> | null = null;
let rankReset = false;
let hotReset = false;

const el = (id: string): HTMLElement => document.getElementById(id)!;
const typeName = (): string => TYPE_NAMES[typeCode] ?? "板块";

function dirClass(v: number | null | undefined): string {
  if (v == null) return "";
  return v > 0.0001 ? "up" : v < -0.0001 ? "down" : "";
}

function pctHtml(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return `<span style="color:var(--faint)">—</span>`;
  return `<span class="${dirClass(v)}">${fmtChg(v)}%</span>`;
}

/** 有当日快照的成分数（API 字段 members；total_members 为全部成分） */
function upRate(r: ZyBlockRow): number {
  return r.members > 0 ? (r.up_count / r.members) * 100 : 0;
}

/** 热度：成交额 40% + 上涨占比 25% + 领涨高度 20% + 均涨绝对值 15% */
function hotScore(r: ZyBlockRow): number {
  if (!r.members) return 0;
  const amount = Math.log1p(Math.max(0, r.amount ?? 0)) / Math.log1p(Math.max(1, maxAmt));
  const width = Math.min(1, upRate(r) / 100);
  const leader = Math.min(1, Math.abs(r.leader_change ?? 0) / 10);
  const chg = Math.min(1, Math.abs(r.avg_change ?? 0) / 8);
  return Math.round((0.4 * amount + 0.25 * width + 0.2 * leader + 0.15 * chg) * 100);
}

function visible(): ZyBlockRow[] {
  const kw = q.trim().toLowerCase();
  if (!kw) return blocks;
  return blocks.filter((b) =>
    b.block_name.toLowerCase().includes(kw) || b.block_code.toLowerCase().includes(kw));
}

function rowOf(code: string): ZyBlockRow | null {
  return blocks.find((b) => b.block_code === code) ?? null;
}

/* ── 排行表列 ── */
const RANK_COLS: DataTableCol<ZyBlockRow>[] = [
  { label: "#", width: 32, mono: true, pri: 3, render: (_r, i) => `<span style="color:var(--faint)">${i + 1}</span>` },
  { label: "板块", pri: 1, sort: (r) => r.block_name, render: (r) =>
      `<span style="font-weight:600">${esc(r.block_name)}</span>` },
  { label: "均涨%", num: true, pri: 1, sort: (r) => r.avg_change ?? null, render: (r) => pctHtml(r.avg_change) },
  { label: "上涨占比", num: true, pri: 1, sort: (r) => upRate(r), render: (r) => breadthCell(r) },
  { label: "涨/跌", num: true, pri: 2, sort: (r) => r.up_count - r.down_count, render: (r) =>
      `<span class="up num">${r.up_count}</span><span style="color:var(--faint)"> / </span><span class="down num">${r.down_count}</span>` },
  { label: "成交额", num: true, pri: 2, sort: (r) => r.amount ?? null, render: (r) => fmtYi(r.amount) },
  { label: "领涨股", pri: 2, sort: (r) => r.leader_change ?? null, title: "板块内涨幅最高的成分股", render: (r) =>
      r.leader ? `${esc(r.leader)} ${pctHtml(r.leader_change)}` : `<span style="color:var(--faint)">—</span>` },
  { label: "热度", num: true, pri: 2, sort: (r) => hotScore(r), title: "成交额 40% + 上涨占比 25% + 领涨 20% + 均涨 15%",
    render: (r) => hotCell(hotScore(r)) },
  { label: "成分", num: true, pri: 3, sort: (r) => r.total_members, title: "全部成分 / 有当日快照",
    render: (r) => `<span style="color:var(--faint)">${r.total_members}</span>` },
];

function breadthCell(r: ZyBlockRow): string {
  if (!r.members) return `<span style="color:var(--faint)">—</span>`;
  const pct = upRate(r);
  return `<span class="brcell"><span class="brbar"><i class="u" style="width:${pct.toFixed(1)}%"></i></span>` +
    `<span class="num">${pct.toFixed(0)}%</span></span>`;
}

function hotCell(score: number): string {
  return `<span class="hotcell"><span class="hcbar"><i style="width:${score}%"></i></span>` +
    `<b class="num">${score}</b></span>`;
}

/* ── 成分股列（服务端排序/分页，字段与全景大表一致） ── */
const MEM_COLS: DataTableCol<BoardRow>[] = [
  { label: "#", width: 30, mono: true, pri: 3, render: (_r, i) => `<span style="color:var(--faint)">${i + 1}</span>` },
  { label: "代码", mono: true, pri: 2, sort: "symbol", render: (r) => r.symbol },
  { label: "名称", pri: 1, sort: "name", render: (r) => `<span style="font-weight:600">${esc(r.name || "—")}</span>` },
  { label: "现价", num: true, pri: 1, render: (r) => fmt(r.current) },
  { label: "涨跌幅", num: true, pri: 1, sort: "change_rate", render: (r) => pctHtml(r.change_rate) },
  { label: "成交额", num: true, pri: 2, sort: "amount", render: (r) => fmtYi(r.amount) },
  { label: "换手%", num: true, pri: 3, render: (r) => fmt(r.turnover_rate) },
];

/* ── 视图渲染 ── */
function syncTypeUI(): void {
  document.querySelectorAll<HTMLElement>("#sec-type button").forEach((b) =>
    b.classList.toggle("on", Number(b.dataset.t) === typeCode));
}

function syncViewUI(): void {
  document.querySelectorAll<HTMLElement>("#sec-view button").forEach((b) =>
    b.classList.toggle("on", b.dataset.v === view));
  const title = el("sec-viewtitle");
  const sub = el("sec-views");
  if (view === "heat") {
    title.textContent = `${typeName()}热力图`;
    sub.textContent = `面积按成交额分档 · 色深 = 均涨强弱 · 取成交额前 90 个`;
  } else if (view === "rank") {
    title.textContent = `${typeName()}涨幅榜`;
    sub.textContent = "点击表头排序（再点反向）· 点击行联动右侧成分股";
  } else {
    title.textContent = `${typeName()}热度榜`;
    sub.textContent = "成交额 40% · 上涨占比 25% · 领涨 20% · 均涨 15%";
  }
  el("sec-total").textContent = blocks.length ? `${visible().length} / ${blocks.length} 个` : "";
}

function setStatus(text: string): void {
  el("sec-status").textContent = text;
}

function paintSelection(): void {
  const code = cur?.block_code ?? "";
  document.querySelectorAll<HTMLElement>(
    "#blk-heat .hm-tile, #sec-rankwrap tbody tr, #blk-hot .hotrow",
  ).forEach((node) => node.classList.toggle("sel", node.dataset.key === code));
}

function renderCurrentView(): void {
  const heat = el("sec-heatwrap");
  const rank = el("sec-rankwrap");
  const hot = el("sec-hotwrap");
  const rankPagerEl = el("sec-rank-pager");
  const hotPagerEl = el("sec-hot-pager");
  heat.hidden = view !== "heat";
  rank.hidden = view !== "rank";
  hot.hidden = view !== "hot";
  rankPagerEl.hidden = view !== "rank";
  hotPagerEl.hidden = view !== "hot";
  syncViewUI();
  if (view === "heat") renderHeat();
  else if (view === "rank") renderRank();
  else renderHot();
  paintSelection();
}

function renderHeat(): void {
  const wrap = el("blk-heat");
  const rows = [...visible()].sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1)).slice(0, 90);
  if (!rows.length) {
    wrap.innerHTML = `<div class="sec-empty">${q ? "无匹配板块" : "暂无板块数据"}</div>`;
    return;
  }
  wrap.innerHTML = rows.map((r, i) => {
    let cs = 2, rs = 1;
    if (i < 3) { cs = 4; rs = 3; }
    else if (i < 10) { cs = 3; rs = 2; }
    else if (i < 30) { cs = 3; rs = 1; }
    const c = r.avg_change ?? 0;
    const dir = c > 0.0001 ? "up" : c < -0.0001 ? "down" : "flat";
    const h = Math.round(10 + 46 * Math.min(1, Math.abs(c) / 8));
    const up = upRate(r);
    const down = r.members ? (r.down_count / r.members) * 100 : 0;
    const size = rs >= 2 ? "lg" : "sm";
    const title = `${r.block_name} ${fmtChg(r.avg_change)}% · 成交 ${fmtYi(r.amount)} · ` +
      `${r.up_count}涨/${r.down_count}跌 · 领涨 ${r.leader || "—"} ${fmtChg(r.leader_change)}%`;
    return `<button type="button" class="hm-tile ${dir} ${size}" data-key="${esc(r.block_code)}" ` +
      `style="--h:${h}%;grid-column:span ${cs};grid-row:span ${rs}" title="${esc(title)}">` +
      `<span class="hm-top"><b class="hm-name">${esc(r.block_name)}</b>` +
      `<span class="hm-chg num ${dir}">${r.avg_change == null ? "—" : fmtChg(r.avg_change) + "%"}</span></span>` +
      `<span class="hm-meta num">${fmtYi(r.amount, 1)} · ${r.up_count}涨 ${r.down_count}跌` +
      `${r.leader ? " · " + esc(r.leader) : ""}</span>` +
      `<span class="hm-bar"><i class="u" style="width:${up.toFixed(1)}%"></i><i class="d" style="width:${down.toFixed(1)}%"></i></span>` +
      `</button>`;
  }).join("");
  wrap.querySelectorAll<HTMLElement>(".hm-tile").forEach((tile) =>
    tile.addEventListener("click", () => {
      const r = rowOf(tile.dataset.key || "");
      if (r) setSelected(r);
    }));
}

function renderRank(): void {
  const wrap = el("sec-rankwrap");
  if (!rankPager) rankPager = createPager(el("sec-rank-pager"), "sec_rank", () => renderRank());
  if (!rankTbl) {
    rankTbl = createDataTable<ZyBlockRow>(wrap, RANK_COLS, {
      tblKey: "sectors-rank", defaultSort: { label: "均涨%", dir: -1 },
      onChange: () => { rankPager!.reset(); renderRank(); },
      onRow: (r) => setSelected(r),
      rowKey: (r) => r.block_code,
      empty: q ? "无匹配板块" : "暂无板块数据",
    });
  }
  if (rankReset) { rankPager.reset(); rankReset = false; }
  const rows = rankTbl.sort(visible());
  rankPager.update(rows.length);
  rankTbl.render(slicePage(rankPager, rows), (rankPager.page - 1) * rankPager.size);
}

function renderHot(): void {
  if (!hotPager) hotPager = createPager(el("sec-hot-pager"), "sec_hot", () => renderHot());
  if (hotReset) { hotPager.reset(); hotReset = false; }
  const rows = [...visible()].sort((a, b) =>
    hotScore(b) - hotScore(a) || (b.amount ?? 0) - (a.amount ?? 0));
  hotPager.update(rows.length);
  const page = slicePage(hotPager, rows);
  const start = (hotPager.page - 1) * hotPager.size;
  const wrap = el("blk-hot");
  if (!page.length) {
    wrap.innerHTML = `<div class="sec-empty">${q ? "无匹配板块" : "暂无板块数据"}</div>`;
    return;
  }
  wrap.innerHTML = page.map((r, i) => {
    const score = hotScore(r);
    const dir = dirClass(r.avg_change);
    const up = upRate(r);
    return `<button type="button" class="hotrow${r.members ? "" : " empty"}" data-key="${esc(r.block_code)}">` +
      `<span class="hotrank num">${start + i + 1}</span>` +
      `<span class="hotmain">` +
      `<span class="hotline"><b>${esc(r.block_name)}</b>${pctHtml(r.avg_change)}` +
      `<span class="sp"></span><em class="num">热度 ${score}</em></span>` +
      `<span class="hotbar"><i class="${dir || "flat"}" style="width:${score}%"></i></span>` +
      `<span class="hotmeta num">成交 ${fmtYi(r.amount, 1)} · 上涨 ${up.toFixed(0)}% (${r.up_count}/${r.members})` +
      `${r.leader ? " · 领涨 " + esc(r.leader) + " " + fmtChg(r.leader_change) + "%" : ""}</span>` +
      `</span></button>`;
  }).join("");
  wrap.querySelectorAll<HTMLElement>(".hotrow").forEach((row) =>
    row.addEventListener("click", () => {
      const r = rowOf(row.dataset.key || "");
      if (r) setSelected(r);
    }));
}

/* ── 右侧板块详情 + 成分股联动 ── */
function renderDetail(r: ZyBlockRow): void {
  const total = r.members;
  const upPct = total ? (r.up_count / total) * 100 : 0;
  const flatPct = total ? (r.flat_count / total) * 100 : 0;
  const downPct = total ? (r.down_count / total) * 100 : 0;
  const score = hotScore(r);

  el("sec-code").textContent = r.block_code;
  el("sec-name").textContent = r.block_name;
  el("sec-tag").textContent = TYPE_NAMES[r.type_code] ?? "";
  const avg = el("sec-avg");
  avg.textContent = r.avg_change == null ? "—" : `${fmtChg(r.avg_change)}%`;
  avg.className = dirClass(r.avg_change);

  el("sec-kpis").innerHTML =
    `<div class="sec-kpi"><span>上涨占比</span>` +
    `<b class="${upPct >= 50 ? "up" : total ? "down" : ""}">${total ? upPct.toFixed(0) + "%" : "—"}</b>` +
    `<em>${r.up_count} 涨 · ${r.flat_count} 平 · ${r.down_count} 跌</em></div>` +
    `<div class="sec-kpi"><span>板块成交额</span><b>${fmtYi(r.amount, 1)}</b>` +
    `<em>${total} 只有行情成分合计</em></div>` +
    `<div class="sec-kpi"><span>领涨股</span><b class="sm">${esc(r.leader || "—")}</b>` +
    `<em class="${dirClass(r.leader_change)}">${r.leader_change == null ? "—" : fmtChg(r.leader_change) + "%"}</em></div>` +
    `<div class="sec-kpi"><span>板块热度</span><b class="accent">${score}</b>` +
    `<em>成交 40 · 宽度 25 · 高度 20 · 振幅 15</em></div>`;

  el("sec-breadth").innerHTML = total
    ? `<div class="sec-bar"><i class="u" style="width:${upPct.toFixed(1)}%"></i>` +
      `<i class="f" style="width:${flatPct.toFixed(1)}%"></i>` +
      `<i class="d" style="width:${downPct.toFixed(1)}%"></i></div>` +
      `<div class="sec-blegend"><span><i class="u"></i>上涨 ${r.up_count}</span>` +
      `<span><i class="f"></i>平 ${r.flat_count}</span>` +
      `<span><i class="d"></i>下跌 ${r.down_count}</span></div>`
    : `<div class="sec-blegend"><span>该板块暂无当日行情快照</span></div>`;

  el("mem-count").textContent = r.total_members
    ? `共 ${r.total_members} 只${r.members < r.total_members ? `（有行情 ${r.members}）` : ""}`
    : "";
}

function renderDetailEmpty(): void {
  el("sec-code").textContent = "—";
  el("sec-name").textContent = "选择板块";
  el("sec-tag").textContent = "";
  const avg = el("sec-avg");
  avg.textContent = "—";
  avg.className = "";
  el("sec-kpis").innerHTML = "";
  el("sec-breadth").innerHTML = "";
  el("mem-count").textContent = "";
}

function setSelected(r: ZyBlockRow, forceMembers = false): void {
  const changed = !cur || cur.block_code !== r.block_code;
  cur = r;
  renderDetail(r);
  paintSelection();
  if (changed || forceMembers) {
    memPager?.reset();
    void loadMembers();
  }
}

async function loadMembers(): Promise<void> {
  const seq = ++memSeq;
  const wrap = el("mem-wrap");
  if (!cur) {
    memTbl?.render([], 0);
    memPager?.update(0);
    return;
  }
  const code = cur.block_code;
  if (!memPager) memPager = createPager(el("mem-pager"), "sec_members", () => void loadMembers());
  if (!memTbl) {
    memTbl = createDataTable<BoardRow>(wrap, MEM_COLS, {
      tblKey: "sectors-mem", defaultSort: { label: "涨跌幅", dir: -1 },
      onChange: () => { memPager!.reset(); void loadMembers(); },
      onRow: (r) => document.dispatchEvent(new CustomEvent("yc:open-stock", {
        detail: { symbol: r.symbol, name: r.name || r.symbol, from: { page: "sectors", label: "板块" } },
      })),
      rowKey: (r) => r.symbol,
      empty: "该板块暂无成分股行情",
    });
  }
  wrap.setAttribute("aria-busy", "true");
  try {
    const r = await marketApi.zyBlockMembers(code, {
      sort: memSortParam(), page: memPager.page, size: memPager.size,
    });
    if (seq !== memSeq || cur?.block_code !== code) return;
    wrap.setAttribute("aria-busy", "false");
    memPager.update(r.total);
    memTbl.render(r.items, (memPager.page - 1) * memPager.size);
    const row = rowOf(code);
    el("mem-count").textContent = row?.total_members
      ? `共 ${row.total_members} 只${row.members < row.total_members ? `（有行情 ${row.members}）` : ""}`
      : `共 ${r.total} 只`;
  } catch (e) {
    if (seq !== memSeq) return;
    wrap.setAttribute("aria-busy", "false");
    toast((e as Error).message || "成分股加载失败");
  }
}

const MEM_SORT_KEYS: Record<string, string> = {
  "代码": "symbol", "名称": "name", "涨跌幅": "change_rate", "成交额": "amount",
};
function memSortParam(): string {
  const st = memTbl?.sortState;
  const key = st?.label ? MEM_SORT_KEYS[st.label] : undefined;
  if (!key) return "-change_rate";
  return st!.dir === -1 ? `-${key}` : key;
}

/* ── 数据加载 ── */
async function fetchAll(tc: number): Promise<{ items: ZyBlockRow[]; as_of: string }> {
  const size = 200;
  const first = await marketApi.zyBlocks({ type_code: tc, sort: "-avg_change", page: 1, size });
  const pages = Math.ceil(first.total / size);
  const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) =>
    marketApi.zyBlocks({ type_code: tc, sort: "-avg_change", page: i + 2, size })));
  const map = new Map<string, ZyBlockRow>();
  for (const chunk of [first, ...rest]) for (const it of chunk.items) map.set(it.block_code, it);
  return { items: [...map.values()], as_of: first.as_of };
}

function firstForView(): ZyBlockRow | null {
  const rows = visible();
  if (!rows.length) return null;
  if (view === "rank" && rankTbl) return rankTbl.sort(rows)[0] ?? null;
  return [...rows].sort((a, b) => hotScore(b) - hotScore(a))[0];
}

function ensureSelection(reloadMembers = false): void {
  const rows = visible();
  if (cur) {
    const same = rows.find((b) => b.block_code === cur!.block_code);
    if (same) { setSelected(same, reloadMembers); return; }
    cur = null;
  }
  const first = firstForView();
  if (first) { setSelected(first, reloadMembers); return; }
  renderDetailEmpty();
  memTbl?.render([], 0);
  memPager?.update(0);
  paintSelection();
}

export async function loadSectors(): Promise<void> {
  const tc = typeCode;
  const seq = ++loadSeq;
  setStatus("加载中…");
  try {
    let data = cache.get(tc);
    if (!data) {
      data = await fetchAll(tc);
      cache.set(tc, data);
    }
    if (seq !== loadSeq || tc !== typeCode) return;
    blocks = data.items;
    maxAmt = Math.max(1, ...blocks.map((b) => b.amount ?? 0));
    el("sec-asof").textContent = data.as_of ? `数据 ${data.as_of}` : "";
    el("sec-scope").textContent = `${typeName()}板块`;
    setStatus(`共 ${blocks.length} 个板块${data.as_of ? ` · ${data.as_of}` : ""}`);
    el("sec-note").textContent =
      "热度 = 成交额 40% + 上涨占比 25% + 领涨涨幅 20% + 均涨绝对值 15%；" +
      "热力图取成交额前 90 个，面积按成交额分档；点击板块联动右侧成分股。";
    syncTypeUI();
    syncViewUI();
    renderCurrentView();
    ensureSelection(!!cur && cur.type_code === tc);
  } catch (e) {
    if (seq !== loadSeq) return;
    setStatus("加载失败");
    toast((e as Error).message || "板块加载失败");
  }
}

function setType(tc: number): void {
  if (tc === typeCode) return;
  typeCode = tc;
  try { localStorage.setItem("yc_sectype", String(tc)); } catch { /* 忽略 */ }
  blocks = [];
  cur = null;
  rankReset = true;
  hotReset = true;
  syncTypeUI();
  el("sec-total").textContent = "";
  void loadSectors();
}

function setView(v: View): void {
  if (v === view) return;
  view = v;
  try { localStorage.setItem("yc_secview", v); } catch { /* 忽略 */ }
  renderCurrentView();
  ensureSelection();
}

/* 顶部全局搜索点板块 → 定位到该板块（先查已载清单，再走服务端 q 兜底） */
export async function jumpSector(id: string, t: "industry" | "concept" = "industry"): Promise<void> {
  const tc = t === "concept" ? 2 : 4;
  if (tc !== typeCode) {
    typeCode = tc;
    blocks = [];
    cur = null;
    rankReset = true;
    hotReset = true;
    syncTypeUI();
  }
  await loadSectors();
  let hit = blocks.find((b) => b.block_code === id) || blocks.find((b) => b.block_name === id);
  if (!hit) {
    try {
      const r = await marketApi.zyBlocks({ type_code: tc, q: id, size: 20 });
      hit = r.items.find((b) => b.block_code === id) ?? r.items.find((b) => b.block_name === id)
        ?? r.items.find((b) => b.block_name.includes(id));
    } catch { /* 忽略 */ }
  }
  if (hit) { setSelected(hit); return; }
  toast(`未找到板块「${id}」，已打开${typeName()}全景`);
}

export function initSectors(): void {
  syncTypeUI();
  syncViewUI();
  el("sec-type").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-t]");
    if (b) setType(Number(b.dataset.t));
  });
  el("sec-view").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-v]");
    if (b) setView(b.dataset.v as View);
  });
  let qTimer: ReturnType<typeof setTimeout> | null = null;
  el("sec-q").addEventListener("input", (e) => {
    q = (e.target as HTMLInputElement).value || "";
    rankReset = true;
    hotReset = true;
    if (qTimer) clearTimeout(qTimer);
    qTimer = setTimeout(() => { renderCurrentView(); ensureSelection(); }, 120);
  });
  el("sec-refresh").addEventListener("click", () => {
    cache.delete(typeCode);
    void loadSectors();
  });
  // 驻留期内 2 分钟静默刷新（后端快照每 5 分钟一轮；离开页面不请求）
  setInterval(() => {
    if (!document.getElementById("page-sectors")?.classList.contains("on")) return;
    cache.delete(typeCode);
    void loadSectors();
  }, 120_000);
}
