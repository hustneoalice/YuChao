/* 涨停追击收盘版：历史快照、精确涨停价、当前板块成分。 */
import { API_BASE, getToken } from "../api";
import { esc, fmt, fmtYiS, fmtVol } from "../fmt";
import { createDataTable, type DataTable, type DataTableCol } from "../table";
import { createPager, slicePage, type Pager } from "../pager";

type View = "stocks" | "ladder" | "blocks";
interface Stock {
  symbol:string;name:string;market_group:string;status:string;close:number|null;change_rate:number|null;
  net:number|null;amount:number|null;turnover_rate:number|null;streak:number;streak_complete:boolean;
  seal_shares:number|null;seal_amount:number|null;seal_ratio:number|null;seal_flow_ratio:number|null;
  first_limit_time:string|null;last_seal_time:string|null;blocks:string[];
}
interface Block {
  code:string;name:string;category:string;members:number;up_count:number;up_ratio:number;one_count:number;
  consecutive_count:number;change_rate:number|null;period_change:number|null;period_coverage:number;
  unknown_limits:number;symbols:string[];
}
interface Result {
  as_of:string|null;previous_date:string|null;available_dates:string[];today:Stock[];yesterday:Stock[];
  broken:Stock[];blocks:Block[];snapshot_count:number;unknown_limits:number;invalid_snapshots:number;invalid_previous_snapshots:number;snapshot_time:string|null;period:number;note:string;
  summary:{up_count:number|null;yesterday_count:number|null;seal_rate:number|null;yesterday_seal_rate:number|null;
    continuity_rate:number|null;yesterday_change:number|null;previous_coverage:number;broken_count:number;previous_unknown:number};
}
const el=(id:string)=>document.getElementById(`chase-${id}`)!;
const input=(id:string)=>el(id) as HTMLInputElement;
const select=(id:string)=>el(id) as HTMLSelectElement;
/* 涨跌幅统一红涨绿跌（跟随 data-dir 偏好），与目标页/看盘页同口径 */
const pct=(v:number|null|undefined)=>v==null?"—":`<span class="${v>0?"up":v<0?"down":""}">${v>0?"+":""}${fmt(v)}%</span>`;
const rate=(v:number|null|undefined)=>v==null?"—":`${fmt(v)}%`;
/* 主力净额与涨跌同色：净流入红、净流出绿 */
const netCell=(v:number|null|undefined)=>v==null?"—":`<span class="${v>0?"up":v<0?"down":""}">${fmtYiS(v)}</span>`;
let initialized=false,view:View="stocks",data:Result|null=null;
let requestedDate="",request:AbortController|null=null;
let stockTable:DataTable<Stock>,blockTable:DataTable<Block>,pager:Pager;
let tableMode="",drill:Block|null=null;
const height=(r:Stock)=>r.streak>0?`${r.streak_complete?"":"≥"}${r.streak}板${r.streak_complete?"":"（历史不足）"}`:"未封板";
const status=(s:string)=>({one:"一字封板",sealed:"封板",broken:"触板未封",normal:"未涨停",unknown:"数据不足"}[s]||s);
function stockColumns():DataTableCol<Stock>[] {return [
  {label:"股票",render:r=>`<b>${esc(r.name)}</b><br><span class="muted">${esc(r.symbol)}</span>`},
  {label:"状态",render:r=>status(r.status)},
  {label:"连板高度",sort:"streak",render:r=>height(r)},
  {label:"收盘价",num:true,sort:"close",render:r=>fmt(r.close)},
  {label:"当日涨幅",num:true,sort:"change_rate",render:r=>pct(r.change_rate)},
  {label:"主力净额",num:true,sort:"net",render:r=>netCell(r.net)},
  {label:"所属板块（当前）",render:r=>r.blocks.map(esc).join(" / ")||"—"},
  {label:"快照封单量",num:true,sort:"seal_shares",render:r=>r.seal_shares==null?"—":`${fmtVol(r.seal_shares)}股`},
  {label:"快照封单额",num:true,sort:"seal_amount",render:r=>fmtYiS(r.seal_amount)},
  {label:"封成比",num:true,sort:"seal_ratio",title:"本版口径：快照封单额 / 同日成交额，显示原始比值",render:r=>fmt(r.seal_ratio,4)},
  {label:"封流比",num:true,sort:"seal_flow_ratio",title:"本版口径：快照封单额 / 同日流通市值，显示原始比值",render:r=>fmt(r.seal_flow_ratio,4)},
  {label:"换手率",num:true,sort:"turnover_rate",render:r=>rate(r.turnover_rate)},
  {label:"首次涨停时间",title:"需要盘中事件记录；缺失显示—",render:r=>r.first_limit_time||"—"},
  {label:"操作",render:()=>'<button class="hbtn">日K</button>'},
];}
function ensureTable(mode:string):void {
  if(mode===tableMode)return;
  tableMode=mode;
  if(mode==='blocks')blockTable=createDataTable(el('wrap'),[
    {label:"板块",key:"block",render:r=>`<b>${esc(r.name)}</b><br><span class="muted">${esc(r.category)}</span>`},
    {label:"成分均涨",key:"change_rate",num:true,sort:"change_rate",render:r=>pct(r.change_rate)},
    {label:`${select('period').value}日成分均涨`,key:"period_change",num:true,sort:"period_change",render:r=>pct(r.period_change)},
    {label:"涨停 / 成分",num:true,sort:"up_count",render:r=>`<button class="hbtn" data-members>${r.unknown_limits?"≥":""}${r.up_count} / ${r.members}</button>`},
    {label:"涨停占比",num:true,sort:"up_ratio",render:r=>`${r.unknown_limits?"≥":""}${rate(r.up_ratio)}`},
    {label:"一字家数",num:true,sort:"one_count",render:r=>String(r.one_count)},
    {label:"已确认连板",num:true,sort:"consecutive_count",title:"至少连续两个交易日快照封板",render:r=>String(r.consecutive_count)},
    {label:"区间数据覆盖",num:true,render:r=>`${r.period_coverage}/${r.members}`},
    {label:"涨停价未知",num:true,render:r=>String(r.unknown_limits)},
  ],{tblKey:"chase-blocks",defaultSort:{label:"成分均涨",dir:-1},onChange:()=>{pager.reset();paint();},rowKey:r=>r.code,
      empty:"没有含已确认涨停股的板块。",onRow:r=>{drill=r;pager.reset();paint();}});
  else stockTable=createDataTable(el('wrap'),stockColumns(),{
    tblKey:"chase-stocks",defaultSort:{label:view==='ladder'?"连板高度":"主力净额",dir:-1},rowKey:r=>r.symbol,
    empty:"当前条件下暂无股票；缺少快照或精确涨停价的股票不作已确认信号。",
    onChange:()=>{pager.reset();paint();},onRow:r=>document.dispatchEvent(new CustomEvent('yc:open-stock',{
      detail:{symbol:r.symbol,name:r.name,from:{page:'chase',label:'涨停追击'}}})),
  });
}
function paint():void {
  const mode=view==='blocks'&&!drill?'blocks':view==='ladder'?'ladder':'stocks';ensureTable(mode);
  el('back').hidden=!drill;
  el('scope').textContent=drill?`${drill.name} · ${drill.up_count}只涨停成分`:({stocks:'涨停个股',ladder:'连板天梯 · 列表',blocks:'含涨停股的强势板块'}[view]);
  el('stock-controls').hidden=view!=='stocks'||!!drill;
  el('ladder-controls').hidden=view!=='ladder';el('block-controls').hidden=view!=='blocks'||!!drill;
  const q=input('q').value.trim().toLowerCase();
  if(mode==='blocks') {
    const category=select('category').value;
    const rows=(data?.blocks||[]).filter(r=>(!category||r.category===category)&&(!q||r.name.toLowerCase().includes(q)||r.code.toLowerCase().includes(q)));
    pager.update(rows.length);blockTable.render(slicePage(pager,blockTable.sort(rows)),(pager.page-1)*pager.size);return;
  }
  const pool=select('pool').value;select('type').disabled=pool!=='today';
  let rows=drill?(data?.today||[]).filter(r=>drill!.symbols.includes(r.symbol))
    :view==='ladder'?data?.today||[]:pool==='yesterday'?data?.yesterday||[]:pool==='broken'?data?.broken||[]:data?.today||[];
  const type=select('type').value;
  if(view==='stocks'&&!drill&&pool==='today'&&type)rows=rows.filter(r=>r.status===type);
  if(view==='ladder') {
    const level=select('height').value;
    if(level==='unknown')rows=rows.filter(r=>!r.streak_complete);
    else if(level==='5')rows=rows.filter(r=>r.streak>=5);
    else if(level)rows=rows.filter(r=>r.streak_complete&&r.streak===Number(level));
  }
  if(q)rows=rows.filter(r=>r.name.toLowerCase().includes(q)||r.symbol.includes(q));
  pager.update(rows.length);stockTable.render(slicePage(pager,stockTable.sort(rows)),(pager.page-1)*pager.size);
}
function renderSummary():void {
  const s=data?.summary;
  const card=(label:string,value:string,foot:string)=>
    `<div class="tp-kpi"><span>${label}</span><b>${value}</b><em>${foot}</em></div>`;
  el('cards').innerHTML=card('已确认涨停',`${s?.up_count??"—"}`,`昨日 ${s?.yesterday_count??"—"} 只`)
    +card('有效触板样本封板率',rate(s?.seal_rate),`昨日 ${rate(s?.yesterday_seal_rate)}`)
    +card('已知昨日涨停股续板率',rate(s?.continuity_rate),`均涨 ${pct(s?.yesterday_change)}`);
}
export async function loadChase():Promise<void> {
  if(!initialized)initChase();
  request?.abort();const current=new AbortController();request=current;
  const markets=Array.from(el('markets').querySelectorAll<HTMLInputElement>('input:checked')).map(x=>x.value);
  data=null;drill=null;renderSummary();paint();el('meta').textContent='';
  if(!markets.length){el('status').textContent='请至少选择一个市场。';return;}
  el('status').textContent='正在读取快照并统计涨停、连板和板块…';el('wrap').setAttribute('aria-busy','true');
  const params=new URLSearchParams({markets:markets.join(','),show_st:String(input('st').checked),period:select('period').value});
  if(requestedDate)params.set('end',requestedDate);
  try {
    const token=getToken();const response=await fetch(`${API_BASE}/market/limit-chase?${params}`,{signal:current.signal,headers:token?{Authorization:`Bearer ${token}`}:{}});
    if(!response.ok){const e=await response.json().catch(()=>({}));throw new Error(typeof e.detail==='string'?e.detail:`HTTP ${response.status}`);}
    const result:Result=await response.json();if(current!==request)return;
    data=result;input('date').value=requestedDate||result.as_of||'';
    el('dates').innerHTML=result.available_dates.map(d=>`<option value="${esc(d)}"></option>`).join('');
    el('status').textContent=result.snapshot_count ? result.unknown_limits===result.snapshot_count ? `${result.as_of} 的快照无法通过同日日线/涨停价核验，暂不能确认涨停与连板。` : `${result.as_of} · 已确认涨停 ${result.today.length} 只 · 触板未封 ${result.broken.length} 只` : `${result.as_of||'所选日'} 暂无已保存股票快照，不能用最新行情替代。`;
    el('meta').textContent=`当前筛选快照 ${result.snapshot_count} 只 · 精确涨停价/行情不足 ${result.unknown_limits} 只 · 同日日线校验未通过 ${result.invalid_snapshots} 只 / 昨日 ${result.invalid_previous_snapshots} 只 · 昨日 ${result.previous_date||'—'} · 已知昨日涨停股当日覆盖 ${result.summary.previous_coverage??0}/${result.summary.yesterday_count??'—'} · 历史保存日期 ${result.available_dates.length} 个`;
    el('note').textContent=result.note;renderSummary();paint();
  } catch(error){if(!current.signal.aborted)el('status').textContent=`加载失败：${error instanceof Error?error.message:'请重试'}`;}
  finally{if(current===request)el('wrap').setAttribute('aria-busy','false');}
}
function initChase():void {
  initialized=true;pager=createPager(el('pager'),'limit-chase',paint);
  el('tabs').addEventListener('click',event=>{const b=(event.target as HTMLElement).closest<HTMLElement>('button[data-view]');if(!b)return;view=b.dataset.view as View;drill=null;pager.reset();input('q').value='';el('tabs').querySelectorAll('button').forEach(x=>{x.classList.toggle('on',x===b);x.setAttribute('aria-pressed',String(x===b));});paint();});
  input('date').addEventListener('change',()=>{requestedDate=input('date').value;pager.reset();void loadChase();});
  el('latest').addEventListener('click',()=>{requestedDate='';pager.reset();void loadChase();});
  el('refresh').addEventListener('click',()=>void loadChase());
  el('markets').addEventListener('change',()=>{pager.reset();void loadChase();});
  input('st').addEventListener('change',()=>{pager.reset();void loadChase();});
  select('period').addEventListener('change',()=>{tableMode='';pager.reset();void loadChase();});
  for(const id of ['pool','type','height','category'])select(id).addEventListener('change',()=>{pager.reset();paint();});
  input('q').addEventListener('input',()=>{pager.reset();paint();});
  el('back').addEventListener('click',()=>{drill=null;pager.reset();paint();});
}
