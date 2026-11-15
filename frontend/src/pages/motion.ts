/* 主力动向试验榜：固定近似模型，按所选日重算，不与原公式混淆。 */
import { API_BASE, getToken } from "../api";
import { esc, fmt, fmtP, fmtYiS } from "../fmt";
import { createDataTable, type DataTable } from "../table";

interface MotionRow {
  symbol: string; name: string; rank: number; score: number; score_raw: number;
  net: number; ratio: number; volume_rel20: number; close: number | null; change_rate: number | null;
  contributions: { intercept: number; log_net: number; ratio: number; volume_rel20: number };
}
interface MotionResult {
  as_of: string | null; items: MotionRow[]; eligible: number; total: number;
  excluded: {net: number; amount: number; history: number}; model_version: string; note: string;
  stale?: boolean; data_date?: string; lag?: number | null; message?: string;
}
let table: DataTable<MotionRow>;
let rows: MotionRow[] = [];
let controller: AbortController | null = null;
let initialized = false;
let selectedDate = "";
const el = (id: string) => document.getElementById(`motion-${id}`)!;
const dateInput = () => el("date") as HTMLInputElement;
const pct = (v: number | null) => v == null ? "—" : `${v>0?"+":""}${fmt(v)}%`;
/* 涨跌幅红涨绿跌（跟随 data-dir 偏好）；占比等比例值保持中性，不套涨跌色 */
const chgPct = (v: number | null) => v == null ? "—" : `<span class="${v>0?"up":v<0?"down":""}">${v>0?"+":""}${fmt(v)}%</span>`;
/* 主力净额与涨跌同色：净流入为红、净流出为绿 */
const netCell = (v: number | null) => v == null ? "—" : `<span class="${v>0?"up":v<0?"down":""}">${fmtYiS(v)}</span>`;
const paint = () => table.render(table.sort(rows));

export async function loadMotion(): Promise<void> {
  if (!initialized) initMotion();
  controller?.abort();
  const request = new AbortController(); controller=request;
  el("status").textContent="正在计算所选日力度榜…";
  el("wrap").setAttribute("aria-busy","true");
  rows=[];paint();el("meta").textContent="";
  try {
    const token=getToken();
    const response=await fetch(`${API_BASE}/market/mainforce-motion${selectedDate?`?end=${encodeURIComponent(selectedDate)}`:""}`,{
      signal:request.signal,headers:token?{Authorization:`Bearer ${token}`}:{},
    });
    if(!response.ok) { const error=await response.json().catch(()=>({})); throw new Error(typeof error.detail==="string"?error.detail:`读取失败（${response.status}）`); }
    const result: MotionResult=await response.json();
    if(request!==controller) return;
    /* 资金数据断更：后端拒绝计算，直接说明，避免把旧资金榜当当日结果 */
    if(result.stale){
      rows=[];paint();
      el("status").textContent=result.message||"资金数据未更新，暂不计算";
      el("status").style.color="var(--warn)";
      el("meta").textContent="";
      return;
    }
    el("status").style.color="";
    rows=result.items;paint();dateInput().value=selectedDate || result.as_of || "";
    el("status").textContent=result.total ? "" : `${result.as_of || "所选日期"} 暂无同日资金数据`;
    el("meta").textContent=`范围：沪深A股 · 有资金记录 ${result.total} 只 · 净额非正或缺失 ${result.excluded.net} 只 · 缺成交额 ${result.excluded.amount} 只 · 历史量不足或无效 ${result.excluded.history} 只 · ${result.model_version}`;
  } catch(error) {
    if(request.signal.aborted) return;
    el("status").textContent=`加载失败：${error instanceof Error?error.message:"请重试"}`;
  } finally { if(request===controller) el("wrap").setAttribute("aria-busy","false"); }
}

function initMotion(): void {
  initialized=true;
  table=createDataTable(el("wrap"),[
    {label:"力度排名",num:true,pri:3,sort:"rank",render:r=>String(r.rank)},
    {label:"股票",pri:1,render:r=>`<b>${esc(r.name)}</b><br><span class="muted">${esc(r.symbol)}</span>`},
    {label:"近似力度",num:true,pri:1,sort:"score_raw",render:r=>`<b>${r.score}</b>`},
    {label:"主力净额",num:true,pri:1,sort:"net",render:r=>netCell(r.net)},
    {label:"当日占比",num:true,pri:2,sort:"ratio",render:r=>pct(r.ratio)},
    {label:"相对20日放量",num:true,pri:2,sort:"volume_rel20",title:"当日成交量 / 此前20个交易日平均成交量（不含当日）",render:r=>`${fmt(r.volume_rel20)}倍`},
    {label:"收盘价",num:true,pri:2,sort:"close",render:r=>fmtP(r.close, r.symbol)},
    {label:"当日涨幅",num:true,pri:1,sort:"change_rate",render:r=>chgPct(r.change_rate)},
    {label:"评分依据",pri:3,render:r=>`<details><summary>查看贡献</summary><div>基准 ${fmt(r.contributions.intercept)}<br>资金项 ${fmt(r.contributions.log_net)}<br>占比项 ${fmt(r.contributions.ratio)}<br>放量项 ${fmt(r.contributions.volume_rel20)}</div></details>`},
    {label:"操作",pri:2,render:()=>'<button class="hbtn">日K</button>'},
  ],{tblKey:"motion",defaultSort:{label:"近似力度",dir:-1},onChange:paint,rowKey:r=>r.symbol,
    empty:"该日暂无可评分股票；请检查同日资金、成交额及此前20日成交量。",
    onRow:(r,event)=>{
      if((event.target as HTMLElement).closest('details')) return;
      document.dispatchEvent(new CustomEvent('yc:open-stock',{detail:{symbol:r.symbol,name:r.name,from:{page:'motion',label:'主力动向'}}}));
    }});
  dateInput().addEventListener('change',()=>{selectedDate=dateInput().value;void loadMotion();});
  el("latest").addEventListener('click',()=>{selectedDate="";void loadMotion();});
  el("refresh").addEventListener('click',()=>void loadMotion());
}
