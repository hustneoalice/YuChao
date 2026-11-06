/* 钱眼掘金（众赢云指标 i_qyjj_c）近似移植
 *  · 原公式在服务端，客户端缓存里只有 money/mine 图标坐标；本文件不复刻公式
 *  · 近似规则：收盘价 ZigZag 6% 波段反转，信号落在拐点后一根（对齐原模型 1 日滞后）
 *  · money = 阶段低点（钱袋，画在最低价下方）；mine = 阶段高点（地雷，画在最高价上方）
 *  · 与原模型 002472 验证：信号条数一致，点位仅部分重合（F1≈0.20）
 */
import type { Bar } from "./api";

export type QyjjSignal = "money" | "mine";
export interface QyjjRow {
  signal: QyjjSignal | null;
  /** 图标锚点价：money=当日最低价，mine=当日最高价 */
  anchor: number | null;
  close: number;
}

/** ZigZag 反转幅度（收盘价口径） */
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

/** 钱袋：金色袋身 + 深色袋口 + ¥ */
function moneyBag(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const r = 9;
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = "round";
  ctx.lineWidth = 1.2;
  // 袋身
  ctx.beginPath();
  ctx.moveTo(-r * 0.52, -r * 0.28);
  ctx.quadraticCurveTo(-r * 0.95, r * 0.62, -r * 0.34, r * 0.94);
  ctx.quadraticCurveTo(0, r * 1.12, r * 0.34, r * 0.94);
  ctx.quadraticCurveTo(r * 0.95, r * 0.62, r * 0.52, -r * 0.28);
  ctx.closePath();
  ctx.fillStyle = "#F7C348";
  ctx.fill();
  ctx.strokeStyle = "#8A5A12";
  ctx.stroke();
  // 袋口
  ctx.beginPath();
  ctx.moveTo(-r * 0.56, -r * 0.44);
  ctx.lineTo(r * 0.56, -r * 0.44);
  ctx.lineTo(r * 0.4, -r * 0.78);
  ctx.lineTo(-r * 0.4, -r * 0.78);
  ctx.closePath();
  ctx.fillStyle = "#E0A62A";
  ctx.fill();
  ctx.strokeStyle = "#8A5A12";
  ctx.stroke();
  // ¥
  ctx.fillStyle = "#7A4A08";
  ctx.font = "bold 9px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("¥", 0, r * 0.42);
  ctx.restore();
}

/** 地雷：橙红尖刺 + 红色雷体 + 深色雷心（深色背景上要能看清，不用纯黑） */
function mineBall(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const r = 6.4;
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = 1.1;
  // 8 根尖刺
  ctx.fillStyle = "#FF7A45";
  ctx.strokeStyle = "#8C1D12";
  for (let k = 0; k < 8; k++) {
    const a = (Math.PI / 4) * k;
    const cx = Math.cos(a), cy = Math.sin(a);
    const px = -cy, py = cx;                // 法向
    ctx.beginPath();
    ctx.moveTo(cx * r * 0.92 + px * 1.9, cy * r * 0.92 + py * 1.9);
    ctx.lineTo(cx * (r + 4.4) + px * 1.5, cy * (r + 4.4) + py * 1.5);
    ctx.lineTo(cx * r * 0.92 - px * 1.9, cy * r * 0.92 - py * 1.9);
    ctx.closePath();
    ctx.fill();
  }
  // 雷体
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = "#F44336";
  ctx.fill();
  ctx.strokeStyle = "#8C1D12";
  ctx.stroke();
  // 高光
  ctx.beginPath();
  ctx.arc(-r * 0.3, -r * 0.32, r * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,.55)";
  ctx.fill();
  // 雷心
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = "#3B0A06";
  ctx.fill();
  ctx.restore();
}

export function drawQyjjIcon(
  ctx: CanvasRenderingContext2D,
  kind: QyjjSignal,
  x: number,
  y: number,
): void {
  if (kind === "money") moneyBag(ctx, x, y);
  else mineBall(ctx, x, y);
}
