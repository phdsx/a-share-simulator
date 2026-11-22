'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./market.js');
const SYMBOL = 'SIM03';

function advanceTo(state, day, phase = 0) {
  while (state.day < day || state.phase < phase) assert.equal(M.advance(state), true);
}

function quote(state, actor, side, quantity, limit) {
  const order = { id: state.seq++, actor, symbol: SYMBOL, side, quantity, remaining: quantity, limit,
    notional: 0, day: state.day, phase: state.phase, minute: state.minute, style: 'quote', resting: false };
  state.orders.push(order);
  return order;
}

function totalCash(state) {
  const cash = Object.values(state.actors).reduce((sum, actor) => sum + actor.cash, 0);
  return cash + state.economy.issuers + state.economy.fees + state.economy.outgoing +
    (state.contract?.margin ?? 0) * 2 - state.economy.injected;
}

test('limits match by price then time and charge only the matched shares', () => {
  const state = M.create();
  state.orders = [];
  quote(state, 'dealer', 'sell', 100, 1010);
  quote(state, 'fund', 'sell', 100, 1004);
  quote(state, 'value', 'sell', 100, 1004);
  const initial = totalCash(state);
  const order = M.place(state, SYMBOL, 'buy', 300, 1004);
  assert.equal(M.buyPower(state), M.START_CASH - 301502);
  M.advance(state);
  assert.deepEqual(state.fills.map(f => f.price), [1004, 1004]);
  assert.equal(state.stocks[2].session.amount, 200800);
  assert.equal(state.stocks[2].session.ticks[0].amount, 200800);
  assert.equal(state.actors.fund.positions[SYMBOL].shares, 104400);
  assert.equal(M.position(state, 'player', SYMBOL).locked, 200);
  assert.equal(state.orders.find(item => item.id === order.id).remaining, 100);
  assert.equal(state.actors.player.cash, M.START_CASH - 201001);
  assert.throws(() => M.place(state, SYMBOL, 'sell', 100, 1000), /次日/);
  assert.ok(M.cancel(state, order.id));
  assert.equal(M.buyPower(state), state.actors.player.cash);
  assert.equal(state.tickets[0].remaining, 100);
  assert.equal(totalCash(state), initial);

  advanceTo(state, 2);
  assert.equal(M.sellable(state, SYMBOL), 200);
  state.orders = [];
  quote(state, 'value', 'buy', 200, 1005);
  M.place(state, SYMBOL, 'sell', 200, 1005);
  M.advance(state);
  assert.equal(M.position(state, 'player', SYMBOL).shares, 0);
  assert.equal(state.actors.player.realized, -202);
  assert.equal(totalCash(state), initial);
});

test('chip costs redistribute on fills and retain the same total shares through a save', () => {
  const state = M.create();
  const initial = M.chipProfile(state, SYMBOL);
  assert.deepEqual(initial.levels, [[1000, initial.total]]);
  assert.deepEqual(initial.range, [1000, 1000]);
  state.orders = [];
  quote(state, 'fund', 'sell', 100, 1010);
  quote(state, 'value', 'sell', 100, 1020);
  M.place(state, SYMBOL, 'buy', 200, 1020);
  M.advance(state);

  const profile = M.chipProfile(state, SYMBOL);
  assert.deepEqual(profile.levels, [[1000, initial.total - 200], [1010, 100], [1020, 100]]);
  assert.equal(profile.total, initial.total);
  assert.equal(profile.profit, (initial.total - 100) / initial.total);
  assert.equal(profile.average, 1000 + 3000 / initial.total);
  assert.deepEqual(M.chipProfile(M.deserialize(JSON.stringify(state)), SYMBOL), profile);

  advanceTo(state, 2);
  const limit = state.stocks[2].prevClose;
  state.orders = [];
  quote(state, 'fund', 'buy', 100, limit);
  M.place(state, SYMBOL, 'sell', 100, limit);
  M.advance(state);
  assert.deepEqual(M.position(state, 'player', SYMBOL).chips, [[1010, 50], [1020, 50]]);
  assert.equal(M.chipProfile(state, SYMBOL).total, initial.total);

  const old = M.create();
  old.actors.player.positions[SYMBOL] = { shares: 100, locked: 0, restricted: 0, pledged: 0, cost: 105000 };
  const revived = M.deserialize(JSON.stringify(old));
  assert.deepEqual(M.chipProfile(revived, SYMBOL).levels, [[1000, initial.total], [1050, 100]]);
  revived.actors.player.positions[SYMBOL].chips = [[1050, 99]];
  assert.throws(() => M.deserialize(JSON.stringify(revived)), /存档格式无效/);
});

test('daily chip snapshots retain the closing distribution and expire outside the visible candles', () => {
  const state = M.create();
  const stock = state.stocks.find(item => item.id === SYMBOL);
  assert.equal(stock.history.at(-1).chips, undefined);
  M.closeSession(state);
  const first = stock.history.at(-1);
  const firstSnapshot = structuredClone(first.chips);
  assert.equal(first.day, 1);
  assert.equal(first.close, stock.price);
  assert.deepEqual(firstSnapshot, M.chipSnapshot(state, stock));
  assert.equal(firstSnapshot.bands.flat().reduce((sum, shares) => sum + shares, 0), M.chipProfile(state, SYMBOL).total);

  M.closeSession(state);
  assert.deepEqual(first.chips, firstSnapshot);
  assert.notDeepEqual(stock.history.at(-1).chips, firstSnapshot);
  const restored = M.deserialize(JSON.stringify(state));
  assert.deepEqual(restored.stocks.find(item => item.id === SYMBOL).history.find(candle => candle.day === 1).chips, firstSnapshot);
  advanceTo(state, M.CHART_CANDLES, 3);
  assert.deepEqual(first.chips, firstSnapshot);
  M.closeSession(state);
  assert.equal(first.chips, undefined);
  assert.ok(stock.history.slice(-M.CHART_CANDLES).every(candle => candle.chips));
  assert.ok(stock.history.slice(0, -M.CHART_CANDLES).every(candle => candle.chips === undefined));
});

test('insufficient cash, bad price, invalid share lot, and self-trades are rejected', () => {
  const state = M.create();
  assert.throws(() => M.place(state, SYMBOL, 'buy', 100, 1190), /涨跌幅/);
  assert.throws(() => M.place(state, SYMBOL, 'buy', 50, 1000), /整数倍/);
  assert.throws(() => M.place(state, SYMBOL, 'buy', 1_000_000, 1000), /资金不足/);
  state.actors.player.positions[SYMBOL] = { shares: 100, locked: 0, restricted: 0, pledged: 0, cost: 100000 };
  state.orders = [];
  M.place(state, SYMBOL, 'sell', 100, 1050);
  M.place(state, SYMBOL, 'buy', 100, 1050);
  M.closeSession(state);
  assert.ok(state.tickets.some(order => order.status === 'self'));
  assert.ok(state.tickets.some(order => order.status === 'expired' || order.status === 'filled'));
  assert.equal(state.orders.length, 0);
  assert.throws(() => M.place(state, SYMBOL, 'buy', 100, 1000), /盘后/);
});

test('saved staged orders and quotes produce the same execution after resuming', () => {
  const state = M.create(123);
  const limit = M.depth(state, SYMBOL).asks[0].price;
  M.place(state, SYMBOL, 'buy', 100, limit);
  const revived = M.deserialize(JSON.stringify(state));
  assert.deepEqual(revived, state);
  M.advance(state);
  M.advance(revived);
  assert.deepEqual(revived, state);
  assert.equal(M.position(revived, 'player', SYMBOL).shares, 100);
  assert.throws(() => M.deserialize('{broken'));
  assert.throws(() => M.deserialize(JSON.stringify({ ...state, activity: [null] })), /格式无效/);
});

test('conditional orders wait for the last trade, survive a reload and activate only once', () => {
  const state = M.create();
  state.orders = [];
  quote(state, 'value', 'sell', 100, 1010);
  quote(state, 'dealer', 'buy', 100, 1010);
  const initialBuyingPower = M.buyPower(state);
  const rule = M.placeCondition(state, SYMBOL, 'buy', 100, 1010, 'above', 1010);
  assert.equal(M.buyPower(state), initialBuyingPower);
  M.advance(state);
  assert.equal(state.stocks[2].price, 1010);
  assert.equal(state.conditions.length, 1);
  assert.equal(state.fills.length, 0);

  const resumed = M.deserialize(JSON.stringify(state));
  resumed.orders = [];
  quote(resumed, 'fund', 'sell', 100, 1009);
  M.advance(resumed);
  assert.equal(resumed.conditions.length, 0);
  assert.equal(resumed.fills.length, 1);
  assert.equal(resumed.fills[0].price, 1009);
  assert.equal(resumed.fills[0].minute, M.HOURS.open + 1);
  assert.equal(resumed.tickets[0].trigger, 1010);
  assert.equal(resumed.tickets[0].conditionId, rule.id);
  assert.equal(resumed.tickets[0].status, 'filled');
  M.advance(resumed);
  assert.equal(resumed.fills.length, 1);
});

test('conditions can be canceled or carried after close and record failure at trigger time', () => {
  const state = M.create();
  const high = M.bounds(state.stocks[2])[1];
  M.place(state, SYMBOL, 'buy', 100, high);
  M.advance(state);
  const quantity = M.position(state, 'player', SYMBOL).shares;
  const lockedSale = M.placeCondition(state, SYMBOL, 'sell', quantity, 1000, 'below', high);
  const unfundedBuy = M.placeCondition(state, SYMBOL, 'buy', 20_000, 1000, 'below', high);
  const outOfBand = M.placeCondition(state, SYMBOL, 'buy', 100, 1, 'below', high);
  M.advance(state);
  for (const [rule, reason] of [[lockedSale, /次日/], [unfundedBuy, /资金不足/], [outOfBand, /涨跌幅范围/]]) {
    const ticket = state.tickets.find(item => item.id === rule.id);
    assert.equal(ticket.status, 'conditionFailed');
    assert.match(ticket.reason, reason);
  }
  const canceled = M.placeCondition(state, SYMBOL, 'buy', 100, 1000, 'below', 1);
  assert.equal(M.cancel(state, canceled.id), true);
  assert.equal(state.tickets[0].status, 'canceled');

  M.closeSession(state);
  const atClose = state.stocks[2].price;
  M.placeCondition(state, SYMBOL, 'sell', quantity, atClose, 'below', atClose);
  M.advance(state);
  assert.equal(state.conditions.length, 1);
  assert.equal(M.sellable(state, SYMBOL), quantity);
  state.orders = [];
  quote(state, 'value', 'buy', quantity, atClose);
  M.advance(state);
  assert.equal(state.conditions.length, 0);
  assert.equal(state.fills[0].side, 'sell');
  assert.equal(M.position(state, 'player', SYMBOL).shares, 0);
});

test('take-profit and stop-loss each consume the linked pair and submit only one sell order', () => {
  for (const [mark, triggeredBy] of [[1060, 'takeProfit'], [940, 'stopLoss']]) {
    const initial = M.create();
    initial.actors.player.positions[SYMBOL] = { shares: 300, locked: 100, restricted: 0, pledged: 0, cost: 300000 };
    const rule = M.setProtection(initial, SYMBOL, 1040, 960);
    assert.equal(M.setProtection(initial, SYMBOL, 1050, 950).id, rule.id);
    assert.throws(() => M.setProtection(initial, SYMBOL, 940, 960), /高于止损价/);
    assert.deepEqual(rule.protection, { takeProfit: 1050, stopLoss: 950 });

    const state = M.deserialize(JSON.stringify(initial));
    assert.equal(M.sellable(state, SYMBOL), 200);
    state.stocks[2].price = mark;
    state.orders = [];
    const counterparty = triggeredBy === 'takeProfit' ? 'fund' : 'value';
    quote(state, counterparty, 'buy', 100, mark);
    M.advance(state);
    assert.equal(M.protectionFor(state, SYMBOL), undefined);
    const order = state.orders.find(item => item.conditionId === rule.id);
    assert.equal(order.triggeredBy, triggeredBy);
    assert.deepEqual(order.protection, rule.protection);
    assert.equal(order.quantity, 200);
    assert.equal(order.remaining, 100);
    assert.equal(state.fills[0].price, mark);
    assert.deepEqual(M.deserialize(JSON.stringify(state)), state);

    state.stocks[2].price = 2000 - mark;
    M.advance(state);
    const linked = [...state.orders, ...state.tickets].filter(item => item.conditionId === rule.id);
    assert.equal(linked.length, 1);
    assert.equal(linked[0].triggeredBy, triggeredBy);
  }
});

test('protection records a T+1 trigger failure and drops when a holding is closed manually', () => {
  const state = M.create();
  assert.throws(() => M.setProtection(state, SYMBOL, 1000, null), /持有/);
  state.actors.player.positions[SYMBOL] = { shares: 100, locked: 100, restricted: 0, pledged: 0, cost: 100000 };
  const rule = M.setProtection(state, SYMBOL, 1000, 900);
  M.advance(state);
  assert.equal(M.protectionFor(state, SYMBOL), undefined);
  const failure = state.tickets.find(item => item.id === rule.id);
  assert.equal(failure.triggeredBy, 'takeProfit');
  assert.equal(failure.status, 'conditionFailed');
  assert.match(failure.reason, /T\+1/);

  advanceTo(state, 2);
  const limit = state.stocks[2].price;
  const dormant = M.setProtection(state, SYMBOL, limit + 1000, null);
  state.orders = [];
  quote(state, 'fund', 'buy', 100, limit);
  M.place(state, SYMBOL, 'sell', 100, limit);
  M.advance(state);
  assert.equal(M.position(state, 'player', SYMBOL).shares, 0);
  assert.equal(M.protectionFor(state, SYMBOL), undefined);
  assert.equal(state.tickets.find(item => item.id === dormant.id).reason, '持仓已清空。');
});

test('legacy index migration preserves percentage returns and existing balances', () => {
  const older = M.create();
  older.divisor *= older.indexBase / 6150;
  delete older.indexBase;
  delete older.conditions;
  older.indexPrev = 6100;
  older.journal = [{ day: 1, equity: M.START_CASH, index: 6200 }];
  older.ended = { reason: 'exit', cash: M.START_CASH, equity: M.START_CASH, holdings: [], index: 6150 };
  const legacyPoint = M.indexValue(older);
  const state = M.deserialize(JSON.stringify(older));
  assert.ok(Math.abs(M.indexValue(state) - 4000) < 1e-8);
  assert.ok(Math.abs(M.indexValue(state) / state.indexBase - legacyPoint / 1000) < 1e-8);
  assert.ok(Math.abs(state.journal[0].index / state.indexBase - 6.2) < 1e-8);
  assert.ok(Math.abs(state.ended.index / state.indexBase - 6.15) < 1e-8);
  assert.deepEqual(state.conditions, []);
  assert.deepEqual(state.actors, older.actors);
});

test('a three-round save resumes from a clock time without replaying old trades', () => {
  const older = M.create();
  M.place(older, SYMBOL, 'buy', 100, M.depth(older, SYMBOL).asks[0].price);
  M.advance(older);
  delete older.minute;
  delete older.fills[0].minute;
  for (const stock of older.stocks) {
    delete stock.session.amount;
    delete stock.session.midpoint;
    delete stock.session.sentiment;
    stock.session.ticks = stock.session.ticks.map(({ close, volume }) => ({ phase: 0, close, volume }));
  }
  const state = M.deserialize(JSON.stringify(older));
  const stock = state.stocks.find(item => item.id === SYMBOL);
  assert.equal(state.minute, M.HOURS.open);
  assert.equal(stock.session.ticks[0].minute, M.HOURS.open);
  assert.equal(state.fills[0].minute, M.HOURS.open);
  assert.equal(stock.session.amount, null);
  const shares = M.position(state, 'player', SYMBOL).shares;
  M.advance(state);
  assert.equal(state.minute, M.HOURS.open + 1);
  assert.equal(M.position(state, 'player', SYMBOL).shares, shares);
  M.closeSession(state);
  assert.equal(stock.session.ticks.length, 242);
  assert.equal(stock.session.ticks.at(-1).minute, M.HOURS.close);
  assert.equal(stock.session.ticks.reduce((sum, tick) => sum + tick.volume, 0), stock.session.volume);
  M.advance(state);
  assert.deepEqual(stock.session.ticks, []);
  assert.equal(stock.session.amount, 0);
});

test('fills remain saved for chart candles after more than 100 trades', () => {
  const state = M.create();
  const symbol = 'SIM08';
  for (let i = 0; i < 101; i += 1) {
    M.place(state, symbol, 'buy', 100, M.depth(state, symbol).asks[0].price);
    M.advance(state);
  }
  const first = state.fills.at(-1);
  assert.equal(state.fills.length, 101);
  const restored = M.deserialize(JSON.stringify(state));
  assert.deepEqual(restored.fills.at(-1), first);
  advanceTo(restored, M.CHART_CANDLES + 1);
  assert.deepEqual(restored.fills.at(-1), first);
  advanceTo(restored, M.CHART_CANDLES + 2);
  assert.equal(restored.fills.length, 100);
  assert.ok(restored.fills.at(-1).minute > first.minute);
});

test('a five-minute save retains its tape, cash and working orders when the finer clock resumes', () => {
  const older = M.create();
  M.advance(older);
  for (let i = 0; i < 5; i += 1) M.advance(older);
  const order = M.place(older, SYMBOL, 'buy', 100, M.bounds(older.stocks[2])[0]);
  for (const stock of older.stocks) {
    const [first, ...following] = stock.session.ticks;
    stock.session.ticks = [first, { minute: older.minute, close: stock.price,
      volume: following.reduce((sum, tick) => sum + tick.volume, 0),
      amount: following.reduce((sum, tick) => sum + tick.amount, 0) }];
    delete stock.session.midpoint;
    delete stock.session.sentiment;
  }
  const resumed = M.deserialize(JSON.stringify(older));
  assert.deepEqual(resumed.actors, older.actors);
  assert.deepEqual(resumed.orders, older.orders);
  M.advance(resumed);
  const ticks = resumed.stocks[2].session.ticks;
  assert.deepEqual(ticks.slice(0, 2), older.stocks[2].session.ticks);
  assert.equal(ticks.at(-1).minute, 576);
  assert.ok(resumed.orders.some(item => item.id === order.id));
  M.closeSession(resumed);
  assert.deepEqual(M.deserialize(JSON.stringify(resumed)), resumed);
});

test('the trading clock reaches 15:00 in 330 one-minute steps and never matches during lunch', () => {
  const state = M.create();
  const stock = state.stocks.find(item => item.id === SYMBOL);
  M.advance(state);
  while (state.minute < M.HOURS.morningEnd) M.advance(state);
  assert.equal(state.minute, 690);
  assert.ok(M.atLunch(state));
  assert.equal(stock.session.ticks.length, 121);
  const morningVolume = stock.session.volume;
  const order = M.place(state, SYMBOL, 'buy', 100, M.bounds(stock)[1]);
  while (state.minute < 779) {
    M.advance(state);
    assert.equal(stock.session.volume, morningVolume);
    assert.deepEqual(state.orders, [order]);
    assert.equal(state.fills.length, 0);
  }
  assert.deepEqual(M.deserialize(JSON.stringify(state)), state);
  M.advance(state);
  assert.equal(state.minute, 780);
  assert.equal(state.fills[0].minute, 780);
  assert.equal(stock.session.ticks[121].minute, 780);
  const pending = M.place(state, SYMBOL, 'buy', 100, M.bounds(stock)[0]);
  let elapsed = (state.minute - M.HOURS.open) / M.HOURS.tick;
  while (state.phase !== 3) {
    M.advance(state);
    elapsed += 1;
  }
  assert.equal(elapsed, 330);
  assert.equal(state.minute, 900);
  assert.equal(state.day, 1);
  assert.equal(state.orders.length, 0);
  assert.ok(state.tickets.some(ticket => ticket.id === pending.id));
  assert.equal(state.journal.length, 1);
  assert.equal(stock.session.ticks.length, 242);
  assert.equal(stock.session.amount, stock.session.ticks.reduce((sum, tick) => sum + tick.amount, 0));
});

test('ordinary minutes show incremental fills and a news shock can still drive a much larger move', () => {
  const state = M.create(2);
  advanceTo(state, 1, 3);
  const quiet = state.stocks.find(stock => stock.id === 'SIM08');
  const returns = quiet.session.ticks.slice(1).flatMap((tick, i) => tick.minute === M.HOURS.afternoonOpen ? [] :
    [Math.abs(tick.close / quiet.session.ticks[i].close - 1)]);
  assert.ok(new Set(quiet.session.ticks.map(tick => tick.close)).size > 8);
  assert.ok(returns.filter(move => move > 0.004).length < returns.length * 0.05);
  advanceTo(state, 9, 3);
  const impacted = state.stocks[2];
  assert.ok(impacted.price / impacted.prevClose < 0.97);
});

test('large buying leaves a trace that removes a dealer bid on the next round', () => {
  const quiet = M.create();
  const large = M.create();
  M.place(large, SYMBOL, 'buy', 4400, 1100);
  M.advance(large);
  M.advance(quiet);
  assert.ok(large.stocks[2].exposure >= 3800);
  const dealerBid = state => state.orders.some(order => order.actor === 'dealer' && order.symbol === SYMBOL &&
    order.side === 'buy' && order.style === 'quote');
  assert.equal(dealerBid(quiet), true);
  assert.equal(dealerBid(large), false);
});

test('only filled sales release pressure, and a clear-out restores the dealer bid', () => {
  const state = M.create();
  M.place(state, SYMBOL, 'buy', 4400, M.bounds(state.stocks[2])[1]);
  advanceTo(state, 2, 0);
  const stock = state.stocks[2];
  const [low, high] = M.bounds(stock);
  const dealerBid = () => state.orders.some(order => order.actor === 'dealer' && order.symbol === SYMBOL &&
    order.side === 'buy' && order.style === 'quote');
  const holding = M.position(state, 'player', SYMBOL);
  assert.ok(holding.shares >= 3800);
  assert.equal(dealerBid(), false);

  const canceled = M.place(state, SYMBOL, 'sell', 100, high);
  assert.equal(M.cancel(state, canceled.id), true);
  assert.equal(stock.exitFlow, undefined);
  M.place(state, SYMBOL, 'sell', 2000, low);
  M.advance(state);
  assert.equal(stock.exitFlow, 2000);
  assert.ok(holding.shares > 0);

  M.place(state, SYMBOL, 'sell', holding.shares, low);
  M.advance(state);
  assert.equal(holding.shares, 0);
  assert.equal(stock.exposure, 0);
  assert.ok(stock.exitFlow >= 3800);
  assert.equal(dealerBid(), true);

  const afterExit = stock.exitFlow;
  const resumed = M.deserialize(JSON.stringify(state));
  M.advance(state);
  M.advance(resumed);
  assert.ok(stock.exitFlow < afterExit);
  assert.deepEqual(resumed, state);
});

test('repeated buys can draw a dealer sale with the same position and market price', () => {
  const series = M.create(1690614022);
  const symbol = 'SIM05';
  const stock = series.stocks.find(item => item.id === symbol);
  M.advance(series);
  for (let round = 0; round < 4; round += 1) {
    M.place(series, symbol, 'buy', 1100, M.bounds(stock)[1]);
    M.advance(series);
  }
  while (series.minute % 3 !== 2) M.advance(series);
  const single = M.deserialize(JSON.stringify(series));
  const shares = M.position(series, 'player', symbol).shares;
  assert.equal(shares, 4400);
  for (const round of single.activity) delete round.playerBought[symbol];
  single.activity[0].playerBought[symbol] = shares;

  const dealerOffer = state => state.orders.find(order => order.symbol === symbol && order.actor === 'dealer' &&
    order.side === 'sell' && order.style === 'flow');
  M.advance(series);
  M.advance(single);
  assert.deepEqual(series.actors.player, single.actors.player);
  assert.equal(stock.price, single.stocks.find(item => item.id === symbol).price);
  assert.ok(dealerOffer(series));
  assert.equal(dealerOffer(single), undefined);
});

test('the dealer can aim a sell order at a large buy limit already resting in the book', () => {
  const state = M.create();
  const stock = state.stocks.find(item => item.id === 'SIM05');
  M.advance(state);
  const price = Math.floor(stock.price * 0.993);
  const bid = M.place(state, stock.id, 'buy', 3400, price);
  assert.equal(bid.resting, false);
  while (state.minute < M.HOURS.open + 3) M.advance(state);
  assert.equal(bid.resting, true);
  assert.ok(state.orders.some(order => order.symbol === stock.id && order.actor === 'dealer' &&
    order.side === 'sell' && order.style === 'flow' && order.limit === price));
});

test('reposted sell orders pull bids farther back while unshown cancellations leave no trace', () => {
  const market = M.create();
  const symbol = 'SIM05';
  const stock = market.stocks.find(item => item.id === symbol);
  M.place(market, symbol, 'buy', 2800, M.bounds(stock)[1]);
  advanceTo(market, 2, 1);
  const ask = Math.ceil(stock.price * 1.007);
  const hidden = M.place(market, symbol, 'sell', 2800, ask);
  assert.equal(M.cancel(market, hidden.id), true);
  assert.equal(market.tickets[0].canceledMinute, undefined);
  for (let round = 0; round < 2; round += 1) {
    const visible = M.place(market, symbol, 'sell', 2800, ask);
    M.advance(market);
    assert.equal(visible.resting, true);
    assert.equal(M.cancel(market, visible.id), true);
    assert.equal(market.tickets[0].canceledMinute, market.minute);
  }
  const single = M.deserialize(JSON.stringify(market));
  const noAsk = M.deserialize(JSON.stringify(market));
  for (const ticket of single.tickets) delete ticket.canceledMinute;
  M.place(market, symbol, 'sell', 2800, ask);
  M.place(single, symbol, 'sell', 2800, ask);
  const dealerBid = state => state.orders.find(order => order.symbol === symbol && order.actor === 'dealer' &&
    order.side === 'buy' && order.style === 'quote');
  for (const state of [market, single, noAsk]) M.advance(state);
  assert.deepEqual(market.actors.player, noAsk.actors.player);
  assert.ok(dealerBid(market).quantity < dealerBid(single).quantity);
  assert.ok(dealerBid(single).quantity < dealerBid(noAsk).quantity);
});

test('crowded rallies can transfer family and state-fund inventory to retail through the book', () => {
  const state = M.create(2);
  advanceTo(state, 2, 0);
  const small = state.stocks.find(stock => stock.id === SYMBOL);
  while (!small.session.crowd && state.phase < 3) M.advance(state);
  assert.ok(state.news.some(item => item.symbol === SYMBOL && item.day === 2 && item.source === '分时监测'));
  assert.equal(small.session.crowd.sold, 0);
  const beforeSale = M.position(state, 'family', SYMBOL).shares;
  const resumed = M.deserialize(JSON.stringify(state));
  M.closeSession(state);
  M.closeSession(resumed);
  assert.deepEqual(resumed, state);
  const crowd = small.session.crowd;
  assert.ok(crowd.retail > 0 && crowd.retail <= crowd.sold && crowd.sold <= crowd.target);
  assert.equal(M.position(state, 'family', SYMBOL).shares, beforeSale - crowd.sold);
  assert.ok(small.price < small.session.high * 0.97);
  assert.ok(state.news.some(item => item.symbol === SYMBOL && item.day === 2 && item.body.includes('散户账户承接')));
  assert.equal(small.overhang, crowd.retail);

  const withoutTransfer = M.deserialize(JSON.stringify(state));
  delete withoutTransfer.stocks.find(stock => stock.id === SYMBOL).overhang;
  M.advance(state);
  M.advance(withoutTransfer);
  const bidShares = market => M.depth(market, SYMBOL).bids.reduce((sum, bid) => sum + bid.quantity, 0);
  assert.ok(bidShares(state) < bidShares(withoutTransfer));

  advanceTo(state, 8, 3);
  const large = state.stocks.find(stock => stock.id === 'SIM01');
  assert.ok(large.session.crowd.retail > 0);
  assert.ok(large.session.crowd.sold <= large.session.crowd.target);
  assert.ok(state.news.some(item => item.symbol === large.id && item.day === 8 && item.body.includes('稳定资金在早盘放量信号后')));
});

test('a smaller family sale can clear without breaking a speculative rally', () => {
  const state = M.create(3);
  advanceTo(state, 2, 3);
  const stock = state.stocks.find(item => item.id === SYMBOL);
  assert.ok(stock.session.crowd.retail > 0);
  assert.equal(stock.session.crowd.sold, stock.session.crowd.target);
  assert.ok(stock.price > stock.prevClose * 1.03);
  assert.ok(stock.price > stock.session.high * 0.99);
});

test('four sides transact, cycle funding and IPO settle, and the calendar continues', () => {
  const state = M.create();
  const initial = totalCash(state);
  const roles = new Set();
  let sawSplit = false;
  while (state.day <= 100) {
    const before = M.indexValue(state);
    const previousPhase = state.phase;
    const previousDay = state.day;
    assert.equal(M.advance(state), true);
    if (previousPhase === 3 && previousDay % 20 === 15) assert.ok(Math.abs(before - M.indexValue(state)) < 1e-9);
    if (state.phase === 3) {
      const count = M.breadth(state);
      const delta = M.indexValue(state) / state.indexPrev - 1;
      if (count.down >= count.up * 2 && count.up > 0 && delta > 0 && delta < 0.009) sawSplit = true;
      assert.deepEqual(M.deserialize(JSON.stringify(state)), state);
    }
    const activity = state.activity[0];
    if (activity) for (const [role, volume] of Object.entries(activity.volumes)) if (volume > 0) roles.add(role);
    assert.equal(totalCash(state), initial);
  }
  assert.equal(state.day, 101);
  assert.equal(state.ended, null);
  assert.equal(state.stocks.length, 13);
  assert.ok(state.economy.issued > 0 && state.economy.injected > state.economy.outgoing);
  assert.deepEqual([...roles].sort(), ['family', 'institution', 'national', 'retail']);
  assert.ok(sawSplit, 'weighted index can rise with more decliners than advancers');
});

test('the same public filings can lead to two outcomes and a later company liquidation', () => {
  const bad = M.create(12);
  const good = M.deserialize(JSON.stringify(bad));
  good.episode.favorable = true;
  advanceTo(good, 4);
  advanceTo(bad, 4);
  const disclosure = state => state.news.find(item => item.type === '财报' && item.symbol === SYMBOL);
  assert.deepEqual(disclosure(good).facts, disclosure(bad).facts);
  assert.ok(disclosure(good).facts.revenue > good.episode.filing.actual.revenue);
  assert.equal(M.newsChannel(disclosure(good)), 'report');
  assert.match(disclosure(good).body, /经营活动净现金流/);
  assert.ok(good.news.some(item => M.newsChannel(item) === 'news' && item.topic === '机器人'));
  assert.ok(good.news.some(item => M.newsChannel(item) === 'forum' && !item.title.includes('云岚设备')));
  assert.ok(bad.news.some(item => item.type === '旧帖'));
  advanceTo(good, 9);
  advanceTo(bad, 9);
  const signed = good.news.find(item => item.event === 'contract');
  const revised = bad.news.find(item => item.event === 'restatement');
  assert.equal(signed.facts.amount, good.episode.project.amount);
  assert.equal(revised.facts.reportedProfit, disclosure(bad).facts.profit);
  assert.equal(revised.facts.correctedProfit, bad.episode.filing.actual.profit);

  const resumed = M.deserialize(JSON.stringify(good));
  const control = M.deserialize(JSON.stringify(good));
  control.stocks[2].business.contracts = [];
  advanceTo(resumed, signed.facts.payment, 3);
  advanceTo(control, signed.facts.payment, 3);
  for (const [day, field] of [[signed.facts.delivery, 'revenue'], [signed.facts.payment, 'collections']]) {
    const cash = state => state.stocks[2].business.days.find(entry => entry.day === day)[field];
    assert.equal(cash(resumed) - cash(control), signed.facts.amount);
  }
  advanceTo(bad, 61);
  assert.ok(bad.stocks.some(stock => stock.id === SYMBOL && stock.status === 'delisted' && !stock.indexMember && stock.price === 0));
});

test('confirmed orders can disappoint or support prices depending on prior expectations', () => {
  function confirmation(seed) {
    const state = M.create(seed);
    advanceTo(state, 9);
    const stock = state.stocks.find(item => item.id === SYMBOL);
    const contract = state.news.find(item => item.event === 'contract' && item.symbol === SYMBOL);
    const claim = state.news.find(item => item.event === 'mediaClaim' && item.symbol === SYMBOL);
    assert.ok(contract && claim);
    while (state.minute < 600) M.advance(state);
    const entry = stock.price;
    advanceTo(state, 10);
    while (state.minute < 600) M.advance(state);
    return { fulfillment: contract.facts.units / claim.facts.claimedUnits, move: stock.price / entry - 1 };
  }
  const belowRumor = confirmation(3);
  const meetsRumor = confirmation(58);
  assert.ok(belowRumor.fulfillment < meetsRumor.fulfillment);
  assert.ok(belowRumor.move < 0 && meetsRumor.move > 0);
});

test('news reports are linked to the operating ledger and the closing trade tape', () => {
  const state = M.create();
  const report = state.news.find(item => item.event === 'periodicReport');
  const business = state.stocks.find(stock => stock.id === report.symbol).business;
  assert.equal(report.facts.revenue, business.days.slice(-20).reduce((sum, day) => sum + day.revenue, 0));
  assert.equal(report.facts.cash, report.facts.collections - report.facts.cost);
  assert.notDeepEqual(M.create(2).news.find(item => item.event === 'periodicReport').facts, report.facts);
  M.closeSession(state);
  const update = state.news.find(item => item.event === 'unusual');
  const stock = state.stocks.find(item => item.id === update.symbol);
  assert.equal(update.facts.close, stock.price);
  assert.equal(update.facts.volume, stock.session.volume);
  assert.equal(update.facts.change, stock.price / stock.prevClose - 1);
  assert.deepEqual(M.deserialize(JSON.stringify(state)).news, state.news);
});

test('six-digit codes are stable and old consumer positions retain their identities', () => {
  const state = M.create();
  const stock = state.stocks[6];
  state.actors.player.positions[stock.id] = { shares: 100, locked: 0, restricted: 0, pledged: 0, cost: 231231 };
  stock.theme = '内需';
  delete stock.business;
  state.news.unshift({ id: 900, day: 1, symbol: stock.id, topic: '内需', type: '财报', title: '内需简报', body: '内需' });
  const restored = M.deserialize(JSON.stringify(state));
  assert.equal(restored.stocks[6].theme, '消费');
  assert.equal(restored.news[0].topic, '消费');
  assert.equal(restored.news[0].title, '消费简报');
  assert.deepEqual(M.position(restored, 'player', stock.id), state.actors.player.positions[stock.id]);
  advanceTo(restored, 51);
  const codes = restored.stocks.map(item => M.stockCode(item.id));
  assert.ok(codes.every(code => /^\d{6}$/.test(code)));
  assert.ok(codes.some(code => /^00/.test(code)));
  assert.ok(codes.some(code => /^60/.test(code)));
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(codes[6], M.stockCode(stock.id));
  assert.ok(restored.stocks.some(item => item.listedDay > 1 && item.theme === '消费' && item.sector === '消费'));
});

test('a confirmed zero recovery can end a career, but a pending holding or a cash remainder cannot', () => {
  const state = M.create();
  state.actors.player.cash = 0;
  state.actors.player.positions[SYMBOL] = { shares: 100, locked: 0, restricted: 0, pledged: 0, cost: M.START_CASH };
  state.stocks[2].status = 'suspended';
  state.stocks[2].receivableDay = 2;
  state.orders = state.orders.filter(order => order.symbol !== SYMBOL);
  M.closeSession(state);
  assert.equal(state.ended, null);
  M.closeSession(state);
  assert.equal(state.ended.reason, 'bankruptcy');
  assert.equal(state.ended.equity, 0);
  assert.equal(M.advance(state), false);

  const small = M.create();
  small.actors.player.cash = 1;
  M.closeSession(small);
  assert.equal(small.ended, null);
});

test('leaving with unsold shares closes orders and preserves the snapshot', () => {
  const state = M.create();
  M.place(state, SYMBOL, 'buy', 100, M.depth(state, SYMBOL).asks[0].price);
  advanceTo(state, 2);
  M.place(state, SYMBOL, 'buy', 100, 1000);
  const cash = state.actors.player.cash;
  M.exit(state);
  assert.equal(state.ended.reason, 'exit');
  assert.equal(state.ended.holdings[0].shares, 100);
  assert.equal(state.ended.cash, cash);
  assert.equal(M.buyPower(state), cash);
  assert.equal(state.orders.length, 0);
  assert.equal(M.advance(state), false);
  assert.deepEqual(M.deserialize(JSON.stringify(state)), state);
});
