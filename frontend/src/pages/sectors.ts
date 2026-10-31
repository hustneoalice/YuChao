/* 板块页：热力 + 排行双视图 + 成分股（策影板块强度表移植版） */
import { sectorsApi, type SectorSummary, type SectorMember } from "../api";
import { esc, fmt, fmtChg, fmtYi } from "../fmt";
import { getState } from "../store";
import { toast } from "../ui";

type View = "heat" | "rank";
let type: "industry" | "concept" = "industry";
let view: View = (localStorage.getItem("yc_secview") as View) || "heat";
let q = "";
let sortKey: SortKey = "pct_change";
let lookback: 5 | 10 | 20 = 20;
let sectors: SectorSummary[] = [];
let curSector = "";
let members: SectorMember[] = [];

type SortKey = "pct_change" | "main_net_today" | "main_net_5d" | "up_count";

/* 排行列（对齐策影板块强度表核心列：涨幅/资金/涨跌家数/成分/领涨股） */
const RANK_COLS: { k?: SortKey; label: string; num?: boolean }[] = [
  { k: "pct_change", label: "涨幅", num: true },
  { k: "main_net_today", label: "当日主力", num: true },
  { k: "main_net_5d", label: "5日主力", num: true },
  { label: "涨/跌", num: true },
  { label: "成分", num: true },
  { label: "领涨股", num: true },
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
  document.getElementById("sec-rank-head")!.innerHTML =
    `<th style="width:30px"></th>` +
    RANK_COLS.map((c) =>
      `<th${c.num ? ' class="n"' : ""}${c.k ? ` data-k="${c.k}" style="cursor:pointer"` : ""}>` +
      `${c.label}${sortKey === c.k ? " ▾" : ""}</th>`).join("");
  const rows = filtered().slice().sort((a, b) =>
    (b[sortKey] ?? -Infinity) - (a[sortKey] ?? -Infinity));
  document.getElementById("sec-rank")!.innerHTML = rows.map((s, i) => {
    const up = (s.pct_change ?? 0) >= 0;
    const lu = (s.leader_change ?? 0) >= 0;
    return `<tr data-sec="${esc(s.id)}"><td class="num" style="color:var(--faint)">${i + 1}</td>` +
      `<td><span style="font-weight:600">${esc(s.name)}</span></td>` +
      `<td class="n num ${up ? "up" : "down"}">${fmtChg(s.pct_change)}%</td>` +
      `<td class="n num">${flowCell(s.main_net_today)}</td>` +
      `<td class="n num">${flowCell(s.main_net_5d)}</td>` +
      `<td class="n num" style="color:var(--faint)">${s.up_count ?? 0}/${s.down_count ?? 0}</td>` +
      `<td class="n num" style="color:var(--faint)">${s.member_count ?? "—"}</td>` +
      `<td class="n num">${s.leader ? `${esc(s.leader)} <span class="${lu ? "up" : "down"}">${fmtChg(s.leader_change)}%</span>` : "—"}</td></tr>`;
  }).join("") ||
    `<tr><td colspan="8" style="text-align:center;color:var(--faint)">${q ? "无匹配板块" : "暂无板块数据（sector_index 未落库）"}</td></tr>`;
  document.querySelectorAll<HTMLElement>("#sec-rank tr[data-sec]").forEach((tr) =>
    tr.addEventListener("click", () => void openSector(tr.dataset.sec!)));
  document.querySelectorAll<HTMLElement>("#sec-rank-head th[data-k]").forEach((th) =>
    th.addEventListener("click", () => {
      sortKey = th.dataset.k as SortKey;
      renderRank();
    }));
}

export async function openSector(id: string): Promise<void> {
  curSector = id;
  const meta = sectors.find((s) => s.id === id);
  document.getElementById("mem-title")!.textContent = "成分股 · " + (meta?.name || id);
  document.getElementById("mem-date")!.textContent = meta ? `指数日 ${meta.trade_date} · 加权窗口 ${lookback} 日` : "";
  const body = document.getElementById("mem-body")!;
  body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--faint)">加载中…</td></tr>`;
  try {
    members = await sectorsApi.members(id, lookback);
  } catch (e) {
    members = [];
    toast((e as Error).message || "成分股加载失败");
  }
  body.innerHTML = members.map((m, i) => {
    const up = (m.lookback_pct ?? 0) >= 0;
    return `<tr data-stock="${m.symbol}"><td class="num" style="color:var(--faint)">${i + 1}</td><td class="num">${m.symbol}</td><td><span style="font-weight:600">${esc(m.name)}</span></td>` +
      `<td class="n num">${fmt(m.last_close)}</td>` +
      `<td class="n num ${up ? "up" : "down"}">${fmtChg(m.lookback_pct)}%</td>` +
      `<td class="n num" style="color:var(--faint)">${m.main_net != null ? fmtYi(m.main_net, 1) : "—"}</td></tr>`;
  }).join("") || `<tr><td colspan="6" style="text-align:center;color:var(--faint)">暂无成分股数据</td></tr>`;
  body.querySelectorAll<HTMLElement>("tr[data-stock]").forEach((tr) =>
    tr.addEventListener("click", () => {
      const m = members.find((x) => x.symbol === tr.dataset.stock);
      document.dispatchEvent(new CustomEvent("yc:open-stock", {
        detail: { symbol: tr.dataset.stock, name: m?.name || tr.dataset.stock, from: { page: "sectors", label: "板块" } },
      }));
    }));
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
