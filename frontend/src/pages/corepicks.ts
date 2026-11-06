/* 核心标强轮动：计算后台执行，页面读取已保存快照。 */
import { corepicksApi, dataApi, type RotationResponse, type RotationStock, type RotationBlock } from "../api";
import { esc, fmtYiS } from "../fmt";
import { createDataTable, type DataTable } from "../table";
import { openWatchPanel } from "../watch";

let data: RotationResponse | null = null;
let table: DataTable<RotationStock>;
let candidates: DataTable<RotationBlock>;
let kind = "行业";
let revision = 0;
let initialized = false;
let loading = false;
let requestedAt = 0;
const el = (id: string) => document.getElementById(`cp-${id}`)!;
const dateInput = () => el("date") as HTMLInputElement;
const history = () => el("history") as HTMLSelectElement;
const pct = (v: number | null | undefined) => v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const money = (v: number | null) => v == null ? "—" : fmtYiS(v);
const time = (v: string) => v.replace("T", " ").slice(0, 19);
const status = (s: string) => ({completed:"已完成",waiting:"等待数据",cancelled:"已停止"}[s] || s);
function renderCandidates(): void { candidates.render(data?.result?.candidates.filter(b => b.category === kind) || []); }

export async function renderCorepicks(): Promise<void> {
  if (!initialized || loading) return;
  loading = true;
  const current = ++revision;
  const date = dateInput().value;
  try {
    const [response, state] = await Promise.all([corepicksApi.rotation(date || undefined), dataApi.state()]);
    if (current !== revision || date !== dateInput().value) return;
    data = response;
    const result = data.result;
    const busy = [state.running, ...state.queued].find(t => t?.kind === "corepicks");
    const recent = state.recent.find(t => t.kind === "corepicks");
    const latest = data.latest_attempt;
    const pending = requestedAt > Date.now() - 15000 && !busy && (!latest || Date.parse(latest.created_at) < requestedAt);
    if (busy || (latest && Date.parse(latest.created_at) >= requestedAt)) requestedAt = 0;
    (el("run") as HTMLButtonElement).disabled = !!busy || pending;
    el("status").textContent = busy ? `${busy.label} · ${busy.stage || busy.status} ${busy.message || ""}` : pending ? "计算请求已提交，等待后台开始…" : recent?.status === "failed" ? `最近计算失败：${recent.error || recent.message}；保留上一份结果。` : latest ? `${status(latest.status)} · ${latest.message} · ${time(latest.created_at)} · ${latest.trigger === "auto" ? "自动" : "手动"}` : "尚未生成结果，点击立即计算。";
    history().innerHTML = '<option value="">最新结果</option>' + data.history.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
    history().value = data.history.includes(date) ? date : "";
    el("run").textContent = date ? "计算该日" : "立即计算";
    el("meta").textContent = result ? `结果交易日 ${result.date} · 生成于 ${time(result.created_at)} · ${result.trigger === "auto" ? "自动" : "手动"} · 合格板块 ${result.selected_blocks.length} 个 · 入选 ${result.items.length} 条${result.previous_available ? ` · 已排除 ${result.previous_date} 优选板块` : ` · ${result.previous_date || "上一交易日"} 无模型记录，本次未执行昨日排除`}` : "";
    table.render(result?.items || []);
    el("empty").textContent = !result ? (date ? `${date} 尚未生成结果，可点击“计算该日”。` : "暂无已完成结果。") : result.items.length < 4 ? `本次符合条件 ${result.items.length} 条，不自动降低条件补足。` : "";
    el("note").textContent = result ? `${result.note} 本次缺少有效资金或占比剔除 ${result.excluded_stock_records} 条成分记录（跨板块可能重复）。` : "板块涨幅采用成分股平均涨幅，数据缺失不当作0。";
    el("selected").innerHTML = result?.selected_blocks.length ? result.selected_blocks.map(b => `<p><b>${esc(b.category)} · ${esc(b.name)}</b>：涨幅第 ${b.change_rank} 名 / ${pct(b.change_rate)}，主力净额 ${money(b.main.net)}，本板块独立选取最多4只。</p>`).join("") : '<p>没有符合条件的优选板块。</p>';
    renderCandidates();
    el("runs").innerHTML = data.runs.map(r => `<p>${esc(time(r.created_at))} · ${esc(r.date)} · ${r.trigger === "auto" ? "自动" : "手动"} · ${esc(status(r.status))} · ${esc(r.message)}</p>`).join("") || "暂无运行记录";
  } catch (error) {
    if (current === revision) { el("status").textContent = `读取失败：${error instanceof Error ? error.message : "请重试"}`; (el("run") as HTMLButtonElement).disabled = false; }
  } finally { if (current === revision) { loading = false; if(date !== dateInput().value) void renderCorepicks(); } }
}

export function initCorepicks(): void {
  if (initialized) { void renderCorepicks(); return; }
  initialized = true;
  table = createDataTable(el("wrap"), [
    { label:"所属板块", render:r => r.sources.map(s => `${esc(s.category)}·${esc(s.name)}`).join(" / ") },
    { label:"板块内排名", render:r => String(r.rank) },
    { label:"代码", render:r => esc(r.symbol) },
    { label:"名称", render:r => `<b>${esc(r.name)}</b>` },
    { label:"市场", render:r => r.mainboard ? "主板" : "其他A股" },
    { label:"涨幅", num:true, render:r => pct(r.change_rate) },
    { label:"资金排名", render:r => r.fund_rank ? `第${r.fund_rank}名 / 前12` : "—" },
    { label:"主力净额", num:true, render:r => money(r.main.net) },
    { label:"主力介入度", num:true, render:r => pct(r.main.participation) },
    { label:"主力占比", num:true, render:r => pct(r.main.ratio) },
    { label:"入选依据", render:r => r.sources.map(s => `${esc(s.category)}·${esc(s.name)}（板块涨幅第${s.change_rank}）`).join(" / ") },
    { label:"操作", render:() => '<button class="hbtn" data-k>日K</button> <button class="hbtn" data-watch>自选</button>' },
  ], {rowKey:r => `${r.sources[0]?.code}:${r.symbol}`, onRow:(r,e) => {
    if ((e.target as HTMLElement).closest('[data-watch]')) { openWatchPanel(r.symbol,r.name); return; }
    document.dispatchEvent(new CustomEvent('yc:open-stock',{detail:{symbol:r.symbol,name:r.name,from:{page:'corepicks',label:'核心标'}}}));
  }});
  candidates = createDataTable(el("candidates"), [
    {label:"涨幅排名",render:r => String(r.change_rank)}, {label:"板块",render:r => esc(r.name)},
    {label:"涨幅",num:true,render:r => pct(r.change_rate)}, {label:"主力净额",num:true,render:r => money(r.main.net)},
    {label:"筛选结果",render:r => esc(r.reason)},
  ],{rowKey:r => r.key});
  el("kinds").addEventListener('click',e => { const b=(e.target as HTMLElement).closest<HTMLElement>('[data-kind]'); if(!b) return; kind=b.dataset.kind!; el("kinds").querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b)); renderCandidates(); });
  history().addEventListener('change',() => { dateInput().value=history().value; void renderCorepicks(); });
  dateInput().addEventListener('change',() => void renderCorepicks());
  el("latest").addEventListener('click',() => { dateInput().value=""; void renderCorepicks(); });
  el("refresh").addEventListener('click',() => void renderCorepicks());
  el("run").addEventListener('click',async () => {
    (el("run") as HTMLButtonElement).disabled=true;
    el("status").textContent="正在提交计算任务…";
    try { await corepicksApi.runRotation(dateInput().value || undefined); requestedAt=Date.now(); await renderCorepicks(); }
    catch(error) { el("status").textContent=`提交失败：${error instanceof Error ? error.message : "请重试"}`; (el("run") as HTMLButtonElement).disabled=false; }
  });
  setInterval(() => { if(document.getElementById('page-corepicks')?.classList.contains('on') && !document.hidden) void renderCorepicks(); },5000);
  void renderCorepicks();
}
