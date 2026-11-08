/* 阶段反转信号（原「钱眼掘金」近似实现，仅保留自家拐点口径）
 *  · 原公式在服务端，客户端缓存里只有低点/高点反转的图标坐标；本文件不复刻公式
 *  · 近似规则：收盘价 ZigZag 6% 波段反转，信号落在拐点后一根（对齐原模型 1 日滞后）
 *  · 低点反转 = 阶段低点确认后拐头向上（画在最低价下方）；高点反转 = 阶段高点确认后
 *    拐头向下（画在最高价上方）。图标为自绘「折返箭头」，不使用第三方钱袋/地雷形象。
 */
import type { Bar } from "./api";

export type QyjjSignal = "money" | "mine";   // 键名沿用接口字段 money/mine，展示层统一叫低点/高点反转
export interface QyjjRow {
  signal: QyjjSignal | null;
  /** 图标锚点价：低点反转=当日最低价，高点反转=当日最高价 */
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

/** 阶段反转标记：折返箭头（低点=触底拐头向上，高点=冲高拐头向下）。
 *  两段折线 + 箭头，深色描边保证在任意 K 线配色/底色上都可读；不复制第三方的钱袋、地雷形象。 */
function reversalMark(ctx: CanvasRenderingContext2D, x: number, y: number, up: boolean): void {
  const r = 7.6;
  const color = up ? "#EF5350" : "#519C2C";
  const tipX = r * 0.84, tipY = up ? -r * 0.42 : r * 0.42;
  const pts: [number, number][] = up
    ? [[-r, -r * 0.52], [0, r * 0.82], [tipX, tipY]]
    : [[-r, r * 0.52], [0, -r * 0.82], [tipX, tipY]];
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // 折返轨迹：先画深色底衬，再叠本色，避免浅色 K 线上糊成一片
  for (const [w, c] of [[3.6, "rgba(8,12,18,.7)"], [1.8, color]] as [number, string][]) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[1][0], pts[1][1]);
    ctx.lineTo(pts[2][0], pts[2][1]);
    ctx.lineWidth = w;
    ctx.strokeStyle = c;
    ctx.stroke();
  }
  // 箭头：沿末段方向指出去
  const ang = Math.atan2(pts[2][1] - pts[1][1], pts[2][0] - pts[1][0]);
  ctx.translate(tipX, tipY);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(3.4, 0);
  ctx.lineTo(-3.2, -3.1);
  ctx.lineTo(-3.2, 3.1);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(8,12,18,.7)";
  ctx.lineWidth = 1.2;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export function drawReversalMark(
  ctx: CanvasRenderingContext2D,
  kind: QyjjSignal,
  x: number,
  y: number,
): void {
  reversalMark(ctx, x, y, kind === "money");
}
