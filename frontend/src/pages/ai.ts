/* 智能助手：问股对话 + 工具调用卡（页面与右下角浮框共用同一套渲染与请求） */
import { aiApi, ApiError, type AiAnswer, type AiStreamMeta, type AiToolCall } from "../api";
import { mk } from "./market";

const PAGE_CHIPS = ["这只票做什么的", "主营业务是什么", "现在多少钱", "最近涨跌幅", "换手率多少"];

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function row(cls: string, html: string): string {
  return `<div class="ai-row ${cls}"><div class="ai-bub">${html}</div></div>`;
}

function toolCard(c: AiToolCall): string {
  const args = esc(JSON.stringify(c.args));
  return `<div class="ai-tool"><div class="ai-tool-h"><b>${esc(c.tool)}</b>` +
    `<span class="ai-tag">${c.ms} ms</span>` +
    (c.data_date ? `<span class="ai-tag">数据 ${esc(c.data_date)}</span>` : "") +
    `<span class="sp"></span><span class="ai-caret" data-fold>展开</span></div>` +
    `<div class="ai-tool-b"><div class="ai-kv"><span>参数</span><code>${args}</code></div></div></div>`;
}

const MISSING_ZH: Record<string, string> = {
  "stock_profile.main_business": "主营业务",
  "stock_profile": "个股档案",
  "stock_quote": "实时行情",
};

function answerHtml(a: AiAnswer): string {
  const mode = a.mode === "llm" ? (a.fallback ? "模型补答" : "模型") : "规则";
  const body = esc(a.answer).replace(/\n/g, "<br>");
  let html = row("ai-a",
    `<div class="ai-meta">${mode}模式${a.data_date ? ` · 数据 ${esc(a.data_date)}` : ""}</div>` +
    `<div class="ai-txt">${body}</div>`);
  if (a.tool_calls.length) {
    html += `<div class="ai-tools">${a.tool_calls.map(toolCard).join("")}</div>`;
  }
  if (a.missing.length) {
    html += `<div class="ai-warn">本地未覆盖：${a.missing.map((m) => MISSING_ZH[m] || esc(m)).join("、")}</div>`;
  }
  if (a.warnings.length) {
    html += `<div class="ai-warn">${a.warnings.map(esc).join("；")}</div>`;
  }
  if (a.candidates.length) {
    html += `<div class="ai-cand">${a.candidates.map((c) =>
      `<button class="ai-chip" data-pick="${esc(c.symbol)}">${esc(c.name)} ${esc(c.symbol)}</button>`).join("")}</div>`;
  }
  return html;
}

function bindFold(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("[data-fold]").forEach((el) => {
    el.onclick = () => {
      const card = el.closest(".ai-tool");
      card?.classList.toggle("open");
      el.textContent = card?.classList.contains("open") ? "收起" : "展开";
    };
  });
}

/** 流式回答骨架：思考流（默认折叠区）→ 工具卡 → 正文 → 元信息 */
function streamShell(): string {
  return `<div class="ai-think" hidden>` +
    `<div class="ai-think-h"><i class="ai-pulse"></i><span class="ai-think-s">模型思考中…</span>` +
    `<span class="sp"></span><span class="ai-caret" data-think>收起</span></div>` +
    `<div class="ai-think-b"></div></div>` +
    `<div class="ai-tools"></div><div class="ai-txt"></div><div class="ai-tail"></div>`;
}

function metaHtml(m: AiStreamMeta): string {
  const mode = m.mode === "llm" ? (m.fallback ? "模型补答" : "模型") : "规则";
  let html = `<div class="ai-meta">${mode}模式${m.data_date ? ` · 数据 ${esc(m.data_date)}` : ""}</div>`;
  if (m.missing.length) {
    html += `<div class="ai-warn">本地未覆盖：${m.missing.map((x) => MISSING_ZH[x] || esc(x)).join("、")}</div>`;
  }
  if (m.warnings.length) html += `<div class="ai-warn">${m.warnings.map(esc).join("；")}</div>`;
  return html;
}

export interface ChatMountOptions {
  log: HTMLElement;
  chips: HTMLElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  send?: HTMLElement | null;
  chipsList: string[];
  /** 当前上下文标的（不含后缀的 6 位代码）；无标的返回 undefined */
  context: () => string | undefined;
  /** 发送前回调（浮框用它确保面板已展开/聚焦） */
  beforeAsk?: () => void;
}

/** 把一套对话 UI 接上后端；页面与浮框各自调用一次，互不干扰。 */
export function mountChat(o: ChatMountOptions): void {
  let busy = false;

  const scrollLog = () => { o.log.scrollTop = o.log.scrollHeight; };

  const ask = async (q: string): Promise<void> => {
    const text = q.trim();
    if (busy || !text) return;
    o.beforeAsk?.();
    o.log.insertAdjacentHTML("beforeend", row("ai-u", esc(text)));
    o.log.insertAdjacentHTML("beforeend", row("ai-a", streamShell()));
    const tip = o.log.lastElementChild as HTMLElement;
    const think = tip.querySelector<HTMLElement>(".ai-think")!;
    const thinkBody = tip.querySelector<HTMLElement>(".ai-think-b")!;
    const thinkState = tip.querySelector<HTMLElement>(".ai-think-s")!;
    const tools = tip.querySelector<HTMLElement>(".ai-tools")!;
    const txt = tip.querySelector<HTMLElement>(".ai-txt")!;
    const tail = tip.querySelector<HTMLElement>(".ai-tail")!;
    const fold = tip.querySelector<HTMLElement>("[data-think]")!;
    fold.onclick = () => {
      think.classList.toggle("fold");
      fold.textContent = think.classList.contains("fold") ? "展开" : "收起";
    };
    scrollLog();

    if (o.send) (o.send as HTMLButtonElement).disabled = true;
    busy = true;
    let body = "";
    let answered = false;
    try {
      await aiApi.chatStream(text, o.context(), {
        onThinking: (t) => {
          think.hidden = false;
          thinkBody.textContent += t;
          scrollLog();
        },
        onTool: (c) => {
          tools.insertAdjacentHTML("beforeend", toolCard(c));
          bindFold(tools);
          scrollLog();
        },
        onToken: (t) => {
          body += t;
          answered = true;
          txt.textContent = body;
          scrollLog();
        },
        onAnswer: (t) => {
          body = t;
          answered = true;
          txt.textContent = body;
          scrollLog();
        },
        onWarn: (m) => {
          tail.insertAdjacentHTML("beforeend", `<div class="ai-warn">${esc(m)}</div>`);
        },
        onMeta: (m) => {
          tail.insertAdjacentHTML("beforeend", metaHtml(m));
          if (m.mode === "llm" && !think.hidden) {
            thinkState.textContent = "思考完成";
            think.classList.add("done");
          }
          if (m.candidates?.length) {
            tail.insertAdjacentHTML("beforeend",
              `<div class="ai-cand">${m.candidates.map((c) =>
                `<button class="ai-chip" data-pick="${esc(c.symbol)}">${esc(c.name)} ${esc(c.symbol)}</button>`).join("")}</div>`);
          }
        },
      });
      if (!answered) {
        txt.classList.add("ai-dim");
        txt.textContent = "（没有返回内容）";
      }
    } catch (e) {
      // 流式中断且还没吐字 → 用非流式接口兜底一次
      if (!answered) {
        try {
          const a = await aiApi.chat(text, o.context());
          tip.remove();
          o.log.insertAdjacentHTML("beforeend", answerHtml(a));
          bindFold(o.log);
        } catch (e2) {
          const msg = e2 instanceof ApiError ? e2.message : "请求失败，请稍后再试";
          txt.classList.add("ai-err");
          txt.textContent = msg;
        }
      } else {
        const msg = e instanceof ApiError ? e.message : "连接中断";
        tail.insertAdjacentHTML("beforeend", `<div class="ai-warn">${esc(msg)}</div>`);
      }
    } finally {
      busy = false;
      if (o.send) (o.send as HTMLButtonElement).disabled = false;
      scrollLog();
    }
  };

  o.chips.innerHTML = o.chipsList.map((c) => `<button class="ai-chip" data-q="${esc(c)}">${esc(c)}</button>`).join("");
  o.chips.querySelectorAll<HTMLElement>("[data-q]").forEach((el) => {
    el.onclick = () => void ask(el.dataset.q!);
  });

  o.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = o.input.value;
    o.input.value = "";
    void ask(q);
  });

  o.log.addEventListener("click", (e) => {
    const pick = (e.target as HTMLElement).closest<HTMLElement>("[data-pick]");
    if (pick) void ask(`${pick.dataset.pick} 主营业务是什么`);
  });
}

/* ── 智能页（侧栏「智能」） ── */
export function initAi(): void {
  const form = document.getElementById("ai-form") as HTMLFormElement | null;
  const input = document.getElementById("ai-q") as HTMLInputElement | null;
  const chips = document.getElementById("ai-chips");
  const log = document.getElementById("ai-log");
  if (!form || !input || !chips || !log) return;

  mountChat({
    log, chips, form, input,
    send: document.getElementById("ai-send"),
    chipsList: PAGE_CHIPS,
    context: () => mk.cur?.symbol,
  });

  void aiApi.health().then((h) => {
    const mode = document.getElementById("ai-mode");
    if (!mode) return;
    mode.textContent = h.llm ? `模型模式 · ${h.model}` : "规则模式";
    mode.title = h.llm ? "" : "未配置模型：主营与行情问答仍可用";
  }).catch(() => { /* 未登录或后端未就绪时保持默认文案 */ });
}
