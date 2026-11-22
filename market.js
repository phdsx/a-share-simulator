/* global window */
(() => {
  'use strict';

  const News = typeof module !== 'undefined' && module.exports ? require('./market-news.js') : window.MarketNews;
  const VERSION = 1;
  const START_CASH = 10_000_000;
  const INDEX_BASE = 3200;
  const LOT = 100;
  const CHART_CANDLES = 18;
  const RECENT_FILLS = 100;
  const CHIP_LEVELS = 64;
  const CHIP_BANDS = 28;
  const STAGES = ['开盘', '盘中', '尾盘', '盘后'];
  const HOURS = { open: 570, morningEnd: 690, afternoonOpen: 780, late: 885, close: 900, tick: 1 };
  const SESSION_POINTS = (HOURS.morningEnd - HOURS.open + HOURS.close - HOURS.afternoonOpen) / HOURS.tick + 2;
  const EXPOSURE_DECAY = 0.985 ** (HOURS.tick / 5);
  const EXIT_FLOW_DECAY = 0.965;
  const RECENT_ACTIVITY = 30;
  const INTRADAY_FLOW = 0.24;
  const LEGACY_TIME = [HOURS.open, HOURS.open, HOURS.late, HOURS.close];
  const LEGACY_BATCHES = [HOURS.open, HOURS.afternoonOpen, HOURS.close];
  const ROLES = { retail: '散户', institution: '机构', national: '国家队', family: '家族' };
  const STOCKS = [
    ['SIM01', '海岳银行', '金融', '高股息', 1248, 6500, 8_000_000, true],
    ['SIM02', '华枢能源', '能源', '高股息', 1820, 5900, 7_400_000, true],
    ['SIM03', '云岚设备', '高端制造', '机器人', 1000, 1900, 600_000, false],
    ['SIM04', '锐拓传动', '高端制造', '机器人', 1543, 1800, 570_000, false],
    ['SIM05', '南川新材', '能源', '储能', 836, 1900, 610_000, false],
    ['SIM06', '长川电力', '能源', '储能', 1176, 2100, 650_000, false],
    ['SIM07', '维澜消费', '消费', '消费', 2310, 2000, 630_000, false],
    ['SIM08', '禾野食品', '消费', '消费', 675, 1300, 390_000, false],
  ];
  const NPCS = [
    ['seekers', 'retail', '追涨盘', 480_000_000],
    ['value', 'retail', '逆向资金', 520_000_000],
    ['fund', 'institution', '配置基金', 1_800_000_000],
    ['dealer', 'institution', '主题庄家', 570_000_000],
    ['national', 'national', '稳定资金', 1_480_000_000],
    ['family', 'family', '控股家族', 180_000_000],
  ];
  const ROLE_IDS = NPCS.map(([id]) => id);
  const CODE_PREFIXES = ['600', '601', '000', '002', '603', '001', '605', '003'];
  const emptyPosition = () => ({ shares: 0, locked: 0, restricted: 0, pledged: 0, cost: 0 });
  const fee = amount => Math.ceil(amount / 1000);
  const lots = amount => Math.floor(Math.max(amount, 0) / LOT) * LOT;
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  const bounds = stock => [Math.max(1, Math.round(stock.prevClose * 0.90)), Math.round(stock.prevClose * 1.10)];
  const stockById = (state, id) => state.stocks.find(stock => stock.id === id);
  const position = (state, actor, symbol) => state.actors[actor].positions[symbol] ?? emptyPosition();
  const protectionFor = (state, symbol) => state.conditions.find(rule => rule.symbol === symbol && rule.protection);
  const validProtection = plan => plan && [plan.takeProfit, plan.stopLoss].every(mark => mark === null || Number.isSafeInteger(mark) && mark > 0) &&
    (plan.takeProfit !== null || plan.stopLoss !== null) && (plan.takeProfit === null || plan.stopLoss === null || plan.stopLoss < plan.takeProfit);
  const atLunch = state => state.minute >= HOURS.morningEnd && state.minute < HOURS.afternoonOpen;
  const tradingElapsed = minute => Math.min(minute, HOURS.morningEnd) - HOURS.open + Math.max(0, minute - HOURS.afternoonOpen);
  const emptySession = price => ({ open: null, high: price, low: price, volume: 0, amount: 0, ticks: [], midpoint: price, sentiment: 0 });
  const holdingChips = holding => holding.chips ?? (holding.shares ? [[Math.round(holding.cost / holding.shares), holding.shares]] : []);

  function addChips(holding, price, shares) {
    const levels = holding.chips ??= holdingChips(holding);
    const index = levels.findIndex(level => level[0] >= price);
    if (index < 0) levels.push([price, shares]);
    else if (levels[index][0] === price) levels[index][1] += shares;
    else levels.splice(index, 0, [price, shares]);
    if (levels.length <= CHIP_LEVELS) return;

    // Combine the closest price levels when the saved distribution gets too wide.
    let nearest = 0;
    for (let i = 1; i < levels.length - 1; i += 1) {
      if (levels[i + 1][0] - levels[i][0] < levels[nearest + 1][0] - levels[nearest][0]) nearest = i;
    }
    const [a, b] = [levels[nearest], levels[nearest + 1]];
    const total = a[1] + b[1];
    const weighted = Math.round(a[0] + (b[0] - a[0]) * (b[1] / total));
    levels.splice(nearest, 2, [weighted, total]);
  }

  function removeChips(holding, shares) {
    const remaining = holding.shares - shares;
    if (remaining === 0) {
      holding.chips = [];
      return;
    }
    const levels = holding.chips ??= holdingChips(holding);
    const ratio = remaining / holding.shares;
    let original = 0;
    let allocated = 0;
    let kept = 0;
    // Apportion the remaining inventory across the seller's cost levels.
    for (let i = 0; i < levels.length; i += 1) {
      const level = levels[i];
      original += level[1];
      const target = i === levels.length - 1 ? remaining : Math.round(original * ratio);
      if (target > allocated) {
        level[1] = target - allocated;
        levels[kept++] = level;
      }
      allocated = target;
    }
    levels.length = kept;
  }

  function chipProfile(state, symbol) {
    const stock = stockById(state, symbol);
    const byPrice = new Map();
    for (const actor of Object.values(state.actors)) {
      const holding = actor.positions[symbol];
      if (!holding?.shares) continue;
      for (const [mark, shares] of holdingChips(holding)) byPrice.set(mark, (byPrice.get(mark) ?? 0) + shares);
    }
    const levels = [...byPrice].sort((a, b) => a[0] - b[0]);
    const total = levels.reduce((sum, level) => sum + level[1], 0);
    if (!stock || !total) return { levels: [], total: 0, average: null, profit: null, range: null };

    let cost = 0;
    let profitable = 0;
    let cumulative = 0;
    let low = null;
    let high = null;
    for (const [mark, shares] of levels) {
      cumulative += shares;
      cost += mark * shares;
      if (mark < stock.price) profitable += shares;
      if (low === null && cumulative >= total * 0.05) low = mark;
      if (high === null && cumulative >= total * 0.95) high = mark;
    }
    return { levels, total, average: cost / total, profit: profitable / total, range: [low, high] };
  }

  function chipSnapshot(state, stock) {
    const { levels, total, average, profit, range } = chipProfile(state, stock.id);
    if (!total) return null;
    const padding = Math.max(2, Math.round(stock.price * 0.008));
    const low = Math.max(0, Math.min(levels[0][0], stock.price) - padding);
    const high = Math.max(levels.at(-1)[0], stock.price) + padding;
    const step = Math.ceil((high - low + 1) / CHIP_BANDS);
    const bands = Array.from({ length: Math.ceil((high - low + 1) / step) }, () => [0, 0, 0]);
    for (const [mark, shares] of levels) {
      const side = mark < stock.price ? 0 : mark === stock.price ? 1 : 2;
      bands[Math.floor((mark - low) / step)][side] += shares;
    }
    return { low, step, bands, total, average, profit, range };
  }

  function stockCode(symbol) {
    const index = Number(symbol.slice(3)) - 1;
    if (!Number.isSafeInteger(index) || index < 0) return '';
    const lane = index % CODE_PREFIXES.length;
    const suffix = (535 + lane * 79 + Math.floor(index / CODE_PREFIXES.length) * 137) % 1000;
    return `${CODE_PREFIXES[lane]}${String(suffix).padStart(3, '0')}`;
  }

  function random(state) {
    let x = state.rng | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    state.rng = x >>> 0;
    return state.rng / 4294967296;
  }

  function createStock(state, spec, indexMember = true) {
    const [id, name, sector, theme, price, depth, float, large] = spec;
    const stock = {
      id, name, sector, theme, price, prevClose: price, fair: price, depth, float, large,
      heat: 0, exposure: 0, distress: 0, listedDay: state.day, indexMember, status: 'active',
      session: emptySession(price), history: [], receivableDay: null,
    };
    stock.business = News.createBusiness(state.seed, stock, state.day - 1);
    if (indexMember) {
      let mark = price;
      for (let day = 0; day > -16; day -= 1) {
        const spread = Math.max(2, Math.round(mark * (0.003 + random(state) * 0.008)));
        const volume = stock.depth * (4 + Math.round(random(state) * 6));
        const open = Math.round(mark * (1 + (random(state) - 0.48) * 0.028));
        stock.history.unshift({ day, close: mark, open, high: Math.max(open, mark) + spread,
          low: Math.min(open, mark) - spread, volume });
        mark = open;
      }
    }
    return stock;
  }

  function allocate(state, stock, issuePrice = 0) {
    const allotments = [15, 64, stock.large ? 120 : 55, 78, stock.large ? 95 : 0, stock.large ? 0 : 80];
    for (const [i, id] of ROLE_IDS.entries()) {
      const actor = state.actors[id];
      const amount = Math.min(lots(stock.depth * allotments[i]), issuePrice ? lots(actor.cash / issuePrice / 4) : Infinity);
      const restricted = id === 'family' ? lots(amount * 0.52) : 0;
      actor.positions[stock.id] = { shares: amount, locked: 0, restricted, pledged: 0, cost: amount * stock.price,
        chips: amount ? [[stock.price, amount]] : [] };
      actor.cash -= amount * issuePrice;
      state.economy.issuers += amount * issuePrice;
      state.economy.issued += amount * issuePrice;
    }
  }

  function indexCap(state) {
    return state.stocks.reduce((sum, stock) => sum + (stock.indexMember ? stock.price * stock.float : 0), 0);
  }

  function indexValue(state) { return indexCap(state) / state.divisor; }

  function create(seed = 48719) {
    const normalizedSeed = (Number(seed) >>> 0) || 48719;
    const state = {
      version: VERSION, seed: normalizedSeed, rng: normalizedSeed, day: 1, phase: 0, minute: HOURS.open, seq: 1,
      actors: { player: { id: 'player', name: '你的账户', kind: 'player', cash: START_CASH, positions: {}, realized: 0 } },
      stocks: [], orders: [], conditions: [], tickets: [], fills: [], news: [], activity: [], journal: [],
      economy: { fees: 0, issuers: 0, injected: 0, issued: 0, outgoing: 0 },
      divisor: 1, indexBase: INDEX_BASE, indexPrev: INDEX_BASE, peak: START_CASH, drawdown: 0,
      policy: null, episode: null, loan: null, contract: null, ended: null,
    };
    for (const [id, kind, name, cash] of NPCS) state.actors[id] = { id, kind, name, cash, positions: {}, realized: 0 };
    state.stocks = STOCKS.map(spec => createStock(state, spec));
    for (const stock of state.stocks) allocate(state, stock);
    state.divisor = indexCap(state) / INDEX_BASE;
    startDay(state);
    return state;
  }

  function heldCash(state, actor) {
    return state.orders.reduce((sum, order) => {
      if (order.actor !== actor || order.side !== 'buy') return sum;
      const rest = order.limit * order.remaining;
      return sum + rest + fee(order.notional + rest) - fee(order.notional);
    }, 0);
  }

  function buyPower(state, actor = 'player') { return state.actors[actor].cash - heldCash(state, actor); }

  function sellable(state, symbol, actor = 'player') {
    const holding = position(state, actor, symbol);
    const reserved = state.orders.reduce((sum, order) => sum + (order.actor === actor && order.symbol === symbol &&
      order.side === 'sell' ? order.remaining : 0), 0);
    return holding.shares - holding.locked - holding.restricted - holding.pledged - reserved;
  }

  function addOrder(state, actor, symbol, side, quantity, limit, style) {
    const order = { id: state.seq++, actor, symbol, side, quantity, remaining: quantity, limit, notional: 0,
      day: state.day, phase: state.phase, minute: state.minute, style, resting: false };
    state.orders.push(order);
    return order;
  }

  function orderStock(state, symbol, side, quantity, limit) {
    const stock = stockById(state, symbol);
    if (!stock || stock.status !== 'active') throw Error('该股票当前暂停交易。');
    if (side !== 'buy' && side !== 'sell') throw Error('请选择买入或卖出。');
    if (!Number.isSafeInteger(quantity) || quantity < LOT || quantity % LOT !== 0) throw Error('请输入 100 股的整数倍。');
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(limit * quantity + fee(limit * quantity))) {
      throw Error('请输入有效的限价和委托金额。');
    }
    return stock;
  }

  function place(state, symbol, side, quantity, limit) {
    if (state.ended || state.phase === 3) throw Error('当前在盘后或生涯已结算，无法提交委托。');
    const stock = orderStock(state, symbol, side, quantity, limit);
    const [low, high] = bounds(stock);
    if (limit < low || limit > high) throw Error('委托价超出当天的涨跌幅范围。');
    if (side === 'buy' && (limit * quantity + fee(limit * quantity) > buyPower(state))) throw Error('可用资金不足，委托需要预留手续费。');
    if (side === 'sell' && quantity > sellable(state, symbol)) throw Error('可卖数量不足，当日买入的股票次日才可卖出。');
    return addOrder(state, 'player', symbol, side, quantity, limit, 'player');
  }

  function placeCondition(state, symbol, side, quantity, limit, comparison, trigger) {
    if (state.ended) throw Error('生涯已结算，无法提交条件单。');
    orderStock(state, symbol, side, quantity, limit);
    if (!['above', 'below'].includes(comparison) || !Number.isSafeInteger(trigger) || trigger < 1) throw Error('请输入有效的触发条件。');
    const rule = { id: state.seq++, symbol, side, quantity, limit, comparison, trigger, day: state.day, minute: state.minute };
    state.conditions.push(rule);
    return rule;
  }

  function setProtection(state, symbol, takeProfit, stopLoss) {
    if (state.ended) throw Error('生涯已结算，无法设置止盈止损。');
    if (stockById(state, symbol)?.status !== 'active') throw Error('该股票当前暂停交易。');
    if (position(state, 'player', symbol).shares === 0) throw Error('请先持有该股票。');
    const protection = { takeProfit, stopLoss };
    if (!validProtection(protection)) throw Error(takeProfit !== null && stopLoss !== null && stopLoss >= takeProfit ?
      '止盈价必须高于止损价。' : '请至少填写一项有效的触发价。');
    const previous = protectionFor(state, symbol);
    if (previous) {
      previous.protection = protection;
      return previous;
    }
    const rule = { id: state.seq++, symbol, side: 'sell', protection, day: state.day, minute: state.minute };
    state.conditions.push(rule);
    return rule;
  }

  function archive(state, order, status) {
    if (order.actor !== 'player') return;
    state.tickets.unshift({ ...order, status });
    state.tickets.length = Math.min(state.tickets.length, 80);
  }

  function archiveCondition(state, rule, status, reason) {
    const quantity = rule.quantity ?? 0;
    archive(state, { ...rule, actor: 'player', quantity, remaining: quantity, reason: reason ?? '' }, status);
  }

  function cancelPositionProtection(state, symbol, reason) {
    const index = state.conditions.findIndex(rule => rule.symbol === symbol && rule.protection);
    if (index === -1) return;
    const [rule] = state.conditions.splice(index, 1);
    archiveCondition(state, rule, 'canceled', reason);
  }

  function activateConditions(state) {
    state.conditions = state.conditions.filter(rule => {
      const stock = stockById(state, rule.symbol);
      if (stock.status === 'delisted') {
        archiveCondition(state, rule, 'conditionFailed', '该股票已退市。');
        return false;
      }
      if (stock.status !== 'active') return true;
      let submission = rule;
      if (rule.protection) {
        const { takeProfit, stopLoss } = rule.protection;
        const triggeredBy = takeProfit !== null && stock.price >= takeProfit ? 'takeProfit' :
          stopLoss !== null && stock.price <= stopLoss ? 'stopLoss' : null;
        if (!triggeredBy) return true;
        // Consume the linked rule on the first hit, even if the sell cannot be submitted.
        submission = { ...rule, triggeredBy, trigger: rule.protection[triggeredBy], comparison: triggeredBy === 'takeProfit' ? 'above' : 'below',
          limit: bounds(stock)[0], quantity: lots(sellable(state, stock.id)) };
      } else if (rule.comparison === 'above' ? stock.price < rule.trigger : stock.price > rule.trigger) return true;
      try {
        if (submission.protection && !submission.quantity) throw Error('当前没有可卖股份。请检查 T+1 锁定及已有卖出委托。');
        const order = place(state, submission.symbol, submission.side, submission.quantity, submission.limit);
        order.conditionId = rule.id;
        order.comparison = submission.comparison;
        order.trigger = submission.trigger;
        if (submission.protection) {
          order.protection = submission.protection;
          order.triggeredBy = submission.triggeredBy;
        }
      } catch (error) {
        archiveCondition(state, submission, 'conditionFailed', error.message);
      }
      return false;
    });
  }

  function cancel(state, id) {
    if (state.ended) return false;
    const i = state.orders.findIndex(order => order.id === id && order.actor === 'player');
    if (i !== -1) {
      const [order] = state.orders.splice(i, 1);
      archive(state, order.resting ? { ...order, canceledMinute: state.minute } : order, 'canceled');
      return true;
    }
    const j = state.conditions.findIndex(rule => rule.id === id);
    if (j === -1) return false;
    const [rule] = state.conditions.splice(j, 1);
    archiveCondition(state, rule, 'canceled');
    return true;
  }

  // Record fees cumulatively per order so many partial fills cost the same as one fill.
  function fill(state, stock, buy, sell, price, quantity, activity) {
    const turnover = price * quantity;
    const costOf = order => fee(order.notional + turnover) - fee(order.notional);
    const buyFee = costOf(buy);
    const sellFee = costOf(sell);
    const buyer = state.actors[buy.actor];
    const seller = state.actors[sell.actor];
    const bought = buyer.positions[stock.id] ??= emptyPosition();
    const sold = seller.positions[stock.id];
    const basis = quantity === sold.shares ? sold.cost : Math.floor(sold.cost * quantity / sold.shares);

    addChips(bought, price, quantity);
    removeChips(sold, quantity);
    buyer.cash -= turnover + buyFee;
    seller.cash += turnover - sellFee;
    bought.shares += quantity;
    bought.locked += quantity;
    bought.cost += turnover + buyFee;
    sold.shares -= quantity;
    sold.cost -= basis;
    seller.realized += turnover - sellFee - basis;
    state.economy.fees += buyFee + sellFee;
    for (const order of [buy, sell]) {
      order.remaining -= quantity;
      order.notional += turnover;
    }

    stock.price = price;
    const session = stock.session;
    if (session.open === null) session.open = session.high = session.low = price;
    else {
      session.high = Math.max(session.high, price);
      session.low = Math.min(session.low, price);
    }
    session.volume += quantity;
    if (session.amount !== null) session.amount += turnover;
    const crowd = session.crowd;
    if (crowd && tradingElapsed(state.minute) >= crowd.start && sell.actor === (stock.large ? 'national' : 'family')) {
      crowd.sold += quantity;
      if (buyer.kind === 'retail' || buyer.kind === 'player') crowd.retail += quantity;
    }
    if (!stock.large && sell.actor === 'fund' && sell.style === 'flow' && buyer.kind === 'retail') {
      session.rotationRetail = (session.rotationRetail ?? 0) + quantity;
    }
    activity.volume += quantity;
    activity.matches += 1;
    for (const [account, direction] of [[buyer, 1], [seller, -1]]) {
      if (account.kind === 'player') continue;
      activity.flows[account.kind] += direction * turnover;
      activity.volumes[account.kind] += quantity;
    }
    if (buy.actor === 'player' || sell.actor === 'player') {
      const buying = buy.actor === 'player';
      state.fills.unshift({ day: state.day, phase: state.phase, minute: state.minute, symbol: stock.id, side: buying ? 'buy' : 'sell',
        price, quantity, fee: buying ? buyFee : sellFee });
      if (buying) activity.playerBought[stock.id] = (activity.playerBought[stock.id] ?? 0) + quantity;
      else {
        activity.playerSold[stock.id] = (activity.playerSold[stock.id] ?? 0) + quantity;
        if (sold.shares === 0) cancelPositionProtection(state, stock.id, '持仓已清空。');
      }
    }
  }

  const orderPriority = order => order.style === 'quote' ? 0 : order.style === 'player' ? 1 : 2;
  const byPriceTime = (side, a, b) => (side === 'buy' ? b.limit - a.limit : a.limit - b.limit) || a.id - b.id;

  function match(state) {
    const activity = { day: state.day, phase: state.phase, minute: state.minute, volume: 0, matches: 0, playerBought: {}, playerSold: {},
      flows: { retail: 0, institution: 0, national: 0, family: 0 }, volumes: { retail: 0, institution: 0, national: 0, family: 0 } };
    for (const stock of state.stocks) {
      const volumeBefore = stock.session.volume;
      const amountBefore = stock.session.amount;
      const book = state.orders.filter(order => order.symbol === stock.id);
      const incoming = book.filter(order => !order.resting).sort((a, b) => orderPriority(a) - orderPriority(b) || a.id - b.id);
      const bids = book.filter(order => order.resting && order.side === 'buy').sort((a, b) => byPriceTime('buy', a, b));
      const asks = book.filter(order => order.resting && order.side === 'sell').sort((a, b) => byPriceTime('sell', a, b));
      for (const order of incoming) {
        const buying = order.side === 'buy';
        const opposite = buying ? asks : bids;
        const own = buying ? bids : asks;
        for (const resting of opposite) {
          if (order.remaining === 0 || (buying ? order.limit < resting.limit : order.limit > resting.limit)) break;
          if (resting.remaining === 0) continue;
          if (order.actor === resting.actor) {
            archive(state, order, 'self');
            order.remaining = 0;
            break;
          }
          fill(state, stock, buying ? order : resting, buying ? resting : order, resting.limit,
            Math.min(order.remaining, resting.remaining), activity);
        }
        if (order.remaining > 0) {
          order.resting = true;
          own.push(order);
          own.sort((a, b) => byPriceTime(order.side, a, b));
        }
      }
      const netBuying = (activity.playerBought[stock.id] ?? 0) - (activity.playerSold[stock.id] ?? 0);
      stock.exposure = Math.max(0, Math.floor(stock.exposure * EXPOSURE_DECAY) + netBuying);
      if (netBuying < 0 || stock.exitFlow !== undefined) {
        stock.exitFlow = Math.max(0, Math.floor((stock.exitFlow ?? 0) * EXIT_FLOW_DECAY) - netBuying);
      }
      if (stock.status === 'active') {
        const session = stock.session;
        const volume = session.volume - volumeBefore;
        const amount = amountBefore === null ? null : session.amount - amountBefore;
        if (volume > 0) {
          // Small trades at either side of the spread contribute only part of their move.
          const tradedPrice = amount === null ? stock.price : amount / volume;
          session.midpoint += (tradedPrice - session.midpoint) * 0.36;
        }
        (session.ticks ??= []).push({ minute: state.minute, close: stock.price, volume, amount });
      }
    }

    state.orders = state.orders.filter(order => {
      if (order.actor !== 'player') return false;
      if (order.remaining === 0) {
        if (!state.tickets.some(ticket => ticket.id === order.id)) archive(state, order, 'filled');
        return false;
      }
      if (state.minute === HOURS.close) {
        archive(state, order, 'expired');
        return false;
      }
      return true;
    });
    state.activity.unshift(activity);
    state.activity.length = Math.min(state.activity.length, RECENT_ACTIVITY);
  }

  function npcOrder(state, actor, stock, side, quantity, target, style = 'quote') {
    const [low, high] = bounds(stock);
    const limit = clamp(Math.round(target), low, high);
    const maximum = side === 'buy' ? lots(buyPower(state, actor) * 1000 / (limit * 1001)) : sellable(state, stock.id, actor);
    const flowScale = style === 'flow' && state.phase !== 0 ? INTRADAY_FLOW : 1;
    const size = lots(Math.min(quantity * flowScale, maximum));
    if (size === 0) return;
    const wouldCross = order => order.actor === actor && order.symbol === stock.id && order.side !== side &&
      (side === 'buy' ? limit >= order.limit : limit <= order.limit);
    if (style === 'flow') state.orders = state.orders.filter(order => !(order.style === 'quote' && wouldCross(order)));
    if (state.orders.some(wouldCross)) return;
    addOrder(state, actor, stock.id, side, size, limit, style);
  }

  function observeCrowd(state, stock) {
    const { session, prevClose, depth } = stock;
    const elapsed = tradingElapsed(state.minute);
    const speculative = !stock.large && stock.heat >= 0.45;
    const gainThreshold = stock.large ? 0.0045 : speculative ? 0.008 : 0.012;
    const expectedVolume = depth * (stock.large ? 0.16 : 0.095) * elapsed;
    if (session.crowd || elapsed < 20 || elapsed > 85 ||
      stock.price < prevClose * (1 + gainThreshold) || session.volume < expectedVolume) return;
    const timing = (state.seed ^ stock.float ^ Math.imul(state.day, 263)) >>> 0;
    const project = state.episode.symbol === stock.id ? state.episode.project : null;
    const recent = stock.business.days.at(-1);
    const financingPressure = state.loan?.symbol === stock.id ||
      (project ? project.paymentLag >= 8 : recent?.collections < recent?.cost);
    const largerTranche = speculative && financingPressure;
    // Tight financing raises the sale target. A small tranche can clear in a rising market.
    const tranche = speculative ? (largerTranche ? 12 : 4) : 5;
    // Stagger larger sales across the session.
    const delay = 12 + timing % 18 + (largerTranche ? (timing >>> 8) % 92 : 0);
    session.crowd = {
      start: elapsed + delay,
      target: lots(depth * tranche),
      sold: 0, retail: 0,
    };
    const rise = ((stock.price / prevClose - 1) * 100).toFixed(2);
    const time = String(Math.floor(state.minute / 60)) + ':' + String(state.minute % 60).padStart(2, '0');
    headline(state, stock, '盘面', `${stock.name}早盘放量上攻`,
      `截至 ${time}，${stock.name}累计成交 ${session.volume.toLocaleString('zh-CN')} 股，现价较昨收上涨 ${rise}%，盘中最高 ${(session.high / 100).toFixed(2)} 元。\n\n继续观察放量时价格能否刷新高点，以及买卖盘和收盘后披露的资金变化。`,
      { source: '分时监测' });
  }

  function positionSignal(stock, shares) {
    const footprint = shares / Math.max(stock.depth * 2, stock.float * 0.004, 1);
    return clamp((footprint - 0.40) / 1.45, 0, 1);
  }

  function repeatedFlow(stock, recent, field) {
    let rounds = 0;
    let shares = 0;
    recent.forEach((round, index) => {
      const quantity = round[field]?.[stock.id] ?? 0;
      if (quantity < LOT) return;
      rounds += 1;
      shares += quantity * (1 - index / (RECENT_ACTIVITY * 2));
    });
    return positionSignal(stock, shares) * clamp((rounds - 1) / 3, 0, 1);
  }

  function dealerSignals(stock, recent, standing, canceled) {
    const bids = standing.filter(order => order.symbol === stock.id && order.side === 'buy' && order.limit >= stock.price * 0.99);
    const asks = standing.filter(order => order.symbol === stock.id && order.side === 'sell' && order.limit <= stock.price * 1.01);
    const quantity = orders => orders.reduce((total, order) => total + order.remaining, 0);
    const reorders = side => new Set(canceled.filter(order => order.symbol === stock.id && order.side === side &&
      order.remaining >= Math.max(LOT, stock.depth * 0.30)).map(order => order.minute)).size;
    const bid = bids.reduce((best, order) => !best || order.limit > best.limit ? order : best, null);
    const bidSize = positionSignal(stock, quantity(bids));
    const askSize = positionSignal(stock, quantity(asks));
    return {
      bid, bidSize, askSize,
      chasing: repeatedFlow(stock, recent, 'playerBought'),
      selling: repeatedFlow(stock, recent, 'playerSold'),
      buyingReposts: bidSize * clamp((reorders('buy') - 1) / 2, 0, 1),
      sellingReposts: askSize * clamp((reorders('sell') - 1) / 2, 0, 1),
    };
  }

  function prepare(state) {
    const episode = state.episode;
    const age = state.day - episode.since;
    const index = indexValue(state);
    const indexChange = index / state.indexPrev - 1;
    // Weight-stock liquidity providers shade their quotes as the composite moves beyond its usual band.
    const indexBias = clamp((clamp(index, 2750, 3750) - index) / 100_000, -0.006, 0.006);
    const policy = state.policy && state.day <= state.policy.until;
    const rotation = age >= 7 && age <= 10;
    const opening = state.phase === 0;
    const reopening = state.minute >= HOURS.afternoonOpen && state.minute < HOURS.afternoonOpen + 5;
    const busy = state.minute < HOURS.open + 15 || reopening || state.minute >= HOURS.late;
    const dealerActive = opening || state.minute % 3 === 0;
    const recent = state.activity.slice(0, RECENT_ACTIVITY).filter(round => round.day === state.day);
    const standing = state.orders.filter(order => order.actor === 'player' && order.resting);
    const canceled = state.tickets.filter(order => order.day === state.day && order.canceledMinute <= state.minute &&
      tradingElapsed(state.minute) - tradingElapsed(order.canceledMinute) < RECENT_ACTIVITY);
    for (const stock of state.stocks) {
      if (stock.status !== 'active') continue;
      const depth = stock.depth;
      const held = positionSignal(stock, position(state, 'player', stock.id).shares);
      const recentBuying = positionSignal(stock, stock.exposure);
      const behavior = dealerSignals(stock, recent, standing, canceled);
      const released = Math.max(0, positionSignal(stock, stock.exitFlow ?? 0) - held * 0.7);
      const relief = clamp(released + behavior.selling * 0.40, 0, 1) * (1 - behavior.askSize * 0.90);
      const pressure = clamp(Math.max(held * 0.70, recentBuying) - relief * 0.60 + behavior.chasing * 0.58 +
        behavior.bidSize * 0.25 + behavior.askSize * 0.36 + (behavior.buyingReposts + behavior.sellingReposts) * 0.22, 0, 1);
      const watched = pressure > 0.22 && (Math.max(held, recentBuying) >= 0.41 || behavior.chasing >= 0.35);
      const focus = stock.id === episode.symbol;
      const dealerSelling = focus && age >= 4 && age <= 9;
      const lead = stock.large ? 'national' : 'family';
      observeCrowd(state, stock);
      const crowd = stock.session.crowd;
      const minutesIntoSale = crowd ? tradingElapsed(state.minute) - crowd.start : -1;
      const exitRoom = crowd && minutesIntoSale >= 0 && (!stock.large || indexChange >= 0.0005)
        ? Math.min(crowd.target - crowd.sold, sellable(state, stock.id, lead),
          position(state, lead, stock.id).shares - depth * (stock.large ? 55 : 42))
        : 0;
      const distributing = exitRoom >= LOT;
      // Early sales meet queued buyers. Quotes soften as that demand is absorbed.
      const demandAbsorbed = crowd?.retail >= depth * 0.8 && minutesIntoSale >= 10;
      const steadySupply = crowd?.target >= depth * 10;
      const unloading = distributing && demandAbsorbed && (steadySupply || stock.large || stock.heat < 0.45);
      const pressing = steadySupply && crowd.sold < crowd.target * 0.75;
      const supplyShade = unloading ? ((pressing ? 0.00165 : 0.00075) + (steadySupply && watched ? 0.0004 : 0)) : 0;
      // After a large transfer to retail, liquidity providers commit less capital near the old price.
      const overhang = clamp(((stock.overhang ?? 0) / depth - 1) / 7, 0, 1);
      const withdrawal = overhang * clamp((stock.session.midpoint / Math.max(1, stock.fair) - 0.78) / 0.22, 0, 1);
      const inventoryShade = pressure * 0.00075 - relief * 0.00068;
      const price = Math.round(stock.session.midpoint * (1 + (stock.large ? indexBias : 0) - supplyShade - withdrawal * 0.00062 - inventoryShade));
      const daily = stock.session.midpoint / stock.prevClose - 1;
      const regularSpread = stock.large ? 0.00065 : 0.0009;
      const spread = Math.max(1, Math.round(price * (opening ? 0.0035 : regularSpread * (busy ? 1.3 : 1))));
      const offered = lots(Math.min(exitRoom, depth * 0.25));
      const sellingCleared = steadySupply && demandAbsorbed && !distributing;
      const valueBid = sellingCleared && stock.fair > price * 1.015 ? 0.95 : 0.55;
      const bidSize = depth * (1 - withdrawal * 0.64);

      if (offered) npcOrder(state, lead, stock, 'sell', offered, price + spread);
      npcOrder(state, 'value', stock, 'buy', bidSize * valueBid, price - spread);
      npcOrder(state, 'value', stock, 'sell', depth * 0.65, price + spread);
      if (!rotation || stock.large) npcOrder(state, 'fund', stock, 'buy', bidSize * 0.72, price - spread * 2);
      npcOrder(state, 'fund', stock, 'sell', depth * 0.70, price + spread * 2);
      if (!watched && !dealerSelling && !unloading) {
        const caution = clamp(behavior.askSize + behavior.sellingReposts * 1.1, 0, 1);
        npcOrder(state, 'dealer', stock, 'buy', bidSize * (0.9 - caution * 0.6), price - spread * (3 + 3 * caution));
      }
      npcOrder(state, 'dealer', stock, 'sell', depth * 0.70, price + spread * 3);
      npcOrder(state, 'value', stock, 'buy', bidSize * 0.6, price - spread * 4);
      npcOrder(state, 'value', stock, 'sell', depth * 0.55, price + spread * 4);

      // Aggressive orders are generated from the preceding public snapshot and each actor's information.
      const noise = random(state) - 0.5;
      stock.session.sentiment = stock.session.sentiment * 0.64 + noise * 0.95;
      const deviation = clamp(stock.fair / price - 1, -0.15, 0.15);
      const chaseHolding = position(state, 'seekers', stock.id);
      const inventory = chaseHolding.shares / depth;
      const rebalance = clamp((15 - inventory) * 0.014, -0.30, 0.21);
      const fadingTheme = demandAbsorbed && steadySupply;
      const themeWeight = fadingTheme ? (sellingCleared ? 0.29 : 0.13) : 0.48;
      const attention = stock.heat > 0 ? stock.heat * (1 - withdrawal * 0.65) : stock.heat;
      const appetite = opening ? clamp(attention * 0.65 + daily * 4 + deviation * 3.1 + (noise - 0.02) * 1.3, -1.9, 2.2) :
        clamp(attention * themeWeight + daily * 2.5 + deviation * 1.6 + rebalance + stock.session.sentiment, -2.1, 2.2);
      const demandSide = appetite >= 0 ? 'buy' : 'sell';
      const participation = !opening && busy ? 1.2 : 1;
      const breakEven = chaseHolding.cost / Math.max(1, chaseHolding.shares);
      const heldLoss = breakEven ? 1 - price / breakEven : 0;
      const holdingForRebound = overhang > 0 && heldLoss > 0.035;
      const reluctance = appetite < 0 && holdingForRebound ? (heldLoss < 0.29 ? 0.22 : 0.68) : 1;
      if (overhang > 0 && heldLoss >= 0.007 && heldLoss <= 0.05) {
        npcOrder(state, 'seekers', stock, 'sell', depth * 0.45, Math.max(price + 2 * spread, breakEven));
      }
      npcOrder(state, 'seekers', stock, demandSide, depth * (0.15 + Math.abs(appetite)) * participation * reluctance,
        price + spread * (appetite >= 0 ? 4 : -4), 'flow');

      if (dealerActive) {
        const roll = noise + 0.5;
        const sellIntoBid = behavior.bid && behavior.bid.limit >= stock.fair * 0.975 &&
          roll < Math.min(0.9, behavior.bidSize * 0.95 + behavior.buyingReposts * 0.35);
        if (sellIntoBid) {
          npcOrder(state, 'dealer', stock, 'sell', depth * (0.7 + behavior.bidSize), behavior.bid.limit, 'flow');
        } else if (roll < relief * 0.85) {
          npcOrder(state, 'dealer', stock, 'buy', depth * (0.65 + relief * 1.5), price + spread * 4, 'flow');
        } else if (dealerSelling || roll < pressure * 0.8) {
          npcOrder(state, 'dealer', stock, 'sell', depth * (0.7 + pressure * 1.2), price - spread * 3, 'flow');
        } else if (focus && age <= 1 && !fadingTheme) {
          npcOrder(state, 'dealer', stock, 'buy', depth, price + spread * 4, 'flow');
        }
      }
      // The fund builds index support in several tranches and backs off once the index has recovered.
      const scalingIn = stock.large ? state.minute % 5 === 0 && indexChange < 0.0035 : state.minute % 3 === 0;
      if (rotation && (opening || scalingIn)) {
        const side = stock.large ? 'buy' : 'sell';
        npcOrder(state, 'fund', stock, side, depth * 1.35, price + spread * (stock.large ? 3 : -4), 'flow');
      }
      if (unloading && state.minute % 2 === 0) {
        const batch = Math.min((exitRoom - offered) / INTRADAY_FLOW, depth * 0.96);
        npcOrder(state, lead, stock, 'sell', batch, price - spread * 3, 'flow');
      }
      if (stock.large && !distributing && ((policy && state.phase >= 1 && indexChange < 0.0015) ||
        (state.phase >= 1 && indexChange < -0.0045 && state.minute % 4 === 0))) {
        const cap = depth * (indexChange < -0.009 ? 1.6 : 0.7);
        npcOrder(state, 'national', stock, 'buy', cap, price + spread * 3, 'flow');
      } else if (stock.large && !crowd && state.phase === 2 && age >= 12 && age <= 14 && daily >= 0) {
        npcOrder(state, 'national', stock, 'sell', depth * 0.4, price - spread, 'flow');
      }

      const family = position(state, 'family', stock.id);
      if (!crowd && (opening || state.minute % 4 === 0) && focus && age >= 5 && age <= 8 && family.shares > depth * 20) {
        npcOrder(state, 'family', stock, 'sell', depth * 0.95, price - spread * 2, 'flow');
      } else if (!distributing && !stock.large && age >= 11 && state.phase === 1 && stock.fair > price * 1.05 && random(state) < 0.25) {
        npcOrder(state, 'family', stock, 'buy', depth * 0.35, price + spread * 2, 'flow');
      }
    }
  }

  function newsChannel(item) {
    if (['财报', '更正'].includes(item.type)) return 'report';
    if (['论坛', '旧帖'].includes(item.type)) return 'forum';
    return 'news';
  }

  function headline(state, stock, type, title, body, { topic = stock?.theme ?? '全市场', source = '盘面快讯' } = {}) {
    News.write(state, stock, 'announcement', type, source, title, body, null, topic);
  }

  function addFunding(state) {
    const deposits = { seekers: 13_000_000, value: 7_000_000, fund: 29_000_000, national: 36_000_000 };
    for (const [actor, cash] of Object.entries(deposits)) {
      state.actors[actor].cash += cash;
      state.economy.injected += cash;
    }
    const out = Math.min(9_000_000, Math.floor(state.actors.fund.cash / 10));
    state.actors.fund.cash -= out;
    state.economy.outgoing += out;
    headline(state, null, '资金', '周期资金到账，机构同时面临赎回',
      `本轮居民与定投资金新增 ${(deposits.seekers + deposits.value) / 1e6} 万元，配置基金收到 ${deposits.fund / 1e6} 万元，稳定资金收到 ${deposits.national / 1e6} 万元。配置基金另行兑付 ${(out / 1e6).toFixed(2)} 万元赎回款。\n\n实际买入取决于各席位的报价和盘中承接，本轮资金可用于权重配置、新股申购或保留现金。`,
      { topic: '全市场资金', source: '盘面资金观察' });
  }

  function listStock(state) {
    const number = state.stocks.length + 1;
    const themes = ['机器人', '储能', '消费'];
    const theme = themes[(number - 9) % themes.length];
    const companies = ['北辰精工', '泽鸣智控', '青澜材料', '远衡科技', '星泊实业'];
    const price = 570 + Math.floor(random(state) * 920);
    const stock = createStock(state, [`SIM${String(number).padStart(2, '0')}`, `${companies[(number - 9) % companies.length]}${number > 13 ? ` ${number}` : ''}`,
      theme === '机器人' ? '高端制造' : theme === '储能' ? '能源' : '消费', theme, price, 1200, 420_000, false], false);
    const issuedBefore = state.economy.issued;
    allocate(state, stock, price);
    state.stocks.push(stock);
    const raised = state.economy.issued - issuedBefore;
    headline(state, stock, '上市', `${stock.name}挂牌交易`,
      `挂牌首日参考价为 ${(price / 100).toFixed(2)} 元，所属概念为${stock.theme}。散户、机构和家族的认购款计入发行人账户，本次募集 ${(raised / 1e6).toFixed(2)} 万元。\n\n该股将于第 ${state.day + 5} 日纳入指数。纳入时调整指数除数，挂牌当天的价格涨跌先体现在个股行情。`,
      { source: '市场挂牌公告' });
  }

  function financeFamily(state, stock) {
    const family = state.actors.family;
    const fund = state.actors.fund;
    const holding = position(state, 'family', stock.id);
    const collateral = lots(Math.min(stock.depth * 3, sellable(state, stock.id, 'family')));
    const principal = Math.floor(collateral * stock.price * 0.46);
    if (collateral === 0 || fund.cash < principal * 3 || state.loan) return;
    holding.pledged += collateral;
    family.cash += principal;
    fund.cash -= principal;
    state.loan = { symbol: stock.id, collateral, principal, due: state.day + 6 };
    const quantity = lots(stock.depth * 0.75);
    const margin = Math.ceil(quantity * stock.price * 0.30);
    if (quantity > 0 && family.cash >= margin && fund.cash >= margin) {
      family.cash -= margin;
      fund.cash -= margin;
      state.contract = { symbol: stock.id, entry: stock.price, quantity, margin, due: state.day + 5 };
    }
    headline(state, stock, '公告', `${stock.name}披露控股股东股权质押`,
      `控股股东向机构质押 ${collateral} 股，取得融资 ${(principal / 100).toFixed(2)} 元，约定于第 ${state.loan.due} 日归还。质押期间股份锁定。\n\n若担保价值降至借款的 1.33 倍以下，将提前进入结算。届时控股股东可偿还借款解押，偿付能力不足时机构可接收担保股份。`,
      { source: `${stock.name}公告` });
  }

  function settleFamily(state) {
    const family = state.actors.family;
    const fund = state.actors.fund;
    const contract = state.contract;
    if (contract) {
      const stock = stockById(state, contract.symbol);
      const pnl = (contract.entry - stock.price) * contract.quantity;
      if (state.day >= contract.due || Math.abs(pnl) >= contract.margin || stock.status !== 'active') {
        const settled = clamp(pnl, -contract.margin, contract.margin);
        family.cash += contract.margin + settled;
        fund.cash += contract.margin - settled;
        family.realized += settled;
        fund.realized -= settled;
        state.contract = null;
        headline(state, stock, '复盘', '家族关联盘的合约已结算',
          `关联空头覆盖 ${contract.quantity} 股，建仓参考价 ${(contract.entry / 100).toFixed(2)} 元，本次结算参考价 ${(stock.price / 100).toFixed(2)} 元。家族关联盘结算损益为 ${(settled / 100).toFixed(2)} 元。\n\n损益在家族与作为对手方的机构之间划转，质押借款和股票现货按各自条款处理。`, { source: '交易复盘' });
      }
    }
    const loan = state.loan;
    if (!loan) return;
    const stock = stockById(state, loan.symbol);
    if (state.day < loan.due && loan.collateral * stock.price >= loan.principal * 1.33 && stock.status === 'active') return;
    const holding = position(state, 'family', loan.symbol);
    holding.pledged -= loan.collateral;
    if (family.cash >= loan.principal) {
      family.cash -= loan.principal;
      fund.cash += loan.principal;
      headline(state, stock, '公告', '控股股东解除本次质押',
        `控股股东已向出资机构归还 ${(loan.principal / 100).toFixed(2)} 元，解除本次质押的 ${loan.collateral} 股。\n\n股份留在原账户，解除质押后的可交易状态仍取决于限售安排。`, { source: `${stock.name}公告` });
    } else {
      const received = fund.positions[stock.id] ??= emptyPosition();
      addChips(received, Math.round(loan.principal / loan.collateral), loan.collateral);
      removeChips(holding, loan.collateral);
      holding.cost -= Math.floor(holding.cost * loan.collateral / holding.shares);
      holding.shares -= loan.collateral;
      received.shares += loan.collateral;
      received.cost += loan.principal;
      headline(state, stock, '公告', '质押股份发生处置',
        `控股股东未能归还 ${(loan.principal / 100).toFixed(2)} 元贷款，出资机构按约接收 ${loan.collateral} 股担保股份。\n\n本次账户过户将在当前结算轮次完成，市场内的实际卖出仍需机构另行下单。`, { source: `${stock.name}公告` });
    }
    state.loan = null;
  }

  function episodeNews(state) {
    const age = (state.day - 1) % 20;
    if (age === 0) {
      const targets = state.stocks.filter(stock => stock.status === 'active' && ['机器人', '储能'].includes(stock.theme));
      const focus = targets.find(stock => stock.id === 'SIM03') ?? targets[0];
      const stock = (state.day > 1 ? targets[Math.floor(random(state) * targets.length)] : focus) ?? state.stocks[0];
      state.episode = { since: state.day, symbol: stock.id, favorable: random(state) > 0.48 };
      News.projectNews(state, stock, 'sample');
    }
    const event = state.episode;
    const stock = stockById(state, event.symbol);
    const peers = state.stocks.filter(peer => peer.theme === stock.theme && peer.id !== stock.id && peer.status === 'active');
    if (age === 1) {
      stock.heat += 1.25;
      for (const peer of peers) peer.heat += 0.45;
      News.projectNews(state, stock, 'pickup');
    }
    if (age === 3) {
      stock.heat += 1.35;
      News.projectNews(state, stock, 'filing');
    }
    if (age === 4) financeFamily(state, stock);
    if (age === 5) {
      const holding = position(state, 'family', stock.id);
      const unlocked = Math.min(holding.restricted, lots(stock.depth * 5));
      holding.restricted -= unlocked;
      if (unlocked > 0) headline(state, stock, '公告', `${stock.name}部分控股股东股份解除限售`,
        `本次解除限售 ${unlocked} 股，占控股股东目前持有的 ${holding.shares} 股的 ${(unlocked / holding.shares * 100).toFixed(1)}%。仍有限售 ${holding.restricted} 股、质押 ${holding.pledged} 股。\n\n解除限售自第 ${state.day} 日起生效，后续减持以实际成交或权益变动公告为准。`, { source: `${stock.name}公告` });
    }
    if (age === 6 && state.actors.national.cash > 9_000_000) {
      state.policy = { until: state.day + 4 };
      const core = state.stocks.filter(item => item.large && item.status === 'active');
      for (const item of core) item.heat += 0.18;
      const names = core.map(item => item.name).join('、');
      headline(state, null, '政策', `稳定资金披露权重配置窗口`,
        `第 ${state.day}–${state.policy.until} 日，稳定资金将跟踪${names || '核心权重股'}。公告时指数为 ${indexValue(state).toFixed(2)} 点，基金将根据盘中指数和买卖盘情况分批报价。\n\n市场可在实际成交后观察权重与其他题材涨跌家数的变化。`,
        { topic: '高股息', source: '稳定资金公开说明' });
    }
    if (age === 8) {
      News.projectNews(state, stock, 'resolution');
      if (event.favorable) {
        const project = event.project;
        const earlier = state.news.find(item => item.event === 'mediaClaim' && item.symbol === stock.id &&
          item.day >= event.since && Number.isSafeInteger(item.facts?.claimedUnits));
        const shortfall = Math.max(0, 1 - project.units / (earlier?.facts.claimedUnits || project.units));
        const premium = clamp(stock.price / stock.fair - 1, 0, 0.15);
        const marginImpact = (project.amount - project.cost) / Math.max(1, stock.fair * stock.float);
        // Buyers compare the signed order to the earlier claim, today's valuation and time to cash.
        stock.heat = clamp(stock.heat * 0.5 + 0.93 - shortfall * 4 - premium * 4 - (project.paymentLag - 3) * 0.025, -0.9, 1.1);
        stock.fair = Math.round(stock.fair * (1 + clamp(marginImpact * 0.65, 0, 0.09)));
      } else {
        stock.heat -= 2.8;
        stock.fair = Math.max(1, Math.round(stock.fair * 0.86));
      }
      stock.distress = Math.max(0, stock.distress + (event.favorable ? -1 : 2));
    }
    if (age === 12) {
      const nextTheme = stock.theme === '机器人' ? '储能' : '机器人';
      const candidates = state.stocks.filter(item => item.theme === nextTheme && item.status === 'active');
      for (const peer of candidates) peer.heat += 0.8;
      if (!candidates.length) return;
      const previous = candidates.map(item => item.history.at(-1)).filter(Boolean);
      const volume = previous.reduce((sum, bar) => sum + bar.volume, 0);
      const names = candidates.slice(0, 3).map(item => item.name).join('、');
      headline(state, null, '媒体', `配置动向转向${nextTheme}`,
        `板块观察本期跟踪${names}等 ${candidates.length} 只${nextTheme}股票，上个交易日合计成交 ${volume.toLocaleString('zh-CN')} 股。\n\n简报依据重点题材变化将跟踪重心从${stock.theme}移向${nextTheme}，今日实际流入仍有待成交盘面验证。`,
        { topic: nextTheme, source: '板块观察' });
    }
  }

  function processListings(state) {
    const before = indexCap(state);
    for (const stock of state.stocks) {
      if (!stock.indexMember && stock.status === 'active' && state.day - stock.listedDay === 5) stock.indexMember = true;
    }
    const after = indexCap(state);
    if (before > 0 && after !== before) state.divisor *= after / before;
  }

  function startDay(state) {
    state.phase = 0;
    state.minute = HOURS.open;
    // Keep every fill that can appear on a daily candle and the recent account history.
    state.fills = state.fills.filter((trade, index) => index < RECENT_FILLS || trade.day >= state.day - CHART_CANDLES);
    for (const actor of Object.values(state.actors)) for (const holding of Object.values(actor.positions)) holding.locked = 0;
    for (const stock of state.stocks) {
      stock.prevClose = stock.price;
      stock.session = emptySession(stock.price);
      if (stock.exitFlow !== undefined) stock.exitFlow = Math.floor(stock.exitFlow * EXIT_FLOW_DECAY ** 50);
      if (stock.overhang !== undefined) stock.overhang = lots(stock.overhang * 0.79);
      stock.heat *= 0.82;
      if (state.day > 1 && stock.status === 'active') stock.fair = Math.max(1, Math.round(stock.fair * (0.993 + random(state) * 0.014)));
    }
    processListings(state);
    state.indexPrev = indexValue(state);
    if (state.day % 20 === 5) addFunding(state);
    if (state.day % 20 === 11) listStock(state);
    if (state.day % 60 === 45) startDelisting(state);
    episodeNews(state);
    News.open(state);
    prepare(state);
  }

  function startDelisting(state) {
    const stock = state.stocks.find(item => !item.large && item.status === 'active' && item.id !== state.episode.symbol && item.distress >= 2);
    if (!stock) return;
    const before = indexCap(state);
    stock.status = 'suspended';
    stock.indexMember = false;
    stock.receivableDay = state.day + 5;
    state.divisor *= indexCap(state) / before;
    headline(state, stock, '公告', `${stock.name}停牌并进入清算`,
      `公司从第 ${state.day} 日起暂停交易，并同步从市场指数移出。清算小组预计于第 ${stock.receivableDay} 日公布股东财产分配结果。\n\n清算期间股东权益仍记在原账户。公司将先支付清算费用及债务，剩余财产再按持股比例分配。`, { source: '清算安排公告' });
  }

  function clearDelistings(state) {
    for (const stock of state.stocks.filter(item => item.status === 'suspended' && item.receivableDay <= state.day)) {
      for (const actor of Object.values(state.actors)) {
        const holding = actor.positions[stock.id];
        if (!holding?.shares) continue;
        actor.realized -= holding.cost;
        delete actor.positions[stock.id];
      }
      stock.status = 'delisted';
      stock.price = 0;
      cancelPositionProtection(state, stock.id, '该股票已退市。');
      headline(state, stock, '退市', `${stock.name}完成清算`,
        `第 ${state.day} 日公布最终清算结果。变现资产用于支付清算费用及债务，股东剩余可分配财产为零。\n\n相关股份从各账户注销，账户损益以剩余持仓成本结转。`, { source: '清算结果公告' });
    }
  }

  function netWorth(state) {
    const player = state.actors.player;
    return player.cash + state.stocks.reduce((sum, stock) => sum + position(state, 'player', stock.id).shares * stock.price, 0);
  }

  function depth(state, symbol) {
    // Public quotes are firm for the upcoming batch. Directional orders join after the player.
    const active = state.orders.filter(order => order.symbol === symbol && order.style === 'quote');
    const collect = side => {
      const levels = new Map();
      for (const order of active.filter(item => item.side === side).sort((a, b) => byPriceTime(side, a, b))) {
        levels.set(order.limit, (levels.get(order.limit) ?? 0) + order.remaining);
      }
      return [...levels].map(([price, quantity]) => ({ price, quantity }));
    };
    return { bids: collect('buy'), asks: collect('sell') };
  }

  function estimate(state, symbol, side, quantity, limit = side === 'buy' ? Infinity : 0) {
    const book = depth(state, symbol)[side === 'buy' ? 'asks' : 'bids'];
    let filled = 0;
    let notional = 0;
    for (const level of book) {
      if (side === 'buy' ? level.price > limit : level.price < limit) break;
      const size = Math.min(quantity - filled, level.quantity);
      notional += size * level.price;
      filled += size;
      if (filled === quantity) break;
    }
    const charge = fee(notional);
    return { filled, notional, fee: charge, total: notional + (side === 'buy' ? charge : -charge) };
  }

  function finish(state, reason) {
    const holdings = state.stocks.filter(stock => position(state, 'player', stock.id).shares > 0).map(stock => {
      const holding = position(state, 'player', stock.id);
      const sale = estimate(state, stock.id, 'sell', holding.shares - holding.locked);
      return { name: stock.name, shares: holding.shares, marketValue: holding.shares * stock.price,
        estimated: sale.total, estimatedShares: sale.filled };
    });
    for (const order of state.orders) archive(state, order, 'canceled');
    for (const rule of state.conditions) archiveCondition(state, rule, 'canceled');
    state.orders = [];
    state.conditions = [];
    state.ended = { reason, day: state.day, phase: state.phase, minute: state.minute, cash: state.actors.player.cash, equity: netWorth(state),
      realized: state.actors.player.realized, holdings, index: indexValue(state), drawdown: state.drawdown };
  }

  function exit(state) {
    if (!state.ended) finish(state, 'exit');
  }

  function closeDay(state) {
    settleFamily(state);
    clearDelistings(state);
    News.close(state);
    for (const stock of state.stocks.filter(item => item.status !== 'delisted')) {
      const { open, high, low, volume, crowd } = stock.session;
      const crowdTransfer = !stock.large && crowd?.sold >= stock.depth * 6 ? crowd.retail : 0;
      const transferred = crowdTransfer + (stock.session.rotationRetail ?? 0);
      if (transferred > 0) stock.overhang = Math.min(stock.depth * 15, (stock.overhang ?? 0) + transferred);
      if (crowd?.sold > 0) {
        const role = stock.large ? '稳定资金' : '控股股东';
        headline(state, stock, '复盘', `${stock.name}放量后的席位成交`,
          `${role}在早盘放量信号后的分批卖出窗口内成交 ${crowd.sold.toLocaleString('zh-CN')} 股，其中散户账户承接 ${crowd.retail.toLocaleString('zh-CN')} 股。盘中最高 ${(high / 100).toFixed(2)} 元，收盘 ${(stock.price / 100).toFixed(2)} 元。`,
          { source: '交易复盘' });
      }
      stock.history.push({ day: state.day, close: stock.price, open: open ?? stock.price, high, low, volume, chips: chipSnapshot(state, stock) });
      if (stock.history.length > 100) stock.history.shift();
      const outsideDailyView = stock.history.at(-CHART_CANDLES - 1);
      if (outsideDailyView) delete outsideDailyView.chips;
    }
    const equity = netWorth(state);
    state.peak = Math.max(state.peak, equity);
    state.drawdown = Math.max(state.drawdown, 1 - equity / state.peak);
    state.journal.push({ day: state.day, equity, index: indexValue(state) });
    if (state.journal.length > 180) state.journal.shift();
    const player = state.actors.player;
    // Pending delisting rights remain in positions until clearDelistings settles them.
    if (player.cash === 0 && Object.values(player.positions).every(holding => holding.shares === 0)) finish(state, 'bankruptcy');
  }

  function advance(state) {
    if (state.ended) return false;
    if (state.phase === 3) {
      state.day += 1;
      startDay(state);
      return true;
    }
    if (state.phase !== 0) {
      state.minute += HOURS.tick;
      if (state.minute > HOURS.morningEnd && state.minute < HOURS.afternoonOpen) return true;
      state.phase = state.minute >= HOURS.late ? 2 : 1;
      if (state.minute === HOURS.afternoonOpen) prepare(state);
    }
    if (state.conditions.length) activateConditions(state);
    match(state);
    if (state.minute === HOURS.close) {
      state.phase = 3;
      closeDay(state);
    } else {
      state.phase = state.minute >= HOURS.late ? 2 : 1;
      if (!atLunch(state)) prepare(state);
    }
    return true;
  }

  function closeSession(state) {
    if (!state.ended && state.phase === 3) advance(state);
    while (!state.ended && state.phase < 3) advance(state);
  }

  function breadth(state) {
    const results = { up: 0, down: 0, flat: 0, suspended: 0 };
    for (const stock of state.stocks) {
      if (stock.status === 'suspended') results.suspended += 1;
      if (stock.status !== 'active') continue;
      results[stock.price > stock.prevClose ? 'up' : stock.price < stock.prevClose ? 'down' : 'flat'] += 1;
    }
    return results;
  }

  function deserialize(raw) {
    const state = JSON.parse(raw);
    const integer = n => Number.isSafeInteger(n) && n >= 0;
    const validChips = holding => holding.chips === undefined || Array.isArray(holding.chips) && holding.chips.length <= CHIP_LEVELS &&
      holding.chips.every((level, index, levels) => Array.isArray(level) && level.length === 2 && integer(level[0]) &&
        integer(level[1]) && level[1] > 0 && (!index || level[0] > levels[index - 1][0])) &&
      holding.chips.reduce((total, level) => total + level[1], 0) === holding.shares;
    const validChipSnapshot = (snapshot, close) => snapshot == null || integer(snapshot.low) && integer(snapshot.step) && snapshot.step > 0 &&
      integer(snapshot.total) && snapshot.total > 0 && Number.isFinite(snapshot.average) && snapshot.average >= 0 &&
      Array.isArray(snapshot.range) && snapshot.range.length === 2 && snapshot.range.every(integer) && snapshot.range[0] <= snapshot.range[1] &&
      Array.isArray(snapshot.bands) && snapshot.bands.length > 0 && snapshot.bands.length <= CHIP_BANDS &&
      snapshot.bands.every(band => Array.isArray(band) && band.length === 3 && band.every(integer)) &&
      close >= snapshot.low && close < snapshot.low + snapshot.step * snapshot.bands.length &&
      snapshot.bands.reduce((sum, band) => sum + band[0] + band[1] + band[2], 0) === snapshot.total &&
      snapshot.bands.reduce((sum, band) => sum + band[0], 0) / snapshot.total === snapshot.profit;
    const optionalAmount = value => value === undefined || value === null || integer(value);
    const arrays = ['stocks', 'orders', 'tickets', 'fills', 'news', 'activity', 'journal'];
    const clockMinute = value => integer(value) && value >= HOURS.open && value <= HOURS.close && value % HOURS.tick === 0;
    const legacy = state?.minute === undefined;
    const valid = state?.version === VERSION && integer(state.day) && state.day > 0 && integer(state.phase) && state.phase < 4 &&
      (legacy || (clockMinute(state.minute) && (state.phase === 0 ? state.minute === HOURS.open :
        state.phase === 3 ? state.minute === HOURS.close : state.minute < HOURS.close && (state.minute >= HOURS.late) === (state.phase === 2)))) &&
      integer(state.rng) && state.rng > 0 && integer(state.seed) && integer(state.seq) && state.seq > 0 &&
      arrays.every(name => Array.isArray(state[name])) && Number.isFinite(state.divisor) && state.divisor > 0 &&
      (state.indexBase === undefined || Number.isFinite(state.indexBase) && state.indexBase > 0) &&
      Number.isFinite(state.indexPrev) && state.indexPrev > 0 && integer(state.peak) && state.peak > 0 &&
      Number.isFinite(state.drawdown) && state.drawdown >= 0 && state.drawdown <= 1 &&
      ['fees', 'issuers', 'injected', 'issued', 'outgoing'].every(name => integer(state.economy?.[name])) &&
      ['player', ...ROLE_IDS].every(id => {
        const actor = state.actors?.[id];
        return actor?.id === id && integer(actor.cash) && Number.isSafeInteger(actor.realized) && actor.positions &&
          Object.values(actor.positions).every(p => p && ['shares', 'locked', 'restricted', 'pledged', 'cost'].every(key => integer(p[key])) &&
            p.locked + p.restricted + p.pledged <= p.shares && validChips(p));
      }) && state.stocks.length >= 8 && state.stocks.every(stock => /^SIM\d+$/.test(stock?.id) && typeof stock.name === 'string' &&
      ['active', 'suspended', 'delisted'].includes(stock.status) && integer(stock.price) && integer(stock.prevClose) &&
      integer(stock.fair) && integer(stock.float) && integer(stock.depth) && Number.isFinite(stock.heat) && integer(stock.exposure) &&
      (stock.business === undefined || News.validBusiness(stock.business)) &&
      integer(stock.distress) &&
      (stock.overhang === undefined || integer(stock.overhang)) &&
      (stock.exitFlow === undefined || integer(stock.exitFlow)) &&
      stock.session && (stock.session.open === null || integer(stock.session.open)) && optionalAmount(stock.session.amount) &&
      (stock.session.midpoint === undefined || Number.isFinite(stock.session.midpoint) && stock.session.midpoint >= 0) &&
      (stock.session.sentiment === undefined || Number.isFinite(stock.session.sentiment)) &&
      (stock.session.rotationRetail === undefined || integer(stock.session.rotationRetail)) &&
      (stock.session.crowd === undefined || (stock.session.crowd &&
        ['start', 'target', 'sold', 'retail'].every(key => integer(stock.session.crowd[key])) &&
        stock.session.crowd.start <= SESSION_POINTS && stock.session.crowd.target > 0 &&
        stock.session.crowd.retail <= stock.session.crowd.sold && stock.session.crowd.sold <= stock.session.crowd.target)) &&
      (stock.session.ticks === undefined || (Array.isArray(stock.session.ticks) && stock.session.ticks.length <= SESSION_POINTS &&
        stock.session.ticks.every(tick => tick && (legacy ? integer(tick.phase) && tick.phase < 3 : clockMinute(tick.minute)) &&
          integer(tick.close) && integer(tick.volume) && optionalAmount(tick.amount)))) &&
      ['high', 'low', 'volume'].every(name => integer(stock.session[name])) && Array.isArray(stock.history) &&
      stock.history.every(candle => candle && ['open', 'high', 'low', 'close', 'volume'].every(name => integer(candle[name])) &&
        validChipSnapshot(candle.chips, candle.close))) &&
      state.episode && state.stocks.some(stock => stock.id === state.episode.symbol) && integer(state.episode.since) && News.validEpisode(state.episode) &&
      state.news.every(item => item && integer(item.id) && integer(item.day) && typeof item.title === 'string') &&
      state.tickets.every(item => item && integer(item.id) && integer(item.remaining) && integer(item.quantity) &&
        (item.canceledMinute === undefined || item.status === 'canceled' && item.resting === true && clockMinute(item.canceledMinute)) &&
        (item.protection === undefined || validProtection(item.protection))) &&
      state.fills.every(item => item && integer(item.day) && integer(item.quantity) && integer(item.price)) &&
      state.activity.every(item => item && item.flows && item.volumes && Object.keys(ROLES).every(role =>
        Number.isSafeInteger(item.flows[role]) && integer(item.volumes[role]))) &&
      (state.ended === null || (['exit', 'bankruptcy'].includes(state.ended?.reason) && integer(state.ended.cash) &&
        integer(state.ended.equity) && Array.isArray(state.ended.holdings) && state.ended.holdings.every(item => item && integer(item.shares))));
    if (!valid) throw Error('存档格式无效或版本不受支持。');
    const symbols = new Set(state.stocks.map(stock => stock.id));
    if (state.conditions === undefined) state.conditions = [];
    const ids = new Set(state.orders.map(order => order?.id));
    const protectedSymbols = new Set();
    if (!Array.isArray(state.conditions) || state.conditions.some(rule => {
      if (!rule || !symbols.has(rule.symbol) || !integer(rule.id) || rule.id === 0 || rule.id >= state.seq || ids.has(rule.id) ||
        !integer(rule.day) || rule.day === 0 || rule.day > state.day || !clockMinute(rule.minute)) return true;
      if (rule.protection !== undefined) {
        if (!validProtection(rule.protection) || rule.side !== 'sell' || protectedSymbols.has(rule.symbol)) return true;
        protectedSymbols.add(rule.symbol);
      } else if (!['buy', 'sell'].includes(rule.side) || !['above', 'below'].includes(rule.comparison) ||
        !integer(rule.trigger) || rule.trigger === 0 || !integer(rule.quantity) || rule.quantity === 0 || rule.quantity % LOT !== 0 ||
        !integer(rule.limit) || rule.limit === 0 || !integer(rule.limit * rule.quantity + fee(rule.limit * rule.quantity))) return true;
      ids.add(rule.id);
      return false;
    })) throw Error('存档中的条件单无效。');
    if (symbols.size !== state.stocks.length || state.orders.some(order => !symbols.has(order?.symbol) || !Object.hasOwn(state.actors, order.actor) ||
      !['buy', 'sell'].includes(order.side) || !integer(order.id) || !integer(order.quantity) || !integer(order.limit) ||
      !integer(order.remaining) || order.remaining === 0 || order.remaining > order.quantity || !integer(order.notional) ||
      (order.protection !== undefined && !validProtection(order.protection)) ||
      !['quote', 'flow', 'player'].includes(order.style) || order.day !== state.day ||
      (order.side === 'sell' && sellable(state, order.symbol, order.actor) < 0)) ||
      Object.keys(state.actors).some(id => buyPower(state, id) < 0)) {
      throw Error('存档里的股票或订单记录无效。');
    }
    if (state.indexBase === undefined) {
      const oldIndex = indexValue(state);
      const scale = oldIndex > 0 ? clamp(oldIndex * (INDEX_BASE / 1000), 2500, 4000) / oldIndex : INDEX_BASE / 1000;
      state.indexBase = 1000 * scale;
      state.divisor /= scale;
      state.indexPrev *= scale;
      for (const entry of state.journal) if (entry && Number.isFinite(entry.index)) entry.index *= scale;
      if (state.ended) state.ended.index *= scale;
    }
    if (legacy) {
      state.minute = LEGACY_TIME[state.phase];
      for (const stock of state.stocks) {
        stock.session.ticks = stock.session.ticks?.map(tick => ({ minute: LEGACY_BATCHES[tick.phase], close: tick.close, volume: tick.volume })) ?? [];
      }
      if (state.ended) state.ended.minute = LEGACY_TIME[state.ended.phase];
    }
    for (const trade of state.fills) {
      if (trade.minute === undefined && Number.isInteger(trade.phase) && LEGACY_BATCHES[trade.phase] !== undefined) {
        trade.minute = LEGACY_BATCHES[trade.phase];
      }
    }
    for (const stock of state.stocks) {
      if (stock.theme === '内需') stock.sector = stock.theme = '消费';
      stock.business ??= News.createBusiness(state.seed, stock, state.phase === 3 ? state.day : state.day - 1);
      if (stock.session.amount === undefined) stock.session.amount = stock.session.volume === 0 ? 0 : null;
      stock.session.midpoint ??= stock.price;
      stock.session.sentiment ??= 0;
    }
    for (const item of state.news) {
      for (const key of ['topic', 'title', 'body']) if (typeof item[key] === 'string' && item[key].includes('内需')) item[key] = item[key].replaceAll('内需', '消费');
    }
    return state;
  }

  const api = { START_CASH, CHART_CANDLES, STAGES, ROLES, HOURS, atLunch, create, place, placeCondition, setProtection, protectionFor, advance, closeSession, cancel, exit, deserialize,
    depth, estimate, netWorth, indexValue, breadth, bounds, sellable, buyPower, position, chipProfile, chipSnapshot, stockCode, newsChannel, fee };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.Market = api;
})();
