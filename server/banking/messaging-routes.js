'use strict';
/**
 * banking/messaging-routes.js — web API for linking a messaging channel to the account.
 * Mounted at /api/messaging (behind the JWT auth middleware, so req.user is set).
 *
 *   POST   /api/messaging/link-code      → { code, instructions } (mint a 15-min code)
 *   GET    /api/messaging/links          → [{ channel, external_id, display_name, … }]
 *   DELETE /api/messaging/links/:channel → unlink that channel
 */
const express = require('express');
const { query } = require('../core/db');
const { createLinkCode, listLinks, unlink } = require('./messaging-store');

module.exports = function makeMessagingRouter(/* makeIO */) {
  const router = express.Router();

  router.post('/link-code', async (req, res) => {
    try {
      const channel = (req.body && req.body.channel) || 'discord';
      const code = await createLinkCode(query, req.user.id, { channel });
      const smsNumber = process.env.TWILIO_FROM_NUMBER || null;
      const instructions = channel === 'sms'
        ? `Text  link ${code}  to ${smsNumber || 'the CaiShen number'} from your phone.`
        : `In Discord, DM the CaiShen bot:  link ${code}`;
      res.json({ code, channel, expiresInMinutes: 15, smsNumber: channel === 'sms' ? smsNumber : undefined, instructions });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/links', async (req, res) => {
    try { res.json(await listLinks(query, req.user.id)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/links/:channel', async (req, res) => {
    try { res.json(await unlink(query, req.user.id, req.params.channel)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
