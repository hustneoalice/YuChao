/** 两条可调周期的成交量算术均线；样本不足时不画线。 */
export function volumeAverageSeries<T extends { volume?: number }>(list: T[], periods: number[]) {
  const sums = [0, 0];
  return list.map((bar, i) => {
    const volume = bar.volume ?? 0;
    const averages = periods.map((period, j) => {
      sums[j] += volume;
      if (i >= period) sums[j] -= list[i - period].volume ?? 0;
      return i >= period - 1 ? sums[j] / period : null;
    });
    return { ...bar, volume, ma1: averages[0], ma2: averages[1] };
  });
}
