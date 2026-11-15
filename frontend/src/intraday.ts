/* 分时图（全景页右上角）：通达信/众赢同款画法。
 * 左轴涨跌幅、右轴价格、昨收虚线、VWAP 均价线、分钟量柱 VOLFS；横轴固定交易时段
 * 09:30-15:00（午休压成一格），不随数据根数漂移。独立 canvas 实现，避免 K 线组件
 * 在分时场景下时间刻度退化成日期、且无法同时给出左右两套坐标轴。 */
import { cssv, fmt, fmtChg, fmtP, fmtVol, priceDigits } from "./fmt";

export interface MinutePoint {
  date: string;
  open: number; high: number; low: number; close: number;
  volume?: number | null; amount?: number | null;
  avg?: number | null; has_avg?: boolean;
}
export interface MinuteSeries {
  symbol?: string;
  date?: string;
  prev_close?: number | null;
  bars: MinutePoint[];
}
export interface IntradayHandle {
  setData: (d: MinuteSeries | null) => void;
  /** 数据源不可用时显示占位文案（不保留上一只股票的旧图） */
  setMessage: (msg: string) => void;
  resize: () => void;
  destroy: () => void;
}

/* 交易时段映射：09:30=0，11:30=120，13:00=150，15:00=270。
 * 午休 90 分钟压成 30 个格（一格），10 个刻度在视觉上等距，同时保留午休断档。 */
const MORNING_END = 120;
const AFTERNOON_START = 150;
const DOMAIN_MAX = 270;
const TICKS_30: { m: number; label: string }[] = [
  { m: 0, label: "09:30" }, { m: 30, label: "10:00" }, { m: 60, label: "10:30" },
  { m: 90, label: "11:00" }, { m: 120, label: "11:30" }, { m: 150, label: "13:00" },
  { m: 180, label: "13:30" }, { m: 210, label: "14:00" }, { m: 240, label: "14:30" },
  { m: 270, label: "15:00" },
];
const TICKS_60 = TICKS_30.filter((t) => t.m === 0 || t.m === 60 || t.m === 120 ||
  t.m === 150 || t.m === 210 || t.m === 270);
const TICKS_120 = TICKS_30.filter((t) => t.m === 0 || t.m === 120 || t.m === 150 || t.m === 270);

/** "HH:MM" / "YYYY-MM-DD HH:MM" → 交易时段分钟轴坐标；非交易时段返回 null */
function sessionMinute(date: string): number | null {
  const m = /(\d{1,2}):(\d{2})/.exec(date.slice(-8));
  if (!m) return null;
  const t = Number(m[1]) * 60 + Number(m[2]);
  if (t >= 570 && t <= 690) return t - 570;                  // 09:30-11:30
  if (t >= 780 && t <= 900) return AFTERNOON_START + t - 780; // 13:00-15:00
  return null;
}

const font = (size: number, weight = 400): string =>
  `${weight} ${size}px -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif`;

interface Pt { m: number; date: string; price: number; avg: number | null; vol: number; chg: number }
interface Box {
  w: number; h: number; plotL: number; plotR: number; plotT: number; plotB: number;
  volT: number; volB: number; leftW: number; rightW: number; plotW: number;
}

function measure(w: number, h: number): Box {
  const leftW = w < 360 ? 48 : 54;
  const rightW = w < 360 ? 50 : 58;
  const plotL = leftW, plotR = w - rightW;
  const xAxisH = 20;
  const volH = Math.round(Math.min(110, Math.max(44, (h - xAxisH) * 0.26)));
  const gap = 16;
  const plotT = 10;
  const plotB = Math.max(plotT + 60, h - xAxisH - volH - gap - 2);
  const volT = plotB + gap;
  const volB = h - xAxisH;
  return { w, h, plotL, plotR, plotT, plotB, volT, volB, leftW, rightW, plotW: plotR - plotL };
}

/** 横轴刻度按可用宽度降档，避免 5 字符时间标签重叠 */
function xTicks(plotW: number): { m: number; label: string }[] {
  if (plotW >= 390) return TICKS_30;
  if (plotW >= 230) return TICKS_60;
  return TICKS_120;
}

/** 纵轴格数随主图高度降档：面板越矮，标签越少，避免百分比数字互相压住 */
function levelCount(mainH: number): number {
  if (mainH >= 190) return 4;
  if (mainH >= 140) return 3;
  if (mainH >= 95) return 2;
  return 1;
}

/** 纵轴百分位步长：盘中最大偏离均分到上下各 levels 格，向上取到 0.01 */
function pctStep(pts: Pt[], prev: number, levels: number): number {
  const maxDev = pts.reduce((m, p) => Math.max(m, Math.abs((p.price - prev) / prev) * 100), 0);
  const raw = maxDev * 1.02 / levels;
  return Math.max(0.02, Math.ceil(raw * 100) / 100);
}

/** 时段刻度：09:30 右移避开左栏日期，其余按网格线居中（15:00 允许压到右栏空白） */
function drawXLabels(
  g: CanvasRenderingContext2D, ticks: { m: number; label: string }[], box: Box, y: number, color: string,
): void {
  g.font = font(9.5); g.fillStyle = color; g.textAlign = "center";
  ticks.forEach((t, i) => {
    if (i === 0) { g.textAlign = "left"; g.fillText(t.label, box.plotL + 2, y); }
    else g.fillText(t.label, box.plotL + (t.m / DOMAIN_MAX) * box.plotW, y);
  });
  g.textAlign = "center";
}

function yyMMdd(d: string): string {
  const parts = d.replace(/\//g, "-").split("-");
  return parts.length >= 3 ? `${parts[0].slice(-2)}/${parts[1]}/${parts[2].slice(0, 2)}` : d;
}

export function createIntraday(el: HTMLElement): IntradayHandle {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  const tip = document.createElement("div");
  tip.className = "kl-tip";
  tip.style.display = "none";
  el.appendChild(canvas);
  el.appendChild(tip);
  const ctx = canvas.getContext("2d")!;

  let series: MinuteSeries | null = null;
  let message = "点击左侧股票查看分时";
  let hoverIdx: number | null = null;
  let cssW = 0;
  let cssH = 0;

  const palette = () => ({
    up: cssv("--up") || "#FF453A",
    down: cssv("--down") || "#32D74B",
    text: cssv("--text") || "#F5F5F7",
    faint: cssv("--faint") || "#717176",
    dim: cssv("--dim") || "#A1A1A6",
    grid: cssv("--border-soft") || "rgba(255,255,255,.06)",
    sep: cssv("--border") || "#2B2B2F",
    neutral: "#757575",
    avg: cssv("--intra-avg") || "#2E6BD6",
    fillTop: cssv("--intra-fill-top") || "rgba(64,110,161,.28)",
    fillBot: cssv("--intra-fill-bottom") || "rgba(64,110,161,.02)",
  });

  /** 数据 → 绘图点；始终以昨收为涨跌基准 */
  const prepare = (d: MinuteSeries): { pts: Pt[]; prev: number } => {
    const bars = d.bars ?? [];
    const prev = d.prev_close ?? bars[0]?.close ?? 0;
    const pts: Pt[] = [];
    for (const b of bars) {
      const m = sessionMinute(b.date);
      if (m == null || b.close == null || !isFinite(b.close)) continue;
      const avg = b.avg != null && b.has_avg !== false && isFinite(b.avg) ? b.avg : null;
      pts.push({
        m, date: b.date, price: b.close, avg, vol: Math.max(0, b.volume ?? 0),
        chg: prev ? b.close - prev : 0,
      });
    }
    return { pts, prev };
  };

  function draw(): void {
    const c = palette();
    const w = cssW, h = cssH;
    if (!w || !h) return;
    const pd = priceDigits(series?.symbol);   // ETF 价格轴保留三位小数
    const box = measure(w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.textBaseline = "middle";

    const empty = () => {
      // 空态也保留时段刻度，避免面板看起来是一块死黑
      ctx.strokeStyle = c.grid; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      for (const t of TICKS_30) {
        const x = box.plotL + (t.m / DOMAIN_MAX) * box.plotW;
        ctx.beginPath(); ctx.moveTo(x, box.plotT); ctx.lineTo(x, box.volB); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = c.sep;
      ctx.beginPath(); ctx.moveTo(box.plotL, box.plotB + 4.5); ctx.lineTo(box.plotR, box.plotB + 4.5); ctx.stroke();
      ctx.fillStyle = c.faint; ctx.font = font(12); ctx.textAlign = "center";
      ctx.fillText(message, (box.plotL + box.plotR) / 2, (box.plotT + box.plotB) / 2);
      drawXLabels(ctx, xTicks(box.plotW), box, box.volB + 13, c.faint);
    };

    if (!series || !series.bars?.length) { empty(); return; }
    const { pts, prev } = prepare(series);
    if (!pts.length || !prev) { empty(); return; }

    const levels = levelCount(box.plotB - box.plotT);
    const step = pctStep(pts, prev, levels);
    const top = step * levels;
    const yOfPct = (p: number): number =>
      box.plotB - ((p + top) / (2 * top)) * (box.plotB - box.plotT);
    const priceOfPct = (p: number): number => prev * (1 + p / 100);
    const xOf = (m: number): number => box.plotL + (m / DOMAIN_MAX) * box.plotW;

    /* ── 网格 + 左右双轴 ── */
    ctx.font = font(10.5);
    ctx.textAlign = "right";
    ctx.setLineDash([2, 3]);
    for (let k = levels; k >= -levels; k--) {
      const p = k * step;
      const y = yOfPct(p);
      ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(box.plotL, y); ctx.lineTo(box.plotR, y); ctx.stroke();
      // 0.00% 行下面单独画（加粗 + 昨收价），这里跳过，避免标签叠两遍
      if (k !== 0) {
        const pctColor = k > 0 ? c.up : c.down;
        ctx.fillStyle = pctColor;
        ctx.fillText(`${(p).toFixed(2)}%`, box.plotL - 5, y);
        ctx.textAlign = "left";
        ctx.fillStyle = pctColor;
        ctx.fillText(priceOfPct(p).toFixed(pd), box.plotR + 6, y);
        ctx.textAlign = "right";
      }
      // 轴刻度短线（只画在绘图区边缘，不侵入数据区）
      ctx.strokeStyle = c.sep;
      ctx.beginPath();
      ctx.moveTo(box.plotL - 3, y); ctx.lineTo(box.plotL, y);
      ctx.moveTo(box.plotR, y); ctx.lineTo(box.plotR + 3, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const ticks = xTicks(box.plotW);
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = c.grid;
    for (const t of ticks) {
      const x = xOf(t.m);
      ctx.beginPath(); ctx.moveTo(x, box.plotT); ctx.lineTo(x, box.volB); ctx.stroke();
    }
    ctx.setLineDash([]);

    /* ── 昨收虚线（0.00% 中轴） ── */
    const y0 = yOfPct(0);
    ctx.strokeStyle = c.avg; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(box.plotL, y0); ctx.lineTo(box.plotR, y0); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = font(10.5, 600); ctx.textAlign = "right"; ctx.fillStyle = c.text;
    ctx.fillText("0.00%", box.plotL - 5, y0);
    ctx.textAlign = "left";
    ctx.fillText(prev.toFixed(pd), box.plotR + 6, y0);

    /* ── 价格面积（蓝渐变，向下跌水一直铺到副图上方） ── */
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.plotL, box.plotT, box.plotW, box.volB - box.plotT);
    ctx.clip();
    const grad = ctx.createLinearGradient(0, box.plotT, 0, box.plotB);
    grad.addColorStop(0, c.fillTop);
    grad.addColorStop(1, c.fillBot);
    ctx.fillStyle = grad;
    ctx.beginPath();
    pts.forEach((p, i) => { const x = xOf(p.m), y = yOfPct((p.price - prev) / prev * 100); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.lineTo(xOf(pts[pts.length - 1].m), box.plotB);
    ctx.lineTo(xOf(pts[0].m), box.plotB);
    ctx.closePath();
    ctx.fill();

    /* ── 均价线（VWAP） ── */
    const avgPts = pts.filter((p) => p.avg != null);
    if (avgPts.length) {
      ctx.strokeStyle = c.avg; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.92;
      ctx.beginPath();
      avgPts.forEach((p, i) => {
        const x = xOf(p.m), y = yOfPct((p.avg! - prev) / prev * 100);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* ── 价格线（白） ── */
    ctx.strokeStyle = c.text; ctx.lineWidth = 1.2;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xOf(p.m), y = yOfPct((p.price - prev) / prev * 100);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.restore();

    /* ── 分钟量柱 VOLFS ── */
    ctx.strokeStyle = c.sep; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(box.plotL, box.plotB + 4.5); ctx.lineTo(box.plotR, box.plotB + 4.5); ctx.stroke();
    const vmax = pts.reduce((m, p) => Math.max(m, p.vol), 0);
    const vH = box.volB - box.volT;
    const barW = Math.max(1, (box.plotW / DOMAIN_MAX) * 0.74);
    if (vmax > 0) {
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!p.vol) continue;
        const prevClose = i > 0 ? pts[i - 1].price : prev;
        const color = p.price > prevClose ? c.up : p.price < prevClose ? c.down : c.neutral;
        const x = xOf(p.m);
        const y = box.volB - (p.vol / vmax) * vH;
        ctx.fillStyle = color;
        ctx.fillRect(x - barW / 2, y, barW, box.volB - y);
      }
    }
    ctx.font = font(9.5);
    const vLevels = vH >= 55 ? 3 : 2;
    ctx.setLineDash([2, 3]); ctx.strokeStyle = c.grid;
    for (let i = 1; i <= vLevels; i++) {
      const y = box.volB - (vH * i) / vLevels;
      ctx.beginPath(); ctx.moveTo(box.plotL, y); ctx.lineTo(box.plotR, y); ctx.stroke();
      const label = fmtVol((vmax * i) / vLevels);
      ctx.fillStyle = c.faint; ctx.textAlign = "right";
      ctx.fillText(label, box.plotL - 5, y);
      ctx.textAlign = "left";
      ctx.fillText(label, box.plotR + 5, y);
    }
    ctx.setLineDash([]);
    ctx.fillStyle = c.faint; ctx.textAlign = "left"; ctx.font = font(9.5);
    ctx.fillText("VOLFS", box.plotL + 4, box.volT + 9);

    /* ── 横轴：日期 + 时段刻度 ── */
    ctx.strokeStyle = c.sep; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(box.plotL, box.volB + 0.5); ctx.lineTo(box.plotR, box.volB + 0.5); ctx.stroke();
    const dateTxt = yyMMdd(series.date || pts[0].date.slice(0, 10));
    ctx.font = font(9.5); ctx.fillStyle = c.faint; ctx.textAlign = "left";
    ctx.fillText(dateTxt, 3, box.volB + 13);
    drawXLabels(ctx, ticks, box, box.volB + 13, c.faint);

    /* ── 十字光标 ── */
    if (hoverIdx != null && pts[hoverIdx]) {
      const p = pts[hoverIdx];
      const x = xOf(p.m);
      const y = yOfPct((p.price - prev) / prev * 100);
      ctx.setLineDash([4, 4]); ctx.strokeStyle = c.faint; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, box.plotT); ctx.lineTo(x, box.volB); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(box.plotL, y); ctx.lineTo(box.plotR, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = c.text;
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  /** 指针 → 最近分钟点（只在绘图区内响应） */
  function hitTest(clientX: number, clientY: number): { idx: number; px: number; py: number } | null {
    if (!series?.bars?.length) return null;
    const { pts, prev } = prepare(series);
    if (!pts.length || !prev) return null;
    const rect = el.getBoundingClientRect();
    const box = measure(cssW, cssH);
    const x = clientX - rect.left, y = clientY - rect.top;
    if (x < box.plotL || x > box.plotR || y < box.plotT || y > box.volB) return null;
    const m = ((x - box.plotL) / box.plotW) * DOMAIN_MAX;
    let idx = 0, best = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(p.m - m); if (d < best) { best = d; idx = i; } });
    const levels = levelCount(box.plotB - box.plotT);
    const step = pctStep(pts, prev, levels), top = step * levels;
    const px = box.plotL + (pts[idx].m / DOMAIN_MAX) * box.plotW;
    const py = box.plotB - ((((pts[idx].price - prev) / prev * 100) + top) / (2 * top)) * (box.plotB - box.plotT);
    return { idx, px, py };
  }

  function showTip(idx: number, px: number, py: number): void {
    if (!series) return;
    const { pts, prev } = prepare(series);
    const p = pts[idx];
    if (!p) return;
    const pct = prev ? (p.price - prev) / prev * 100 : 0;
    const cls = pct > 0 ? "up" : pct < 0 ? "down" : "";
    tip.innerHTML =
      `<div class="t num">${p.date.slice(5, 10)} ${p.date.slice(11, 16)} · 分时</div>` +
      `<div class="grp">` +
      `<span>价<b class="${cls}">${fmtP(p.price, series?.symbol)}</b></span>` +
      `<span>涨幅<b class="${cls}">${fmtChg(pct)}%</b></span>` +
      `<span>均价<b>${p.avg == null ? "—" : fmtP(p.avg, series?.symbol)}</b></span>` +
      `<span>量<b>${fmtVol(p.vol)}手</b></span>` +
      `</div>`;
    tip.style.display = "block";
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const left = px + 14 + tw > cssW ? px - tw - 14 : px + 14;
    const top = py + 14 + th > cssH ? py - th - 14 : py + 14;
    tip.style.left = Math.max(2, left) + "px";
    tip.style.top = Math.max(2, top) + "px";
  }

  const onMove = (e: PointerEvent): void => {
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) {
      if (hoverIdx != null) { hoverIdx = null; draw(); }
      tip.style.display = "none";
      return;
    }
    hoverIdx = hit.idx;
    draw();
    showTip(hit.idx, hit.px, hit.py);
  };
  const onLeave = (): void => {
    if (hoverIdx == null) return;
    hoverIdx = null;
    tip.style.display = "none";
    draw();
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerleave", onLeave);

  function resize(): void {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    cssW = w; cssH = h;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  const ro = new ResizeObserver(() => resize());
  ro.observe(el);
  const mo = new MutationObserver(() => draw());
  mo.observe(document.documentElement, {
    attributes: true, attributeFilter: ["data-theme", "data-dir", "data-accent"],
  });

  return {
    setData(d: MinuteSeries | null) {
      series = d;
      hoverIdx = null;
      tip.style.display = "none";
      message = d ? "" : "分时数据暂不可用";
      draw();
    },
    setMessage(msg: string) {
      series = null;
      hoverIdx = null;
      tip.style.display = "none";
      message = msg;
      draw();
    },
    resize,
    destroy() {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      canvas.remove();
      tip.remove();
    },
  };
}
