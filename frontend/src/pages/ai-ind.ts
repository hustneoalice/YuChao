/* 聊天指令 · 指标开关的本地识别与执行（0 延迟，不调后端/大模型）。

规则：明确动作词 + 指标名 → 直接改图表指标状态并回一句确认；
问句（"打开了吗"）或多义 → 返回 null，交给后端规则/大模型（数值一律走 indicator_snapshot）。
*/
import { aiApi, type AiIndicator } from "../api";
import { indicatorWhere, setIndicator } from "./market";

const ON_WORDS = ["打开", "开启", "显示", "加上", "添加", "启用", "开一下", "调出"];
const OFF_WORDS = ["关闭", "关掉", "隐藏", "去掉", "移除", "取消", "关了", "撤掉"];

let cache: AiIndicator[] | null = null;

export async function loadIndicatorCatalog(): Promise<AiIndicator[]> {
  if (cache) return cache;
  try {
    cache = (await aiApi.indicators()).items;
  } catch {
    cache = [];
  }
  return cache;
}

function hitAliases(text: string, items: AiIndicator[]): AiIndicator[] {
  const low = text.toLowerCase();
  const found: { start: number; len: number; it: AiIndicator }[] = [];
  for (const it of items) {
    for (const alias of it.aliases) {
      const a = alias.toLowerCase();
      if (!a) continue;
      let idx = low.indexOf(a);
      while (idx >= 0) {
        if (/^[a-z]+$/.test(a)) {           // 纯字母要求词边界，避免 ma 命中 macd / dma
          const before = low[idx - 1] ?? " ";
          const after = low[idx + a.length] ?? " ";
          if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
            found.push({ start: idx, len: a.length, it });
          }
        } else {
          found.push({ start: idx, len: a.length, it });
        }
        idx = low.indexOf(a, idx + 1);
      }
    }
  }
  found.sort((x, y) => y.len - x.len || x.start - y.start);
  const out: AiIndicator[] = [];
  const occupied: [number, number][] = [];
  for (const h of found) {
    const end = h.start + h.len;
    if (occupied.some(([s, e]) => h.start < e && end > s)) continue;
    occupied.push([h.start, end]);
    if (!out.some((x) => x.key === h.it.key)) out.push(h.it);
  }
  return out;
}

/** 解析「打开/关闭 + 指标」指令；不是开关指令返回 null。 */
export async function tryIndicatorCommand(text: string): Promise<string | null> {
  const t = text.trim();
  if (!t) return null;
  const items = await loadIndicatorCatalog();
  if (!items.length) return null;
  // 问句（"打开了吗/显示没有"）不执行，交给后端答状态
  if (/(打开|开启|显示|加上|关闭|关掉|隐藏|去掉|移除)[^。！!]*[吗么？?]/.test(t)) return null;

  let on: boolean | null = null;
  for (const w of ON_WORDS) if (t.includes(w)) { on = true; break; }
  if (on === null) for (const w of OFF_WORDS) if (t.includes(w)) { on = false; break; }
  if (on === null) return null;

  let targets = hitAliases(t, items);
  if (!targets.length && /所有|全部/.test(t)) {
    const onlySub = t.includes("副图");
    targets = items.filter((it) => !onlySub || it.where === "sub");
  }
  if (!targets.length) return null;

  const done: string[] = [];
  const failed: string[] = [];
  for (const it of targets) {
    if (setIndicator(it.key, on)) {
      const where = indicatorWhere(it.key) === "main" ? "主图" : "副图";
      done.push(`${it.label}（${where}）`);
    } else {
      failed.push(it.label);
    }
  }
  if (!done.length) return null;
  const head = on ? "已开启" : "已关闭";
  let msg = `${head} ${done.join("、")}，图表已同步。`;
  if (failed.length) msg += `（${failed.join("、")} 未在指标栏找到，忽略）`;
  return msg;
}
