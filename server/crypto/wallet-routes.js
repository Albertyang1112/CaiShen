'use strict';
/**
 * crypto/wallet-routes.js — extracted from index.js. Crypto transaction ledger CRUD,
 * saved-wallet CRUD, and read-only on-chain address lookup (BTC/ETH/SOL/LTC/DOGE).
 * Mounted at /api (after the auth guard). Faithful move: readData/writeData(file, uid)
 * became makeIO(uid).read/write(file). Must be mounted BEFORE the /api/crypto report
 * router so /api/crypto/transactions resolves here.
 */
const express = require('express');

function detectChain(addr) {
  const a = addr.trim();
  if (/^(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(a) || /^bc1[ac-hj-np-z02-9]{6,87}$/i.test(a)) return 'BTC';
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return 'ETH';
  if (/^[LM][a-km-zA-HJ-NP-Z1-9]{26,33}$/.test(a) || /^ltc1[a-z0-9]{6,87}$/i.test(a)) return 'LTC';
  if (/^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}$/.test(a)) return 'DOGE';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return 'SOL';
  return null;
}

module.exports = function makeCryptoWalletRoutes(makeIO) {
  const router = express.Router();
  const io = (req) => makeIO(req.user.id);

  // ── Crypto transactions ─────────────────────────────────────────────────────
  router.get('/crypto/transactions', (req, res) => res.json(io(req).read('crypto_txns.json') || []));

  router.post('/crypto/transactions', (req, res) => {
    const x = io(req);
    const txns = x.read('crypto_txns.json') || [];
    const tx = { ...req.body, id: `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, createdAt: new Date().toISOString() };
    txns.push(tx);
    x.write('crypto_txns.json', txns);
    res.json(tx);
  });

  router.patch('/crypto/transactions/:id', (req, res) => {
    const x = io(req);
    const txns = x.read('crypto_txns.json') || [];
    const idx = txns.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    txns[idx] = { ...txns[idx], ...req.body };
    x.write('crypto_txns.json', txns);
    res.json(txns[idx]);
  });

  router.delete('/crypto/transactions/:id', (req, res) => {
    const x = io(req);
    x.write('crypto_txns.json', (x.read('crypto_txns.json') || []).filter(t => t.id !== req.params.id));
    res.json({ success: true });
  });

  // ── Wallets ─────────────────────────────────────────────────────────────────
  router.get('/wallets', (req, res) => res.json(io(req).read('wallets.json') || []));

  router.post('/wallets', (req, res) => {
    const x = io(req);
    const wallets = x.read('wallets.json') || [];
    const wallet = { ...req.body, id: `wallet_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, createdAt: new Date().toISOString() };
    wallets.push(wallet);
    x.write('wallets.json', wallets);
    res.json(wallet);
  });

  router.delete('/wallets/:id', (req, res) => {
    const x = io(req);
    x.write('wallets.json', (x.read('wallets.json') || []).filter(w => w.id !== req.params.id));
    res.json({ success: true });
  });

  // ── On-chain wallet lookup (read-only; routes through server to avoid CORS) ──
  router.get('/wallet-lookup', async (req, res) => {
    const address = (req.query.address || '').trim();
    if (!address) return res.status(400).json({ error: 'Address required' });
    const chain = detectChain(address);
    if (!chain) return res.status(400).json({ error: 'Unrecognized address format. Supported: BTC, ETH, SOL, LTC, DOGE' });
    const ax = require('axios');
    try {
      if (chain === 'BTC') {
        const [infoRes, txRes] = await Promise.all([
          ax.get(`https://blockstream.info/api/address/${address}`),
          ax.get(`https://blockstream.info/api/address/${address}/txs`),
        ]);
        const d = infoRes.data;
        const balance = (d.chain_stats.funded_txo_sum - d.chain_stats.spent_txo_sum) / 1e8;
        const transactions = (txRes.data || []).slice(0, 25).map(tx => {
          const received = (tx.vout || []).filter(o => o.scriptpubkey_address === address).reduce((s, o) => s + (o.value || 0), 0);
          const sent = (tx.vin || []).filter(i => i.prevout?.scriptpubkey_address === address).reduce((s, i) => s + (i.prevout?.value || 0), 0);
          return { hash: tx.txid, date: tx.status.confirmed ? new Date(tx.status.block_time * 1000).toISOString().split('T')[0] : 'Pending', amount: (received - sent) / 1e8, confirmed: tx.status.confirmed };
        });
        return res.json({ chain, address, balance, transactions });
      }

      if (chain === 'ETH') {
        const key = process.env.ETHERSCAN_API_KEY || 'YourApiKeyToken';
        const base = 'https://api.etherscan.io/api';
        const [balRes, txRes] = await Promise.all([
          ax.get(`${base}?module=account&action=balance&address=${address}&apikey=${key}`),
          ax.get(`${base}?module=account&action=txlist&address=${address}&sort=desc&page=1&offset=25&apikey=${key}`),
        ]);
        const balance = parseInt(balRes.data.result || '0') / 1e18;
        const rawTxs = Array.isArray(txRes.data.result) ? txRes.data.result : [];
        const transactions = rawTxs.slice(0, 25).map(tx => {
          const isSend = tx.from.toLowerCase() === address.toLowerCase();
          return { hash: tx.hash, date: new Date(parseInt(tx.timeStamp) * 1000).toISOString().split('T')[0], amount: (parseInt(tx.value || '0') / 1e18) * (isSend ? -1 : 1), confirmed: parseInt(tx.confirmations || '0') > 0, from: tx.from, to: tx.to };
        });
        return res.json({ chain, address, balance, transactions });
      }

      if (chain === 'SOL') {
        const rpc = 'https://api.mainnet-beta.solana.com';
        const [balRes, sigRes] = await Promise.all([
          ax.post(rpc, { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }),
          ax.post(rpc, { jsonrpc: '2.0', id: 2, method: 'getSignaturesForAddress', params: [address, { limit: 25 }] }),
        ]);
        const balance = (balRes.data.result?.value || 0) / 1e9;
        const transactions = (sigRes.data.result || []).map(s => ({ hash: s.signature, date: s.blockTime ? new Date(s.blockTime * 1000).toISOString().split('T')[0] : 'Pending', amount: null, confirmed: !s.err }));
        return res.json({ chain, address, balance, transactions });
      }

      if (chain === 'LTC' || chain === 'DOGE') {
        const coin = chain === 'LTC' ? 'ltc' : 'doge';
        const [balRes, txRes] = await Promise.all([
          ax.get(`https://api.blockcypher.com/v1/${coin}/main/addrs/${address}/balance`),
          ax.get(`https://api.blockcypher.com/v1/${coin}/main/addrs/${address}/full?limit=25`),
        ]);
        const balance = (balRes.data.final_balance || 0) / 1e8;
        const transactions = (txRes.data.txs || []).slice(0, 25).map(tx => {
          const received = (tx.outputs || []).filter(o => (o.addresses || []).includes(address)).reduce((s, o) => s + (o.value || 0), 0);
          const sent = (tx.inputs || []).filter(i => (i.addresses || []).includes(address)).reduce((s, i) => s + (i.output_value || 0), 0);
          return { hash: tx.hash, date: tx.received ? tx.received.split('T')[0] : 'Pending', amount: (received - sent) / 1e8, confirmed: (tx.confirmations || 0) > 0 };
        });
        return res.json({ chain, address, balance, transactions });
      }

      res.status(400).json({ error: 'Chain not supported' });
    } catch (e) {
      console.error('Wallet lookup error:', e.response?.data || e.message);
      res.status(500).json({ error: e.response?.data?.error_message || e.message });
    }
  });

  return router;
};

module.exports.detectChain = detectChain;
