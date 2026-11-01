import test from 'node:test';
import assert from 'node:assert/strict';
import { trendHistogramSeries } from '../src/trend-histogram.ts';
const bars = Array.from({length:160},(_,i)=>({high:12+i/10,low:10+i/10,close:11+i/10}));
test('constant prices have zero trend after 15-value warmup',()=>{
 const out=trendHistogramSeries(bars.map(()=>({high:12,low:10,close:11})));
 assert.equal(out[13].base,null); assert.equal(out[14].base,0); assert.equal(out[100].short,0);
});
test('rising and falling series are symmetric',()=>{
 const up=trendHistogramSeries(bars), down=trendHistogramSeries(bars.map(b=>({high:100-b.low,low:100-b.high,close:100-b.close})));
 assert.ok(up[159].base>0); assert.ok(down[159].base<0);
 assert.ok(Math.abs(up[159].short+down[159].short)<1e-9);
});
test('scale invariant, immutable and stable when appending future data',()=>{
 const copy=structuredClone(bars), a=trendHistogramSeries(bars), scaled=trendHistogramSeries(bars.map(b=>({high:b.high*10,low:b.low*10,close:b.close*10})));
 assert.deepEqual(a.slice(0,100),trendHistogramSeries(bars.slice(0,100)));
 assert.deepEqual(bars,copy);
 assert.ok(Math.abs(a[159].short-scaled[159].short)<1e-9);
});
test('zero volatility gives null instead of infinity',()=>{
 assert.deepEqual(trendHistogramSeries([]),[]);
 assert.ok(trendHistogramSeries(bars.map(()=>({high:10,low:10,close:10}))).every(v=>v.short===null&&v.base===null));
});
test('sixth sample uses dynamic EMA periods with hand-calculated output',()=>{
 const b=Array.from({length:6},(_,i)=>({high:i+2,low:i,close:i+1}));
 assert.ok(Math.abs(trendHistogramSeries(b)[5].short-625/378)<1e-12);
});
