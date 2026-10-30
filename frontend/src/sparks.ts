/* 行内走势 sparkline（自选页表格 / 行情页自选卡共用）：
   /market/sparks 批量当日分时（后端降采样 ≈40 点 + 昨收），会话级缓存 45s；
   绘制按 svg width/height 自适应，昨收虚线基准，涨红跌绿（var(--up/--down)）。 */
import { marketApi } from "./api";

const cache = new Map<string, { points: number[]; prev: number | null; at: number }>();
let busy = false;

/** 行内占位 svg（paintSparksIn 按 data-c 就地回填） */
export function sparkSvg(symbol: string, w: number, h: number): string {
  return `<svg class="spark" data-c="${symbol}" width="${w}" height="${h}"></svg>`;
}

/** 就地回填缓存命中的曲线（不动已有内容，避免重绘闪烁） */
export function paintSparksIn(root: ParentNode): void {
  root.querySelectorAll<SVGSVGElement>("svg.spark[data-c]").forEach((svg) => {
    const hit = cache.get(svg.dataset.c!);
    if (!hit || svg.childNodes.length) return;
    const pts = hit.points;
    if (pts.length < 2) return;
    const W = Number(svg.getAttribute("width")) || 72;
    const H = Number(svg.getAttribute("height")) || 22;
    const pad = 2;
    // 统一昨收基准轴（同花顺自选同款）：各股以昨收为对称中心归一化，
    // 昨收虚线恒在垂直居中——曲线「起点」（开盘相对昨收）在各行可比，不再高低错落
    const prev = hit.prev;
    let lo: number, hi: number;
    if (prev != null) {
      const amp = Math.max(...pts.map((v) => Math.abs(v - prev)), prev * 0.002);
      lo = prev - amp;
      hi = prev + amp;
    } else {
      lo = Math.min(...pts);
      hi = Math.max(...pts);
    }
    const span = hi - lo || 1;
    const x = (i: number) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
    const y = (v: number) => pad + (1 - (v - lo) / span) * (H - 2 * pad);
    const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const up = pts[pts.length - 1] >= (prev ?? pts[0]);
    const color = up ? "var(--up)" : "var(--down)";
    const base = prev != null && prev >= lo && prev <= hi ?
      `<line x1="${pad}" x2="${W - pad}" y1="${y(prev).toFixed(1)}" y2="${y(prev).toFixed(1)}" stroke="var(--faint)" stroke-width=".5" stroke-dasharray="2 2" opacity=".55"/>` : "";
    svg.innerHTML = base + `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round"/>`;
  });
}

/** 拉取 root 内缺失 / 过期（>45s）的曲线并绘制；busy 期间只回填缓存 */
export async function refreshSparksIn(root: ParentNode): Promise<void> {
  const rows = [...root.querySelectorAll<SVGSVGElement>("svg.spark[data-c]")];
  if (!rows.length) return;
  const need = rows.filter((s) => {
    const h = cache.get(s.dataset.c!);
    return !h || Date.now() - h.at > 45_000;
  }).map((s) => s.dataset.c!);
  if (need.length && !busy) {
    busy = true;
    try {
      // 后端单次 ≤50 只：超出部分下轮再补
      const r = await marketApi.sparks(need.slice(0, 50));
      for (const it of r.items)
        cache.set(it.symbol, { points: it.points, prev: it.prev_close, at: Date.now() });
    } catch { /* 静默：保留旧曲线 */ } finally {
      busy = false;
    }
  }
  paintSparksIn(root);
}
