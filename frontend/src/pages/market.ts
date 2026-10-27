/* 行情页：个股头 + klinecharts K线 + 右列功能卡 */
import { marketApi, type Bar, type Quote } from "../api";
import { cssv, fmt, fmtChg, fmtYi } from "../fmt";
import { sma, bollSeries, kdjSeries, atrSeries, sixSegment } from "../indicators";
import { ic } from "../icons";
import { CARD_DEFS, getState, isVip, setCardPref, subscribe } from "../store";
import { openModal, toast } from "../ui";
import { mountKline, type KlineChartHandle } from "./kline";

const CH_FAST = "#FF9800";
const CH_SLOW = "#0A84FF";

export const SEG6 = ["超卖", "低位", "弱势", "回升", "强势", "超买"];
export const SEGNAME = ["", "超卖", "低位", "弱势", "回升", "强势", "超买"];

export interface CurStock { symbol: string; name: string }
export const mk = {
  cur: null as CurStock | null,
  bars: [] as Bar[],
  quote: null as Quote | null,
  period: "d",
  mainInd: "ma",
  subInd: "vol",
  from: null as { page: string; label: string } | null,
};

/* ── 载入 ── */
export async function openStock(s: CurStock, from?: { page: string; label: string } | null): Promise<void> {
  mk.cur = s;
  mk.from = from ?? null;
  localStorage.setItem("yc_last_symbol", `${s.symbol}|${s.name}`);
  renderBackbar();
  document.dispatchEvent(new CustomEvent("yc:goto-page", { detail: "market" }));
  renderHeadLoading();
  try {
    const [k, q] = await Promise.all([
      // 后端 ORDER BY date ASC LIMIT N 语义为「取最早 N 根」：
      // limit 提到 2000（单标的上市以来日线），前端再取尾部即最新行情
      marketApi.kline({ symbol: s.symbol, limit: 2000 }),
      marketApi.quote(s.symbol).catch(() => null),
    ]);
    mk.bars = k.bars;
    mk.quote = q;
    renderStockHead();
    renderKline();
    renderRight();
  } catch (e) {
    toast((e as Error).message || "K线加载失败");
  }
}

export function refreshCur(): void {
  if (mk.cur && document.getElementById("page-market")!.classList.contains("on")) void openStock(mk.cur, mk.from);
}

function renderHeadLoading(): void {
  document.getElementById("s-name")!.textContent = mk.cur?.name || mk.cur?.symbol || "—";
  document.getElementById("s-code")!.textContent = mk.cur?.symbol || "";
  document.getElementById("s-price")!.textContent = "…";
}

function renderBackbar(): void {
  const b = document.getElementById("btn-back") as HTMLElement;
  if (mk.from) { b.hidden = false; document.getElementById("back-label")!.textContent = mk.from.label; }
  else b.hidden = true;
}

export function initMarket(): void {
  document.getElementById("btn-back")!.addEventListener("click", () => {
    if (!mk.from) return;
    document.dispatchEvent(new CustomEvent("yc:goto-page", { detail: mk.from.page }));
    mk.from = null;
    renderBackbar();
  });
  document.getElementById("kl-period")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (b) { mk.period = b.dataset.p!; toggleSeg("kl-period", b); void reloadPeriod(); }
  });
  document.getElementById("kl-main-ind")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (b) { mk.mainInd = b.dataset.mi!; toggleSeg("kl-main-ind", b); renderKline(); }
  });
  document.getElementById("kl-sub-ind")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (b) { mk.subInd = b.dataset.si!; toggleSeg("kl-sub-ind", b); renderKline(); }
  });
  window.addEventListener("resize", () => {
    clearTimeout((window as unknown as { _rz?: number })._rz);
    (window as unknown as { _rz?: number })._rz = window.setTimeout(() => {
      if (document.getElementById("page-market")!.classList.contains("on")) kl?.resize();
    }, 160);
  });
  // 主题 / 涨跌方向 / 强调色变化 → 图表重上色；右列卡重渲染
  subscribe(() => {
    kl?.retheme();
    if (mk.cur) { renderKlLegend(); }
    renderRight();
  });
}

function toggleSeg(id: string, btn: HTMLElement): void {
  document.querySelectorAll(`#${id} button`).forEach((x) => x.classList.toggle("on", x === btn));
}

async function reloadPeriod(): Promise<void> {
  if (!mk.cur) return;
  try {
    // M1 底座为日线表：周/月由日线前端聚合
    const k = await marketApi.kline({ symbol: mk.cur.symbol, limit: 2000 });
    mk.bars = k.bars;
    renderStockHead();
    renderKline();
    renderRight();
  } catch (e) {
    toast((e as Error).message || "K线加载失败");
  }
}

/** 日线聚合为周/月 */
export function aggDaily(daily: Bar[], n: number): Bar[] {
  const out: Bar[] = [];
  let bucket: Bar[] = [];
  for (const b of daily) {
    bucket.push(b);
    if (bucket.length === n) {
      const o = bucket[0], l = bucket[bucket.length - 1];
      out.push({
        date: l.date, open: o.open, high: Math.max(...bucket.map((x) => x.high)),
        low: Math.min(...bucket.map((x) => x.low)), close: l.close,
        volume: bucket.reduce((s, x) => s + (x.volume || 0), 0),
        amount: bucket.reduce((s, x) => s + (x.amount || 0), 0),
      });
      bucket = [];
    }
  }
  if (bucket.length) {
    const o = bucket[0], l = bucket[bucket.length - 1];
    out.push({
      date: l.date, open: o.open, high: Math.max(...bucket.map((x) => x.high)),
      low: Math.min(...bucket.map((x) => x.low)), close: l.close,
      volume: bucket.reduce((s, x) => s + (x.volume || 0), 0),
      amount: bucket.reduce((s, x) => s + (x.amount || 0), 0),
    });
  }
  return out;
}

export function curBars(): Bar[] {
  if (mk.period === "w") return aggDaily(mk.bars, 5);
  if (mk.period === "m") return aggDaily(mk.bars, 20);
  return mk.bars; // 日K 全量：klinecharts 滚轮缩放 / 拖拽平移浏览历史
}

/* ── 个股头 ── */
const MKT_CN: Record<string, string> = { sh: "沪", sz: "深", bj: "北" };
export function renderStockHead(): void {
  const s = mk.cur, q = mk.quote;
  if (!s) return;
  const bars = curBars();
  const last = bars[bars.length - 1];
  document.getElementById("s-name")!.textContent = q?.name || s.name || s.symbol;
  document.getElementById("s-code")!.textContent = s.symbol;
  // 交易所放代码后面（SH→沪 / SZ→深 / BJ→北）
  const boardTag = document.getElementById("s-board") as HTMLElement;
  const mkt = (q?.market || "").toLowerCase();
  if (mkt) { boardTag.hidden = false; boardTag.textContent = MKT_CN[mkt] || mkt.toUpperCase(); }
  else boardTag.hidden = true;

  const prev = bars.length > 1 ? bars[bars.length - 2].close : last.open;
  const up = last.close >= prev;
  const cls = up ? "up" : "down";
  const chgPct = q?.pct_chg ?? (prev ? (last.close - prev) / prev * 100 : 0);
  const price = document.getElementById("s-price")!;
  price.textContent = fmt(last.close);
  price.className = "p num " + cls;
  const chgEl = document.getElementById("s-chg")!;
  chgEl.textContent = fmtChg(chgPct) + "%";
  chgEl.className = "c " + cls;

  const amt = (last.amount ?? (last.volume || 0) * last.close);
  const turn = last.turnover_rate != null ? fmt(last.turnover_rate) : "—";
  const amp = prev ? fmt((last.high - last.low) / prev * 100) : "—";
  // 两行：第一行价格要素，第二行行业 / 概念（无数据时隐藏对应项）
  const infoRow = (pairs: [string, string | null][]) =>
    `<div class="srow">` + pairs.filter((p) => p[1] != null).map(([k, v]) =>
      `<span>${k} <b class="num">${v}</b></span>`).join("") + `</div>`;
  document.getElementById("s-stats")!.innerHTML =
    infoRow([["今开", fmt(last.open)], ["最高", fmt(last.high)], ["最低", fmt(last.low)],
      ["成交额", fmtYi(amt, 1)], ["换手率", turn + "%"], ["振幅", amp + "%"]]) +
    infoRow([["行业", q?.industry ?? null], ["概念", q?.concept ?? null]]);
}
/* ── K线（klinecharts 10 · 策影同款配置，见 kline.ts） ── */
let kl: KlineChartHandle | null = null;

/** 供外部（侧栏拖拽/窗口 resize）触发的图表重排 */
export function klResize(): void {
  kl?.resize();
}

export function renderKline(): void {
  const empty = document.getElementById("kl-empty")!;
  if (!mk.cur || !mk.bars.length) {
    empty.style.display = "grid";
    kl?.setData([]);
    return;
  }
  empty.style.display = "none";
  if (!kl) kl = mountKline(document.getElementById("kl-main")!);
  // 每次都按当前状态应用指标（setMain/setSub 幂等：先移除再创建），
  // 指标 seg 切换只改状态后调这里即可生效
  kl.setMain(mk.mainInd as "ma");
  kl.setSub(mk.subInd as "vol");
  kl.resize();
  kl.setData(curBars());
  renderKlLegend();
}

function renderKlLegend(): void {
  const accC = cssv("--accent") || "#FF9F43", p1C = "#0A84FF", vipC = cssv("--vip") || "#FFD60A";
  const dimC = cssv("--dim") || "#A1A1A6";
  const el = document.getElementById("kl-legend")!;
  if (mk.mainInd === "ma") {
    el.innerHTML = `<span><i style="background:${accC}"></i>MA5</span><span><i style="background:${p1C}"></i>MA10</span><span><i style="background:${vipC}"></i>MA20</span>`;
  } else if (mk.mainInd === "boll") {
    el.innerHTML = `<span><i style="background:${dimC}"></i>BOLL(20,2)</span>`;
  } else {
    const strong = mk.mainInd === "short"
      ? (mk.bars.length && mk.bars[mk.bars.length - 1].close > sma(mk.bars, 10)[mk.bars.length - 1]!)
      : (mk.bars.length && mk.bars[mk.bars.length - 1].close > sma(mk.bars, 45)[mk.bars.length - 1]!);
    const fill = strong ? "rgba(255,155,87,.82)" : "rgba(90,88,251,.86)";
    el.innerHTML = `<span><i style="background:${CH_FAST}"></i>快线</span><span><i style="background:${CH_SLOW}"></i>慢线</span>` +
      `<span><i style="background:${fill}"></i>${strong ? "多头 · 偏强" : "空头 · 偏弱"}</span>`;
  }
}

/* ── 右列功能卡 ── */
function spark(seq: number[], w: number, h: number, color: string): string {
  if (seq.length < 2) return "";
  const mn = Math.min(...seq), mx = Math.max(...seq);
  const r = mx - mn || 1, step = w / (seq.length - 1);
  const pts = seq.map((v, i) => (i * step).toFixed(1) + "," + (h - 2 - ((v - mn) / r) * (h - 4)).toFixed(1)).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="spk" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function mbar(items: [string, number, string][]): string {
  const mx = Math.max(...items.map((i) => Math.abs(i[1])), 1);
  return `<div class="mbar">` + items.map((i) =>
    `<div class="mbl"><span>${i[0]}</span><div class="mbt"><i style="width:${Math.max(4, Math.abs(i[1]) / mx * 100).toFixed(0)}%;background:${i[2]}"></i></div><b class="num ${i[1] >= 0 ? "up" : "down"}">${i[1] > 0 ? "+" : ""}${fmt(i[1])}</b></div>`).join("") + `</div>`;
}

function cardBody(cid: string, mode: string): string {
  const s = mk.cur;
  if (!s) return "";
  const bars = curBars();
  const q = mk.quote;
  const closes = mk.bars.map((b) => b.close);
  const shortSeq = closes.slice(-10), midSeq = closes.slice(-30);
  const chg = q?.pct_chg ?? 0;
  if (cid === "signals") {
    const segI = sixSegment(mk.bars, mk.bars.length - 1);
    if (!isVip()) {
      return `<div class="locklayer">${ic("lock-key", 20)}<b>VIP 指标已锁定</b><span>趋势通道 · 六分段判定（服务端计算）</span><button class="hbtn primary" data-vip-open style="padding:0 12px;height:26px;font-size:11px">解锁</button></div>`;
    }
    if (mode === "simple") {
      return `<div class="csimple"><div class="st"><b>${SEGNAME[segI]}</b> · 六分段判定<br><span style="font-size:10px;color:var(--faint)">短线 ${shortSeq[shortSeq.length - 1] > shortSeq[0] ? "上行" : "下行"} · 中线 ${midSeq[midSeq.length - 1] > midSeq[0] ? "上行" : "下行"}</span></div><div class="minifig">${spark(midSeq, 64, 22, "var(--p1)")}</div></div>`;
    }
    return `<div style="font-size:11px;color:var(--faint)">六分段 · ${SEGNAME[segI]}</div>` +
      `<div class="sixseg" id="rc-six">${Array.from({ length: 6 }, (_, k2) => `<i class="${k2 <= segI - 1 ? "on" : ""}${k2 === segI - 1 ? " cur" : ""}"></i>`).join("")}</div>` +
      `<div class="sixlab"><span>超卖</span><span>超买</span></div>` +
      `<div class="tr2">${spark(shortSeq, 96, 26, "var(--up)")}${spark(midSeq, 96, 26, "var(--p1)")}</div>` +
      `<div style="display:flex;gap:8px;margin-top:8px">` +
      `<div style="flex:1;background:var(--panel-2);border-radius:9px;padding:7px 9px"><div style="font-size:10px;color:var(--faint)">短线趋势</div><div style="font-size:13px;font-weight:650;color:${shortSeq[shortSeq.length - 1] > shortSeq[0] ? "var(--up)" : "var(--down)"}">${shortSeq[shortSeq.length - 1] > shortSeq[0] ? "上行" : "下行"}</div></div>` +
      `<div style="flex:1;background:var(--panel-2);border-radius:9px;padding:7px 9px"><div style="font-size:10px;color:var(--faint)">中线趋势</div><div style="font-size:13px;font-weight:650;color:var(--p1)">${midSeq[midSeq.length - 1] > midSeq[0] ? "上行" : "下行"}</div></div></div>`;
  }
  if (cid === "moneyflow") {
    const cf = q?.capital_flow;
    const items: [string, number, string][] = [
      ["超大单", (cf?.net_super ?? 0) / 1e8, "var(--up)"],
      ["大单", (cf?.net_large ?? 0) / 1e8, "var(--up)"],
      ["中单", (cf?.net_medium ?? 0) / 1e8, "var(--down)"],
      ["小单", (cf?.net_small ?? 0) / 1e8, "var(--down)"],
    ];
    const main = (cf?.net_main ?? 0) / 1e8;
    if (mode === "simple") {
      return `<div class="csimple"><div class="st"><b class="num ${main >= 0 ? "up" : "down"}">${main > 0 ? "+" : ""}${fmt(main)}亿</b> 主力净流入<br><span style="font-size:10px;color:var(--faint)">超大单 +${fmt(items[0][1])} / 小单 ${fmt(items[3][1])}</span></div><div class="minifig">${mbar(items)}</div></div>`;
    }
    return `<div style="display:flex;align-items:baseline;gap:8px"><span style="font-size:20px;font-weight:700" class="num ${main >= 0 ? "up" : "down"}">${main > 0 ? "+" : ""}${fmt(main)}亿</span><span style="font-size:10.5px;color:var(--faint)">主力净流入${cf ? " · " + cf.date : "（无资金流数据）"}</span></div>` +
      `<div class="flowbars">` + items.map((f) =>
        `<div class="f"><div class="bar"><i style="height:${Math.round(Math.abs(f[1]) / 1.3 * 100)}%;background:${f[2]};opacity:.8"></i></div><div class="v num ${f[1] >= 0 ? "up" : "down"}">${f[1] > 0 ? "+" : ""}${fmt(f[1])}</div><div class="t">${f[0]}</div></div>`).join("") + `</div>`;
  }
  if (cid === "indicators") {
    const closesN = bars.map((b) => b.close);
    const ma20 = sma(bars, 20);
    const i = bars.length - 1;
    const bl = bollSeries(bars);
    const kd = kdjSeries(bars);
    const atr = atrSeries(bars);
    const row = (k: string, v: string, cls = "") => `<div class="mbl"><span>${k}</span><div class="mbt"></div><b class="num ${cls}">${v}</b></div>`;
    const ma20v = ma20[i];
    const pos = ma20v != null ? (closesN[i] > ma20v ? "上方" : "下方") : "—";
    const posCls = ma20v != null && closesN[i] > ma20v ? "up" : "down";
    if (mode === "simple") {
      return `<div class="csimple"><div class="st"><b>MA20 ${pos}</b> · KDJ ${fmt(kd.k[i] ?? 0, 0)}<br><span style="font-size:10px;color:var(--faint)">ATR14 ${fmt(atr[i] ?? 0)} · BOLL 带宽 ${ma20v != null ? fmt(((bl.up[i]! - bl.low[i]!) / ma20v) * 100, 1) + "%" : "—"}</span></div><div class="minifig">${spark(closesN.slice(-20), 64, 22, "var(--accent)")}</div></div>`;
    }
    return row("MA5", fmt(sma(bars, 5)[i] ?? 0)) + row("MA20", fmt(ma20v), posCls) +
      row("KDJ K", fmt(kd.k[i] ?? 0, 1)) + row("KDJ J", fmt(kd.j[i] ?? 0, 1)) +
      row("BOLL 上", fmt(bl.up[i] ?? 0)) + row("BOLL 下", fmt(bl.low[i] ?? 0)) +
      row("ATR14", fmt(atr[i] ?? 0));
  }
  if (cid === "valuation") {
    const v = q?.valuation;
    if (!v) return `<div style="font-size:11.5px;color:var(--faint)">暂无估值数据（daily_valuation 未覆盖）</div>`;
    const row = (k: string, val: number | null | undefined, digits = 2) =>
      `<div class="mbl"><span>${k}</span><div class="mbt"></div><b class="num">${fmt(val, digits)}</b></div>`;
    if (mode === "simple") {
      return `<div class="csimple"><div class="st"><b>PE ${fmt(v.pe_ttm, 1)}</b> · PB ${fmt(v.pb, 2)}<br><span style="font-size:10px;color:var(--faint)">总市值 ${fmtYi(v.total_mv, 0)} · 流通 ${fmtYi(v.circ_mv, 0)}</span></div><div class="minifig"></div></div>`;
    }
    return row("PE-TTM", v.pe_ttm) + row("PB", v.pb) + row("PS-TTM", v.ps_ttm) +
      row("总市值(亿)", v.total_mv != null ? v.total_mv / 1e8 : null) + row("流通市值(亿)", v.circ_mv != null ? v.circ_mv / 1e8 : null) +
      `<div style="font-size:10px;color:var(--faint)">数据日期 ${v.date}</div>`;
  }
  if (cid === "corepick") {
    void chg;
    return `<div style="font-size:11.5px;color:var(--faint)"><span class="tag flat" style="font-size:10px">档案</span> 在「核心标」页查看 ${s.name} 的追涨 / 低吸信号与 VIP 因子明细</div><button class="hbtn" data-ic-go-core style="height:26px;padding:0 10px;font-size:11px;margin-top:6px">前往核心标</button>`;
  }
  return "";
}

function cardHead(def: { id: string; name: string; icon: string }): string {
  const p = getState().cards[def.id];
  const mono = def.id === "moneyflow" ? (mk.cur?.symbol || "") : def.id === "corepick" ? "池档案" : "OPEN";
  return `<div class="rh">${ic(def.icon, 14)}<h4>${def.name}</h4><span class="mono" style="margin-left:auto">${mono}</span>` +
    `<span class="cbar"><span class="cseg"><button class="cbtn${p.mode === "simple" ? " on" : ""}" data-mode="simple" title="简单模式">${ic("list", 12)}</button><button class="cbtn${p.mode === "detailed" ? " on" : ""}" data-mode="detailed" title="详细模式">${ic("faders-horizontal", 12)}</button></span>` +
    `<button class="cbtn" data-fold title="折叠 / 展开">${ic("caret-up", 12)}</button>` +
    `<span class="drag" draggable="true" title="拖动排序">${ic("dots-six-vertical", 13)}</span></span></div>`;
}

export function renderRight(): void {
  const el = document.getElementById("rightcol");
  if (!el || !mk.cur) return;
  const st = getState();
  const defs = [...CARD_DEFS].sort((a, b) => st.cards[a.id].order - st.cards[b.id].order);
  let html = "";
  for (const def of defs) {
    const p = st.cards[def.id];
    if (!p.on) continue;
    const locked = def.id === "signals" && !isVip();
    html += `<div class="rcard" data-cid="${def.id}">${locked ? "" : cardHead(def)}` +
      `<div class="fbody${p.mode === "simple" && def.id === "signals" ? "" : ""}${false ? " hide" : ""}">${cardBody(def.id, p.mode)}</div></div>`;
  }
  html += `<div class="cmpl">仅提供基于公开数据的规则化分析，不构成投资建议 · 指标为开源口径前端计算，VIP 明细服务端脱敏返回</div>`;
  el.innerHTML = html;
  el.querySelectorAll<HTMLElement>("[data-vip-open]").forEach((b) =>
    b.addEventListener("click", () => openModal("modal-vip")));
  el.querySelectorAll<HTMLElement>("[data-ic-go-core]").forEach((b) =>
    b.addEventListener("click", () => document.dispatchEvent(new CustomEvent("yc:goto-page", { detail: "corepicks" }))));
  el.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      setCardPref(b.closest(".rcard")!.getAttribute("data-cid")!, { mode: b.dataset.mode as "simple" | "detailed" });
    }));
  el.querySelectorAll<HTMLElement>("[data-fold]").forEach((b) =>
    b.addEventListener("click", () => {
      const card = b.closest(".rcard")!;
      const body = card.querySelector(".fbody") as HTMLElement;
      body.classList.toggle("hide");
      b.innerHTML = ic(body.classList.contains("hide") ? "caret-down" : "caret-up", 12);
    }));
  // 拖拽排序
  el.querySelectorAll<HTMLElement>(".drag").forEach((h) => {
    h.addEventListener("dragstart", (e) => {
      const card = h.closest(".rcard") as HTMLElement;
      e.dataTransfer!.setData("text/plain", card.dataset.cid!);
      e.dataTransfer!.effectAllowed = "move";
      card.classList.add("dragging");
    });
    h.addEventListener("dragend", () => {
      el.querySelectorAll(".rcard").forEach((r) => r.classList.remove("dragging", "drop-before", "drop-after"));
    });
  });
  el.querySelectorAll<HTMLElement>(".rcard").forEach((card) => {
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      el.querySelectorAll(".rcard").forEach((r) => r.classList.remove("drop-before", "drop-after"));
      const r = card.getBoundingClientRect();
      card.classList.add((e.clientY - r.top) > r.height / 2 ? "drop-after" : "drop-before");
    });
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      const id = e.dataTransfer!.getData("text/plain");
      const to = card.dataset.cid!;
      if (id && id !== to) {
        const st2 = getState();
        const fromOrder = st2.cards[id].order;
        void fromOrder;
        let toOrder = st2.cards[to].order;
        if (card.classList.contains("drop-after")) toOrder += 0.5;
        else toOrder -= 0.5;
        setCardPref(id, { order: toOrder });
        toast("卡片顺序已更新");
      }
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-before", "drop-after"));
  });
  el.querySelectorAll<HTMLElement>("[data-go-stock]").forEach((r) =>
    r.addEventListener("click", () => {
      const sym = r.dataset.goStock!;
      void openStock({ symbol: sym, name: r.dataset.goName || sym });
    }));
}
