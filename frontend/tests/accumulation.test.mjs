import test from 'node:test';
import assert from 'node:assert/strict';
import { accumulationSeries } from '../src/accumulation.ts';
const bars = lows => lows.map(low => ({low, close: low + 1}));
test('hand calculated new low then EMA decay', () => {
  const out = accumulationSeries(bars([10,11,9,10]));
  assert.deepEqual(out.slice(0,2), [null,0]);
  assert.ok(Math.abs(out[2] - 1875/618) < 1e-10);
  assert.ok(Math.abs(out[3] - 937.5/618) < 1e-10);
});
test('flat and falling prices never yield infinity', () => {
  assert.deepEqual(accumulationSeries([]), []);
  for (const lows of [[10,10,10], [10,9,8]]) assert.deepEqual(accumulationSeries(bars(lows)), [null,null,null]);
});
test('future bars do not change history or mutate inputs', () => {
  const input = bars(Array.from({length:120}, (_,i) => 10 + Math.sin(i)));
  const before = structuredClone(input);
  assert.deepEqual(accumulationSeries(input).slice(0,80), accumulationSeries(input.slice(0,80)));
  assert.deepEqual(input,before);
});
