/** 众赢 4.1.14 sys_index1.xml「主力成本」公式移植，尚未与原软件逐点核对。
 * ZJ:=(O+H+L+C)/4；YZ:=IF(BARSCOUNT(C)>60,VOL/SUM(VOL,60),VOL/SUM(VOL,BARSCOUNT(C)))。
 * 超短期:DMA(ZJ,YZ/0.125)；短期:DMA(ZJ,YZ/0.25)；中期:DMA(ZJ,YZ/0.50)；长期:DMA(ZJ,YZ)。
 * 四条线可在「主力成本」齿轮里逐条开关（见 main-cost-settings.ts）。
 * 原软件标注「仅大盘」，此处个股也可计算以便对照；个股量能口径未必等同原版。
 * DMA 首值取首根 ZJ；量总和为 0 时沿用上一值，无有效值则留空。
 */
export type MainCostPoint = {
  ultra: number | null;
  short: number | null;
  mid: number | null;
  long: number | null;
};

/** 四条输出的 DMA 权重，顺序与图上/设置面板一致 */
export const MAIN_COST_WEIGHTS = [0.125, 0.25, 0.5, 1] as const;

export function mainCostSeries(
  bars: readonly { open: number; high: number; low: number; close: number; volume?: number | null }[],
): MainCostPoint[] {
  let sumAll = 0, sum60 = 0;
  const costs = [0, 0, 0, 0];
  let started = false;
  return bars.map((bar, i) => {
    const vol = bar.volume != null && Number.isFinite(bar.volume) ? bar.volume : 0;
    sumAll += vol;
    sum60 += vol;
    if (i >= 60) sum60 -= bars[i - 60].volume != null && Number.isFinite(bars[i - 60].volume) ? bars[i - 60].volume! : 0;
    const total = i + 1 > 60 ? sum60 : sumAll;
    const zj = (bar.open + bar.high + bar.low + bar.close) / 4;
    if (vol <= 0 || total <= 0) {
      if (!started) return { ultra: null, short: null, mid: null, long: null };
      return { ultra: costs[0], short: costs[1], mid: costs[2], long: costs[3] };
    }
    const yz = vol / total;
    if (!started) {
      costs[0] = costs[1] = costs[2] = costs[3] = zj;
      started = true;
    }
    MAIN_COST_WEIGHTS.forEach((weight, k) => {
      const alpha = yz / weight;
      costs[k] = alpha * zj + (1 - alpha) * costs[k];
    });
    return { ultra: costs[0], short: costs[1], mid: costs[2], long: costs[3] };
  });
}
