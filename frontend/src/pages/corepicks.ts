/* 核心标页：公开名单 + VIP 因子明细（403 → 锁定） */
import { corepicksApi, type Corepick } from "../api";
import { esc, fmt, fmtChg } from "../fmt";
import { ic } from "../icons";
import { getState, isVip, addWatch, isWatched } from "../store";
import { toast, openModal, closeModals } from "../ui";

let tab: "chase" | "dip" | "all" = "chase";
let picks: Corepick[] = [];
let date = "";

function showCore(name: string): void {
  document.querySelectorAll("[data-core-state]").forEach((s) =>
    s.classList.toggle("on", (s as HTMLElement).dataset.coreState === name));
}

export async function renderCorepicks(): Promise<void> {
  showCore("loading");
  try {
    picks = await corepicksApi.list(undefined, tab === "all" ? undefined : tab);
    date = picks[0]?.date || "";
    document.getElementById("cp-date")!.textContent = date || "最新";
    document.getElementById("cp-total")!.textContent = String(picks.length);
    if (!picks.length) { showCore("empty"); return; }
    renderRows();
    showCore("data");
  } catch (e) {
    (document.getElementById("cp-err-msg") as HTMLElement).textContent = (e as Error).message || "请求失败";
    showCore("error");
  }
}

function scoreCell(v: number | null | undefined, color: string): string {
  return `<div class="scorebar"><span class="num" style="font-size:11px;color:var(--faint);width:22px">${v ?? "—"}</span><span class="sb"><i style="width:${v ?? 0}%;background:${color}"></i></span></div>`;
}

function renderRows(): void {
  const body = document.getElementById("cp-body")!;
  body.innerHTML = picks.map((r, i) => {
    const poolTag = `<span class="tag ${r.pool === "chase" ? "acc" : "p1"}">${r.pool === "chase" ? "追涨" : "低吸"}</span>`;
    return `<tr data-cp="${r.symbol}"><td class="num" style="color:var(--faint)">${i + 1}</td><td class="num">${r.symbol}</td>` +
      `<td><span style="font-weight:600">${esc(r.name)}</span></td>` +
      `<td>${poolTag}</td>` +
      `<td>${esc(r.sector || "—")}</td>` +
      `<td>${scoreCell(r.fund_score, "var(--accent)")}</td>` +
      `<td>${isVip()
        ? `<button class="hbtn" data-cp-open="${r.symbol}" data-pool="${r.pool}" style="height:26px;padding:0 10px;font-size:11.5px">三因子</button>`
        : `<span class="tag lock">${ic("lock", 10)}VIP</span>`}</td>` +
      `<td><span class="tag ${segCls(r.seg)}">${esc(segName(r.seg))}</span></td>` +
      `<td><button class="hbtn" data-cp-open="${r.symbol}" data-pool="${r.pool}" style="height:26px;padding:0 10px;font-size:11.5px">明细</button></td></tr>`;
  }).join("");
  body.querySelectorAll<HTMLElement>("[data-cp-open]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      void openDetail(b.dataset.cpOpen!, b.dataset.pool || "chase");
    }));
  body.querySelectorAll<HTMLElement>("tr[data-cp]").forEach((tr) =>
    tr.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-cp-open]")) return;
      const r = picks.find((x) => x.symbol === tr.dataset.cp);
      if (r) void openDetail(r.symbol, r.pool);
    }));
}

function segName(seg: string | null | undefined): string {
  return seg || "—";
}
function segCls(seg: string | null | undefined): string {
  switch (seg) {
    case "强势": case "超买": return "acc";
    case "超卖": case "低位": return "flat";
    case null: case undefined: return "flat";
    default: return "p1";
  }
}

/* 明细弹窗：VIP → /corepicks/{symbol}/factors；未授权 403 → VIP 弹窗 */
async function openDetail(symbol: string, pool: string): Promise<void> {
  const r = picks.find((x) => x.symbol === symbol && x.pool === pool) ||
    picks.find((x) => x.symbol === symbol);
  if (!r) return;
  document.getElementById("dt-name")!.textContent = r.name || symbol;
  document.getElementById("dt-code")!.textContent = `${symbol} · ${date}`;
  const tag = document.getElementById("dt-pool-tag") as HTMLElement;
  tag.textContent = r.pool === "chase" ? "追涨池" : "低吸池";
  tag.className = "tag " + (r.pool === "chase" ? "acc" : "p1");

  if (!isVip()) {
    (document.getElementById("dt-factors") as HTMLElement).innerHTML =
      `<div class="factor" style="grid-column:1/-1;display:grid;place-items:center;gap:8px;padding:22px">${ic("lock-key", 22)}<b>VIP 三因子明细已锁定</b><span style="font-size:11px;color:var(--faint)">趋势 / 位置 / 六分段由服务端计算，未授权不返回数据</span><button class="hbtn primary" data-dt-vip style="height:28px">开通 VIP</button></div>`;
    (document.getElementById("dt-kv") as HTMLElement).innerHTML =
      `<dt>资金分</dt><dd class="num">${r.fund_score ?? "—"}</dd><dt>六分段</dt><dd>${esc(r.seg || "—")}</dd>`;
  } else {
    (document.getElementById("dt-factors") as HTMLElement).innerHTML =
      `<div class="factor"><div class="k">三因子明细</div><div style="font-size:11.5px;color:var(--dim);margin-top:4px">加载中…</div></div>`;
    (document.getElementById("dt-kv") as HTMLElement).innerHTML = "";
    try {
      const f = await corepicksApi.factors(symbol, r.date, r.pool);
      const fac = (f.factors || {}) as Record<string, unknown>;
      const num = (k: string) => (typeof fac[k] === "number" ? fac[k] as number : null);
      const f1 = num("fund_score") ?? r.fund_score;
      const f2 = num("trend_score");
      const f3 = num("position_score");
      (document.getElementById("dt-factors") as HTMLElement).innerHTML =
        `<div class="factor"><div class="k">资金因子</div><div class="v num" style="color:var(--accent)">${f1 ?? "—"}</div></div>` +
        `<div class="factor"><div class="k">趋势因子</div><div class="v num" style="color:var(--p1)">${f2 ?? "—"}</div></div>` +
        `<div class="factor"><div class="k">位置因子</div><div class="v num" style="color:var(--vip)">${f3 ?? "—"}</div></div>`;
      const segI = typeof fac.seg_index === "number" ? fac.seg_index : 3;
      (document.getElementById("dt-seg-v") as HTMLElement).textContent = `${segName(f.seg)}（${segI}/6）`;
      (document.getElementById("dt-sixseg") as HTMLElement).innerHTML =
        Array.from({ length: 6 }, (_, k) => `<i class="${k <= segI - 1 ? "on" : ""}${k === segI - 1 ? " cur" : ""}"></i>`).join("");
      (document.getElementById("dt-kv") as HTMLElement).innerHTML =
        `<dt>资金分</dt><dd class="num">${f1 ?? "—"}</dd><dt>板块</dt><dd>${esc(f.sector || "—")}</dd><dt>更新</dt><dd class="num">${esc(f.date)}</dd>`;
    } catch (e) {
      (document.getElementById("dt-factors") as HTMLElement).innerHTML =
        `<div class="factor" style="grid-column:1/-1;color:var(--up);font-size:12px">因子加载失败：${esc((e as Error).message)}</div>`;
    }
  }
  (document.getElementById("dt-sixseg") as HTMLElement).innerHTML =
    (document.getElementById("dt-sixseg") as HTMLElement).innerHTML ||
    Array.from({ length: 6 }, () => `<i></i>`).join("");
  (document.getElementById("dt-seg-v") as HTMLElement).textContent =
    (document.getElementById("dt-seg-v") as HTMLElement).textContent || "—";
  const watchBtn = document.getElementById("dt-watch")!;
  watchBtn.onclick = () => {
    if (!isWatched(symbol)) { addWatch(symbol, r.name || symbol); toast(`${r.name || symbol} 已加入自选`); }
    else toast(`${r.name || symbol} 已在自选中`);
  };
  openModal("modal-detail");
  document.querySelector<HTMLButtonElement>("[data-dt-vip]")?.addEventListener("click", () => {
    closeModals();
    document.getElementById("vipbadge")!.click();
  });
}

export function initCorepicks(): void {
  document.getElementById("cp-tabs")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (!b) return;
    tab = b.dataset.t as "chase" | "dip" | "all";
    document.querySelectorAll("#cp-tabs button").forEach((x) => x.classList.toggle("on", x === b));
    void renderCorepicks();
  });
  document.getElementById("cp-retry")!.addEventListener("click", () => void renderCorepicks());
  void renderCorepicks();
}

export function coreCount(): number { return picks.length; }
export function curDate(): string { return date; }
export function useStoreState(): string { return getState().theme; }
export function fmtChgExport(v: number): string { return fmtChg(v); }
