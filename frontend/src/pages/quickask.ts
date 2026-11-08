/* 快速问股：入口挂在个股信息条「昨收」后的 AI 对话按钮，浮框按需唤起，自动带当前标的上下文。
 * 浮框半透明、可拖动；模型选择放底部（规则模式 / 已配置模型可切换）。
 * LLM 已配置时按钮点亮（绿色），否则灰色（规则模式仍可用）。 */
import { aiApi } from "../api";
import { ic } from "../icons";
import { mk } from "./market";
import { mountChat } from "./ai";

const STOCK_RE = /^\d{6}$/;
const QUICK_CHIPS = ["这只股票主营业务是什么", "分析下这个股票", "现在多少钱", "最近涨跌幅", "换手率多少"];
const POS_KEY = "yc_qa_pos";
const MODEL_KEY = "yc_qa_model";

export function initQuickAsk(): void {
  if (document.getElementById("qa-panel")) return;

  const panel = document.createElement("div");
  panel.id = "qa-panel";
  panel.className = "qa-panel";
  panel.hidden = true;
  panel.innerHTML =
    `<div class="qa-head" id="qa-head">` +
    `<span class="qa-grip" aria-hidden="true"></span>` +
    `<span class="qa-title">AI 问股</span>` +
    `<span class="qa-ctx" id="qa-ctx"></span>` +
    `<span class="sp"></span>` +
    `<button class="qa-x" id="qa-x" type="button" aria-label="关闭">×</button></div>` +
    `<div class="ai-log qa-log" id="qa-log"></div>` +
    `<div class="ai-chips" id="qa-chips"></div>` +
    `<form class="ai-form qa-form" id="qa-form" autocomplete="off">` +
    `<input id="qa-q" placeholder="问：这只股票主营业务是什么？" maxlength="200">` +
    `<button class="hbtn primary" id="qa-send" type="submit">${ic("paper-plane-tilt", 13)}发送</button></form>` +
    `<div class="qa-foot">` +
    `<span class="qa-modeltag">${ic("ai-chat", 12)}模型</span>` +
    `<select class="qa-modelsel" id="qa-model" aria-label="选择模型" title="切换问答模型"></select>` +
    `<span class="sp"></span><span class="qa-hint" id="qa-hint"></span></div>`;
  document.body.append(panel);

  const headEl = document.getElementById("qa-head")!;
  const ctxEl = document.getElementById("qa-ctx")!;
  const input = document.getElementById("qa-q") as HTMLInputElement;
  const log = document.getElementById("qa-log")!;
  const modelSel = document.getElementById("qa-model") as HTMLSelectElement;
  const hintEl = document.getElementById("qa-hint")!;

  const updateCtx = () => {
    const cur = mk.cur;
    if (!cur) {
      ctxEl.textContent = "未选标的";
      ctxEl.title = "先在搜索框选择一只股票，再提问可自动带上标的";
      return;
    }
    ctxEl.textContent = `${cur.name} ${cur.symbol}`;
    ctxEl.title = STOCK_RE.test(cur.symbol) ? "提问会自动带上该标的" : "指数/非个股标的：请直接输入股票代码";
  };

  const markInline = (open: boolean) => {
    document.querySelectorAll<HTMLElement>(".qa-inline").forEach((b) => {
      b.setAttribute("aria-expanded", String(open));
      b.classList.toggle("active", open);
    });
  };

  /* ── 位置：可拖动 + 记忆（桌面端）；移动端固定全宽不拖 ── */
  const clampPos = (x: number, y: number) => {
    const w = panel.offsetWidth || 320;
    const h = panel.offsetHeight || 384;
    return {
      x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      y: Math.max(58, Math.min(y, window.innerHeight - h - 8)),
    };
  };
  const readPos = (): { x: number; y: number } | null => {
    try {
      const v = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      return v && typeof v.x === "number" && typeof v.y === "number" ? v : null;
    } catch { return null; }
  };
  let pos = readPos();
  const applyPos = () => {
    if (!pos || window.innerWidth <= 820) return;
    const p = clampPos(pos.x, pos.y);
    panel.style.left = `${p.x}px`;
    panel.style.top = `${p.y}px`;
    panel.style.right = "auto";
  };
  const clearPos = () => {
    panel.style.left = "";
    panel.style.top = "";
    panel.style.right = "";
  };

  headEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || window.innerWidth <= 820) return;
    if ((e.target as HTMLElement).closest("button,select")) return;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      pos = clampPos(ev.clientX - dx, ev.clientY - dy);
      panel.style.left = `${pos.x}px`;
      panel.style.top = `${pos.y}px`;
      panel.style.right = "auto";
    };
    const up = () => {
      headEl.removeEventListener("pointermove", move);
      headEl.removeEventListener("pointerup", up);
      headEl.removeEventListener("pointercancel", up);
      headEl.classList.remove("dragging");
      if (pos) localStorage.setItem(POS_KEY, JSON.stringify(pos));
    };
    headEl.setPointerCapture(e.pointerId);
    headEl.classList.add("dragging");
    headEl.addEventListener("pointermove", move);
    headEl.addEventListener("pointerup", up);
    headEl.addEventListener("pointercancel", up);
    e.preventDefault();
  });

  const setOpen = (v: boolean) => {
    panel.hidden = !v;
    markInline(v);
    if (v) {
      if (window.innerWidth <= 820) clearPos(); else applyPos();
      updateCtx();
      input.focus();
    }
  };

  /* ── 底部模型选择器：后端 /ai/models 给候选，切换即按次指定模型 ── */
  let modelId: string | undefined;
  const syncModel = () => {
    modelId = modelSel.value || undefined;
    const isRule = modelSel.value === "rule";
    hintEl.textContent = isRule ? "本地规则" : "";
    hintEl.title = isRule ? "不调用大模型，仅用本地数据规则回答" : "";
    modelSel.title = isRule ? "当前使用本地规则模式" : `当前模型：${modelSel.value}`;
  };
  const loadModels = () => {
    void aiApi.models().then((m) => {
      const saved = localStorage.getItem(MODEL_KEY) || "";
      const ids = m.items.map((i) => i.id);
      modelSel.innerHTML = "";
      for (const it of m.items) {
        const o = document.createElement("option");
        o.value = it.id;
        o.textContent = it.id === "rule" ? "规则模式" : it.label;
        modelSel.append(o);
      }
      modelSel.value = ids.includes(saved) ? saved : m.current;
      modelSel.disabled = m.items.length <= 1;
      syncModel();
    }).catch(() => { modelSel.disabled = true; });
  };
  modelSel.addEventListener("change", () => {
    localStorage.setItem(MODEL_KEY, modelSel.value);
    syncModel();
  });
  loadModels();

  mountChat({
    log,
    chips: document.getElementById("qa-chips")!,
    form: document.getElementById("qa-form") as HTMLFormElement,
    input,
    send: document.getElementById("qa-send"),
    chipsList: QUICK_CHIPS,
    // 个股 / ETF / 指数都可作为上下文（指标问答支持指数带后缀）
    context: () => mk.cur?.symbol || undefined,
    model: () => modelId,
    beforeAsk: () => { if (panel.hidden) setOpen(true); },
  });

  // 信息条会被行情刷新反复重建 → 用事件委托，按钮永远有效
  document.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".qa-inline");
    if (btn) setOpen(panel.hidden);
  });
  document.getElementById("qa-x")!.onclick = () => setOpen(false);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) setOpen(false);
  });
  window.addEventListener("resize", () => {
    if (panel.hidden) return;
    if (window.innerWidth <= 820) clearPos(); else applyPos();
  });

  let healthLoaded = false;
  const loadHealth = () => {
    if (healthLoaded) return;
    healthLoaded = true;
    void aiApi.health().then((h) => {
      const label = h.llm ? (h.model || "模型已就绪") : "规则模式";
      // AI 入口与顶栏状态灯：已配置模型点亮（绿），否则灰
      document.body.classList.toggle("llm-on", h.llm);
      const chip = document.getElementById("llmchip");
      const chipT = document.getElementById("llmchip-t");
      if (chip) {
        chip.classList.toggle("on", h.llm);
        chip.classList.toggle("off", !h.llm);
        chip.title = h.llm ? `大模型已启用 · ${label}` : "未配置大模型：使用本地规则模式";
      }
      if (chipT) chipT.textContent = label;
    }).catch(() => { healthLoaded = false; });
  };
  loadHealth();
  // 设置页保存模型配置后重读健康状态与模型候选：顶栏灯与 AI 入口即时点亮/熄灭
  document.addEventListener("yc:llm-changed", () => {
    healthLoaded = false;
    loadHealth();
    loadModels();
  });

  // 页面切换标的时，浮框若开着就同步上下文
  document.addEventListener("yc:open-stock", () => { if (!panel.hidden) updateCtx(); });
}
