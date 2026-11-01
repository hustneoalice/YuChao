import test from 'node:test';
import assert from 'node:assert/strict';
import { volumeActivitySeries, estimateFloatShares } from '../src/volume-activity.ts';
const make = n => Array.from({length:n},(_,i)=>({open:10,high:11,low:9,close:10,volume:1000000}));
test('constant volume gives zero short activity and flat-price trend after 60 bars',()=>{
 const out=volumeActivitySeries(make(90),100000000);
 assert.equal(out[59].short,null); assert.equal(out[60].short,0); assert.equal(out[60].trend,0);
});
test('volume spike has hand-calculated short activity and TL, then new low volume DL',()=>{
 const bars=make(125); bars[60]={open:10,low:10,high:12,close:11,volume:2000000}; bars[120].volume=100;
 const out=volumeActivitySeries(bars,100000000);
 assert.ok(Math.abs(out[60].short-14666.67)<0.001); assert.equal(out[60].signal,'TL'); assert.equal(out[120].signal,'DL');
});
test('missing capital or volume does not fabricate activity',()=>{
 assert.equal(volumeActivitySeries(make(70),null)[60].short,null);
 const b=make(70);b[30].volume=null; assert.equal(volumeActivitySeries(b,1e8)[60].trend,null);
});
test('capital estimate uses latest positive turnover and returns shares',()=>{
 assert.equal(estimateFloatShares([{volume:1000000,turnover_rate:1}]),1e8);
 assert.equal(estimateFloatShares([{volume:1000000,turnover_rate:null}]),null);
});
test('prefix stability and input immutability',()=>{
 const b=make(130), copy=structuredClone(b);
 assert.deepEqual(volumeActivitySeries(b,1e8).slice(0,80),volumeActivitySeries(b.slice(0,80),1e8)); assert.deepEqual(b,copy);
});
test('strong breakout produces PP instead of TL and trend is signed turnover',()=>{
 const bars=make(80); bars[60]={open:19,low:19,high:21,close:20,volume:2000000};
 const out=volumeActivitySeries(bars,1e8);
 assert.equal(out[60].signal,'PP'); assert.equal(out[60].trend,2000);
});
