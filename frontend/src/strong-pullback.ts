/** 用户约定候选规则，并非已还原的众赢原公式。
 * 次日量比(50%,200%)；后续量比>50%；<=50%、破涨停日最低价、缺量结束组；新涨停重新起组。
 * 仅起点后第2～8个交易日命中，第9日结束组；命中要求C>=MA45。涨停沿用固定9.5%且H=C口径。
 */
export type PullbackPoint = {anchor: number | null; protection: number | null; eye: number | null; hit: boolean; low: number};
export function strongPullbackSeries(bars: readonly {open: number; high: number; low: number; close: number; volume?: number | null}[]): PullbackPoint[] {
  let anchor: number | null = null, sum=0;
  return bars.map((bar,i) => {
    sum+=bar.close;if(i>=45)sum-=bars[i-45].close;
    const volume=bar.volume;
    const valid=volume!=null && Number.isFinite(volume) && volume>0;
    const zt=i>0 && bar.close>bars[i-1].close*1.095 && bar.close===bar.high;
    if(zt) anchor=valid ? i : null;
    else if(anchor!=null){
      const ratio=valid ? volume!/bars[anchor].volume! : 0;
      if(i-anchor>8 || !valid || ratio<=0.5 || (i===anchor+1 && ratio>=2) || bar.low<bars[anchor].low)anchor=null;
    }
    const protection=anchor==null ? null : bars[anchor].low;
    const eye=anchor==null ? null : protection!-Math.max((bars[anchor].high-protection!)*0.6,protection!*0.04);
    return {anchor,protection,eye,hit:anchor!=null && i>=anchor+2 && i>=44 && bar.close>=sum/45,low:bar.low};
  });
}
