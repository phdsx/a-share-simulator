(() => {
  'use strict';

  const PERIOD = 20;
  const precision = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  const money = cents => `${precision.format(cents / 1e6)} 万元`;
  const price = cents => `${(cents / 100).toFixed(2)} 元`;
  const shares = count => `${count.toLocaleString('zh-CN')} 股`;
  const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
  const growth = (now, before) => before === 0 ? '前期为零' :
    `${now < before ? '下降' : '增长'} ${(Math.abs(now - before) / Math.abs(before) * 100).toFixed(1)}%`;
  const product = stock => ({ 机器人: '伺服模组', 储能: '储能组件', 消费: '渠道备货' })[stock.theme] ?? '项目交付';

  function draw(seed, symbol, day, salt) {
    const number = Number(symbol.slice(3));
    let value = seed ^ Math.imul(number, 0x9e3779b1) ^ Math.imul(day, 0x85ebca6b) ^ Math.imul(salt, 0x27d4eb2d);
    value = Math.imul(value ^ value >>> 16, 0x7feb352d);
    return ((value ^ value >>> 15) >>> 0) / 4294967296;
  }

  function operate(seed, stock, business, day) {
    const noise = salt => draw(seed, stock.id, day, salt);
    const scale = stock.fair * stock.float / (stock.large ? 52 : 22);
    const demand = 1 + Math.sin(day / 8 + Number(stock.id.slice(3))) * 0.18 + noise(1) * 0.38;
    const coreSales = Math.round(scale * demand);
    const coreCost = Math.round(coreSales * (0.73 + noise(2) * 0.33));
    const coreCollections = Math.round(coreSales * (0.33 + noise(3) * 0.58) + business.receivable * (0.045 + noise(4) * 0.13));
    business.receivable += coreSales - coreCollections;

    let revenue = coreSales;
    let cost = coreCost;
    let collections = coreCollections;
    let unpaid = 0;
    for (const contract of business.contracts) {
      if (contract.delivery === day) {
        revenue += contract.amount;
        cost += contract.cost;
      }
      if (contract.payment === day) collections += contract.amount;
      if (contract.delivery <= day && day < contract.payment) unpaid += contract.amount;
    }
    business.contracts = business.contracts.filter(contract => contract.payment > day);
    business.days.push({ day, revenue, cost, collections, receivable: business.receivable + unpaid });
    if (business.days.length > PERIOD * 2) business.days.shift();
  }

  function createBusiness(seed, stock, through) {
    const business = { receivable: 0, contracts: [], days: [] };
    for (let day = through - PERIOD * 2 + 1; day <= through; day += 1) operate(seed, stock, business, day);
    return business;
  }

  function validBusiness(business) {
    return business && nonnegative(business.receivable) && Array.isArray(business.days) && business.days.length === PERIOD * 2 &&
      business.days.every((item, i, days) => item && Number.isSafeInteger(item.day) && (!i || item.day === days[i - 1].day + 1) &&
        ['revenue', 'cost', 'collections', 'receivable'].every(field => nonnegative(item[field]))) &&
      Array.isArray(business.contracts) && business.contracts.every(item => item && nonnegative(item.amount) && nonnegative(item.cost) &&
        nonnegative(item.delivery) && nonnegative(item.payment) && item.payment > item.delivery);
  }

  function validEpisode(event) {
    const project = event.project;
    const filing = event.filing;
    return (project === undefined || project && typeof project.product === 'string' &&
      ['samples', 'units', 'amount', 'cost', 'inspection', 'paymentLag'].every(key => nonnegative(project[key]) && project[key] > 0) &&
      project.units >= project.samples && project.cost <= project.amount) &&
      (filing === undefined || filing && nonnegative(filing.day) && [filing.actual, filing.posted].every(report => report &&
        ['revenue', 'cost', 'collections', 'receivable'].every(key => nonnegative(report[key])) &&
        Number.isSafeInteger(report.profit) && Number.isSafeInteger(report.cash)));
  }

  function write(state, stock, event, type, source, title, body, facts, topic = stock?.theme ?? '全市场') {
    state.news.unshift({ id: state.seq++, day: state.day, symbol: stock?.id ?? null, topic, source, event, type, title, body, facts });
    state.news.length = Math.min(state.news.length, 96);
  }

  function summarize(days) {
    const result = { from: days[0].day, to: days.at(-1).day, revenue: 0, cost: 0, collections: 0, receivable: days.at(-1).receivable };
    for (const day of days) {
      result.revenue += day.revenue;
      result.cost += day.cost;
      result.collections += day.collections;
    }
    return { ...result, profit: result.revenue - result.cost, cash: result.collections - result.cost };
  }

  function report(state, stock, project = null) {
    const actual = summarize(stock.business.days.slice(-PERIOD));
    const prior = summarize(stock.business.days.slice(0, PERIOD));
    const posted = { ...actual };
    if (project) {
      posted.revenue += project.amount;
      posted.cost += project.cost;
      posted.profit += project.amount - project.cost;
      posted.receivable += project.amount;
    }
    const label = actual.from <= 0 ? `截至第 ${state.day} 日的近 ${PERIOD} 个交易日` : `第 ${actual.from}–${actual.to} 日`;
    const collectionRate = (posted.collections / Math.max(1, posted.revenue) * 100).toFixed(1);
    const note = project ? `附注将 ${project.units} 件${project.product}按预计交付列入业绩口径，对应收入 ${money(project.amount)}，本期没有收到该项目货款。` :
      `本期收到货款 ${money(posted.collections)}，相当于同期收入的 ${collectionRate}%。期末应收较上一窗口${growth(posted.receivable, prior.receivable)}。`;
    write(state, stock, project ? 'projectReport' : 'periodicReport', '财报', `${stock.name}经营披露`,
      `${stock.name}${project ? '发布业绩快报' : '披露经营数据'}，净利润较上期${growth(posted.profit, prior.profit)}`,
      `${label}，营收 ${money(posted.revenue)}，较上期${growth(posted.revenue, prior.revenue)}。归母净利润 ${money(posted.profit)}，上一窗口为 ${money(prior.profit)}。经营活动净现金流 ${money(posted.cash)}，期末应收账款 ${money(posted.receivable)}。\n\n${note}`,
      { ...posted, priorProfit: prior.profit, priorRevenue: prior.revenue });
    return { actual, posted, day: state.day };
  }

  function projectFor(state, stock, since) {
    const noise = salt => draw(state.seed, stock.id, since, salt);
    const samples = 2 + Math.floor(noise(11) * 14);
    const units = samples * (7 + Math.floor(noise(12) * 17));
    const rate = Math.round(stock.float * stock.fair / (units * (2.7 + noise(13) * 3)));
    const amount = units * rate;
    return { product: product(stock), samples, units, amount, cost: Math.round(amount * (0.63 + noise(14) * 0.20)),
      inspection: 2 + Math.floor(noise(15) * 6), paymentLag: 3 + Math.floor(noise(16) * 10) };
  }

  function rumor(state, stock, angle, evidence) {
    const roll = draw(state.seed, stock.id, state.day, 21);
    const skeptical = draw(state.seed, stock.id, state.day, 23) < 0.46;
    const author = ['排队的小孟', '席位记事本', '隔壁阿七', '翻旧帖的老魏'][Math.floor(roll * 4)];
    const nickname = roll < 0.46 ? `${stock.name.slice(0, 1)}系` : roll < 0.78 ? `${stock.name.slice(1, 2)}字头` : '那家概念票';
    const voices = {
      sample: [skeptical ? '送样那张图，谁看到全页了？' : '样品进去了，这次轮得到吗？',
        `清单有 ${evidence.samples} 件，测试栏大概写了 ${evidence.inspection} 天。${skeptical ? '有人拿测试数当订单数，想找完整的验收栏核一下。' : '群里说这是试单，做完就可以谈批次，采购方还没露面。'}`],
      order: [skeptical ? '排产截图能当订单吗？' : '据说订单量要翻好几倍？',
        `今天有人按 ${evidence.claim} 件在传。${skeptical ? '两个群贴的裁图像同一张，客户名字都被截了。' : '转图的人说排期已经下到班组，我没找到盖章页。'}`],
      restricted: ['验货帖被折叠，哪位还留着？', `原楼只露出「${evidence.product}」「待验」两个词。有人说他在暗示回款，有人说那张截图根本不对应这批货。`],
      tape: [evidence.change < 0 ? '尾盘谁在往外倒？' : '放量这下，是不是有人抢先了？',
        `成交量大概是平时 ${Math.max(1, Math.round(evidence.ratio))} 倍。小群把这事跟${stock.theme}消息连起来了，席位截图还没看到。`],
    };
    const [hook, body] = voices[angle];
    write(state, stock, `rumor:${angle}`, angle === 'restricted' ? '旧帖' : '论坛', author, `${nickname} ${hook}`, body,
      { angle, evidence: angle === 'tape' ? '成交放量' : '流传的单据' });
  }

  function projectNews(state, stock, stage) {
    const event = state.episode;
    const project = event.project ??= projectFor(state, stock, event.since);
    if (stage === 'sample') {
      write(state, stock, 'sampling', '媒体', '产业前线', `${stock.name}向客户提交 ${project.samples} 件${project.product}样品`,
        `${stock.name}提交的送样单列有 ${project.samples} 件${project.product}，计划用 ${project.inspection} 个交易日核对性能和一致性。送样单仅有检测安排，采购数量和交货计划仍待客户书面确认。`,
        { samples: project.samples, inspection: project.inspection });
      rumor(state, stock, 'sample', project);
    } else if (stage === 'pickup') {
      const climb = draw(state.seed, stock.id, state.day, 20);
      const claim = project.units + project.samples * Math.floor(climb * 8);
      rumor(state, stock, 'order', { claim });
      write(state, stock, 'mediaClaim', '媒体', '盘中新讯', `${stock.name}被曝拟排产约 ${claim} 件${project.product}`,
        `供应链受访者称，其取得的排产记录标注约 ${claim} 件，较此前 ${project.samples} 件送样规模显著增加。报道把排产解读为批量采购即将启动。\n\n记者见到的记录缺少客户签章与回款条款，暂未取得采购方确认。`,
        { samples: project.samples, claimedUnits: claim });
    } else if (stage === 'filing') {
      event.filing = report(state, stock, project);
      rumor(state, stock, 'restricted', project);
    } else if (event.favorable) {
      const delivery = state.day + Math.max(1, Math.floor(project.inspection / 2));
      const payment = delivery + project.paymentLag;
      stock.business.contracts.push({ amount: project.amount, cost: project.cost, delivery, payment });
      write(state, stock, 'contract', '公告', `${stock.name}补充公告`, `${stock.name}客户确认首批订单`,
        `采购方确认本批 ${project.units} 件${project.product}，合同金额 ${money(project.amount)}。预计第 ${delivery} 日验收入账，第 ${payment} 日回款。\n\n公司将按实际验收及回款进度更新后续报告。`, { units: project.units, amount: project.amount, delivery, payment });
    } else {
      const filing = event.filing;
      const earlier = state.news.find(item => item.event === 'mediaClaim' && item.symbol === stock.id && item.day >= event.since &&
        Number.isSafeInteger(item.facts?.claimedUnits));
      const restatement = filing ? `公司撤回第 ${filing.day} 日快报中的项目收入 ${money(filing.posted.revenue - filing.actual.revenue)}。归母净利润由 ${money(filing.posted.profit)} 更正为 ${money(filing.actual.profit)}，经营活动净现金流为 ${money(filing.actual.cash)}。` :
        `公司撤回此前的批量交付口径，核实项目仅有 ${project.samples} 件样品进入检测。`;
      write(state, stock, 'restatement', '更正', `${stock.name}财务更正公告`, `${stock.name}更正业绩快报，送样项目未获采购确认`,
        `经客户函证，${project.product}仍处于样品测试阶段。${restatement}\n\n客户未出具批量采购单。公司将待验收和回款的项目单独列示。`,
        { filingDay: filing?.day ?? null, reportedProfit: filing?.posted.profit ?? null, correctedProfit: filing?.actual.profit ?? null });
      if (earlier) write(state, stock, 'mediaCorrection', '媒体', earlier.source, `${stock.name}采购报道更新，排产数量待确认`,
        `本栏第 ${earlier.day} 日报道援引的 ${earlier.facts.claimedUnits} 件出自备产记录。客户函证只确认收到 ${project.samples} 件样品，双方尚无批量采购协议。\n\n已按客户书面核实结果更新交付状态。`,
        { priorArticleId: earlier.id, samples: project.samples });
    }
  }

  function open(state) {
    for (const stock of state.stocks) {
      const number = Number(stock.id.slice(3));
      if (stock.status === 'active' && stock.id !== state.episode.symbol && (state.day - number) % PERIOD === 0) report(state, stock);
    }
  }

  function close(state) {
    let lead = null;
    for (const stock of state.stocks) {
      if (stock.status !== 'active') continue;
      operate(state.seed, stock, stock.business, state.day);
      const change = stock.price / stock.prevClose - 1;
      const previous = stock.history.filter(item => item.day < state.day).slice(-5);
      const typical = previous.reduce((sum, item) => sum + item.volume, 0) / Math.max(1, previous.length);
      const ratio = typical ? stock.session.volume / typical : 0;
      const score = Math.abs(change) * 12 + Math.min(ratio, 5) * 0.14;
      const recent = state.news.some(item => item.event === 'unusual' && item.symbol === stock.id && state.day - item.day < 3);
      if (!recent && stock.session.volume > 0 && (Math.abs(change) >= 0.039 || ratio >= 1.8) && (!lead || score > lead.score)) {
        lead = { stock, change, ratio, typical, score };
      }
    }
    if (!lead) return;
    const { stock, change, ratio, typical } = lead;
    const linked = state.stocks.filter(item => item.status === 'active' && item.id !== stock.id && item.theme === stock.theme);
    const rises = linked.filter(item => item.price > item.prevClose).length;
    const direction = Math.abs(change) < 0.00005 ? '收平' : `${change > 0 ? '上涨' : '下跌'} ${(Math.abs(change) * 100).toFixed(2)}%`;
    write(state, stock, 'unusual', '媒体', '收盘数据观察', `${stock.name}${direction}${ratio >= 1.8 ? '，成交放量' : ''}`,
      `第 ${state.day} 日收于 ${price(stock.price)}，较昨收${direction}。日内最高 ${price(stock.session.high)}、最低 ${price(stock.session.low)}，成交 ${shares(stock.session.volume)}。${typical ? `成交量为此前五日均量的 ${ratio.toFixed(1)} 倍。` : ''}\n\n${linked.length ? `同属${stock.theme}的其他 ${linked.length} 只股票中，${rises} 只上涨。` : `该股归属${stock.theme}。`} 成交数据尚无法确认哪一方在下单。`,
      { close: stock.price, change, volume: stock.session.volume, typical, ratio, peers: linked.length, rises });
    if (ratio >= 1.8 && draw(state.seed, stock.id, state.day, 22) > 0.4) rumor(state, stock, 'tape', lead);
  }

  const news = { createBusiness, validBusiness, validEpisode, projectNews, write, open, close };
  if (typeof module !== 'undefined' && module.exports) module.exports = news;
  else window.MarketNews = news;
})();
