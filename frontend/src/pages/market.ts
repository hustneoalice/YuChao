/* 行情页：个股头 + K线（SVG）+ 副图 + 右列功能卡 + 十字光标 */
import { marketApi, type Bar, type Quote } from "../api";
import { cssv, fmt, fmtChg, fmtVol, fmtYi, dlab } from "../fmt";
import { sma, bollSeries, macdSeries, kdjSeries, atrSeries, sixSegment } from "../indicators";
import { ic } from "../icons";
import { CARD_DEFS, getState, isVip, setCardPref, subscribe } from "../store";
import { openModal, toast } from "../ui";

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
  initCrosshair();
  window.addEventListener("resize", () => {
    clearTimeout((window as unknown as { _rz?: number })._rz);
    (window as unknown as { _rz?: number })._rz = window.setTimeout(() => {
      if (document.getElementById("page-market")!.classList.contains("on")) renderKline();
    }, 160);
  });
  subscribe(() => renderRight());
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
  if (mk.period === "w") return aggDaily(mk.bars, 5).slice(-80);
  if (mk.period === "m") return aggDaily(mk.bars, 20).slice(-40);
  return mk.bars.slice(-90);
}

/* ── 个股头 ── */
export function renderStockHead(): void {
  const s = mk.cur, q = mk.quote;
  if (!s) return;
  const bars = curBars();
  const last = bars[bars.length - 1];
  document.getElementById("s-name")!.textContent = q?.name || s.name || s.symbol;
  document.getElementById("s-code")!.textContent = s.symbol;
  document.getElementById("kl-code")!.textContent = s.symbol;
  const segTag = document.getElementById("s-seg") as HTMLElement;
  if (q?.industry) { segTag.hidden = false; segTag.textContent = q.industry; } else segTag.hidden = true;
  const boardTag = document.getElementById("s-board") as HTMLElement;
  if (q?.market) { boardTag.hidden = false; boardTag.textContent = q.market; } else boardTag.hidden = true;

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
  document.getElementById("s-stats")!.innerHTML =
    `<span>今开 <b class="num">${fmt(last.open)}</b></span>` +
    `<span>最高 <b class="num up">${fmt(last.high)}</b></span>` +
    `<span>最低 <b class="num down">${fmt(last.low)}</b></span>` +
    `<span>成交额 <b class="num">${fmtYi(amt, 1)}</b></span>` +
    `<span>换手率 <b class="num">${turn}%</b></span>` +
    `<span>振幅 <b class="num">${amp}%</b></span>`;
}
/* ── K线主图 ── */
export function renderKline(): void {
  const stage = document.getElementById("kl-main")!;
  const empty = document.getElementById("kl-empty")!;
  if (!mk.cur || !mk.bars.length) {
    stage.innerHTML = "";
    document.getElementById("kl-sub")!.innerHTML = "";
    document.getElementById("kl-legend")!.innerHTML = "";
    empty.style.display = "grid";
    return;
  }
  empty.style.display = "none";
  if (!stage.clientWidth) return;
  const bars = curBars();
  const closes = bars.map((b) => b.close);
  const ma5 = sma(bars, 5), ma10 = sma(bars, 10), ma20 = sma(bars, 20);
  const bl = bollSeries(bars, 20, 2);
  const W = stage.clientWidth, H = stage.clientHeight;
  const pad = { l: 58, r: 14, t: 12, b: 20 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  let lo = Infinity, hi = -Infinity;
  bars.forEach((b, i) => {
    hi = Math.max(hi, b.high, ma5[i] || 0, ma10[i] || 0, ma20[i] || 0, bl.up[i] || 0);
    lo = Math.min(lo, b.low, bl.low[i] ?? Infinity);
  });
  const rng = (hi - lo) || 1;
  hi += rng * .07; lo -= rng * .07;
  const y = (v: number) => pad.t + ph - (v - lo) / (hi - lo) * ph;
  const bw = pw / bars.length, cw = Math.max(2, bw * .66);
  const x = (i: number) => pad.l + bw * i + bw / 2;
  const upC = cssv("--up"), dnC = cssv("--down"), gridC = cssv("--grid"),
    accC = cssv("--accent"), p1C = cssv("--p1"), vipC = cssv("--vip"),
    dimC = cssv("--dim"), faintC = cssv("--faint");

  let svg = `<svg width="${W}" height="${H}" style="width:100%;height:100%;display:block">`;
  for (let g = 0; g <= 4; g++) {
    const gy = pad.t + ph * g / 4;
    svg += `<line x1="${pad.l}" y1="${gy}" x2="${W - pad.r}" y2="${gy}" stroke="${gridC}"/>`;
    const val = hi - (hi - lo) * g / 4;
    svg += `<text x="${pad.l - 8}" y="${gy + 3}" text-anchor="end" font-size="10" fill="${faintC}">${fmt(val, 1)}</text>`;
  }
  const nlab = 6;
  for (let i = 0; i < nlab; i++) {
    const bi = Math.round(i * (bars.length - 1) / (nlab - 1));
    svg += `<text x="${x(bi)}" y="${H - 5}" text-anchor="middle" font-size="10" fill="${faintC}">${dlab(bars[bi].date)}</text>`;
  }
  bars.forEach((b, i) => {
    const up = b.close >= b.open, col = up ? upC : dnC;
    svg += `<line x1="${x(i).toFixed(1)}" y1="${y(b.high).toFixed(1)}" x2="${x(i).toFixed(1)}" y2="${y(b.low).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    const yc = y(Math.max(b.open, b.close)), yh = y(Math.min(b.open, b.close));
    svg += `<rect x="${(x(i) - cw / 2).toFixed(1)}" y="${yc.toFixed(1)}" width="${cw.toFixed(1)}" height="${Math.max(1, yh - yc).toFixed(1)}" fill="${col}" rx="${cw > 4 ? 1 : 0}"/>`;
  });
  const line = (arr: (number | null)[], color: string, wd: number) => {
    let d = "", started = false;
    arr.forEach((v, i) => {
      if (v == null) return;
      d += (started ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1) + " ";
      started = true;
    });
    return d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="${wd}" opacity=".9"/>` : "";
  };
  if (mk.mainInd === "ma") svg += line(ma5, accC, 1.4) + line(ma10, p1C, 1.4) + line(ma20, vipC, 1.4);
  else svg += line(bl.up, dimC, 1) + line(bl.mid, dimC, 1) + line(bl.low, dimC, 1);
  svg += "</svg>";
  stage.innerHTML = svg;
  document.getElementById("kl-legend")!.innerHTML = mk.mainInd === "ma"
    ? `<span><i style="background:${accC}"></i>MA5</span><span><i style="background:${p1C}"></i>MA10</span><span><i style="background:${vipC}"></i>MA20</span>`
    : `<span><i style="background:${dimC}"></i>BOLL(20,2)</span>`;
  renderSub(bars);
}

/* ── 副图 ── */
function renderSub(bars: Bar[]): void {
  const el = document.getElementById("kl-sub")!;
  if (!el.clientWidth) return;
  const W = el.clientWidth, H = 112;
  const pad = { l: 58, r: 14, t: 10, b: 14 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const upC = cssv("--up"), dnC = cssv("--down"), gridC = cssv("--grid"),
    faintC = cssv("--faint"), accC = cssv("--accent"), vipC = cssv("--vip");
  const bw = pw / bars.length, cw = Math.max(2, bw * .66);
  const x = (i: number) => pad.l + bw * i + bw / 2;
  let y = (v: number) => v;
  let svg = `<svg width="${W}" height="${H}" style="width:100%;height:100%;display:block">`;
  const pLine = (arr: (number | null)[], col: string) => {
    let d = "";
    arr.forEach((v, i) => {
      if (v == null) return;
      d += (d ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1) + " ";
    });
    return d ? `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.2"/>` : "";
  };
  if (mk.subInd === "vol") {
    const vols = bars.map((b) => b.volume || 0);
    const maxv = Math.max(...vols) || 1;
    bars.forEach((b, i) => {
      const h = Math.max(1, ph * (b.volume || 0) / maxv);
      const up = b.close >= b.open;
      svg += `<rect x="${(x(i) - cw / 2).toFixed(1)}" y="${(H - pad.b - h).toFixed(1)}" width="${cw.toFixed(1)}" height="${h.toFixed(1)}" fill="${up ? upC : dnC}" opacity=".55" rx="${cw > 4 ? 1 : 0}"/>`;
    });
    const vma = sma(bars.map((b, i) => ({ ...b, close: vols[i] })), 5);
    let d = "";
    vma.forEach((v, i) => {
      if (v == null) return;
      d += (d ? "L" : "M") + x(i).toFixed(1) + "," + (H - pad.b - ph * v / maxv).toFixed(1) + " ";
    });
    if (d) svg += `<path d="${d}" fill="none" stroke="${accC}" stroke-width="1.1"/>`;
    svg += `<text x="${pad.l - 8}" y="14" text-anchor="end" font-size="10" fill="${faintC}">VOL</text>`;
  } else if (mk.subInd === "macd") {
    const { dif, dea, hist } = macdSeries(bars);
    let mx = 0;
    hist.forEach((v) => mx = Math.max(mx, Math.abs(v || 0)));
    mx = mx || 1;
    const zero = pad.t + ph / 2;
    y = (v: number) => zero - (v / mx) * (ph / 2 - 6);
    hist.forEach((v, i) => {
      if (v == null) return;
      const h = Math.max(1, Math.abs(v) / mx * (ph / 2 - 6));
      const col = v >= 0 ? upC : dnC;
      svg += `<rect x="${(x(i) - cw / 2).toFixed(1)}" y="${(v >= 0 ? zero - h : zero).toFixed(1)}" width="${cw.toFixed(1)}" height="${h.toFixed(1)}" fill="${col}" opacity=".5" rx="${cw > 4 ? 1 : 0}"/>`;
    });
    svg += `<line x1="${pad.l}" y1="${zero}" x2="${W - pad.r}" y2="${zero}" stroke="${gridC}"/>`;
    svg += pLine(dif, upC) + pLine(dea, accC);
    svg += `<text x="${pad.l - 8}" y="14" text-anchor="end" font-size="10" fill="${faintC}">MACD</text>`;
  } else {
    const { k, d, j } = kdjSeries(bars);
    let lo = 1e9, hi = -1e9;
    [...k, ...d, ...j].forEach((v) => { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    const rng = (hi - lo) || 1;
    hi += rng * .1; lo -= rng * .1;
    y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * ph;
    svg += pLine(k, vipC) + pLine(d, accC) + pLine(j, upC);
    svg += `<text x="${pad.l - 8}" y="14" text-anchor="end" font-size="10" fill="${faintC}">KDJ</text>`;
  }
  svg += "</svg>";
  el.innerHTML = svg;
}

/* ── 十字光标 ── */
function initCrosshair(): void {
  const stage = document.getElementById("kl-stage")!;
  const xhair = document.getElementById("xhair")!, tip = document.getElementById("xtip")!;
  stage.addEventListener("mousemove", (e) => {
    const s = document.getElementById("kl-main")!;
    if (!mk.cur || !mk.bars.length || !s.clientWidth) return;
    const bars = curBars();
    const r = s.getBoundingClientRect();
    const W = r.width, padL = 58, pw = W - 58 - 14, bw = pw / bars.length;
    const mx = e.clientX - r.left;
    const idx = Math.max(0, Math.min(bars.length - 1, Math.floor((mx - padL) / bw)));
    const x = padL + bw * idx + bw / 2;
    xhair.style.left = x + "px";
    xhair.style.display = "block";
    const b = bars[idx];
    const up = b.close >= b.open, cl = up ? "up" : "down";
    tip.innerHTML = `<div class="t-date num">${dlab(b.date)} · ${mk.cur.name} ${mk.cur.symbol}</div>` +
      `<div class="t-grid"><span class="k">开</span><span class="v num">${fmt(b.open)}</span>` +
      `<span class="k">高</span><span class="v num up">${fmt(b.high)}</span>` +
      `<span class="k">低</span><span class="v num down">${fmt(b.low)}</span>` +
      `<span class="k">收</span><span class="v num ${cl}">${fmt(b.close)}</span>` +
      `<span class="k">量</span><span class="v num">${fmtVol(b.volume)}</span></div>`;
    tip.style.display = "block";
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let tx = x + 14;
    if (tx + tw > r.width - 8) tx = x - tw - 14;
    let ty = 14;
    if (ty + th > r.height - 8) ty = r.height - th - 8;
    tip.style.left = tx + "px";
    tip.style.top = ty + "px";
  });
  stage.addEventListener("mouseleave", () => {
    xhair.style.display = "none";
    tip.style.display = "none";
  });
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
