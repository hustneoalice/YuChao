import test from 'node:test';
import assert from 'node:assert/strict';
import { volumeAverageSeries } from '../src/volume-average.ts';
test('40-period average requires 40 bars and uses a rolling window', () => {
  const bars = Array.from({length: 42}, (_, i) => ({volume: i + 1}));
  const result = volumeAverageSeries(bars, [40, 40]);
  assert.equal(result[38].ma1, null);
  assert.equal(result[39].ma1, 20.5);
  assert.equal(result[40].ma1, 21.5);
  assert.equal(result[41].ma1, result[41].ma2);
});
test('two periods calculate independently without changing volume bars', () => {
  const bars = [2, 4, 6, 8].map(volume => ({volume, open: 1, close: 2}));
  const copy = structuredClone(bars);
  const result = volumeAverageSeries(bars, [2, 3]);
  assert.equal(result[2].ma1, 5);
  assert.equal(result[2].ma2, 4);
  assert.equal(result[3].volume, 8);
  assert.deepEqual(bars, copy);
});
