/* 六分段理论示意图（共享）：真实日 K 走完 1 超跌 → 2 反弹 → 3 突破 → 4 超涨 → 5 回踩 → 6 跌破。
 *  · 目标页底部大图（SegmentsMap 区块）与各处的「示意图」小按钮弹层共用同一份 SVG；
 *  · 小按钮 <button class="seg-info"> 由 bindSegInfo() 全局委托：悬停弹出、点击固定、Esc / 点外部关闭；
 *  · 样例行惰引用 002472.SZ 的真实日 K，5 分钟缓存，取回后自动重绘弹层与目标页大图。 */
import { marketApi, type Bar } from "./api";
import { esc } from "./fmt";
import { ic } from "./icons";
import { SEGACTION, SEGFULL, sixSegmentSeries } from "./indicators";
import { trendPalette } from "./pages/kline";

export const SEG_TINTS = ["var(--down)", "var(--down)", "var(--up)", "var(--accent)", "var(--up)", "var(--down)"];
const SEG_SAMPLE = { symbol: "002472.SZ", name: "双环传动", bars: [] as Bar[], at: 0, loading: false };
const SEG_SAMPLE_TTL = 5 * 60 * 1000;

const listeners: (() => void)[] = [];
/** 行情样例行取回后通知外部（目标页大图重绘） */
export function onSegMapData(cb: () => void): void { listeners.push(cb); }

function refreshAll(): void {
  if (pop && pop.style.display === "block") {
    (pop.querySelector(".seg-pop-body") as HTMLElement).innerHTML = segMapSvg();
    if (curTrigger) place(curTrigger, pop);
  }
  listeners.forEach((cb) => cb());
}

function segSampleBars(): Bar[] {
  const s = SEG_SAMPLE;
  if (s.bars.length && Date.now() - s.at < SEG_SAMPLE_TTL) return s.bars;
  if (!s.loading) {
    s.loading = true;
    void marketApi.kline({ symbol: s.symbol, adjust: "qfq", limit: 220 })
      .then((k) => {
        s.bars = k.bars || [];
        s.at = Date.now();
        s.loading = false;
        refreshAll();
      })
      .catch(() => { s.loading = false; });
  }
  return s.bars;
}

/** 最近一个「1→6 各段首次依序出现」的窗口，前后各留几根 K 作上下文 */
function segCycle(): { bars: Bar[]; segs: number[]; base: number; label: string } | null {
  const raw = segSampleBars();
  if (raw.length < 40) return null;
  const all = sixSegmentSeries(raw);
  for (let start = raw.length - 1; start >= 0; start--) {
    if (all[start] !== 1) continue;
    let want = 2, end = -1;
    for (let i = start + 1; i < raw.length; i++) {
      if (all[i] !== want) continue;
      if (++want === 7) { end = i; break; }
    }
    if (end < 0 || end - start < 18) continue;
    const a = Math.max(0, start - 10), b = Math.min(raw.length, end + 3);
    return {
      bars: raw.slice(a, b), segs: all.slice(a, b), base: start - a,
      label: `${SEG_SAMPLE.name} ${SEG_SAMPLE.symbol.slice(0, 6)} · ${raw[a].date} → ${raw[b - 1].date}`,
    };
  }
  return null;
}

/** 六分段示意图 SVG（真实日 K + 短线趋势通道 + 趋势柱 + 六段拉线） */
export function segMapSvg(): string {
  const data = segCycle();
  if (!data) {
    return `<div class="segmap-load${SEG_SAMPLE.loading ? "" : " retry"}">` +
      `${SEG_SAMPLE.loading ? "正在加载真实日 K 行情…" : "行情暂不可用，稍后自动重试"}</div>`;
  }
  const pal = trendPalette();
  const { bars, segs, base } = data;
  const n = bars.length;
  /* 与目标页缩略图同款结构：上半 K 线 + 短线趋势线，下半趋势柱 + 零轴 */
  const X0 = 26, X1 = 604, TX = 618;
  const Y0 = 14, Y1 = 182, H0 = 200, H1 = 258;
  const PW = X1 - X0, step = PW / n;
  const xAt = (i: number): number => X0 + (i + 0.5) * step;
  let lo = Infinity, hi = -Infinity;
  bars.forEach((b) => { lo = Math.min(lo, b.low); hi = Math.max(hi, b.high); });
  const pad = (hi - lo) * 0.06 || 0.1;
  lo -= pad; hi += pad;
  const yAt = (v: number): number => Y1 - ((v - lo) / (hi - lo)) * (Y1 - Y0);
  const bw = Math.min(8, step * 0.62);

  /* 0) 六段底色带：按各段实际区间铺淡色，作为标注底板 */
  const bands: string[] = [];
  let runStart = 0;
  for (let i = 1; i <= n; i++) {
    if (i < n && segs[i] === segs[runStart]) continue;
    const seg = segs[runStart] || 1;
    const xa = xAt(runStart) - step / 2, xb = xAt(i - 1) + step / 2;
    bands.push(`<rect x="${xa.toFixed(1)}" y="${Y0}" width="${(xb - xa).toFixed(1)}"` +
      ` height="${Y1 - Y0}" style="fill:${SEG_TINTS[seg - 1]}" opacity=".05"/>`);
    runStart = i;
  }

  /* 1) 短线趋势指标（与行情页 SHORT_TREND_CHANNEL 同款）：MA7/MA10 通道逐柱填充，
     站上慢线（强）橙柱、跌破慢线（弱）蓝柱，颜色随趋势主题色 */
  const sma = (p: number): (number | null)[] => {
    let sum = 0;
    return bars.map((b, i) => {
      sum += b.close;
      if (i >= p) sum -= bars[i - p].close;
      return i >= p - 1 ? sum / p : null;
    });
  };
  const fast = sma(7), slow = sma(10);
  let channel = "";
  for (let i = 0; i < n; i++) {
    const f = fast[i], s = slow[i];
    if (f == null || s == null) continue;
    const yTop = yAt(Math.max(f, s)), yBot = yAt(Math.min(f, s));
    channel += `<rect x="${(xAt(i) - bw / 2).toFixed(1)}" y="${yTop.toFixed(1)}"` +
      ` width="${bw.toFixed(1)}" height="${Math.max(0.8, yBot - yTop).toFixed(1)}" rx="1"` +
      ` style="fill:${bars[i].close >= s ? pal.fast : pal.slow}" opacity=".82"/>`;
  }

  /* 2) 真实 K 线：影线用 high/low，实体用开盘/收盘，阳/阴随主题涨跌色 */
  const candles = bars.map((b, i) => {
    const up = b.close >= b.open, x = xAt(i);
    const col = up ? "var(--up)" : "var(--down)";
    return `<line x1="${x.toFixed(1)}" y1="${yAt(b.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${yAt(b.low).toFixed(1)}"` +
      ` style="stroke:${col}" stroke-width="1" opacity=".7"/>` +
      `<rect x="${(x - bw / 2).toFixed(1)}" y="${Math.min(yAt(b.open), yAt(b.close)).toFixed(1)}"` +
      ` width="${bw.toFixed(1)}" height="${Math.max(1.2, Math.abs(yAt(b.open) - yAt(b.close))).toFixed(1)}"` +
      ` rx="1" style="fill:${col}" opacity=".85"/>`;
  }).join("");

  /* 3) 快慢线：与指标同款配色（快线橙 / 慢线蓝），叠在通道柱之上 */
  const strokeAt = (arr: (number | null)[], colorAt: (i: number) => string, w: number, alpha: number): string => {
    let out = "";
    for (let i = 1; i < n; i++) {
      const a = arr[i - 1], b = arr[i];
      if (a == null || b == null) continue;
      out += `<line x1="${xAt(i - 1).toFixed(1)}" y1="${yAt(a).toFixed(1)}"` +
        ` x2="${xAt(i).toFixed(1)}" y2="${yAt(b).toFixed(1)}"` +
        ` style="stroke:${colorAt(i)}" stroke-width="${w}" opacity="${alpha}"/>`;
    }
    return out;
  };
  const fastLine = strokeAt(fast, () => pal.fast, 1.2, .95);
  const slowLine = strokeAt(slow, () => pal.slow, 1.2, .95);

  /* 4) 趋势柱（收盘 − 慢线）：下半副图，零轴上红下绿 */
  const histMid = (H0 + H1) / 2;
  const dev = bars.map((b, i) => (slow[i] == null ? null : b.close - (slow[i] as number)));
  const maxAbs = Math.max(1, ...dev.filter((v): v is number => v != null).map((v) => Math.abs(v)));
  let hist = "";
  for (let i = 0; i < n; i++) {
    const v = dev[i];
    if (v == null) continue;
    const bh = Math.max(1, Math.abs(v) / maxAbs * (H1 - H0) / 2 - 1);
    hist += `<rect x="${(xAt(i) - bw / 2).toFixed(1)}" y="${(v >= 0 ? histMid - bh : histMid).toFixed(1)}"` +
      ` width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1"` +
      ` style="fill:${v >= 0 ? "var(--up)" : "var(--down)"}" opacity=".85"/>`;
  }
  const histAxis = `<line x1="${X0}" y1="${histMid}" x2="${X1}" y2="${histMid}" style="stroke:var(--axis)" stroke-width="1"/>` +
    `<text x="${X0 - 4}" y="${(histMid + 3.5).toFixed(1)}" text-anchor="end" style="fill:var(--faint)" font-size="9.5">0</text>`;

  /* 5) 六段分别拉线：钉在该段首次出现的收盘，右侧标注段名 + 操作含义 */
  const marks: { seg: number; idx: number; x: number; y: number }[] = [];
  for (let i = 1; i <= 6; i++) {
    const idx = segs.indexOf(i, base);
    if (idx >= 0) marks.push({ seg: i, idx, x: xAt(idx), y: yAt(bars[idx].close) });
  }
  // 右侧固定按 1→6 自上而下排，阅读顺序即理论循环顺序；拉线从各段首次出现点连过去
  const leads = marks.map((m) => {
    const ly = Y0 + 12 + (m.seg - 1) * ((Y1 - Y0 - 26) / 5);
    const tint = SEG_TINTS[m.seg - 1];
    return `<line x1="${(m.x + 3).toFixed(1)}" y1="${m.y.toFixed(1)}" x2="${TX - 6}" y2="${ly.toFixed(1)}"` +
      ` style="stroke:${tint}" stroke-width="1" stroke-dasharray="4 3" opacity=".55"/>` +
      `<circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="3" style="fill:${tint}"/>` +
      `<text x="${TX}" y="${(ly + 3.5).toFixed(1)}">` +
      `<tspan style="fill:${tint}" font-weight="600">${m.seg} · ${SEGFULL[m.seg]}</tspan>` +
      `<tspan dx="7" style="fill:var(--faint)" font-size="10">${SEGACTION[m.seg] || ""}</tspan></text>`;
  }).join("");

  /* 4) 窗口末根所在段：圈最后一根收盘，标签压在点的左侧，避免伸进右侧说明栏 */
  const lx = xAt(n - 1), ly = yAt(bars[n - 1].close);
  const cur = segs[n - 1] || 1;
  const last = `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.6" fill="none"` +
    ` style="stroke:var(--accent)" stroke-width="1.4"/>` +
    `<text x="${(lx - 7).toFixed(1)}" y="${(ly - 7).toFixed(1)}" text-anchor="end"` +
    ` style="fill:var(--accent)" font-size="10.5">当前</text>`;

  return `<svg viewBox="0 0 880 272" role="img"` +
    ` aria-label="六分段理论示意图：真实日 K 走完超跌、反弹、突破、超涨、回踩、跌破六个位置">` +
    `${bands}${channel}${hist}${histAxis}${candles}${fastLine}${slowLine}${leads}${last}</svg>` +
    `<div class="segmap-note">${esc(data.label)} · 日K（前复权）｜K 线 + 短线趋势指标（MA7/MA10 橙/蓝通道柱），` +
    `下方为趋势柱（收盘−慢线）｜六段取最近一个完整循环｜当前段：${SEGFULL[cur]}</div>`;
}

/** 六分段「示意图」小按钮（悬停/点击弹层） */
export function segInfoBtn(): string {
  return `<button type="button" class="seg-info" title="六分段理论示意图（悬停查看，点击固定）"` +
    ` aria-label="六分段理论示意图">${ic("chart-line", 12)}</button>`;
}

/* ── 弹层：全局唯一，事件委托，页面重绘无需重新绑定 ── */
let pop: HTMLDivElement | null = null;
let curTrigger: Element | null = null;
let pinned = false;
let hoverT = 0;
let hideT = 0;

function ensurePop(): HTMLDivElement {
  if (pop) return pop;
  pop = document.createElement("div");
  pop.className = "seg-pop";
  pop.innerHTML = `<div class="seg-pop-h"><b>六分段理论 · 示意图</b>` +
    `<span class="seg-pop-tip">悬停查看 · 点击固定 · Esc 关闭</span>` +
    `<button type="button" class="seg-pop-x" aria-label="关闭">✕</button></div>` +
    `<div class="seg-pop-body"></div>`;
  pop.addEventListener("mouseenter", () => { window.clearTimeout(hideT); });
  pop.addEventListener("mouseleave", () => {
    if (!pinned) hideT = window.setTimeout(hidePop, 160);
  });
  pop.querySelector(".seg-pop-x")!.addEventListener("click", () => { pinned = false; hidePop(); });
  document.body.appendChild(pop);
  return pop;
}

function place(trigger: Element, el: HTMLElement): void {
  const r = trigger.getBoundingClientRect();
  const pr = el.getBoundingClientRect();
  const gap = 8, pad = 10;
  let left = Math.min(r.left, window.innerWidth - pr.width - pad);
  left = Math.max(pad, left);
  let top = r.bottom + gap;
  if (top + pr.height > window.innerHeight - pad) top = Math.max(pad, r.top - pr.height - gap);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function showPop(trigger: Element): void {
  const p = ensurePop();
  curTrigger = trigger;
  (p.querySelector(".seg-pop-body") as HTMLElement).innerHTML = segMapSvg();
  p.style.display = "block";
  place(trigger, p);
}

function hidePop(): void {
  if (pop) pop.style.display = "none";
  if (!pinned) curTrigger = null;
}

/** 全局绑定（幂等）：悬停弹出、点击固定、点外部 / Esc 关闭 */
export function bindSegInfo(): void {
  if (bound) return;
  bound = true;
  document.addEventListener("mouseover", (e) => {
    const t = (e.target as Element | null)?.closest?.(".seg-info");
    if (!t) return;
    window.clearTimeout(hideT);
    hoverT = window.setTimeout(() => { if (!pinned) showPop(t); }, 120);
  });
  document.addEventListener("mouseout", (e) => {
    const t = (e.target as Element | null)?.closest?.(".seg-info");
    if (!t) return;
    window.clearTimeout(hoverT);
    if (!pinned) hideT = window.setTimeout(hidePop, 180);
  });
  // 捕获阶段先拦一次：避免表格行/卡片自身的点击（打开个股）被顺带触发
  document.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    const t = target?.closest?.(".seg-info");
    if (t) {
      e.preventDefault();
      e.stopPropagation();
      window.clearTimeout(hoverT);
      window.clearTimeout(hideT);
      if (pinned && curTrigger === t) { pinned = false; hidePop(); }
      else { pinned = true; showPop(t); }
      return;
    }
    if (pinned && !target?.closest?.(".seg-pop")) { pinned = false; hidePop(); }
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pop && pop.style.display === "block") { pinned = false; hidePop(); }
  });
}
let bound = false;
