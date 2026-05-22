const Anthropic = require('@anthropic-ai/sdk');
const express   = require('express');

module.exports = function(makeIO) {
  const router = express.Router();

  const configured = !!(process.env.ANTHROPIC_API_KEY &&
    process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here');

  let client = null;
  if (configured) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    console.log('✓ AI Advisor initialized (claude-opus-4-7)');
  } else {
    console.log('⚠ AI Advisor not configured — add ANTHROPIC_API_KEY to .env');
  }

  function buildContext(read) {
    const accounts     = read('accounts.json')     || [];
    const transactions = read('transactions.json') || [];
    const properties   = read('properties.json')   || [];

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const recentTxs     = [...transactions].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 150);
    const spendByCategory = transactions
      .filter(t => t.date >= thirtyDaysAgo && t.amount < 0)
      .reduce((acc, t) => { acc[t.category] = (acc[t.category] || 0) + Math.abs(t.amount); return acc; }, {});

    const totalLiquid    = accounts.filter(a => a.balance > 0).reduce((s, a) => s + (a.balance || 0), 0);
    const totalLiab      = Math.abs(accounts.filter(a => a.balance < 0).reduce((s, a) => s + (a.balance || 0), 0));
    const totalReValue   = properties.reduce((s, p) => s + (p.value    || 0), 0);
    const totalMortgage  = properties.reduce((s, p) => s + (p.mortgage || 0), 0);
    const monthlyNOI     = properties.reduce((s, p) => s + ((p.rent || 0) - (p.exp || 0)), 0);

    return `You are CaiShen, a personal AI financial advisor for Albert Yang, a high-net-worth individual in Los Angeles, CA. You have full access to his financial data. Be specific, data-driven, and reference actual numbers when giving advice. Be concise but thorough.

## Financial Snapshot — ${new Date().toISOString().split('T')[0]}

### Accounts (${accounts.length})
${accounts.map(a => `- ${a.name} (${a.institution || '?'}): $${(a.balance || 0).toLocaleString()} [${a.type}]`).join('\n') || 'No accounts connected'}

### Real Estate Portfolio (${properties.length} properties)
Total Value: $${totalReValue.toLocaleString()} | Mortgage: $${totalMortgage.toLocaleString()} | Monthly NOI: $${monthlyNOI.toLocaleString()}
${properties.map(p => {
  const equity = (p.value || 0) - (p.mortgage || 0);
  const noi    = (p.rent  || 0) - (p.exp     || 0);
  const roi    = p.value ? ((noi * 12) / p.value * 100).toFixed(1) : '?';
  return `- ${p.name}: Value $${(p.value||0).toLocaleString()}, Equity $${equity.toLocaleString()}, NOI $${noi.toLocaleString()}/mo (${roi}% ROI), Rate ${p.rate||'?'}%`;
}).join('\n') || 'No properties configured'}

### Net Worth Summary
- Liquid Assets: $${totalLiquid.toLocaleString()}
- Liquid Liabilities: $${totalLiab.toLocaleString()}
- RE Equity: $${(totalReValue - totalMortgage).toLocaleString()}
- Approx Net Worth: $${(totalLiquid - totalLiab + totalReValue - totalMortgage).toLocaleString()}

### Spending by Category — Last 30 Days
${Object.entries(spendByCategory).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => `- ${cat}: $${amt.toFixed(0)}`).join('\n') || 'No recent spending data'}

### Recent Transactions (last ${recentTxs.length})
${recentTxs.map(t => `${t.date}: ${t.desc}  ${t.amount > 0 ? '+' : ''}$${(t.amount||0).toFixed(2)}  [${t.category}]`).join('\n') || 'No transactions'}

### Tax Context
- California resident — CA income tax + federal (highest brackets)
- Multiple rental properties — Schedule E filer
- Likely W-2 + RSU vesting income
- NIIT (3.8%) applies on passive/investment income above thresholds`;
  }

  router.get('/status', (req, res) => res.json({ configured }));

  router.post('/chat', async (req, res) => {
    if (!client) return res.status(400).json({ error: 'AI Advisor not configured. Add ANTHROPIC_API_KEY to .env and restart the server.' });
    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages array required' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      const { read } = makeIO(req.user.id);
      const stream = client.messages.stream({
        model: 'claude-opus-4-7', max_tokens: 2048, thinking: { type: 'adaptive' },
        system: [{ type: 'text', text: buildContext(read), cache_control: { type: 'ephemeral' } }],
        messages
      });
      stream.on('text', text => res.write(`data: ${JSON.stringify({ text })}\n\n`));
      await stream.finalMessage();
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (e) {
      console.error('[Advisor] Chat error:', e.message);
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    }
    res.end();
  });

  router.get('/insights', (req, res) => {
    const data = makeIO(req.user.id).read('insights.json');
    res.json(data || { insights: [], generatedAt: null });
  });

  router.post('/generate-insights', (req, res) => {
    if (!client) return res.status(400).json({ error: 'AI Advisor not configured' });
    const { read, write } = makeIO(req.user.id);
    res.json({ status: 'generating' });

    (async () => {
      try {
        const response = await client.messages.create({
          model: 'claude-opus-4-7', max_tokens: 1500, thinking: { type: 'adaptive' },
          system: [{ type: 'text', text: buildContext(read), cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: 'Generate 5 proactive financial insights based on my current data. Cover: spending patterns, cash flow, tax planning, real estate performance, and any notable opportunities or concerns. Return ONLY a JSON array with objects: { "title": string, "insight": string, "priority": "high"|"medium"|"low", "category": "Spending"|"Cash Flow"|"Tax"|"Real Estate"|"Portfolio" }. No markdown, no explanation, just the raw JSON array.' }]
        });
        const text     = response.content.find(b => b.type === 'text')?.text || '[]';
        const insights = JSON.parse(text.replace(/```json|```/g, '').trim());
        write('insights.json', { insights, generatedAt: new Date().toISOString() });
        console.log(`[Advisor] Generated ${insights.length} insights`);
      } catch (e) { console.error('[Advisor] Insights error:', e.message); }
    })();
  });

  return { router };
};
