/* 板块页：热力图 + 成分股 */
import { sectorsApi, type SectorSummary, type SectorMember } from "../api";
import { esc, fmt, fmtChg, fmtYi } from "../fmt";
import { getState } from "../store";
import { toast } from "../ui";

let type: "industry" | "concept" = "industry";
let lookback: 5 | 10 | 20 = 20;
let sectors: SectorSummary[] = [];
let curSector = "";
let members: SectorMember[] = [];

function sparkline(vals: number[]): string {
  if (vals.length < 2) return "";
  const mx = Math.max(...vals.map(Math.abs)) || 1;
  const pts = vals.map((v, i) => ((i * 30) + 2) + "," + (26 - (v / mx * 20 + 10))).join(" ");
  return `<svg class="spark" width="128" height="34" viewBox="0 0 128 34"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".8"/></svg>`;
}

export async function loadSectors(): Promise<void> {
  document.getElementById("sec-title")!.textContent = type === "industry" ? "行业热力" : "概念热力";
  try {
    sectors = await sectorsApi.list(type, 200);
  } catch (e) {
    toast((e as Error).message || "板块加载失败");
    sectors = [];
  }
  renderHeat();
  if (sectors.length && !curSector) void openSector(sectors[0].id);
}

function renderHeat(): void {
  const el = document.getElementById("heat")!;
  if (!sectors.length) {
    el.innerHTML = `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--faint);font-size:12px">暂无板块数据（sector_index 未落库）</div>`;
    return;
  }
  el.innerHTML = sectors.slice(0, 48).map((s) => {
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
