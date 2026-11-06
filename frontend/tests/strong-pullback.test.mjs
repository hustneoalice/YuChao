import test from 'node:test';
import assert from 'node:assert/strict';
import { strongPullbackSeries } from '../src/strong-pullback.ts';
const flat=()=>({open:10,high:10.2,low:9.8,close:10,volume:100});
function sample(){const b=Array.from({length:45},flat); b.push({open:10,high:11,low:9.5,close:11,volume:1000});b.push({open:11,high:11.2,low:10.5,close:11,volume:1500});b.push({open:11,high:11.3,low:10.4,close:11.1,volume:700});return b;}
test('multiple eligible bars share one anchor and protection includes lower wick',()=>{
 const out=strongPullbackSeries(sample());assert.equal(out[46].hit,false);assert.equal(out[47].hit,true);assert.equal(out[47].anchor,45);assert.equal(out[47].protection,9.5);
});
test('50 percent equality ends group permanently',()=>{
 const b=sample();b[46].volume=500;b[47].volume=900;const out=strongPullbackSeries(b);assert.equal(out[46].hit,false);assert.equal(out[47].anchor,null);
});
test('first-day 200 percent equality ends group, later upper limit is not applied',()=>{
 const b=sample();b[46].volume=2000;assert.equal(strongPullbackSeries(b)[47].hit,false);
 const c=sample();c[47].volume=3000;assert.equal(strongPullbackSeries(c)[47].hit,true);
});
test('breaking protection or missing volume ends group',()=>{
 for(const modify of [b=>b[46].low=9.49,b=>b[46].volume=null]){const b=sample();modify(b);assert.equal(strongPullbackSeries(b)[47].hit,false);}
});
test('MA45 equality is strong; weak bar is not marked',()=>{
 const b=sample();b[47].low=9.5;b[47].close=452/44; // (43*10 + 11 + 11 + close)/45 = close
 assert.equal(strongPullbackSeries(b)[47].hit,true);
 b[47].close=10;assert.equal(strongPullbackSeries(b)[47].hit,false);
});
test('new limit-up replaces anchor; future data cannot change historical hits',()=>{
 const b=sample();b.push({open:11,high:12.3,low:11,close:12.3,volume:2000});b.push({open:12,high:12.3,low:11.5,close:12,volume:1500});
 b.push({open:12,high:12.3,low:11.5,close:12,volume:1500});
 const copy=structuredClone(b),out=strongPullbackSeries(b);assert.equal(out[49].anchor,48);assert.equal(out[49].hit,false);assert.equal(out[50].hit,true);assert.deepEqual(out.slice(0,48),strongPullbackSeries(b.slice(0,48)));assert.deepEqual(b,copy);
});
test('later low volume terminates group and touching protection does not',()=>{
 const b=sample();b[46].low=9.5;assert.equal(strongPullbackSeries(b)[47].hit,true);
 b.push({open:11,high:11.3,low:10.5,close:11,volume:500});b.push({open:11,high:11.3,low:10.5,close:11,volume:900});
 const out=strongPullbackSeries(b);assert.equal(out[47].hit,true);assert.equal(out[48].anchor,null);assert.equal(out[49].anchor,null);
});

test('only days 2 through 8 are eligible; day 9 expires protection and cannot revive',()=>{
 const b=sample();while(b.length<56)b.push({open:11,high:11.3,low:10.5,close:11,volume:900});
 const out=strongPullbackSeries(b);
 assert.equal(out[46].anchor,45);assert.equal(out[46].hit,false);
 for(let i=47;i<=53;i++){assert.equal(out[i].hit,true);assert.equal(out[i].anchor,45);}
 for(let i=54;i<out.length;i++){assert.equal(out[i].hit,false);assert.equal(out[i].anchor,null);assert.equal(out[i].protection,null);}
});
test('a new limit-up after expiry starts its own eight-day window',()=>{
 const b=sample();while(b.length<55)b.push({open:11,high:11.3,low:10.5,close:11,volume:900});
 b.push({open:11,high:12.3,low:11,close:12.3,volume:2000});
 b.push({open:12,high:12.3,low:11.5,close:12,volume:1500});
 b.push({open:12,high:12.3,low:11.5,close:12,volume:1500});
 const out=strongPullbackSeries(b);assert.equal(out[56].hit,false);assert.equal(out[57].anchor,55);assert.equal(out[57].hit,true);
});
