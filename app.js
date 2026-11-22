/* global Market */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const SAVE_KEY = 'ashare-simulator-v1';
  const BACKUP_KEY = `${SAVE_KEY}-backup`;
  const integer = new Intl.NumberFormat('zh-CN');
  const currency = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' });
  const money = value => currency.format(value / 100);
  const price = value => (value / 100).toFixed(2);
  const signedPrice = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${price(Math.abs(value))}`;
  const compactNumber = value => value >= 1e8 ? `${(value / 1e8).toFixed(2)}亿` :
    value >= 1e4 ? `${(value / 1e4).toFixed(2)}万` : integer.format(value);
  const percent = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}${(Math.abs(n) * 100).toFixed(2)}%`;
  const colorOf = n => n > 0 ? 'up' : n < 0 ? 'down' : '';
  const text = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const { open, morningEnd, afternoonOpen, close } = Market.HOURS;
  const minutesPerSecond = 5;
  const tickDelay = 1000 * Market.HOURS.tick / minutesPerSecond;
  const volumeInterval = 5;
  const statusLabels = { filled: '已成交', canceled: '已撤单', expired: '收盘失效', self: '自成交拦截', waiting: '等待触发', conditionFailed: '触发失败' };
  const defaultWatch = ['SIM03', 'SIM04', 'SIM01', 'SIM02', 'SIM05'];
  const defaultPeriod = () => matchMedia('(max-width: 760px)').matches ? 'intraday' : 'day';
  let previousSave = null;
  let storageNotice = '';
  let state = load();
  let selected = state.stocks.some(item => item.id === state.viewedStock) ? state.viewedStock : 'SIM03';
  let side = 'buy';
  let holdingsOnly = false;
  let accountView = 'positions';
  let tradeView = 'positions';
  let bookView = 'ladder';
  let stockSort = 'default';
  let sortDirection = -1;
  let page = 'watch';
  let listPage = 'watch';
  let detailTab = 'chart';
  let period = defaultPeriod();
  let selectedNewsOnly = false;
  let newsView = 'news';
  let relatedNewsView = 'news';
  let chartPointer = null;
  let chartPoints = [];
  let visibleChipView = null;
  let dayPriceAxis = null;
  let dailySide = 'chips';
  let chartRight = 0;
  let chartLeft = 0;
  let autoPrice = true;
  let toastTimer;
  let clockTimer;
  let nextTickAt = null;
  let resumeAfterDialog = false;
  const renderedNews = new Map();

  function load() {
    try {
      let found = false;
      for (const key of [SAVE_KEY, BACKUP_KEY]) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        found = true;
        try {
          const restored = Market.deserialize(raw);
          previousSave = raw;
          storageNotice = key === BACKUP_KEY ? '已从上一个完整存档恢复' : '已读取本机存档';
          return restored;
        } catch { /* Recover from the previous successful snapshot when possible. */ }
      }
      storageNotice = found ? '存档无法读取，可导入备份' : '本地自动存档';
    } catch {
      storageNotice = '浏览器存档受限，请导出备份';
    }
    return Market.create();
  }

  function save() {
    state.viewedStock = selected;
    const raw = JSON.stringify(state);
    try {
      if (raw === previousSave && localStorage.getItem(SAVE_KEY) === raw) return true;
      localStorage.setItem(SAVE_KEY, raw);
    } catch {
      storageNotice = '自动保存失败，请导出存档';
      $('save-status').textContent = storageNotice;
      return false;
    }
    if (previousSave) {
      try { localStorage.setItem(BACKUP_KEY, previousSave); } catch { /* The complete current snapshot was already saved. */ }
    }
    previousSave = raw;
    storageNotice = `已保存 · 第 ${state.day} 日`;
    $('save-status').textContent = storageNotice;
    return true;
  }

  function announce(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3300);
  }

  const current = () => state.stocks.find(stock => stock.id === selected) ?? state.stocks[0];
  const label = symbol => state.stocks.find(stock => stock.id === symbol)?.name ?? symbol;
  const code = symbol => Market.stockCode(symbol);
  const change = stock => stock.price / Math.max(stock.prevClose, 1) - 1;
  const watchSymbols = () => Array.isArray(state.watchSymbols) ? state.watchSymbols : defaultWatch;
  const timeLabel = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const sessionOpen = () => !state.ended && state.phase > 0 && state.phase < 3;
  const hasTicket = () => ['buy', 'sell', 'conditions'].includes(tradeView);
  const hasTrigger = () => ['above', 'below'].includes($('order-kind').value);
  const protectionStocks = () => state.stocks.filter(stock => stock.status === 'active' && Market.position(state, 'player', stock.id).shares > 0);

  function protectionPrices(plan) {
    const prices = [];
    if (plan.takeProfit !== null) prices.push(`止盈 ≥ ${price(plan.takeProfit)}`);
    if (plan.stopLoss !== null) prices.push(`止损 ≤ ${price(plan.stopLoss)}`);
    return prices;
  }

  function positionFigures(stock, holding) {
    const profit = stock.price * holding.shares - holding.cost;
    return { cost: price(holding.cost / holding.shares), amount: `${profit > 0 ? '+' : ''}${money(profit)}`,
      rate: holding.cost ? percent(profit / holding.cost) : '—', tone: colorOf(profit) };
  }

  function metric(name, amount, detail = '', color = '') {
    return `<div class="metric"><span class="metric-label">${text(name)}</span><strong class="${color}">${text(amount)}</strong><small>${text(detail)}</small></div>`;
  }

  function renderMetrics() {
    const equity = Market.netWorth(state);
    const index = Market.indexValue(state);
    const movement = index / state.indexPrev - 1;
    const breadth = Market.breadth(state);
    const secondary = `${breadth.flat} 平${breadth.suspended ? ` · ${breadth.suspended} 停牌` : ''}`;
    $('metrics').innerHTML = [
      metric('市场指数', index.toFixed(2), `${percent(movement)} 今日`, colorOf(movement)),
      metric('涨跌家数', `${breadth.up} 涨 / ${breadth.down} 跌`, secondary),
    ].join('');
    if (page === 'trade') {
      const cash = state.actors.player.cash;
      const marketValue = equity - cash;
      const bookCost = Object.values(state.actors.player.positions).reduce((sum, holding) => sum + holding.cost, 0);
      const profit = marketValue - bookCost;
      const dayStart = state.journal.findLast(item => item.day < state.day)?.equity ?? Market.START_CASH;
      const free = Market.buyPower(state);
      $('trade-metrics').innerHTML = [
        metric('总资产', money(equity)), metric('持仓盈亏', money(profit), bookCost ? percent(profit / bookCost) : '', colorOf(profit)),
        metric('今日盈亏', money(equity - dayStart), '', colorOf(equity - dayStart)), metric('持仓市值', money(marketValue)),
        metric('可用资金', money(free)), metric('委托占用', money(cash - free)),
      ].join('');
    }
  }

  function renderStocks() {
    const listed = state.stocks.filter(stock => stock.status !== 'delisted');
    const query = $('stock-search').value.trim().toLowerCase();
    const watch = listPage === 'watch';
    const favorites = watchSymbols();
    let stocks = listed.filter(stock => holdingsOnly ? Market.position(state, 'player', stock.id).shares > 0 :
      !watch || query || favorites.includes(stock.id));
    if (query) stocks = stocks.filter(stock => `${stock.name} ${code(stock.id)} ${stock.theme} ${stock.sector}`.toLowerCase().includes(query));
    else if (watch && !holdingsOnly) stocks.sort((a, b) => favorites.indexOf(a.id) - favorites.indexOf(b.id));
    if (!holdingsOnly && stockSort !== 'default') {
      const value = stockSort === 'price' ? stock => stock.price : stockSort === 'percent' ? change : stock => stock.price - stock.prevClose;
      stocks.sort((a, b) => sortDirection * (value(a) - value(b)));
    }
    for (const button of $('stock-sort').querySelectorAll('[data-sort]')) {
      const active = button.dataset.sort === stockSort;
      button.setAttribute('aria-pressed', String(active));
      button.dataset.direction = active && stockSort !== 'default' ? (sortDirection < 0 ? 'descending' : 'ascending') : '';
    }
    $('market-heading').textContent = watch ? '自选' : '行情';
    $('stock-count').textContent = `${stocks.length} 只`;
    $('all-stocks').textContent = watch ? '我的自选' : '全部股票';
    $('all-stocks').setAttribute('aria-pressed', String(!holdingsOnly));
    $('held-stocks').setAttribute('aria-pressed', String(holdingsOnly));
    $('stock-sort').hidden = holdingsOnly;
    $('holding-heading').hidden = !holdingsOnly;
    const list = $('stock-list');
    const listKey = `${holdingsOnly ? 'holdings' : 'quotes'}:${stocks.map(stock => stock.id).join(',')}`;
    if (!stocks.length) {
      list.dataset.symbols = '';
      const message = query ? '未找到匹配股票。' : holdingsOnly ? '暂无持仓。' : '暂无自选。可在行情中选择股票，再加入自选。';
      if (list.textContent !== message) list.innerHTML = `<p class="empty">${message}</p>`;
      return;
    }
    if (list.dataset.symbols !== listKey) {
      list.dataset.symbols = listKey;
      const extra = holdingsOnly ? '<span><span data-field></span><small class="muted"></small></span>' : '<span></span>';
      list.innerHTML = stocks.map(stock => `<button type="button" class="stock-row${holdingsOnly ? ' holding-columns' : ''}" data-symbol="${text(stock.id)}">
        <span class="stock-name"><strong></strong><small class="muted"></small></span>
        ${extra.repeat(3)}</button>`).join('');
    }
    stocks.forEach((stock, index) => {
      const row = list.children[index];
      const [name, quote, gain, amount] = row.children;
      row.setAttribute('aria-pressed', String(stock.id === selected));
      name.firstElementChild.textContent = stock.name;
      name.lastElementChild.textContent = holdingsOnly ? code(stock.id) : `${code(stock.id)} · ${stock.theme}`;
      if (holdingsOnly) {
        const holding = Market.position(state, 'player', stock.id);
        const figures = positionFigures(stock, holding);
        const available = Market.sellable(state, stock.id);
        quote.firstElementChild.textContent = integer.format(holding.shares);
        quote.lastElementChild.textContent = `可卖 ${integer.format(available)}`;
        gain.firstElementChild.textContent = figures.cost;
        gain.lastElementChild.textContent = price(stock.price);
        amount.firstElementChild.textContent = figures.amount;
        amount.lastElementChild.textContent = figures.rate;
        amount.className = `number ${figures.tone}`;
        row.setAttribute('aria-label', `${stock.name} ${code(stock.id)}，持股 ${holding.shares} 股，可卖 ${available} 股，每股成本 ${figures.cost} 元，现价 ${price(stock.price)} 元，浮动盈亏 ${figures.amount}，${figures.rate}`);
        return;
      }
      const movement = change(stock);
      const css = colorOf(movement);
      const delta = stock.price - stock.prevClose;
      quote.className = `stock-price number ${css}`;
      quote.textContent = price(stock.price);
      gain.className = `percent-chip number ${css}`;
      gain.textContent = stock.status === 'suspended' ? '停牌' : percent(movement);
      amount.className = `absolute-change number ${css}`;
      amount.textContent = signedPrice(delta);
    });
  }

  function renderQuote(stock) {
    $('symbol-title').textContent = stock.name;
    const stockStatus = stock.status === 'suspended' ? ' · 停牌' : stock.status === 'delisted' ? ' · 退市' : '';
    const crowdLabel = stock.session.crowd ? ' · 早盘放量' : '';
    $('symbol-meta').textContent = [code(stock.id), ...new Set([stock.sector, stock.theme])].join(' · ') + stockStatus + crowdLabel;
    $('symbol-price').textContent = price(stock.price);
    const movement = change(stock);
    $('symbol-price').className = colorOf(movement);
    $('symbol-change').className = colorOf(movement);
    $('symbol-change').textContent = `${signedPrice(stock.price - stock.prevClose)}  ${percent(movement)}`;
    const session = stock.session;
    const stats = [['高', '最高价', session.open === null ? '—' : price(session.high)], ['开', '开盘价', session.open === null ? '—' : price(session.open)],
      ['额', '成交额（元）', session.amount === null ? '—' : compactNumber(session.amount / 100)],
      ['低', '最低价', session.open === null ? '—' : price(session.low)], ['昨', '昨收价', price(stock.prevClose)],
      ['量', '成交量（股）', compactNumber(session.volume)]];
    $('quote-stats').innerHTML = stats.map(([key, title, value]) => `<div title="${title}"><dt aria-label="${title}">${key}</dt><dd>${value}</dd></div>`).join('');
    const average = session.volume && session.amount !== null ? price(session.amount / session.volume) : '—';
    $('chart-key').innerHTML = period === 'intraday' ? `<span class="latest-key">最新 <b>${price(stock.price)}</b></span><span class="average-key">均价 <b>${average}</b></span>` :
      `<span>最新 <b>${price(stock.price)}</b></span>`;
    const favorite = watchSymbols().includes(stock.id);
    $('favorite').setAttribute('aria-pressed', String(favorite));
    $('favorite').innerHTML = favorite ? '<span aria-hidden="true">★</span> 已自选' : '<span aria-hidden="true">☆</span> 加自选';
    $('quote-buy').disabled = stock.status !== 'active';
    $('quote-sell').disabled = stock.status !== 'active';
    const markerDescription = period === 'week' ? '' : '图中标注本人买卖成交。逐笔明细可在交易页查看。';
    $('chart').setAttribute('aria-label', `${stock.name}${period === 'intraday' ? '分时走势' : period === 'week' ? '周 K 线' : '日 K 线'}。最新价 ${price(stock.price)} 元，今日 ${percent(movement)}。${markerDescription}`);
    drawChart();
  }

  const showingDayChips = () => detailTab === 'chart' && period === 'day' && dailySide === 'chips';

  function renderDayChips(hovered, priceChart) {
    const axis = dayPriceAxis;
    if (!axis) return;
    const stock = current();
    const latest = stock.history.at(-1);
    const candle = hovered ?? (state.phase === 3 && latest?.day === state.day && latest.chips ? latest : null);
    const historical = candle && !(candle.day === state.day && state.phase < 3);
    const bar = historical ? candle : null;
    if (visibleChipView?.axis === axis && visibleChipView.bar === bar) return;
    const mark = historical ? candle.close : stock.price;
    const markLabel = historical ? '收盘' : '现价';
    const sessionLabel = state.phase === 0 ? '盘前' : state.phase === 3 ? '当前' : '盘中';
    $('chip-date').textContent = historical ? `${candleDate(candle.day)} · 收盘` : `${candleDate(state.day)} · ${sessionLabel}`;
    const snapshot = historical ? candle.chips : axis.liveChips;
    const stats = $('chip-stats');
    stats.innerHTML = `<div><dt>平均成本</dt><dd>${snapshot ? price(snapshot.average) : '—'}</dd></div>
      <div><dt>获利比例</dt><dd>${snapshot ? `${(snapshot.profit * 100).toFixed(2)}%` : '—'}</dd></div>
      <div><dt>90% 成本区间</dt><dd>${snapshot ? `${price(snapshot.range[0])}–${price(snapshot.range[1])}` : '—'}</dd></div>`;
    const empty = $('chip-empty');
    empty.hidden = Boolean(snapshot);
    empty.textContent = historical ? '该日无筹码快照' : '暂无筹码数据';
    const canvas = $('chip-chart');
    canvas.title = '';
    canvas.setAttribute('aria-label', snapshot ?
      `筹码分布，${markLabel}价 ${price(mark)} 元，共 ${integer.format(snapshot.total)} 股。与日 K 共用价格轴。` : empty.textContent);
    const { width, height, top } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    const offset = priceChart.top - top;
    visibleChipView = { axis, bar, snapshot, offset };
    const ctx = sizeCanvas(canvas, width, height);
    const y = value => axis.y(value) + offset;
    ctx.strokeStyle = axis.colors.grid;
    for (const tick of axis.ticks) {
      const row = y(tick);
      ctx.beginPath();
      ctx.moveTo(0, row);
      ctx.lineTo(width, row);
      ctx.stroke();
    }
    if (snapshot) drawChipMountain(ctx, snapshot, mark, historical, axis, offset, width, height);
  }

  function sizeCanvas(canvas, width, height) {
    const ratio = Math.min(devicePixelRatio, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(canvas.width / width, canvas.height / height);
    return ctx;
  }

  function drawChipMountain(ctx, snapshot, mark, historical, axis, offset, width, height) {
    const { low, step, bands } = snapshot;
    const y = value => axis.y(value) + offset;
    const base = 0.5;
    const points = [[low - 0.5, 0]];
    for (const [i, band] of bands.entries()) {
      const start = low + i * step;
      const end = start + step - 1;
      if (start <= mark && mark <= end) {
        if (start < mark) points.push([(start + mark - 1) / 2, band[0]]);
        points.push([mark, band[1]]);
        if (mark < end) points.push([(mark + 1 + end) / 2, band[2]]);
      } else points.push([(start + end) / 2, band[0] + band[1] + band[2]]);
    }
    points.push([low + bands.length * step - 0.5, 0]);
    const peak = Math.max(...points.map(point => point[1]));
    const top = axis.top + offset;
    const bottom = axis.bottom + offset;
    const samples = points.map(([cost, count]) => [y(cost), count]).reverse();
    const shoulder = 4;
    const rows = new Set(samples.map(([row]) => row));
    const firstRow = Math.max(top, samples[0][0] - shoulder);
    const lastRow = Math.min(bottom, samples.at(-1)[0] + shoulder);
    rows.add(firstRow);
    rows.add(lastRow);
    for (let row = Math.ceil(firstRow); row < lastRow; row += 1) rows.add(row);
    let next = 1;
    const ridge = [...rows].filter(row => row >= firstRow && row <= lastRow).sort((a, b) => a - b).map(row => {
      while (next < samples.length - 1 && samples[next][0] < row) next += 1;
      const [from, a] = samples[next - 1];
      const [to, b] = samples[next];
      let count = row >= from && row <= to ? a + (b - a) * (row - from) / (to - from) : 0;
      // Give a cost level narrower than a few screen pixels a visible slope without shifting its peak price.
      for (const [at, shares] of samples) {
        const distance = Math.abs(at - row);
        if (distance < shoulder) count = Math.max(count, shares * (1 - distance / shoulder));
      }
      return [base + count / peak * (width - 4), row];
    });
    const stop = value => Math.max(0, Math.min(1, (y(value) - top) / (bottom - top)));
    const gradient = ctx.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, axis.colors.down);
    gradient.addColorStop(stop(mark + 0.5), axis.colors.down);
    gradient.addColorStop(stop(mark + 0.5), axis.colors.baseline);
    gradient.addColorStop(stop(mark - 0.5), axis.colors.baseline);
    gradient.addColorStop(stop(mark - 0.5), axis.colors.up);
    gradient.addColorStop(1, axis.colors.up);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, width, bottom - top);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(base, firstRow);
    for (const [x, row] of ridge) ctx.lineTo(x, row);
    ctx.lineTo(base, lastRow);
    ctx.closePath();
    ctx.globalAlpha = 0.76;
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = gradient;
    ctx.stroke();
    ctx.restore();

    const row = y(mark);
    ctx.strokeStyle = axis.colors.line;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, row);
    ctx.lineTo(width, row);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = `${historical ? '收' : '现'} ${price(mark)}`;
    ctx.font = '11px sans-serif';
    const labelWidth = ctx.measureText(label).width + 8;
    const labelTop = Math.max(0, Math.min(height - 16, row - 8));
    ctx.fillStyle = axis.colors.line;
    ctx.fillRect(width - labelWidth, labelTop, labelWidth, 16);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'right';
    ctx.fillText(label, width - 4, labelTop + 12);
  }

  function drawChart() {
    const canvas = $('chart');
    const { width, height } = canvas.getBoundingClientRect();
    chartPoints = [];
    dayPriceAxis = null;
    $('chart-tooltip').hidden = $('chart-crosshair').hidden = true;
    if (width < 100 || height < 100) return;
    const ctx = sizeCanvas(canvas, width, height);
    const stock = current();
    const style = getComputedStyle(canvas);
    const colors = {
      grid: style.getPropertyValue('--border').trim(),
      muted: style.getPropertyValue('--muted').trim(),
      line: style.getPropertyValue('--chart-price').trim(),
      baseline: style.getPropertyValue('--chart-baseline').trim(),
      average: style.getPropertyValue('--average').trim(),
      up: style.getPropertyValue('--up').trim(),
      down: style.getPropertyValue('--down').trim(),
    };
    if (period === 'intraday') {
      const marks = tradeMarkers(stock.id, fill => {
        if (fill.day === state.day && Number.isInteger(fill.minute) && fill.minute <= state.minute &&
          ((fill.minute >= open && fill.minute <= morningEnd) || (fill.minute >= afternoonOpen && fill.minute <= close))) return fill.minute;
      });
      drawIntraday(ctx, stock, width, height, colors, marks);
      inspectChart();
      return;
    }
    const allDays = stock.history.slice();
    if (state.phase !== 3 && stock.session.open !== null) allDays.push({ day: state.day, close: stock.price, ...stock.session });
    const series = period === 'week' ? weekly(allDays) : allDays;
    const candles = series.slice(-Market.CHART_CANDLES);
    let max = candles.length ? Math.max(...candles.map(candle => candle.high)) : stock.price;
    let min = candles.length ? Math.min(...candles.map(candle => candle.low)) : stock.price;
    const liveChips = period === 'day' ? Market.chipSnapshot(state, stock) : null;
    if (period === 'day') {
      // Keep one range while moving between dates, including the cost levels outside the K-line range.
      min = Math.min(min, stock.price);
      max = Math.max(max, stock.price);
      for (const snapshot of [liveChips, ...candles.map(candle => candle.chips)]) {
        if (!snapshot) continue;
        const hasShares = band => band[0] || band[1] || band[2];
        const first = snapshot.bands.findIndex(hasShares);
        const last = snapshot.bands.findLastIndex(hasShares);
        min = Math.min(min, snapshot.low + first * snapshot.step);
        max = Math.max(max, snapshot.low + (last + 1) * snapshot.step - 1);
      }
    }
    const pad = Math.max(2, (max - min) * 0.09);
    const lower = Math.max(0, min - pad);
    const upper = max + pad;
    const chartTop = 14;
    const chartBottom = height - 62;
    const volumeBottom = height - 17;
    const usableWidth = width - 50;
    const step = usableWidth / Math.max(candles.length, 6);
    const x = i => (i + 0.5) * step;
    const y = mark => chartTop + (upper - mark) / (upper - lower) * (chartBottom - chartTop);
    const ticks = Array.from(new Set(Array.from({ length: 4 }, (_, i) => Math.round(lower + (upper - lower) * i / 3))));
    if (period === 'day') dayPriceAxis = { y, lower, upper, top: chartTop, bottom: chartBottom, ticks, colors, liveChips };
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    for (const mark of ticks) {
      const gridY = y(mark);
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      ctx.moveTo(0, gridY);
      ctx.lineTo(usableWidth + 5, gridY);
      ctx.stroke();
      ctx.fillStyle = colors.muted;
      ctx.fillText(price(mark), width - 1, gridY + 3);
    }
    if (!candles.length) {
      ctx.fillStyle = colors.muted;
      ctx.textAlign = 'left';
      ctx.font = '13px sans-serif';
      ctx.fillText('等待挂牌后的首笔成交', 10, 32);
      inspectChart();
      return;
    }
    const highestVolume = Math.max(1, ...candles.map(candle => candle.volume));
    const barWidth = Math.min(15, Math.max(3, step * .62));
    candles.forEach((candle, i) => {
      const center = x(i);
      ctx.strokeStyle = ctx.fillStyle = candle.close >= candle.open ? colors.up : colors.down;
      ctx.beginPath();
      ctx.moveTo(center, y(candle.high));
      ctx.lineTo(center, y(candle.low));
      ctx.stroke();
      ctx.fillRect(center - barWidth / 2, Math.min(y(candle.open), y(candle.close)), barWidth, Math.max(1.5, Math.abs(y(candle.open) - y(candle.close))));
      ctx.globalAlpha = 0.43;
      const size = Math.max(1, candle.volume / highestVolume * 31);
      ctx.fillRect(center - barWidth / 2, volumeBottom - size, barWidth, size);
      ctx.globalAlpha = 1;
      if (i === candles.length - 1 || (i > 1 && i < candles.length - 3 && i % 5 === 0)) {
        ctx.textAlign = 'center';
        ctx.fillStyle = colors.muted;
        ctx.fillText(candleDate(candle.day), center, height - 3);
      }
    });
    if (period === 'day') {
      const slots = new Map(candles.map((candle, i) => [candle.day, i]));
      const marks = tradeMarkers(stock.id, fill => slots.get(fill.day));
      drawTradeMarkers(ctx, marks, x, y, { left: 0, right: usableWidth, top: 0, bottom: chartBottom + 7 }, colors);
    }
    chartLeft = 0;
    chartRight = candles.length * step;
    chartPoints = candles.map((candle, i) => {
      const previous = series[series.length - candles.length + i - 1]?.close ??
        (period === 'day' && candle.day === state.day ? stock.prevClose : undefined);
      const heading = period === 'week' && candle.firstDay !== candle.day ? `${candleDate(candle.firstDay)}–${candleDate(candle.day)}` : candleDate(candle.day);
      return { x: x(i), y: y(candle.close), heading, candle, rows: () => [
        ['开盘', price(candle.open)], ['最高', price(candle.high)], ['最低', price(candle.low)],
        [candle.day === state.day && state.phase < 3 ? '最新' : '收盘', price(candle.close)],
        ['涨跌幅', previous > 0 ? percent(candle.close / previous - 1) : '—', previous > 0 ? colorOf(candle.close - previous) : ''],
        ['成交量', `${compactNumber(candle.volume)} 股`],
      ] };
    });
    inspectChart();
  }

  const candleDate = day => day > 0 ? `第${day}日` : day < 0 ? `前${-day}日` : '前收';

  function inspectChart() {
    const tooltip = $('chart-tooltip');
    const guide = $('chart-crosshair');
    const rect = $('chart').getBoundingClientRect();
    let point = null;
    if (chartPointer && chartPoints.length) {
      const pointerX = chartPointer.x - rect.left;
      const pointerY = chartPointer.y - rect.top;
      if (pointerX >= chartLeft - 2 && pointerX <= chartRight + 2 && pointerY >= 0 && pointerY <= rect.height) {
        point = chartPoints.reduce((best, candidate) => Math.abs(candidate.x - pointerX) < Math.abs(best.x - pointerX) ? candidate : best);
      }
    }
    if (showingDayChips()) renderDayChips(point?.candle, rect);
    if (!point) {
      tooltip.hidden = guide.hidden = true;
      return;
    }
    guide.style.setProperty('--chart-x', `${point.x}px`);
    guide.style.setProperty('--chart-y', `${point.y}px`);
    guide.style.setProperty('--chart-left', `${chartLeft}px`);
    guide.style.setProperty('--chart-right', `${Math.max(0, rect.width - chartRight)}px`);
    tooltip.innerHTML = `<strong>${text(point.heading)}</strong><dl>${point.rows().map(([name, value, tone]) =>
      `<dt>${text(name)}</dt><dd class="${tone ?? ''}">${text(value)}</dd>`).join('')}</dl>`;
    tooltip.style.left = point.x > rect.width / 2 ? '4px' : '';
    tooltip.style.right = point.x > rect.width / 2 ? '' : '4px';
    tooltip.hidden = guide.hidden = false;
  }

  function tradeMarkers(symbol, slotOf) {
    const groups = new Map();
    for (const fill of state.fills) {
      if (fill.symbol !== symbol || fill.quantity <= 0 || (fill.side !== 'buy' && fill.side !== 'sell')) continue;
      const slot = slotOf(fill);
      if (slot === undefined) continue;
      const key = `${slot}:${fill.side}`;
      const group = groups.get(key) ?? { slot, side: fill.side, shares: 0, turnover: 0 };
      group.shares += fill.quantity;
      group.turnover += fill.price * fill.quantity;
      groups.set(key, group);
    }
    return [...groups.values()].map(group => ({ slot: group.slot, side: group.side, price: group.turnover / group.shares }));
  }

  function drawTradeMarkers(ctx, marks, x, y, bounds, colors) {
    const size = 14;
    const points = marks.map(mark => ({ px: x(mark.slot), py: y(mark.price), buying: mark.side === 'buy' }));
    const labels = [];
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    for (const { px, py, buying } of points) {
      const color = buying ? colors.up : colors.down;
      const direction = buying ? 1 : -1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px - 3, py + direction * 5);
      ctx.lineTo(px + 3, py + direction * 5);
      ctx.fill();

      const left = Math.max(bounds.left, Math.min(px - size / 2, bounds.right - size));
      const above = Math.max(bounds.top, py - size - 4);
      const below = Math.min(bounds.bottom - size, py + 4);
      const top = buying ? below : above;
      const options = [[left, top], [left, buying ? above : below], [left + size + 2, top], [left - size - 2, top]];
      const spot = options.find(([l, t]) => l >= bounds.left && l + size <= bounds.right && t >= bounds.top && t + size <= bounds.bottom &&
        !labels.some(label => Math.abs(l - label.left) < size + 2 && Math.abs(t - label.top) < size + 1) &&
        !points.some(point => point.px >= l && point.px <= l + size && point.py >= t && point.py <= t + size));
      if (spot) labels.push({ left: spot[0], top: spot[1], px, py, buying, color });
    }
    for (const label of labels) {
      ctx.strokeStyle = label.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(label.px, label.py);
      ctx.lineTo(Math.max(label.left, Math.min(label.px, label.left + size)), Math.max(label.top, Math.min(label.py, label.top + size)));
      ctx.stroke();
    }
    for (const label of labels) {
      ctx.fillStyle = label.color;
      ctx.fillRect(label.left, label.top, size, size);
      ctx.fillStyle = '#fff';
      ctx.fillText(label.buying ? '买' : '卖', label.left + size / 2, label.top + 11);
    }
  }

  function weekly(days) {
    const groups = new Map();
    for (const day of days) {
      const key = Math.floor((day.day - 1) / 5);
      const group = groups.get(key);
      if (!group) groups.set(key, { ...day, firstDay: day.day });
      else {
        group.day = day.day;
        group.close = day.close;
        group.high = Math.max(group.high, day.high);
        group.low = Math.min(group.low, day.low);
        group.volume += day.volume;
      }
    }
    return [...groups.values()];
  }

  function drawIntraday(ctx, stock, width, height, colors, marks = []) {
    const ticks = stock.session.ticks ?? [];
    const reference = stock.prevClose;
    ctx.font = '11px sans-serif';
    if (reference <= 0) {
      ctx.fillStyle = colors.muted;
      ctx.fillText('暂无分时数据', 8, 22);
      return;
    }

    const firstTrade = ticks.findIndex(tick => tick.volume > 0);
    const trades = firstTrade < 0 ? [] : ticks.slice(firstTrade);
    const averages = [];
    if (stock.session.amount !== null && ticks.every(tick => Number.isFinite(tick.amount))) {
      let volume = 0;
      let amount = 0;
      for (const tick of ticks) {
        volume += tick.volume;
        amount += tick.amount;
        if (volume > 0) averages.push({ minute: tick.minute, price: amount / volume });
      }
    }

    const prices = [stock.session.high, stock.session.low, ...trades.map(point => point.close),
      ...averages.map(point => point.price), ...marks.map(mark => mark.price)];
    const swing = Math.max(2, reference * 0.01, ...prices.map(value => Math.abs(value - reference) * 1.06));
    const range = Math.min(reference, Math.ceil(swing));
    const axis = [1, 0, -1].map(direction => {
      const offset = range * direction;
      return { value: reference + offset, change: percent(offset / reference), color: direction > 0 ? colors.up : direction < 0 ? colors.down : colors.muted };
    });
    const left = Math.ceil(Math.max(...axis.map(mark => ctx.measureText(price(mark.value)).width))) + 5;
    const right = width - Math.ceil(Math.max(...axis.map(mark => ctx.measureText(mark.change).width))) - 5;
    const top = 10;
    const volumeTop = Math.floor(height * 0.73);
    const bottom = volumeTop - 17;
    const volumeGridTop = volumeTop + 13;
    const volumeBottom = height - 3;
    const morningDuration = morningEnd - open;
    const afternoonStart = morningDuration + volumeInterval;
    const duration = afternoonStart + close - afternoonOpen;
    // Leave one plotting interval between the two sessions so 11:30 and 13:00 do not overlap.
    const x = minute => left + (minute < afternoonOpen ? minute - open : afternoonStart + minute - afternoonOpen) / duration * (right - left);
    const y = value => top + (axis[0].value - value) / (axis[0].value - axis[2].value) * (bottom - top);
    const line = (x1, y1, x2, y2) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };

    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const column = left + (right - left) * i / 4;
      const row = top + (bottom - top) * i / 4;
      line(column, top, column, bottom);
      line(column, volumeGridTop, column, volumeBottom);
      if (i !== 2) line(left, row, right, row);
    }
    line(left, volumeBottom, right, volumeBottom);
    ctx.strokeStyle = colors.baseline;
    ctx.setLineDash([3, 3]);
    line(left, y(reference), right, y(reference));
    ctx.setLineDash([]);

    for (const mark of axis) {
      const labelY = y(mark.value) + 3;
      ctx.fillStyle = mark.color;
      ctx.textAlign = 'right';
      ctx.fillText(price(mark.value), left - 4, labelY);
      ctx.textAlign = 'left';
      ctx.fillText(mark.change, right + 4, labelY);
    }
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'center';
    for (const minute of [open, morningEnd, close]) ctx.fillText(timeLabel(minute), x(minute), volumeTop - 4);
    ctx.textAlign = 'left';
    ctx.fillText('5 分钟量', left, volumeTop + 10);
    const volumeBars = [];
    for (const tick of trades) {
      if (!tick.volume) continue;
      const start = tick.minute < afternoonOpen ? open : afternoonOpen;
      const minute = start + Math.floor((tick.minute - start) / volumeInterval) * volumeInterval;
      const bar = volumeBars.at(-1);
      if (bar?.minute === minute) {
        bar.volume += tick.volume;
        bar.close = tick.close;
      } else volumeBars.push({ minute, volume: tick.volume, close: tick.close });
    }
    const highestVolume = Math.max(0, ...volumeBars.map(bar => bar.volume));
    if (highestVolume > 0) {
      ctx.textAlign = 'right';
      ctx.fillText(compactNumber(highestVolume), right, volumeTop + 10);
    }

    const plot = (points, getPrice, color, thickness) => {
      if (!points.length) return;
      ctx.strokeStyle = ctx.fillStyle = color;
      ctx.lineWidth = thickness;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x(points[0].minute), y(getPrice(points[0])));
      for (const point of points.slice(1)) ctx.lineTo(x(point.minute), y(getPrice(point)));
      ctx.stroke();
      const last = points.at(-1);
      ctx.beginPath();
      ctx.arc(x(last.minute), y(getPrice(last)), thickness, 0, Math.PI * 2);
      ctx.fill();
    };
    plot(averages, point => point.price, colors.average, 1.1);
    plot(trades, point => point.close, colors.line, 1.5);

    const barWidth = Math.max(1, (right - left) / (duration / volumeInterval) * 0.72);
    let previous = reference;
    for (const bar of volumeBars) {
      ctx.fillStyle = bar.close > previous ? colors.up : bar.close < previous ? colors.down : colors.muted;
      const barHeight = Math.max(1, bar.volume / highestVolume * (volumeBottom - volumeGridTop));
      ctx.globalAlpha = 0.78;
      ctx.fillRect(x(bar.minute) - barWidth / 2, volumeBottom - barHeight, barWidth, barHeight);
      ctx.globalAlpha = 1;
      previous = bar.close;
    }
    drawTradeMarkers(ctx, marks, x, y, { left, right, top: 0, bottom: bottom + 9 }, colors);
    const averageByMinute = new Map(averages.map(point => [point.minute, point.price]));
    chartLeft = left;
    chartRight = trades.length ? x(trades.at(-1).minute) : left;
    chartPoints = trades.map(tick => ({ x: x(tick.minute), y: y(tick.close), heading: timeLabel(tick.minute), rows: () => [
      ['最新价', price(tick.close)], ['均价', averageByMinute.has(tick.minute) ? price(averageByMinute.get(tick.minute)) : '—'],
      ['涨跌幅', percent(tick.close / reference - 1), colorOf(tick.close - reference)],
      ['分钟量', `${compactNumber(tick.volume)} 股`], ['分钟额', Number.isFinite(tick.amount) ? `${compactNumber(tick.amount / 100)} 元` : '—'],
    ] }));
    if (!trades.length && !marks.length) {
      ctx.fillStyle = colors.muted;
      ctx.textAlign = 'center';
      ctx.fillText('等待本日成交', (left + right) / 2, top + 17);
    }
  }

  function renderNews() {
    const stock = current();
    const related = state.news.filter(item => item.symbol === selected || (!item.symbol && newsTopic(item) === stock.theme));
    for (const [id, view] of [['news-channels', newsView], ['related-channels', relatedNewsView]]) {
      for (const button of $(id).querySelectorAll('[data-channel]')) button.setAttribute('aria-pressed', String(button.dataset.channel === view));
    }
    $('all-news').setAttribute('aria-pressed', String(!selectedNewsOnly));
    $('selected-news').setAttribute('aria-pressed', String(selectedNewsOnly));
    fillNews('news', (selectedNewsOnly ? related : state.news).filter(item => Market.newsChannel(item) === newsView).slice(0, 30));
    fillNews('related-news', related.filter(item => Market.newsChannel(item) === relatedNewsView).slice(0, 15));
  }

  function newsTopic(item) {
    if (item.topic) return item.topic;
    return state.stocks.find(stock => item.title.startsWith(stock.theme))?.theme ?? (item.type === '政策' ? '高股息' : '全市场资金');
  }

  function fillNews(id, items) {
    const container = $(id);
    const previous = renderedNews.get(id);
    if (previous?.length === items.length && items.every((item, i) => item === previous[i])) return;
    renderedNews.set(id, items);
    const openItems = new Set([...container.querySelectorAll('details[open]')].map(node => node.dataset.news));
    container.innerHTML = items.map(item => {
      const forum = Market.newsChannel(item) === 'forum';
      const target = item.symbol ? `${label(item.symbol)} · ${code(item.symbol)}` : newsTopic(item);
      const scope = forum ? `${item.source ?? '股友'} · 未经证实` : target;
      return `<details class="news-item" data-news="${Number(item.id)}" ${openItems.has(String(item.id)) ? 'open' : ''}>
        <summary><span class="news-type">${text(item.type)}</span><span class="news-title">${text(item.title)}<small class="news-target">${text(scope)}</small></span><span class="news-day">第 ${Number(item.day)} 日</span></summary>
        ${item.source && !forum ? `<p class="news-meta">来源 ${text(item.source)}</p>` : ''}<p class="news-body">${text(item.body)}</p></details>`;
    }).join('') || '<p class="empty">此栏目暂无相关内容。</p>';
  }

  function renderBook(stock) {
    const container = $('book');
    const changed = container.dataset.mode !== bookView;
    container.dataset.mode = bookView;
    for (const button of $('book-tabs').querySelectorAll('[data-book]')) {
      button.setAttribute('aria-pressed', String(button.dataset.book === bookView));
    }
    if (bookView === 'tape') {
      const ticks = (stock.session.ticks ?? []).filter(tick => tick.volume > 0).slice(-10).reverse();
      container.innerHTML = `<div class="book-head"><span>时间</span><span>尾价</span><span>股数</span></div>${ticks.length ?
        ticks.map(tick => `<div class="level tape-row number" title="本轮末笔价格与总成交股数"><span>${timeLabel(tick.minute)}</span><span class="${colorOf(tick.close - stock.prevClose)}">${price(tick.close)}</span><span>${compactNumber(tick.volume)}</span></div>`).join('') :
        '<p class="empty">暂无成交</p>'}`;
      return;
    }
    const book = Market.depth(state, stock.id);
    const ranks = [1, 2, 3, 4, 5];
    const askRanks = ranks.slice().reverse();
    if (changed) {
      const levelRow = (name, orderSide) => `<button type="button" data-order-side="${orderSide}">
        <span>${name}</span><span></span><span></span></button>`;
      const asks = askRanks.map(rank => levelRow(`卖${rank}`, 'buy')).join('');
      const bids = ranks.map(rank => levelRow(`买${rank}`, 'sell')).join('');
      container.innerHTML = `<div class="book-head"><span>档位</span><span>价格</span><span>股数</span></div>${asks}<hr class="book-separator">${bids}`;
    }
    const levels = [...askRanks.map(rank => book.asks[rank - 1]), ...ranks.map(rank => book.bids[rank - 1])];
    container.querySelectorAll('button').forEach((button, index) => {
      const level = levels[index];
      const [name, quote, quantity] = button.children;
      button.disabled = !level;
      button.className = level ? `level book-${index < ranks.length ? 'sell' : 'buy'} number` : 'level empty-level';
      quote.textContent = level ? price(level.price) : '—';
      quantity.textContent = level ? integer.format(level.quantity) : '—';
      if (level) button.dataset.level = String(level.price);
      else delete button.dataset.level;
      const label = level ? `${name.textContent} ${quote.textContent} 元，${quantity.textContent} 股` : name.textContent;
      button.setAttribute('aria-label', level ? `${label}，打开委托` : label);
      button.title = label;
    });
  }

  function chooseQuote() {
    const book = Market.depth(state, selected);
    const best = book[side === 'buy' ? 'asks' : 'bids'][0];
    $('limit').value = price(best?.price ?? Math.max(1, current().price));
    autoPrice = false;
  }

  function formEstimate() {
    const stock = current();
    if (stock.status !== 'active') {
      $('order-estimate').textContent = '该股票当前暂停交易。';
      return;
    }
    const details = side === 'buy' ? `可用 ${money(Market.buyPower(state))}` : `可卖 ${integer.format(Market.sellable(state, stock.id))} 股`;
    if (hasTrigger()) {
      $('order-estimate').innerHTML = `${details} · 最新价 ${price(stock.price)}<br>条件单可跨日。每轮按最新价检查，触发时校验资金、T+1 和当日价带。通过校验后提交限价委托。`;
      return;
    }
    if (state.phase === 3) {
      $('order-estimate').textContent = '盘后休市，进入下一交易日可下单。';
      return;
    }
    const limit = Math.round(Number($('limit').value) * 100);
    const quantity = Number($('quantity').value);
    const [low, high] = Market.bounds(stock);
    const possible = Number.isSafeInteger(quantity) && quantity > 0 && limit >= low && limit <= high;
    const estimate = possible ? Market.estimate(state, stock.id, side, quantity, limit) : null;
    $('order-estimate').innerHTML = `${details} · 价带 ${price(low)}–${price(high)}<br>${Market.atLunch(state) ? '午间休市，委托将在 13:00 起参与撮合。' : estimate
      ? `参考可成交 ${integer.format(estimate.filled)} 股 · ${money(estimate.total)}` : '输入限价和数量可预估成交'}`;
  }

  function renderOrder(stock) {
    const select = $('ticket-symbol');
    const options = state.stocks.filter(item => item.status !== 'delisted' || item.id === stock.id)
      .map(item => `<option value="${text(item.id)}">${text(item.name)} · ${text(code(item.id))}</option>`).join('');
    if (select.dataset.options !== options) {
      select.innerHTML = options;
      select.dataset.options = options;
    }
    if (select.value !== stock.id) select.value = stock.id;
    const conditionView = tradeView === 'conditions';
    $('open-protection').hidden = !conditionView;
    $('open-protection').disabled = conditionView && !protectionStocks().length;
    $('condition-side-field').hidden = !conditionView;
    $('condition-side').value = side;
    $('plain-order-option').disabled = $('plain-order-option').hidden = conditionView;
    $('order-kind-label').textContent = conditionView ? '触发条件' : '委托类型';
    if (conditionView && !hasTrigger()) $('order-kind').value = side === 'sell' ? 'below' : 'above';
    const conditional = hasTrigger();
    const direction = side === 'buy' ? '买入' : '卖出';
    $('trigger-field').hidden = !conditional;
    $('trigger').required = conditional;
    $('ticket-heading').textContent = conditionView ? '新建条件单' : `${direction}委托`;
    $('at-quote').textContent = side === 'buy' ? '卖一' : '买一';
    $('place').textContent = `提交${direction}${conditional ? '条件单' : '委托'}`;
    $('place').classList.toggle('sell-mode', side === 'sell');
    $('place').disabled = (!conditional && state.phase === 3) || stock.status !== 'active';
    if (autoPrice) chooseQuote();
    formEstimate();
  }

  function table(headers, rows, empty) {
    if (!rows.length) return `<p class="empty">${text(empty)}</p>`;
    return `<table><thead><tr>${headers.map(item => `<th scope="col">${item}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(row => `<tr>${row.map(value => `<td>${value}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function renderAccount() {
    const gain = Market.netWorth(state) / Market.START_CASH - 1;
    const relative = gain - (Market.indexValue(state) / state.indexBase - 1);
    $('account-caption').textContent = `相对指数 ${(relative * 100).toFixed(2)} 个百分点 · 最大回撤 ${(state.drawdown * 100).toFixed(2)}%`;
    $('trade-page').dataset.view = tradeView;
    $('trade-page').dataset.ticket = hasTicket() ? 'visible' : '';
    $('account-heading').textContent = accountView === 'conditions' ? '条件单记录' : '账户记录';
    for (const button of $('account-tabs').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.view === tradeView));
    let view;
    if (accountView === 'orders' || accountView === 'conditions') {
      const conditionView = accountView === 'conditions';
      const visible = order => !conditionView || order.trigger > 0 || order.protection;
      const working = state.orders.filter(order => order.actor === 'player' && visible(order)).map(order => ({ ...order, status: 'working' }));
      const waiting = state.conditions.map(rule => ({ ...rule, remaining: rule.quantity, status: 'waiting' }));
      const orders = [...working, ...waiting, ...state.tickets.filter(visible).slice(0, 18)];
      const headers = conditionView ? ['股票 / 方向', '触发价 / 限价', '状态', '操作'] : ['股票', '方向', '限价', '数量 / 已成交', '状态', '操作'];
      view = table(headers, orders.map(order => {
        const direction = order.side === 'buy' ? '买入' : '卖出';
        const filled = order.quantity ? order.quantity - order.remaining : 0;
        const quantity = order.quantity ? `${integer.format(order.quantity)} 股` : '触发时可卖股数';
        const limit = order.limit === undefined ? '—' : price(order.limit);
        const trigger = order.trigger ? `${order.comparison === 'above' ? '≥' : '≤'} ${price(order.trigger)}` : '';
        const orderStatusText = order.status === 'working' ?
          `${conditionView ? '已触发 · ' : ''}${filled ? '部分成交' : '等待撮合'}` : statusLabels[order.status];
        const leg = order.triggeredBy === 'takeProfit' ? '止盈' : order.triggeredBy === 'stopLoss' ? '止损' : '';
        const linked = leg && order.protection?.takeProfit && order.protection?.stopLoss ?
          `<small class="muted">${leg === '止盈' ? '止损' : '止盈'}已自动撤销</small>` : '';
        const status = leg ? `${leg} · ${orderStatusText}` : orderStatusText;
        const priceDetails = order.protection ? protectionPrices(order.protection).map(value => `<small class="muted">${value}</small>`).join('') : '';
        const reason = order.reason ? `<small class="muted">${text(order.reason)}</small>` : '';
        const cancelButton = ['working', 'waiting'].includes(order.status) ?
          `<button type="button" class="table-action" data-cancel="${Number(order.id)}">撤单</button>` : '—';
        const edit = order.status === 'waiting' && order.protection && state.stocks.some(stock => stock.id === order.symbol && stock.status === 'active') ?
          `<button type="button" class="table-action protection-entry" data-protection="${text(order.symbol)}">修改</button>` : '';
        const action = `${cancelButton}${edit}`;
        if (conditionView) return [
          `<strong>${text(label(order.symbol))}</strong><small class="muted">${direction} ${quantity}</small>`,
          order.protection ? `${priceDetails}${order.limit === undefined ? '' : `<small class="muted">限价 ${limit}</small>`}` : `${trigger}<small class="muted">限价 ${limit}</small>`,
          `${text(status)}${linked}${reason}${filled ? `<small class="muted">已成交 ${integer.format(filled)} 股</small>` : ''}<small class="muted">#${Number(order.conditionId ?? order.id)}</small>`,
          action,
        ];
        return [text(label(order.symbol)), direction, limit, order.quantity ? `${integer.format(order.quantity)} / ${integer.format(filled)}` : quantity,
          `${text(status)}${priceDetails || (trigger ? `<small class="muted">${trigger}</small>` : '')}${linked}${reason}`, action];
      }), conditionView ? '暂无条件单。设置触发条件、价格和数量后提交。' : '提交限价单后，可以在这里查看排队、成交和撤单。');
    } else if (accountView === 'fills') {
      view = table(['交易日', '股票', '方向', '成交价', '股数', '手续费'], state.fills.slice(0, 20).map(fill => [
        `第 ${Number(fill.day)} 日 · ${text(fill.minute === undefined ? Market.STAGES[fill.phase] : timeLabel(fill.minute))}`, text(label(fill.symbol)), fill.side === 'buy' ? '买入' : '卖出',
        price(fill.price), integer.format(fill.quantity), money(fill.fee),
      ]), '还没有成交。可以在盘口选一个限价，下单后推进交易。');
    } else if (accountView === 'forces') {
      const activity = state.activity[0];
      view = table(['交易者', '最近一轮净买入', '最近一轮成交股数'], activity ? Object.entries(Market.ROLES).map(([id, name]) => {
        const funds = activity.flows[id];
        return [name, `<span class="${colorOf(funds)}">${money(funds)}</span>`, integer.format(activity.volumes[id])];
      }) : [], '首轮撮合后显示四类资金的实际成交。');
    } else {
      const holdings = state.stocks.map(stock => [stock, Market.position(state, 'player', stock.id)]).filter(([, holding]) => holding.shares > 0);
      view = table(['股票', '成本价', '浮动盈亏', '持有 / 可卖', '估算回款'], holdings.map(([stock, holding]) => {
        const available = Market.sellable(state, stock.id);
        const figures = positionFigures(stock, holding);
        const sale = Market.estimate(state, stock.id, 'sell', available);
        const rule = Market.protectionFor(state, stock.id);
        const edit = stock.status === 'active' ? `<button type="button" class="link-button protection-entry" data-protection="${text(stock.id)}">止盈止损</button>` : '';
        const marks = rule ? protectionPrices(rule.protection).map(value => `<small class="muted">${value}</small>`).join('') : '';
        return [`<strong>${text(stock.name)}</strong><small class="muted">${text(code(stock.id))}</small>${edit}${marks}`,
          `<span title="每股持仓成本，含买入手续费">${figures.cost}</span><small class="muted">现价 ${price(stock.price)}</small>`,
          `<span class="${figures.tone}">${figures.amount}</span><small class="${figures.tone}">${figures.rate}</small>`,
          `${integer.format(holding.shares)}<small class="muted">${integer.format(available)}</small>`,
          `${money(sale.total)}<small class="muted">${integer.format(sale.filled)} 股</small>`];
      }), '当前空仓。从行情选择股票，提交限价委托。');
    }
    const container = $('account-table');
    container.dataset.view = accountView;
    if (container.dataset.viewHtml !== view) {
      container.innerHTML = view;
      container.dataset.viewHtml = view;
    }
  }

  function renderEnd() {
    const end = state.ended;
    $('end-title').textContent = end.reason === 'bankruptcy' ? '破产 · 投资生涯结束' : '已退出市场';
    $('end-day').textContent = `第 ${end.day} 个交易日 · ${timeLabel(end.minute ?? state.minute)}`;
    $('end-metrics').innerHTML = [metric('账户净值', money(end.equity), `${percent(end.equity / Market.START_CASH - 1)} 生涯收益`),
      metric('现金', money(end.cash), `已实现损益 ${money(end.realized)}`),
      metric('最大回撤', `${(end.drawdown * 100).toFixed(2)}%`, `同期指数 ${percent(end.index / state.indexBase - 1)}`)].join('');
    $('end-holdings').innerHTML = table(['退出时持仓', '股数', '市值', '盘口估算回款'], end.holdings.map(holding => [
      text(holding.name), integer.format(holding.shares), money(holding.marketValue),
      `${money(holding.estimated)} / ${integer.format(holding.estimatedShares)} 股`,
    ]), end.reason === 'bankruptcy' ? '可收回资产已确认归零。' : '退出时为空仓。');
  }

  function renderRoute() {
    const browsing = ['watch', 'market', 'quote'].includes(page);
    const active = page === 'quote' ? listPage : page;
    $('workspace').dataset.page = page;
    $('browse-page').hidden = !browsing;
    $('quote-page').hidden = !browsing;
    $('news-page').hidden = page !== 'news';
    $('trade-page').hidden = page !== 'trade';
    $('quote-back').innerHTML = `<span aria-hidden="true">‹</span> ${listPage === 'watch' ? '自选' : '行情'}`;
    for (const button of $('app-nav').querySelectorAll('[data-page]')) {
      if (button.dataset.page === active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    $('analysis').dataset.tab = detailTab;
    $('analysis').dataset.chartPeriod = period;
    $('analysis').dataset.dailySide = dailySide;
    $('chip-panel').hidden = !showingDayChips();
    $('daily-side-switch').hidden = detailTab !== 'chart' || period !== 'day';
    for (const button of $('daily-side-switch').querySelectorAll('[data-daily-side]')) {
      button.setAttribute('aria-pressed', String(button.dataset.dailySide === dailySide));
    }
    for (const button of $('quote-tabs').querySelectorAll('[data-detail]')) {
      button.setAttribute('aria-pressed', String(button.dataset.detail === detailTab));
    }
    for (const button of $('chart-periods').querySelectorAll('[data-period]')) {
      button.setAttribute('aria-pressed', String(button.dataset.period === period));
    }
  }

  function showPage(next) {
    chartPointer = null;
    if (next === 'watch' || next === 'market') {
      if (listPage !== next) $('stock-search').value = '';
      holdingsOnly = false;
      listPage = next;
    }
    page = next;
    render();
    window.scrollTo(0, 0);
    const heading = { watch: 'market-heading', market: 'market-heading', quote: 'symbol-title', news: 'news-heading', trade: 'trade-title' };
    $(heading[page]).focus({ preventScroll: true });
  }

  function render() {
    $('market-screen').hidden = Boolean(state.ended);
    $('career-end').hidden = !state.ended;
    $('exit').hidden = Boolean(state.ended);
    $('pause').hidden = Boolean(state.ended);
    $('save-status').textContent = storageNotice;
    if (state.ended) {
      renderEnd();
      return;
    }
    const stock = current();
    $('day-label').textContent = `第 ${state.day} 个交易日`;
    const marketTime = timeLabel(state.minute);
    $('market-clock').textContent = marketTime;
    $('market-clock').dateTime = marketTime;
    const status = state.phase === 0 ? '待开盘' : state.phase === 3 ? '已收盘' :
      Market.atLunch(state) ? '午间休市' : state.minute < morningEnd ? '上午交易' : '下午交易';
    $('market-status').textContent = sessionOpen() && nextTickAt === null ? `${status} · 已暂停` : status;
    $('advance').textContent = state.phase === 0 ? '开盘' : state.phase === 3 ? '下一日开盘' : nextTickAt === null ? '继续交易' : '暂停';
    renderRoute();
    renderMetrics();
    renderStocks();
    renderQuote(stock);
    renderNews();
    renderBook(stock);
    if (page === 'trade' && hasTicket()) renderOrder(stock);
    renderAccount();
  }

  function orderStatus(message = '', ok = false) {
    $('order-status').textContent = message;
    $('order-status').classList.toggle('ok', ok);
  }

  function stopClock() {
    clearTimeout(clockTimer);
    nextTickAt = null;
  }

  function updateMarket(previousFill) {
    if (state.phase === 3) orderStatus();
    if (previousFill !== state.fills[0]) {
      const fill = state.fills[0];
      orderStatus();
      announce(`${label(fill.symbol)} · ${fill.side === 'buy' ? '买入' : '卖出'}成交 ${integer.format(fill.quantity)} 股`);
    }
    save();
    render();
  }

  function scheduleTick() {
    clockTimer = setTimeout(tickClock, Math.max(0, nextTickAt - performance.now()));
  }

  function tickClock() {
    if (nextTickAt === null) return;
    const now = performance.now();
    const previousFill = state.fills[0];
    let advanced = false;
    while (sessionOpen() && now >= nextTickAt) {
      Market.advance(state);
      nextTickAt += tickDelay;
      advanced = true;
    }
    if (!sessionOpen()) stopClock();
    if (advanced) updateMarket(previousFill);
    if (nextTickAt !== null) scheduleTick();
  }

  function startClock() {
    if (!sessionOpen() || nextTickAt !== null) return;
    nextTickAt = performance.now() + tickDelay;
    scheduleTick();
  }

  function sessionAction() {
    if (state.ended) return;
    if (nextTickAt !== null) {
      stopClock();
      render();
      return;
    }
    const previousFill = state.fills[0];
    if (state.phase === 3) Market.advance(state);
    if (state.phase === 0) Market.advance(state);
    startClock();
    updateMarket(previousFill);
  }

  function openMarketDialog(id) {
    resumeAfterDialog = nextTickAt !== null;
    stopClock();
    $(id).showModal();
    render();
  }

  $('stock-list').addEventListener('click', event => {
    const button = event.target.closest('[data-symbol]');
    if (!button) return;
    selected = button.dataset.symbol;
    detailTab = 'chart';
    bookView = 'ladder';
    autoPrice = true;
    orderStatus();
    showPage('quote');
  });
  $('stock-search').addEventListener('input', renderStocks);
  $('stock-sort').addEventListener('click', event => {
    const button = event.target.closest('[data-sort]');
    if (!button) return;
    sortDirection = button.dataset.sort === stockSort ? -sortDirection : -1;
    stockSort = button.dataset.sort;
    renderStocks();
  });
  $('all-stocks').addEventListener('click', () => { holdingsOnly = false; renderStocks(); });
  $('held-stocks').addEventListener('click', () => { holdingsOnly = true; renderStocks(); });
  $('app-nav').addEventListener('click', event => {
    const button = event.target.closest('button[data-page]');
    if (button) showPage(button.dataset.page);
  });
  $('quote-back').addEventListener('click', () => showPage(listPage));
  $('favorite').addEventListener('click', () => {
    const favorites = watchSymbols();
    const exists = favorites.includes(selected);
    state.watchSymbols = exists ? favorites.filter(symbol => symbol !== selected) : [...favorites, selected];
    save();
    render();
    announce(`${label(selected)}${exists ? '已从自选移除' : '已加入自选'}`);
  });
  $('quote-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-detail]');
    if (!button) return;
    detailTab = button.dataset.detail;
    chartPointer = null;
    renderRoute();
    drawChart();
  });
  $('chart-periods').addEventListener('click', event => {
    const button = event.target.closest('[data-period]');
    if (!button) return;
    detailTab = 'chart';
    period = button.dataset.period;
    chartPointer = null;
    renderRoute();
    renderQuote(current());
  });
  $('daily-side-switch').addEventListener('click', event => {
    const button = event.target.closest('[data-daily-side]');
    if (!button || dailySide === button.dataset.dailySide) return;
    dailySide = button.dataset.dailySide;
    chartPointer = null;
    renderRoute();
    drawChart();
  });
  $('book-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-book]');
    if (!button) return;
    bookView = button.dataset.book;
    renderBook(current());
  });
  $('more-news').addEventListener('click', () => { newsView = relatedNewsView; selectedNewsOnly = false; showPage('news'); });
  for (const id of ['news-channels', 'related-channels']) {
    $(id).addEventListener('click', event => {
      const button = event.target.closest('[data-channel]');
      if (!button) return;
      if (id === 'news-channels') newsView = button.dataset.channel;
      else relatedNewsView = button.dataset.channel;
      renderNews();
    });
  }
  $('all-news').addEventListener('click', () => { selectedNewsOnly = false; renderNews(); });
  $('selected-news').addEventListener('click', () => { selectedNewsOnly = true; renderNews(); });
  $('chart').addEventListener('pointermove', event => {
    chartPointer = { x: event.clientX, y: event.clientY };
    inspectChart();
  });
  for (const event of ['pointerleave', 'pointercancel']) {
    $('chart').addEventListener(event, () => { chartPointer = null; inspectChart(); });
  }
  $('chip-chart').addEventListener('pointermove', event => {
    const canvas = $('chip-chart');
    const view = visibleChipView;
    if (!view?.snapshot) return;
    const { axis, snapshot, offset } = view;
    const relativeY = event.clientY - canvas.getBoundingClientRect().top - offset;
    const value = Math.round(axis.upper - (relativeY - axis.top) / (axis.bottom - axis.top) * (axis.upper - axis.lower));
    const index = Math.floor((value - snapshot.low) / snapshot.step);
    const band = relativeY >= axis.top && relativeY <= axis.bottom ? snapshot.bands[index] : null;
    const shares = band ? band[0] + band[1] + band[2] : 0;
    const from = snapshot.low + index * snapshot.step;
    const range = snapshot.step === 1 ? price(from) : `${price(from)}–${price(from + snapshot.step - 1)}`;
    canvas.title = shares ? `${range} 元 · ${integer.format(shares)} 股 · ${(shares / snapshot.total * 100).toFixed(2)}%` : '';
  });
  $('advance').addEventListener('click', sessionAction);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && nextTickAt !== null) {
      clearTimeout(clockTimer);
      tickClock();
    }
  });

  function openTrade(direction, limit) {
    side = direction;
    if (accountView === 'conditions') accountView = 'orders';
    tradeView = direction;
    autoPrice = limit === undefined;
    $('order-kind').value = 'limit';
    $('trigger').value = '';
    if (!autoPrice) $('limit').value = price(limit);
    orderStatus();
    showPage('trade');
  }

  function readPrice(id, label, optional = false) {
    const field = $(id);
    if (optional && field.value === '' && !field.validity?.badInput) return null;
    const value = Number(field.value);
    const cents = Math.round(value * 100);
    if (!Number.isSafeInteger(cents) || cents < 1 || Math.abs(cents - value * 100) > 0.00001) {
      throw Error(`请输入有效的${label}，最多两位小数。`);
    }
    return cents;
  }

  function renderProtectionFields() {
    const symbol = $('protection-symbol').value;
    const stock = state.stocks.find(item => item.id === symbol);
    const rule = Market.protectionFor(state, symbol);
    const plan = rule?.protection;
    $('take-profit').value = plan?.takeProfit ? price(plan.takeProfit) : '';
    $('stop-loss').value = plan?.stopLoss ? price(plan.stopLoss) : '';
    $('remove-protection').hidden = !rule;
    $('protection-error').textContent = '';
    $('protection-summary').textContent = `最新价 ${price(stock.price)} 元 · 当前可卖 ${integer.format(Market.sellable(state, symbol))} 股`;
  }

  function openProtection(symbol = selected) {
    const stocks = protectionStocks();
    if (!stocks.length) return;
    const select = $('protection-symbol');
    select.innerHTML = stocks.map(stock => `<option value="${text(stock.id)}">${text(stock.name)} · ${code(stock.id)}</option>`).join('');
    select.value = stocks.find(stock => stock.id === symbol)?.id ?? stocks[0].id;
    renderProtectionFields();
    openMarketDialog('protection-dialog');
    $('take-profit').focus();
  }

  $('quote-buy').addEventListener('click', () => openTrade('buy'));
  $('quote-sell').addEventListener('click', () => openTrade('sell'));
  $('trade-quote').addEventListener('click', () => showPage('quote'));
  $('ticket-symbol').addEventListener('change', event => {
    selected = event.target.value;
    autoPrice = true;
    $('trigger').value = '';
    orderStatus();
    render();
  });
  $('condition-side').addEventListener('change', event => {
    side = event.target.value;
    autoPrice = true;
    orderStatus();
    renderOrder(current());
  });
  $('order-kind').addEventListener('change', () => { orderStatus(); renderOrder(current()); });
  $('at-quote').addEventListener('click', () => { chooseQuote(); formEstimate(); });
  $('max-quantity').addEventListener('click', () => {
    const limit = Math.max(1, Math.round(Number($('limit').value) * 100));
    const max = side === 'buy' ? Math.floor(Market.buyPower(state) * 1000 / (limit * 1001)) : Market.sellable(state, selected);
    $('quantity').value = Math.floor(max / 100) * 100;
    formEstimate();
  });
  $('limit').addEventListener('input', () => { autoPrice = false; formEstimate(); });
  $('quantity').addEventListener('input', formEstimate);
  $('trade-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const comparison = $('order-kind').value || 'limit';
      const quantity = Number($('quantity').value);
      const limit = readPrice('limit', '限价');
      const conditional = tradeView === 'conditions' || comparison !== 'limit';
      const order = conditional ? Market.placeCondition(state, selected, side, quantity, limit, comparison, readPrice('trigger', '触发价')) :
        Market.place(state, selected, side, quantity, limit);
      accountView = tradeView === 'conditions' ? 'conditions' : 'orders';
      save();
      render();
      orderStatus(conditional ? `已创建条件单 #${order.id}。` : `已提交 #${order.id}，等待撮合。`, true);
    } catch (error) {
      orderStatus(error.message);
    }
  });
  $('book').addEventListener('click', event => {
    const button = event.target.closest('[data-level]');
    if (!button) return;
    openTrade(button.dataset.orderSide, Number(button.dataset.level));
  });
  $('account-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    const view = button.dataset.view;
    if (view === 'buy' || view === 'sell') {
      if (view !== tradeView) openTrade(view);
    } else if (view === 'conditions') {
      if (tradeView === view) return;
      tradeView = accountView = view;
      autoPrice = true;
      orderStatus();
      render();
    } else {
      tradeView = accountView = view;
      renderAccount();
    }
  });
  $('account-table').addEventListener('click', event => {
    const editor = event.target.closest('[data-protection]');
    if (editor) {
      openProtection(editor.dataset.protection);
      return;
    }
    const button = event.target.closest('[data-cancel]');
    if (!button || !Market.cancel(state, Number(button.dataset.cancel))) return;
    save();
    render();
    announce('委托已撤销。');
  });
  $('open-protection').addEventListener('click', () => openProtection());
  $('protection-symbol').addEventListener('change', renderProtectionFields);
  $('close-protection').addEventListener('click', () => $('protection-dialog').close());
  $('protection-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      Market.setProtection(state, $('protection-symbol').value, readPrice('take-profit', '止盈价', true), readPrice('stop-loss', '止损价', true));
      save();
      $('protection-dialog').close();
      announce('止盈止损设置已保存。');
    } catch (error) {
      $('protection-error').textContent = error.message;
    }
  });
  $('remove-protection').addEventListener('click', () => {
    const rule = Market.protectionFor(state, $('protection-symbol').value);
    if (!rule || !Market.cancel(state, rule.id)) return;
    save();
    $('protection-dialog').close();
    announce('止盈止损已撤销。');
  });

  $('pause').addEventListener('click', () => {
    const saved = save();
    $('save-title').textContent = saved ? '存档已暂停' : '市场已暂停';
    $('save-detail').textContent = `第 ${state.day} 日 · ${timeLabel(state.minute)}。${saved ? '下次打开此页面可从当前时刻继续。' : '本机存档写入失败，可导出当前进度。'}`;
    $('save-error').textContent = '';
    openMarketDialog('save-dialog');
  });
  $('resume').addEventListener('click', () => {
    resumeAfterDialog = sessionOpen();
    $('save-dialog').close();
  });
  for (const id of ['save-dialog', 'exit-dialog', 'protection-dialog']) {
    $(id).addEventListener('close', () => {
      if (resumeAfterDialog) startClock();
      resumeAfterDialog = false;
      render();
    });
  }
  $('exit').addEventListener('click', () => openMarketDialog('exit-dialog'));
  $('keep-playing').addEventListener('click', () => $('exit-dialog').close());
  $('confirm-exit').addEventListener('click', () => {
    Market.exit(state);
    $('exit-dialog').close();
    save();
    render();
    $('new-career').focus();
  });
  $('new-career').addEventListener('click', () => {
    if (!state.ended) return;
    state = Market.create(Date.now());
    selected = 'SIM03';
    side = 'buy';
    accountView = 'positions';
    tradeView = 'positions';
    bookView = 'ladder';
    stockSort = 'default';
    holdingsOnly = false;
    autoPrice = true;
    page = listPage = 'watch';
    detailTab = 'chart';
    period = defaultPeriod();
    $('stock-search').value = '';
    $('quantity').value = '100';
    orderStatus();
    save();
    render();
  });

  document.addEventListener('click', event => {
    if (event.target.closest('[data-import]')) $('save-file').click();
    if (!event.target.closest('[data-export]')) return;
    state.viewedStock = selected;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
    link.download = `a-share-save-${state.seed}-day-${state.day}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 30_000);
  });
  $('save-file').addEventListener('change', async () => {
    const file = $('save-file').files[0];
    $('save-file').value = '';
    if (!file) return;
    try {
      const restored = Market.deserialize(await file.text());
      if (!window.confirm(`载入第 ${restored.day} 日的存档，并替换当前进度？`)) return;
      stopClock();
      resumeAfterDialog = false;
      state = restored;
      selected = state.stocks.some(stock => stock.id === state.viewedStock) ? state.viewedStock : 'SIM03';
      autoPrice = true;
      holdingsOnly = false;
      page = listPage = 'watch';
      detailTab = 'chart';
      bookView = 'ladder';
      tradeView = accountView = 'positions';
      $('stock-search').value = '';
      orderStatus();
      $('save-dialog').close();
      save();
      render();
      announce('已导入存档。');
    } catch {
      const message = '无法读取存档。请使用本游戏导出的 JSON 文件。';
      if ($('save-dialog').open) $('save-error').textContent = message;
      else announce(message);
    }
  });

  const chartResize = new ResizeObserver(drawChart);
  chartResize.observe($('chart').parentElement);
  chartResize.observe($('chip-chart').parentElement);
  render();
})();
