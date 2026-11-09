/* 阶段拐点信号（原「钱眼掘金」近似实现，仅保留自家拐点口径）
 *  · 原公式在服务端，客户端缓存里只有低点/高点拐头的图标坐标；本文件不复刻公式
 *  · 近似规则：收盘价 ZigZag 6% 波段转折，信号落在拐点后一根（对齐原模型 1 日滞后）
 *  · 低点拐头 = 阶段低点确认后拐头向上（画在最低价下方）；高点拐头 = 阶段高点确认后
 *    拐头向下（画在最高价上方）。图标为自绘方向箭头，不出现文字。
 */
import type { Bar } from "./api";

export type QyjjSignal = "money" | "mine";   // 键名沿用接口字段 money/mine，展示层统一叫低点/高点拐头
export interface QyjjRow {
  signal: QyjjSignal | null;
  /** 图标锚点价：低点拐头=当日最低价，高点拐头=当日最高价 */
  anchor: number | null;
  close: number;
}

/** ZigZag 转折幅度（收盘价口径） */
const PCT = 0.06;
/** 样本太少时不做波段识别 */
const MIN_BARS = 30;

export function qyjjSeries(rows: readonly Pick<Bar, "close" | "high" | "low">[]): QyjjRow[] {
  const out: QyjjRow[] = rows.map((b) => ({ signal: null, anchor: null, close: b.close }));
  if (rows.length < MIN_BARS) return out;
  const close = rows.map((b) => b.close);
  let dir: -1 | 1 = -1;             // 先找底部，再找顶部，严格交替
  let ext = 0;                      // 当前极值所在下标
  let extVal = close[0];
  for (let i = 1; i < rows.length; i++) {
    const c = close[i];
    if (dir === -1) {
      if (c < extVal) {
        ext = i;
        extVal = c;
      } else if (c >= extVal * (1 + PCT)) {
        const at = ext + 1;         // 原模型信号落在拐点后一根
        if (at < rows.length && out[at].signal == null) {
          out[at] = { signal: "money", anchor: rows[at].low, close: rows[at].close };
        }
        dir = 1;
        ext = i;
        extVal = c;
      }
    } else if (c > extVal) {
      ext = i;
      extVal = c;
    } else if (c <= extVal * (1 - PCT)) {
      const at = ext + 1;
      if (at < rows.length && out[at].signal == null) {
        out[at] = { signal: "mine", anchor: rows[at].high, close: rows[at].close };
      }
      dir = -1;
      ext = i;
      extVal = c;
    }
  }
  return out;
}

/** 阶段拐点标记：纯图形，不出现文字。低点拐头画在最低价下方（红），
 *  高点拐头画在最高价上方（绿）。五种样式可选（设置里切换）：
 *  · badge 胶囊箭头（默认，识别度最高）
 *  · tri   实心三角（贴价，不遮 K 线）
 *  · dot   圆点（最轻，信号密集时清爽）
 *  · hook  钩形（低点兜底 U / 高点盖顶 ∩，呼应「拐头」）
 *  · flag  小旗（插旗标记，方向最直观）
 *  整体夹在本图范围内，靠边/贴顶不会被裁掉；标记间距不足时自动错行。 */
export type QyjjStyle = "badge" | "tri" | "dot" | "hook" | "flag";

/** 每种样式的绘制尺寸与贴价间距（错行避让也按这套 footprint 计算） */
const MARK_SIZE: Record<QyjjStyle, { w: number; h: number; gap: number }> = {
  badge: { w: 19, h: 16, gap: 9 },
  tri: { w: 13, h: 11, gap: 7 },
  dot: { w: 9, h: 9, gap: 6 },
  hook: { w: 13, h: 12, gap: 6 },
  flag: { w: 13, h: 15, gap: 6 },
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

export function drawReversalMark(
  ctx: CanvasRenderingContext2D,
  kind: QyjjSignal,
  x: number,
  y: number,
  boundsW: number,
  boundsH: number,
  placed: { x1: number; x2: number; y1: number; y2: number }[] = [],
  style: QyjjStyle = "badge",
): void {
  const up = kind === "money";                       // 低点拐头 = 向上
  const color = up ? "#EF5350" : "#519C2C";
  const { w, h, gap } = MARK_SIZE[style] ?? MARK_SIZE.badge;
  const left = Math.min(Math.max(x - w / 2, 1), Math.max(1, boundsW - w - 1));
  const baseTop = up ? y + gap : y - gap - h;
  // 相邻信号贴太近会叠在一起：先试原位，再向外/向内错行，取第一个不与已放标记重叠的位置
  let top = -1;
  for (const step of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]) {
    const t = up ? baseTop + step * (h + 4) : baseTop - step * (h + 4);
    if (t < 1 || t + h > boundsH - 1) continue;
    const clash = placed.some((r) =>
      left < r.x2 + 2 && left + w + 2 > r.x1 && t < r.y2 + 2 && t + h + 2 > r.y1);
    if (clash) continue;
    top = t;
    placed.push({ x1: left, x2: left + w, y1: t, y2: t + h });
    break;
  }
  // 贴边/挤满时退化为夹取原位：标注意义优先，允许与邻近标记轻微重叠
  if (top < 0) top = Math.min(Math.max(baseTop, 1), Math.max(1, boundsH - h - 1));

  const cx = left + w / 2;
  const cy = top + h / 2;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (style === "tri") {
    // 实心三角：低点在下、尖朝上；高点在上、尖朝下
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, up ? top + 1 : top + h - 1);
    ctx.lineTo(left + 1, up ? top + h - 1 : top + 1);
    ctx.lineTo(left + w - 1, up ? top + h - 1 : top + 1);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(8,12,18,.5)";
    ctx.stroke();
  } else if (style === "dot") {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, w / 2 - 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(8,12,18,.5)";
    ctx.stroke();
  } else if (style === "hook") {
    // 低点兜底 U（开口向上）/ 高点盖顶 ∩（开口向下），半圆弧勾住拐点
    const r = h / 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    if (up) ctx.arc(cx, top + r, r, 0, Math.PI);              // 下半弧：U
    else ctx.arc(cx, top + r, r, Math.PI, Math.PI * 2);       // 上半弧：∩
    ctx.stroke();
  } else if (style === "flag") {
    // 小旗：竖杆贴价一端挂三角旗，低点旗在下方、高点旗在上方
    const px = left + 3;
    const poleTop = top + 1;
    const poleBottom = top + h - 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, poleTop);
    ctx.lineTo(px, poleBottom);
    ctx.stroke();
    const flagH = 8, flagW = 7;
    const flagTop = up ? poleTop : poleBottom - flagH;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(px, flagTop);
    ctx.lineTo(px + flagW, flagTop + flagH / 2);
    ctx.lineTo(px, flagTop + flagH);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = "rgba(8,12,18,.45)";
    ctx.stroke();
  } else {
    // badge：纯色底衬 + 深色细描边 + 白色矢量箭头
    ctx.fillStyle = color;
    roundRect(ctx, left, top, w, h, 5);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(8,12,18,.55)";
    ctx.stroke();
    const shaft = 4.4, head = 3.4;
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (up) {
      ctx.moveTo(cx, cy + shaft);
      ctx.lineTo(cx, cy - shaft);
      ctx.moveTo(cx - head, cy - shaft + head);
      ctx.lineTo(cx, cy - shaft);
      ctx.lineTo(cx + head, cy - shaft + head);
    } else {
      ctx.moveTo(cx, cy - shaft);
      ctx.lineTo(cx, cy + shaft);
      ctx.moveTo(cx - head, cy + shaft - head);
      ctx.lineTo(cx, cy + shaft);
      ctx.lineTo(cx + head, cy + shaft - head);
    }
    ctx.stroke();
  }
  ctx.restore();
}
