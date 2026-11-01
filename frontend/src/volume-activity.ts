/** 众赢 4.1.14 class.special.index.js 的 i_lnhy 公式；未与原软件逐点核对。 */
type PriceBar = { open: number; high: number; low: number; close: number; volume?: number | null };
export type VolumeActivity = { short: number | null; trend: number | null; signal: 'TL' | 'PP' | 'DL' | null };

/** volume 以股计，turnover_rate 以百分数计；由最近有效日反推固定股本（四舍五入误差）。 */
export function estimateFloatShares(bars: readonly {volume?: number | null; turnover_rate?: number | null}[]): number | null {
  for (let i = bars.length - 1; i >= 0; i--) {
    const {volume, turnover_rate: rate} = bars[i];
    if (volume != null && Number.isFinite(volume) && volume > 0 && rate != null && Number.isFinite(rate) && rate > 0)
      return volume * 100 / rate;
  }
  return null;
}

export function volumeActivitySeries(input: readonly PriceBar[], floatShares: number | null): VolumeActivity[] {
  const empty = (): VolumeActivity => ({short: null, trend: null, signal: null});
  if (floatShares == null || !Number.isFinite(floatShares) || floatShares <= 0) return input.map(empty);
  const bars = input.map(b => ({...b, open: +b.open.toFixed(2), high: +b.high.toFixed(2), low: +b.low.toFixed(2), close: +b.close.toFixed(2)}));
  const volume = bars.map(b => b.volume != null && Number.isFinite(b.volume) && b.volume >= 0 ? b.volume : null);
  const hsl = volume.map(v => v == null ? null : 100 * v / floatShares);
  const a = bars.map(b => (3 * b.close + b.low + b.open + b.high) / 6);
  // 原式末项为 REF(A,20)，跳过19，保留该行为。
  const b = a.map((v,i) => {
    let sum = 20 * v;
    for(let j=1;j<=18;j++) sum += (20-j) * (a[i-j] ?? 0);
    return (sum + (a[i-20] ?? 0)) / 210;
  });
  const avg = (arr: readonly (number | null)[], i: number, n: number): number | null => {
    if (i < n-1) return 0;
    let sum=0;
    for(let j=i-n+1;j<=i;j++){if(arr[j]==null) return null; sum += arr[j]!;}
    return sum/n;
  };
  const signed = hsl.map((v,i) => v == null ? null : bars[i].close === (bars[i-1]?.close ?? 0) ? 0 : (bars[i].close > (bars[i-1]?.close ?? 0) ? v : -v)*10000);
  const obv = signed.map((_,i) => {
    let sum=0;
    for(let j=Math.max(0,i-29);j<=i;j++){if(signed[j]==null) return null; sum+=signed[j]!;}
    return sum;
  });
  return bars.map((bar,i) => {
    if(i<60) return empty();
    const m5=avg(hsl,i,5), m60=avg(hsl,i,60), trend=avg(obv,i,10);
    const short=m5==null || m60==null ? null : +( (m5-m60)*8*10000 ).toFixed(2);
    const window = bars.slice(i-59,i+1);
    const vols = volume.slice(i-59,i+1);
    const v=volume[i];
    const tl=v!=null && vols.every(x=>x!=null) && v===Math.max(...vols as number[]) && bar.close > window.reduce((s,x)=>s+x.close,0)/60;
    const pp=v!=null && bar.close > Math.max(...bars.slice(Math.max(0,i-120),i).map(x=>x.high)) && bar.close > bars[i-1].close*1.05 && bar.close>bar.open && bar.close>window.reduce((s,x)=>s+x.high,0)/60 && b[i]>avg(b,i,10)! && bar.low>b[i] && bar.low>avg(b,i,10)!;
    const lowVol=volume.slice(Math.max(0,i-119),i+1);
    const dl=i>=120 && v!=null && lowVol.every(x=>x!=null) && v===Math.min(...lowVol as number[]) && bar.high!==bar.low && !pp;
    const signal=short==null || trend==null ? null : pp ? 'PP' : tl ? 'TL' : dl ? 'DL' : null;
    return {short, trend: trend==null ? null : +trend.toFixed(2), signal};
  });
}
