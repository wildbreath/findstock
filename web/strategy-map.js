/** 整套策略在同一组量价数据上的联合示意；数据由后端条件引擎校验。 */
const STRATEGY_CONDITION_HELP = {
  pct_chg_range: "从开始日到结束日（含首尾），每个交易日的涨跌幅都须符合上下限。",
  volume_ratio_range: "当日成交量 ÷ 前一交易日成交量；2 倍表示翻倍，与盘中量比不同。",
  cumulative_pct_chg_range: "从开始日当天的涨跌幅起，至结束日复利累计；只判断整段累计值。",
  close_price_range: "对应 K 线的收盘价，单位为元。",
  amount_range: "对应交易日的总成交金额，单位为万元；不是成交股数。",
  listed_min_days: "按基准日向前计算的上市交易日门槛；上市日期缺失时跳过此项。",
  not_st: "所选日期的历史简称不含 ST 或 *ST，不按当前简称判断。",
};

function renderStrategyGuide() {
  el.strategyGuideList.innerHTML = conditionCatalogEntries().map((entry) =>
    `<dt>${escapeHtml(entry.title)}</dt><dd>${escapeHtml(STRATEGY_CONDITION_HELP[entry.kind] || entry.hint)}</dd>`
  ).join("");
  el.strategyGuide.open = window.matchMedia("(min-width: 761px)").matches;
}

function strategyMapRows(conditions) {
  return conditions.map((condition, index) => {
    const params = mergeParams(condition.kind, condition.params);
    return {index, kind: condition.kind, params, ...conditionTimeRange(condition.kind, params)};
  });
}

function strategyMapNumber(value) {
  const shown = Number(value.toPrecision(7));
  return `${Math.abs(shown - value) > Math.max(1, Math.abs(value)) * 1e-12 ? "≈" : ""}${shown}`;
}

function strategyMapConditionText(row) {
  const {kind, params, start, end, reference} = row;
  const scope = start === end ? nodeSymbolText(end) : `${nodeSymbolText(start)} 至 ${nodeSymbolText(end)}（含首尾）`;
  const subjects = {
    pct_chg_range: `${scope} 的${start === end ? "日" : "每日"}涨跌幅`,
    cumulative_pct_chg_range: `${scope} 的累计涨跌幅（复利）`,
    volume_ratio_range: `${nodeSymbolText(end)} 成交量 ÷ ${nodeSymbolText(reference)} 成交量`,
    close_price_range: `${scope} 收盘价（元）`,
    amount_range: `${scope} 成交额（万元）`,
    listed_min_days: "截至基准日 T0 的上市交易日数",
    not_st: `${scope} 的历史简称`,
  };
  let requirement;
  if (kind === "listed_min_days") requirement = `至少 ${Math.trunc(Number(params.days)) || 3} 个交易日`;
  else if (kind === "not_st") requirement = "不含 ST 或 *ST";
  else {
    const format = SIGNED_KINDS.has(kind) ? formatSignedNumber : formatNumber;
    const unit = UNIT_BY_KIND[kind] || "";
    const {min, max, inclusive} = params;
    if (min == null && max == null) requirement = "上下限均不限";
    else if (min != null && min === max && inclusive) requirement = `等于 ${format(min)}${unit}`;
    else requirement = [min == null ? "下限不限" : `${inclusive ? "不低于" : "大于"} ${format(min)}${unit}`, max == null ? "上限不限" : `${inclusive ? "不高于" : "小于"} ${format(max)}${unit}`].join("，");
  }
  return {subject: subjects[kind] || conditionTitle(kind), requirement};
}

function strategyMapWrapText(text, width, context) {
  const lines = [];
  let line = "";
  for (const char of text) {
    if (line && context.measureText(line + char).width > width) {
      lines.push(line);
      line = "";
    }
    line += char;
  }
  if (line) lines.push(line);
  return lines;
}

function strategyMapAnnotation(row, bars, check) {
  const active = bars.filter((bar) => bar.offset >= row.start && bar.offset <= row.end);
  const current = active.at(-1);
  const scope = (row.start === row.end ? nodeSymbolText(row.end) : `${nodeSymbolText(row.start)} 至 ${nodeSymbolText(row.end)}（含首尾）`) + (row.kind === "cumulative_pct_chg_range" ? `；参照日 ${nodeSymbolText(row.reference)}` : "");
  const {requirement} = strategyMapConditionText(row);
  let actual = check.detail;
  if (row.kind === "pct_chg_range") {
    const values = active.map((bar) => bar.pct_chg);
    const valueText = Math.min(...values) === Math.max(...values) ? `${strategyMapNumber(values[0])}%` : `${strategyMapNumber(Math.min(...values))}% 至 ${strategyMapNumber(Math.max(...values))}%`;
    actual = `每日示例：${valueText}；每个交易日分别判断`;
  } else if (row.kind === "volume_ratio_range") {
    const previous = bars.find((bar) => bar.offset === row.reference);
    actual = `示例：${nodeSymbolText(row.end)} 成交量 ÷ ${nodeSymbolText(row.reference)} 成交量 = ${strategyMapNumber(current.volume / previous.volume)} 倍`;
  } else if (row.kind === "close_price_range") actual = `示例收盘价：${strategyMapNumber(current.close)} 元`;
  else if (row.kind === "amount_range") actual = `示例成交额：${strategyMapNumber(current.amount)} 万元`;
  else if (row.kind === "not_st") actual = "示例历史简称已通过非 ST 校验";
  return `<strong>条件 ${row.index + 1} · ${escapeHtml(conditionTitle(row.kind))}</strong><p>日期：${escapeHtml(scope)}</p><p>要求：${escapeHtml(requirement)}</p><p class="strategy-map-example">${escapeHtml(actual)}</p>`;
}

const strategyMapPreview = {key: null, data: null, sequence: 0, timer: null, pending: false, viewKey: null};

function renderStrategyMap(conditions, selectedIndex = 0) {
  const error = conditions.map((item) => validateConditionParams(item.kind, item.params)).find(Boolean);
  const key = JSON.stringify(conditions);
  if (key !== strategyMapPreview.key) {
    strategyMapPreview.key = key;
    strategyMapPreview.data = null;
    strategyMapPreview.pending = false;
    strategyMapPreview.sequence++;
    clearTimeout(strategyMapPreview.timer);
  }
  if (!conditions.length || error) {
    el.strategyMap.dataset.previewState = "empty";
    el.strategyMap.innerHTML = `<p class="strategy-map-empty">${escapeHtml(error || "添加条件后显示整套策略的组合图。")}</p>`;
    el.strategyMapDetail.textContent = "";
    return;
  }
  if (!strategyMapPreview.data) {
    el.strategyMap.dataset.previewState = "loading";
    el.strategyMap.innerHTML = '<p class="strategy-map-empty" role="status">正在计算所有条件的组合形态…</p>';
    el.strategyMapDetail.textContent = "";
    if (strategyMapPreview.pending) return;
    strategyMapPreview.pending = true;
    clearTimeout(strategyMapPreview.timer);
    const sequence = strategyMapPreview.sequence;
    strategyMapPreview.timer = setTimeout(async () => {
      try {
        const data = await api("/api/strategies/preview", {method: "POST", body: JSON.stringify({conditions: JSON.parse(key)})});
        if (sequence !== strategyMapPreview.sequence) return;
        strategyMapPreview.data = data;
      } catch (error) {
        if (sequence !== strategyMapPreview.sequence) return;
        strategyMapPreview.data = {status: "error", message: `组合图计算失败：${error.message}`, conflicts: []};
      }
      strategyMapPreview.pending = false;
      renderStrategyMap(state.conditions, state.mapIndex);
    }, 160);
    return;
  }
  const data = strategyMapPreview.data;
  const rows = strategyMapRows(conditions);
  const selected = rows[Math.min(Math.max(0, selectedIndex), rows.length - 1)];
  const viewKey = `${strategyMapPreview.sequence}:${data.status}:${selected.index}:${el.strategyMap.clientWidth}`;
  if (strategyMapPreview.viewKey === viewKey) return;
  strategyMapPreview.viewKey = viewKey;
  el.strategyMap.dataset.previewState = data.status;
  if (data.status !== "ok") {
    el.strategyMap.innerHTML = `<div class="strategy-map-conflict" role="status"><strong>${data.status === "conflict" ? "条件冲突，无法形成同时满足的图形" : "未生成通过全部校验的组合图"}</strong><p>${escapeHtml(data.message)}</p>` +
      (data.conflicts || []).map((index) => `<button type="button" class="btn btn-mini" data-map-index="${index}" data-map-edit="${index}">条件 ${index + 1}：${escapeHtml(conditionSummary(rows[index].kind, rows[index].params))} · 定位编辑</button>`).join("") +
      (data.status === "error" ? '<button type="button" class="btn btn-mini" data-preview-retry>重试</button>' : '') + '</div>';
    el.strategyMapDetail.textContent = "请调整相关条件后查看组合图；不会将不满足策略的数据画成命中形态。";
    return;
  }
  const bars = data.bars;
  const first = bars[0].offset, last = bars.at(-1).offset;
  const byOffset = new Map(bars.map((bar) => [bar.offset, bar]));
  const hasAmount = rows.some((row) => row.kind === "amount_range");
  const axisY = hasAmount ? 444 : 340;
  const laneTop = axisY + 24;
  const plotLeft = 400;
  const width = Math.max(1040, el.strategyMap.clientWidth - 2, plotLeft + 28 + bars.length * 86);
  const textContext = document.createElement("canvas").getContext("2d");
  const fontFamily = getComputedStyle(el.strategyMap).fontFamily;
  let rowY = laneTop;
  const displayRows = rows.map((row) => {
    const text = strategyMapConditionText(row);
    textContext.font = `600 13px ${fontFamily}`;
    const titleLines = strategyMapWrapText(`✓ ${row.index + 1}. ${text.subject}`, plotLeft - 32, textContext);
    textContext.font = `12px ${fontFamily}`;
    const detailLines = strategyMapWrapText(`要求：${text.requirement}`, plotLeft - 32, textContext);
    const rowHeight = Math.max(44, 12 + (titleLines.length + detailLines.length) * 16);
    const item = {row, text, titleLines, detailLines, top: rowY, height: rowHeight};
    rowY += rowHeight;
    return item;
  });
  const height = rowY + 10;
  const layout = buildLayout(width, bars, {...CHART_LAYOUT, padLeft: plotLeft, padRight: 28, priceTop: 70, priceBottom: 216, volumeTop: 280, volumeBottom: 320});
  const x = (offset) => layout.xOf(offset - first);
  const covers = (row, offset) => offset >= row.start && offset <= row.end;
  const priceRows = rows.filter((row) => ["pct_chg_range", "cumulative_pct_chg_range", "close_price_range"].includes(row.kind));
  const volumeRows = rows.filter((row) => row.kind === "volume_ratio_range");
  const amountRows = rows.filter((row) => row.kind === "amount_range");
  const annotation = strategyMapAnnotation(selected, bars, data.checks[selected.index]);
  const scrollLeft = el.strategyMap.querySelector(".strategy-map-scroll")?.scrollLeft || 0;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="group" aria-label="所有条件共同满足的策略 K 线示意图"><title>整套策略的联合示例，所有条件已由实际筛选引擎逐条校验。非真实行情。</title>`;
  for (const y of [70, 143, 216, 320, ...(hasAmount ? [424] : [])]) svg += `<line x1="${plotLeft}" y1="${y}" x2="${width - 28}" y2="${y}" class="strategy-map-grid"/>`;
  svg += `<text x="16" y="88" class="strategy-map-label">整套策略 · 联合量价形态</text><text x="16" y="110" class="strategy-map-tick">所有条件共同作用于同一组数据</text><text x="16" y="296" class="strategy-map-label">成交量 · 全部量比条件</text>`;
  svg += `<foreignObject x="12" y="126" width="${plotLeft - 28}" height="160" class="strategy-map-annotation" data-map-annotation="${selected.index}" data-kind="${selected.kind}"><div xmlns="http://www.w3.org/1999/xhtml" class="strategy-map-callout">${annotation}</div></foreignObject>`;
  if (hasAmount) svg += '<text x="16" y="400" class="strategy-map-label">成交额（万元）</text>';
  const maxVolume = Math.max(...bars.map((bar) => bar.volume));
  const maxAmount = Math.max(1, ...bars.map((bar) => bar.amount));
  bars.forEach((bar) => {
    const price = priceRows.some((row) => covers(row, bar.offset));
    const volume = volumeRows.some((row) => covers(row, bar.offset));
    const reference = volumeRows.some((row) => row.reference === bar.offset);
    const amount = amountRows.some((row) => covers(row, bar.offset));
    const cx = x(bar.offset), bodyWidth = Math.min(26, layout.step * .42);
    if (price) svg += `<rect x="${cx - layout.step * .4}" y="60" width="${layout.step * .8}" height="164" class="strategy-map-all-shade"/>`;
    const rising = isRisingBar(bar), yOpen = layout.yOf(bar.open), yClose = layout.yOf(bar.close);
    svg += `<g class="strategy-map-candle${price ? ' is-active' : ''}" data-offset="${bar.offset}" data-close="${bar.close}" data-pct="${bar.pct_chg}" data-volume="${bar.volume}" data-amount="${bar.amount}"><title>${nodeSymbolText(bar.offset)}：收盘 ${strategyMapNumber(bar.close)} 元，涨跌幅 ${strategyMapNumber(bar.pct_chg)}%，成交量 ${strategyMapNumber(bar.volume)}，成交额 ${strategyMapNumber(bar.amount)} 万元</title>` +
      `<line x1="${cx}" y1="${layout.yOf(bar.high)}" x2="${cx}" y2="${layout.yOf(bar.low)}" class="strategy-map-wick ${rising ? 'is-up' : 'is-down'}"/><rect x="${cx - bodyWidth / 2}" y="${Math.min(yOpen, yClose)}" width="${bodyWidth}" height="${Math.max(2, Math.abs(yClose - yOpen))}" class="strategy-map-body ${rising ? 'is-up' : 'is-down'}"/>`;
    if (price) svg += `<text x="${cx}" y="48" text-anchor="middle" class="strategy-map-value">${strategyMapNumber(bar.pct_chg)}%</text>`;
    if (rows.some((row) => row.kind === "close_price_range" && covers(row, bar.offset))) svg += `<circle cx="${cx}" cy="${yClose}" r="6" class="strategy-map-close"/><text x="${cx}" y="247" text-anchor="middle" class="strategy-map-value">${strategyMapNumber(bar.close)} 元</text>`;
    const volumeHeight = bar.volume / maxVolume * 40;
    svg += `<rect x="${cx - bodyWidth / 2}" y="${320 - volumeHeight}" width="${bodyWidth}" height="${volumeHeight}" class="strategy-map-volume${volume ? ' is-active' : reference ? ' is-reference' : ''}"/>`;
    if (volume && byOffset.has(bar.offset - 1)) svg += `<text x="${cx}" y="270" text-anchor="middle" class="strategy-map-value">× ${strategyMapNumber(bar.volume / byOffset.get(bar.offset - 1).volume)}</text>`;
    if (hasAmount) {
      const amountHeight = bar.amount / maxAmount * 40;
      svg += `<rect x="${cx - bodyWidth / 2}" y="${424 - amountHeight}" width="${bodyWidth}" height="${amountHeight}" class="strategy-map-volume${amount ? ' is-active' : ''}"/>`;
      if (amount) svg += `<text x="${cx}" y="374" text-anchor="middle" class="strategy-map-value">${strategyMapNumber(bar.amount)}</text>`;
    }
    svg += '</g>';
  });
  const amountSelected = selected.kind === "amount_range";
  const volumeSelected = selected.kind === "volume_ratio_range";
  const metadataSelected = ["listed_min_days", "not_st"].includes(selected.kind);
  const selectedTop = amountSelected ? 378 : volumeSelected ? 276 : 60;
  const selectedBottom = amountSelected ? 430 : volumeSelected ? 326 : 224;
  const selectedLeft = x(selected.start) - layout.step * .42;
  const selectedRight = x(selected.end) + layout.step * .42;
  svg += `<g class="strategy-map-selected-overlay" data-selected-condition="${selected.index}" data-start="${selected.start}" data-end="${selected.end}" data-reference="${selected.reference ?? ''}" aria-label="${escapeHtml(conditionSummary(selected.kind, selected.params))}">`;
  if (metadataSelected) {
    svg += `<line x1="${x(selected.end)}" y1="38" x2="${x(selected.end)}" y2="${axisY - 8}" class="strategy-map-selected-reference"/>`;
  } else {
    svg += `<rect x="${selectedLeft}" y="${selectedTop}" width="${selectedRight - selectedLeft}" height="${selectedBottom - selectedTop}" rx="4" class="strategy-map-selected-frame"/>`;
  }
  if (selected.reference !== null) {
    const arrowY = volumeSelected ? 258 : 62;
    svg += `<line x1="${x(selected.reference)}" y1="${selectedTop}" x2="${x(selected.reference)}" y2="${selectedBottom}" class="strategy-map-selected-reference"/>`;
    for (let offset = selected.kind === "pct_chg_range" ? selected.start : selected.end; offset <= selected.end; offset++) {
      const reference = selected.kind === "pct_chg_range" ? offset - 1 : selected.reference;
      svg += `<path d="M ${x(reference)} ${arrowY} H ${x(offset)} l -6 -4 m 6 4 l -6 4" class="strategy-map-selected-reference"/>`;
    }
  }
  if (selected.kind === "close_price_range") {
    const bar = byOffset.get(selected.end);
    svg += `<circle cx="${x(selected.end)}" cy="${layout.yOf(bar.close)}" r="9" class="strategy-map-selected-frame"/>`;
  }
  svg += '</g>';
  svg += `<line x1="${x(0)}" y1="26" x2="${x(0)}" y2="${height - 12}" class="strategy-map-anchor"/>`;
  for (let offset = first; offset <= last; offset++) svg += `<text x="${x(offset)}" y="${offset === 0 ? 18 : axisY}" text-anchor="middle" class="${offset === 0 ? 'strategy-map-zero' : 'strategy-map-tick'}">${offset === 0 ? 'T0 基准日' : nodeSymbolText(offset)}</text>`;
  svg += `<text x="16" y="${axisY}" class="strategy-map-label">条件叠加 · ${data.checks.length}/${rows.length} 已通过</text>`;
  displayRows.forEach(({row, text, titleLines, detailLines, top, height: rowHeight}) => {
    const center = top + (rowHeight - 2) / 2;
    const fullText = `${text.subject}；要求：${text.requirement}`;
    svg += `<g class="strategy-map-row${row === selected ? ' is-selected' : ''}" data-map-index="${row.index}" data-start="${row.start}" data-end="${row.end}" data-reference="${row.reference ?? ''}" role="button" tabindex="0" aria-label="${escapeHtml(fullText)}" aria-pressed="${row === selected}"><title>${escapeHtml(fullText)}；${escapeHtml(data.checks[row.index].detail)}</title><rect x="2" y="${top}" width="${width - 4}" height="${rowHeight - 2}" rx="5" class="strategy-map-row-bg"/>`;
    svg += `<text class="strategy-map-row-title">${titleLines.map((line, index) => `<tspan x="16" y="${top + 15 + index * 16}">${escapeHtml(line)}</tspan>`).join('')}</text>`;
    svg += `<text class="strategy-map-row-detail">${detailLines.map((line, index) => `<tspan x="16" y="${top + 15 + (titleLines.length + index) * 16}">${escapeHtml(line)}</tspan>`).join('')}</text>`;
    if (row.reference !== null) svg += `<line x1="${x(row.reference)}" y1="${center}" x2="${x(row.start)}" y2="${center}" class="strategy-map-reference"/><circle cx="${x(row.reference)}" cy="${center}" r="3" class="strategy-map-reference-dot"/>`;
    svg += `<line x1="${x(row.start)}" y1="${center}" x2="${x(row.end)}" y2="${center}" class="strategy-map-span"/>`;
    for (let offset = row.start; offset <= row.end; offset++) svg += `<circle cx="${x(offset)}" cy="${center}" r="4" class="strategy-map-point"/>`;
    svg += '</g>';
  });
  const extra = rows.filter((row) => ['listed_min_days', 'not_st'].includes(row.kind)).map((row) => conditionSummary(row.kind, row.params)).join('；');
  el.strategyMap.innerHTML = `<div class="strategy-map-focus"><span class="strategy-map-index">✓</span><div><strong>整套策略 · ${rows.length} 条条件同时满足</strong><p>所有条件已联合生成并逐条验算。${escapeHtml(extra)}</p></div></div><div class="strategy-map-legend"><span class="map-key-active">蓝色：整套策略作用日</span><span class="map-key-selected">金色框：选中条件</span><span class="map-key-reference">空心点 / 虚线：参照日</span></div><div class="strategy-map-mobile-note strategy-map-callout">${annotation}</div><div class="strategy-map-scroll" tabindex="0" aria-label="整套策略组合图，窄屏可横向滑动">${svg}</svg></div>`;
  const selectedText = strategyMapConditionText(selected);
  el.strategyMapDetail.textContent = `条件 ${selected.index + 1}：${selectedText.subject}；要求：${selectedText.requirement}。校验：${data.checks[selected.index].detail}`;
  const scroll = el.strategyMap.querySelector('.strategy-map-scroll');
  scroll.scrollLeft = scrollLeft;
  if (x(selected.end) < scrollLeft + 40 || x(selected.start) > scrollLeft + scroll.clientWidth - 40) scroll.scrollLeft = Math.max(0, (x(selected.start) + x(selected.end)) / 2 - scroll.clientWidth / 2);
}
