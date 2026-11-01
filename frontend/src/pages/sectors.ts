/* 板块页：热力 + 排行双视图 + 成分股（策影板块强度表移植版） */
import { sectorsApi, type SectorSummary, type SectorMember } from "../api";
import { esc, fmt, fmtChg, fmtYi } from "../fmt";
import { createPager, slicePage, type Pager } from "../pager";
import { createDataTable, type DataTable, type DataTableCol } from "../table";
import { getState } from "../store";
import { toast } from "../ui";

type View = "heat" | "rank";
let type: "industry" | "concept" = "industry";
let view: View = (localStorage.getItem("yc_secview") as View) || "heat";
let q = "";
let lookback: 5 | 10 | 20 = 20;
let sectors: SectorSummary[] = [];
let curSector = "";
let members: SectorMember[] = [];
let rankPager: Pager | null = null;
let rankTbl: DataTable<SectorSummary> | null = null;
let memPager: Pager | null = null;
let memTbl: DataTable<SectorMember> | null = null;
let rankReset = false;
let memReset = false;

/* 排行列（对齐策影板块强度表核心列：涨幅/资金/涨跌家数/成分/领涨股），全列可排序 */
const RANK_COLS: DataTableCol<SectorSummary>[] = [
  { label: "#", width: 30, mono: true, render: (_s, i) => `<span style="color:var(--faint)">${i + 1}</span>` },
  { label: "板块", sort: "name", render: (s) => `<span style="font-weight:600">${esc(s.name)}</span>` },
  { label: "涨幅", num: true, sort: (s) => s.pct_change ?? null, render: (s) =>
      `<span class="${(s.pct_change ?? 0) >= 0 ? "up" : "down"}">${fmtChg(s.pct_change)}%</span>` },
  { label: "当日主力", num: true, sort: (s) => s.main_net_today ?? null, render: (s) => flowCell(s.main_net_today) },
  { label: "5日主力", num: true, sort: (s) => s.main_net_5d ?? null, render: (s) => flowCell(s.main_net_5d) },
  { label: "涨/跌", num: true, sort: (s) => s.up_count ?? null, render: (s) =>
      `<span style="color:var(--faint)">${s.up_count ?? 0}/${s.down_count ?? 0}</span>` },
  { label: "成分", num: true, sort: (s) => s.member_count ?? null, render: (s) =>
      `<span style="color:var(--faint)">${s.member_count ?? "—"}</span>` },
  { label: "领涨股", num: true, sort: (s) => s.leader_change ?? null, render: (s) =>
      s.leader ? `${esc(s.leader)} <span class="${(s.leader_change ?? 0) >= 0 ? "up" : "down"}">${fmtChg(s.leader_change)}%</span>` : "—" },
];

const MEM_COLS: DataTableCol<SectorMember>[] = [
  { label: "#", width: 30, mono: true, render: (_m, i) => `<span style="color:var(--faint)">${i + 1}</span>` },
  { label: "代码", mono: true, sort: "symbol", render: (m) => m.symbol },
  { label: "名称", sort: "name", render: (m) => `<span style="font-weight:600">${esc(m.name)}</span>` },
  { label: "现价", num: true, sort: (m) => m.last_close, render: (m) => fmt(m.last_close) },
  { label: "窗口涨幅", num: true, sort: (m) => m.lookback_pct ?? null, render: (m) =>
      `<span class="${(m.lookback_pct ?? 0) >= 0 ? "up" : "down"}">${fmtChg(m.lookback_pct)}%</span>` },
  { label: "主力净流入", num: true, sort: (m) => m.main_net ?? null, render: (m) =>
      `<span style="color:var(--faint)">${m.main_net != null ? fmtYi(m.main_net, 1) : "—"}</span>` },
];

function sparkline(vals: number[]): string {
  if (vals.length < 2) return "";
  const mx = Math.max(...vals.map(Math.abs)) || 1;
  const pts = vals.map((v, i) => ((i * 30) + 2) + "," + (26 - (v / mx * 20 + 10))).join(" ");
  return `<svg class="spark" width="128" height="34" viewBox="0 0 128 34"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".8"/></svg>`;
}

function filtered(): SectorSummary[] {
  const kw = q.trim().toLowerCase();
  return kw ? sectors.filter((s) => s.name.toLowerCase().includes(kw)) : sectors;
}

function applyViewUI(): void {
  document.querySelectorAll<HTMLElement>("#sec-view button").forEach((x) =>
    x.classList.toggle("on", x.dataset.v === view));
  document.getElementById("sec-heatwrap")!.style.display = view === "heat" ? "" : "none";
  document.getElementById("sec-rankwrap")!.style.display = view === "rank" ? "" : "none";
  document.getElementById("sec-rank-pager")!.style.display = view === "rank" ? "" : "none";
}

export async function loadSectors(): Promise<void> {
  const tl = type === "industry" ? "行业" : "概念";
  document.getElementById("sec-title")!.textContent = view === "heat" ? `${tl}热力` : `${tl}排行`;
  document.getElementById("sec-sub")!.textContent =
    view === "heat" ? "色深 = 涨跌幅强度 · 点击查看成分股" : "点击板块看成分股 · 表头可排序";
  try {
    sectors = await sectorsApi.list(type, 300);
  } catch (e) {
    toast((e as Error).message || "板块加载失败");
    sectors = [];
  }
  renderView();
  if (sectors.length && !curSector) void openSector(sectors[0].id);
}

function renderView(): void {
  if (view === "heat") renderHeat(); else renderRank();
}

function renderHeat(): void {
  const el = document.getElementById("heat")!;
  const rows = filtered();
  if (!rows.length) {
    el.innerHTML = `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--faint);font-size:12px">${q ? "无匹配板块" : "暂无板块数据（sector_index 未落库）"}</div>`;
    return;
  }
  el.innerHTML = rows.slice(0, 48).map((s) => {
    const up = (s.pct_change ?? 0) >= 0;
    return `<div class="tile ${up ? "r" : "g"}" data-sec="${esc(s.id)}"><div class="tn">${esc(s.name)}</div>` +
      `<div class="tv num ${up ? "up" : "down"}">${fmtChg(s.pct_change)}%</div>` +
      `<div class="ta num">${up ? s.up_count ?? 0 : s.down_count ?? 0} 家${up ? "上涨" : "下跌"}${s.leader ? " · 领涨 " + esc(s.leader) : ""}</div>` +
      (s.leader_change != null ? `<div class="ta num ${s.leader_change >= 0 ? "up" : "down"}">${fmtChg(s.leader_change)}%</div>` : "") +
      `</div>`;
  }).join("");
  el.querySelectorAll<HTMLElement>(".tile").forEach((t) =>
    t.addEventListener("click", () => void openSector(t.dataset.sec!)));
}

function flowCell(v?: number | null): string {
  return v == null ? "—" : `<span class="${v >= 0 ? "up" : "down"}">${fmtYi(v, 1)}</span>`;
}

function renderRank(): void {
  if (!rankPager) rankPager = createPager(document.getElementById("sec-rank-pager")!, "secrank", renderRank);
  if (!rankTbl) rankTbl = createDataTable(document.getElementById("sec-rankwrap")!, RANK_COLS, {
    defaultSort: { label: "涨幅", dir: -1 },
    onChange: renderRank,
    onRow: (s) => void openSector(s.id),
    empty: q ? "无匹配板块" : "暂无板块数据（sector_index 未落库）",
  });
  if (rankReset) { rankPager.reset(); rankReset = false; }
  const rows = rankTbl.sort(filtered());
  rankPager.update(rows.length);
  const start = (rankPager.page - 1) * rankPager.size;
  rankTbl.render(slicePage(rankPager, rows), start);
}

export async function openSector(id: string): Promise<void> {
  curSector = id;
  const meta = sectors.find((s) => s.id === id);
  document.getElementById("mem-title")!.textContent = "成分股 · " + (meta?.name || id);
  document.getElementById("mem-date")!.textContent = meta ? `指数日 ${meta.trade_date} · 加权窗口 ${lookback} 日` : "";
  if (!memTbl) memTbl = createDataTable(document.getElementById("mem-wrap")!, MEM_COLS, {
    onChange: renderMembers,
    onRow: (m) => document.dispatchEvent(new CustomEvent("yc:open-stock", {
      detail: { symbol: m.symbol, name: m.name, from: { page: "sectors", label: "板块" } } })),
    empty: "暂无成分股数据",
  });
  document.getElementById("mem-wrap")!.innerHTML =
    `<div style="text-align:center;color:var(--faint);font-size:12px;padding:40px 0">加载中…</div>`;
  try {
    members = await sectorsApi.members(id, lookback);
  } catch (e) {
    members = [];
    toast((e as Error).message || "成分股加载失败");
  }
  memReset = true;                          // 新板块成分 → 回第一页
  renderMembers();
}

function renderMembers(): void {
  if (!memPager) memPager = createPager(document.getElementById("mem-pager")!, "secmem", renderMembers);
  if (memReset) { memPager.reset(); memReset = false; }
  const rows = memTbl!.sort(members);
  memPager.update(rows.length);
  const start = (memPager.page - 1) * memPager.size;
  memTbl!.render(slicePage(memPager, rows), start);
}

export function initSectors(): void {
  applyViewUI();
  document.getElementById("sec-view")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (!b) return;
    view = b.dataset.v as View;
    localStorage.setItem("yc_secview", view);
    applyViewUI();
    void loadSectors();
  });
  document.getElementById("sec-q")!.addEventListener("input", (e) => {
    q = (e.target as HTMLInputElement).value || "";
    rankReset = true;                       // 搜索条件变化 → 回第一页
    renderView();
  });
  document.getElementById("sec-type")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (!b) return;
    type = b.dataset.t as "industry" | "concept";
    document.querySelectorAll("#sec-type button").forEach((x) => x.classList.toggle("on", x === b));
    void loadSectors();
  });
  document.getElementById("sec-look")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (!b) return;
    lookback = Number(b.dataset.l) as 5 | 10 | 20;
    document.querySelectorAll("#sec-look button").forEach((x) => x.classList.toggle("on", x === b));
    if (curSector) void openSector(curSector);
  });
}

export function sectorCount(): number { return sectors.length; }
export function currentSectorId(): string { return curSector; }
export function getMembers(): SectorMember[] { return members; }
export function useStore(): string { return getState().theme; }
