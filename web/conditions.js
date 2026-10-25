/**
 * 条件模块目录 + 条件选股中的参数编辑与校验。
 *
 * 依赖 shared.js 的 api() / escapeHtml(); 目录来自后端的 /api/strategy-catalog,
 * 因此后端新增一个条件类型, 前端无需改代码就能编辑。
 */

const conditionCatalog = { entries: null, byKind: {} };

//: 当前基准日的时间节点: 偏移 → 日期 (由页面通过 setTimeNodes 注入)。
let timeNodeDates = {};

function setTimeNodes(nodes) {
  timeNodeDates = {};
  (nodes || []).forEach((node) => {
    timeNodeDates[node.offset] = node.trade_date || null;
  });
}

function nodeSymbolText(offset) {
  return Number(offset) === 0 ? "T0" : `T${Number(offset) > 0 ? "+" : ""}${offset}`;
}

function nodeDateText(offset) {
  const value = timeNodeDates[Number(offset)];
  return value ? String(value) : "";
}

const UNIT_BY_KIND = {
  pct_chg_range: "%",
  volume_ratio_range: " 倍",
  cumulative_pct_chg_range: "%",
  close_price_range: " 元",
  amount_range: " 万元",
};

const SIGNED_KINDS = new Set([
  "pct_chg_range",
  "cumulative_pct_chg_range",
]);

async function loadConditionCatalog() {
  if (conditionCatalog.entries) return conditionCatalog.entries;
  const payload = await api("/api/strategy-catalog");
  conditionCatalog.entries = payload.conditions || [];
  conditionCatalog.byKind = {};
  conditionCatalog.entries.forEach((entry) => {
    conditionCatalog.byKind[entry.kind] = entry;
  });
  return conditionCatalog.entries;
}

function conditionCatalogEntries() {
  return conditionCatalog.entries || [];
}

function conditionEntry(kind) {
  return conditionCatalog.byKind[kind] || null;
}

function conditionTitle(kind) {
  const entry = conditionEntry(kind);
  return entry ? entry.title : kind;
}

function defaultConditionParams(kind) {
  const entry = conditionEntry(kind);
  const params = {};
  (entry ? entry.params : []).forEach((param) => {
    params[param.name] = param.default;
  });
  return params;
}

function mergeParams(kind, params) {
  return Object.assign(defaultConditionParams(kind), params || {});
}

function conditionTimeRange(kind, params) {
  const merged = mergeParams(kind, params);
  const end = kind === "listed_min_days" ? 0 : Math.trunc(Number(merged.offset)) || 0;
  const multiple = ["pct_chg_range", "cumulative_pct_chg_range"].includes(kind);
  const span = merged.span == null || merged.span === "" ? 3 : Math.trunc(Number(merged.span));
  const start = multiple ? end - Math.max(1, span) + 1 : end;
  return {start, end, reference: kind === "volume_ratio_range" ? end - 1 : multiple ? start - 1 : null};
}

function relativeDayLabel(offset) {
  return offset === 0 ? "基准日 · T0" : `${nodeSymbolText(offset)} · ${offset < 0 ? "前" : "后"}${Math.abs(offset)}个交易日`;
}

function rangeStartOptions(end, start, maximum) {
  return Array.from({length: maximum}, (_, index) => end - maximum + index + 1).map((day) =>
    `<option value="${day}"${day === start ? " selected" : ""}>${relativeDayLabel(day)}</option>`).join("");
}

function conditionTimeNote(kind, params) {
  const {start, end, reference} = conditionTimeRange(kind, params);
  if (["pct_chg_range", "cumulative_pct_chg_range"].includes(kind)) {
    const dates = nodeDateText(start) && nodeDateText(end) ? `${nodeDateText(start)} 至 ${nodeDateText(end)} · ` : "";
    return `${dates}共 ${end - start + 1} 个交易日（含首尾）`;
  }
  if (kind === "volume_ratio_range") return `${nodeSymbolText(end)} 成交量 ÷ ${nodeSymbolText(reference)} 成交量`;
  return nodeDateText(end);
}

/* ------------------------------------------------------------- 参数渲染 */

function conditionParamsHtml(kind, params) {
  const entry = conditionEntry(kind);
  if (!entry) return "";
  const merged = mergeParams(kind, params);
  return entry.params
    .map((param) => {
      const name = escapeHtml(param.name);
      const value = merged[param.name];
      if (param.role === "node") {
        const {start, end: offset} = conditionTimeRange(kind, merged);
        const spanParam = entry.params.find((item) => item.role === "span");
        const label = spanParam ? "结束日" : ({volume_ratio_range: "成交量日", close_price_range: "收盘日", amount_range: "成交日", not_st: "简称日期"}[kind] || "检查日");
        const options = Array.from({length: 121}, (_, index) => index - 60).map((day) =>
          `<option value="${day}"${day === offset ? " selected" : ""}>` +
          `${relativeDayLabel(day)}</option>`
        ).join("");
        return (
          (spanParam ? `<label class="param-field"><span>开始日</span><select class="param-select range-start-select" data-role="range-start" data-param="${escapeHtml(spanParam.name)}" title="开始日与结束日均计入，最多连续 ${spanParam.max} 个交易日" aria-label="${escapeHtml(entry.title)}的开始交易日">${rangeStartOptions(offset, start, spanParam.max)}</select></label>` : "") +
          `<div class="param-field"><span>${label}</span>` +
          `<div class="node-stepper" data-param="${name}" data-offset="${offset}">` +
          `<button type="button" class="btn btn-mini" data-step="-1" aria-label="${spanParam ? "区间前移一个交易日" : "前一个交易日"}" title="${spanParam ? "开始日和结束日一起前移" : "前移"}一个交易日"${offset <= -60 ? " disabled" : ""}>←</button>` +
          `<select class="param-select node-offset-select" data-role="node-offset" title="${spanParam ? "更改结束日时，开始日同步平移，保持交易日数量" : "日期相对基准日 T0，按交易日计算"}" aria-label="${escapeHtml(entry.title)}的${label}（相对基准日，按交易日计算）">${options}</select>` +
          `<button type="button" class="btn btn-mini" data-step="1" aria-label="${spanParam ? "区间后移一个交易日" : "后一个交易日"}" title="${spanParam ? "开始日和结束日一起后移" : "后移"}一个交易日"${offset >= 60 ? " disabled" : ""}>→</button>` +
          `</div></div><span class="condition-time-summary" data-role="time-summary">${escapeHtml(conditionTimeNote(kind, merged))}</span>`
        );
      }
      if (param.role === "span") return "";
      if (param.type === "select") {
        const options = (param.options || [])
          .map(
            (option) =>
              `<option value="${escapeHtml(option.value)}"` +
              `${option.value === value ? " selected" : ""}>${escapeHtml(option.label)}</option>`
          )
          .join("");
        return (
          `<label class="param-field"><span>${escapeHtml(param.label)}</span>` +
          `<select class="param-select" data-param="${name}">${options}</select></label>`
        );
      }
      if (param.type === "bool") {
        return (
          `<label class="param-check param-check-inline">` +
          `<input type="checkbox" data-param="${name}"${value ? " checked" : ""}>` +
          `<span>${escapeHtml(param.name === "inclusive" ? "包含上下限" : param.label)}</span></label>`
        );
      }
      const shown = value === null || value === undefined ? "" : String(value);
      return (
        `<label class="param-field"><span>${escapeHtml(param.label)}</span>` +
        `<input type="number" data-param="${name}" value="${escapeHtml(shown)}" ` +
        `step="${param.step ?? 0.5}" min="${param.min ?? ""}" max="${param.max ?? ""}" ` +
        `inputmode="decimal" placeholder="不限" autocomplete="off"></label>`
      );
    })
    .join("");
}

/** 两个子页面直接展示同一套参数表单。 */
function conditionEditorHtml(condition, index, actions = "") {
  const error = validateConditionParams(condition.kind, condition.params);
  return `<div class="condition-block" data-index="${index}">` +
    `<div class="condition-head"><span class="condition-index">${index + 1}</span>` +
    `<span class="condition-title" title="${escapeHtml(conditionEntry(condition.kind)?.hint || "")}">${escapeHtml(conditionTitle(condition.kind))}</span>` +
    `${actions}</div>` +
    `<div class="condition-body"><div class="param-grid">${conditionParamsHtml(condition.kind, condition.params)}</div>` +
    `<p class="condition-error criteria-error" role="alert"${error ? "" : " hidden"}>${escapeHtml(error || "")}</p>` +
    `</div></div>`;
}

function updateConditionParams(event, conditions) {
  const block = event.target.closest(".condition-block");
  if (!block || (event.type === "click" && !event.target.closest("[data-step]"))) return false;
  const condition = conditions[Number(block.dataset.index)];
  if (!condition) return false;
  applyNodeStep(event, block);
  condition.params = readConditionParams(condition.kind, block);
  const timeNote = block.querySelector('[data-role="time-summary"]');
  if (timeNote) timeNote.textContent = conditionTimeNote(condition.kind, condition.params);
  const error = validateConditionParams(condition.kind, condition.params);
  const hint = block.querySelector(".condition-error");
  hint.hidden = !error;
  hint.textContent = error || "";
  return true;
}

/** 从 DOM 容器读回参数值。 */
function readConditionParams(kind, container) {
  const entry = conditionEntry(kind);
  const params = {};
  if (!entry || !container) return params;
  entry.params.forEach((param) => {
    const node = container.querySelector(`[data-param="${param.name}"]`);
    if (!node) return;
    if (param.role === "node") {
      params[param.name] = Number(node.dataset.offset) || 0;
      return;
    }
    if (param.role === "span") {
      params[param.name] = Number(container.querySelector('.node-stepper').dataset.offset) - Number(node.value) + 1;
      return;
    }
    if (param.type === "bool") {
      params[param.name] = node.checked;
    } else if (param.type === "number") {
      const raw = String(node.value ?? "").trim();
      params[param.name] = raw === "" ? null : Number(raw);
    } else {
      params[param.name] = node.value;
    }
  });
  return params;
}

/** 点击节点步进器: 调整偏移并刷新符号与日期。返回是否处理了这次点击。 */
function applyNodeStep(event, container) {
  const button = event.target.closest("[data-step]");
  const select = event.target.closest("[data-role='node-offset']");
  if (!button && !select) return false;
  const stepper = (button || select).closest(".node-stepper");
  if (!stepper) return false;
  const offset = select ? Number(select.value) : (Number(stepper.dataset.offset) || 0) + Number(button.dataset.step);
  if (offset < -60 || offset > 60) return true;
  const start = container.querySelector('[data-role="range-start"]');
  if (start) {
    const span = Number(stepper.dataset.offset) - Number(start.value) + 1;
    start.innerHTML = rangeStartOptions(offset, offset - span + 1, start.options.length);
  }
  stepper.dataset.offset = String(offset);
  stepper.querySelector("[data-role='node-offset']").value = String(offset);
  stepper.querySelector("[data-step='-1']").disabled = offset <= -60;
  stepper.querySelector("[data-step='1']").disabled = offset >= 60;
  return true;
}

/** 校验参数; 返回错误文案, 合法时返回 null。 */
function validateConditionParams(kind, params) {
  const entry = conditionEntry(kind);
  if (!entry) return `未知的条件类型: ${kind}`;
  const title = entry.title;
  for (const param of entry.params) {
    const value = params[param.name];
    if (param.type !== "number") continue;
    if (value === null || value === undefined) continue; // 留空 = 不限制
    if (Number.isNaN(value)) return `${title}: ${param.label} 必须是数字。`;
    if (param.min !== undefined && param.min !== null && value < param.min) {
      return `${title}: ${param.label} 不能小于 ${param.min}。`;
    }
    if (param.max !== undefined && param.max !== null && value > param.max) {
      return `${title}: ${param.label} 不能大于 ${param.max}。`;
    }
  }
  const low = params.min;
  const high = params.max;
  if (
    entry.params.some((param) => param.name === "min") &&
    entry.params.some((param) => param.name === "max") &&
    low !== null &&
    low !== undefined &&
    high !== null &&
    high !== undefined
  ) {
    if (low > high) return `${title}: 下限不能大于上限。`;
    if (low === high && !params.inclusive) {
      return `${title}: 上下限相等时需要勾选"包含上下限"。`;
    }
  }
  return null;
}

/* ------------------------------------------------------------- 文字描述 */

function formatNumber(value) {
  return String(Number(value));
}

function formatSignedNumber(value) {
  const number = Number(value);
  return number > 0 ? `+${formatNumber(number)}` : formatNumber(number);
}

function intervalText(kind, params) {
  const unit = UNIT_BY_KIND[kind] || "";
  const signed = SIGNED_KINDS.has(kind);
  const low = params.min;
  const high = params.max;
  const left = params.inclusive && low != null ? "[" : "(";
  const right = params.inclusive && high != null ? "]" : ")";
  const lowText =
    low === null || low === undefined
      ? "-∞"
      : `${signed ? formatSignedNumber(low) : formatNumber(low)}${unit}`;
  const highText =
    high === null || high === undefined
      ? "+∞"
      : `${signed ? formatSignedNumber(high) : formatNumber(high)}${unit}`;
  return `${left}${lowText}, ${highText}${right}`;
}

/** 条件的文字描述 (与后端漏斗标签口径一致)。 */
function conditionSummary(kind, params) {
  const merged = mergeParams(kind, params);
  switch (kind) {
    case "pct_chg_range": {
      const {start, end} = conditionTimeRange(kind, merged);
      const node = nodeSymbolText(end);
      if (start !== end) {
        return `${nodeSymbolText(start)} 至 ${node}（含首尾），每天涨跌幅均在 ${intervalText(kind, merged)}`;
      }
      return `${node} 涨跌幅落在 ${intervalText(kind, merged)}`;
    }
    case "volume_ratio_range":
      return `${nodeSymbolText(Math.trunc(Number(merged.offset)) || 0)} 成交量 ÷ ${nodeSymbolText((Math.trunc(Number(merged.offset)) || 0) - 1)} 成交量在 ${intervalText(kind, merged)}`;
    case "cumulative_pct_chg_range": {
      const {start, end} = conditionTimeRange(kind, merged);
      return `${nodeSymbolText(start)} 至 ${nodeSymbolText(end)}（含首尾），整段累计涨跌幅在 ${intervalText(kind, merged)}`;
    }
    case "close_price_range":
      return `${nodeSymbolText(merged.offset || 0)} 收盘价落在 ${intervalText(kind, merged)}`;
    case "amount_range":
      return `${nodeSymbolText(merged.offset || 0)} 成交额落在 ${intervalText(kind, merged)}`;
    case "listed_min_days":
      return `上市满 ${merged.days} 个交易日`;
    case "not_st":
      return `${nodeSymbolText(merged.offset || 0)} 非 ST / *ST`;
    default:
      return conditionTitle(kind);
  }
}
