'use strict';
/**
 * tax-advisor/index.js — Orchestration + Express router
 *
 * One advisor turn:
 *   1. Detect risk flags in the question (pre-flight)
 *   2. Retrieve relevant tax-law sources (RAG)         [graceful if RAG down]
 *   3. If a tax scenario was supplied, run the deterministic engine up front
 *      so grounded numbers are already in context
 *   4. Call the LLM with sources + calculation + a calculate_tax / retrieve tool
 *   5. Resolve any tool calls (engine / RAG) over a bounded loop
 *   6. Validate the answer (citations, grounded numbers, correct year)
 *   7. Append disclaimer + escalation note; flag unverified answers
 *   8. Log the full turn to ai_tax_sessions (best-effort)
 *   9. Return a structured result
 *
 * Routes (under /api/tax-advisor):
 *   GET  /status   which providers + RAG are available
 *   POST /ask      run one advisor turn (non-streaming, validated)
 */

const express = require('express');
const crypto  = require('crypto');

const { getProvider, configuredProviders } = require('./providers');
const { buildSystemPrompt, buildCalculationBlock } = require('./prompt');
const guardrails = require('./guardrails');
const { calculate } = require('../tax-engine');
const { buildTaxInputForYear, buildDataSummary } = require('../tax-normalize');
const { retrieve, formatForPrompt } = require('../rag/retriever');
const ragEmbeddings  = require('../rag/embeddings');
const ragVectorStore = require('../rag/vectorStore');
const { query } = require('../db');

const MAX_TOOL_ROUNDS = 3;

// ─── Tool definitions handed to the LLM ────────────────────────────────────────
const TOOLS = [
  {
    name: 'calculate_tax',
    description: 'Run the deterministic federal income tax calculator. Use this ' +
      'whenever you need any specific dollar amount (tax owed, AGI, deduction, ' +
      'refund, effective rate, etc.). Never estimate numbers yourself.',
    parameters: {
      type: 'object',
      properties: {
        taxYear:      { type: 'integer', description: 'e.g. 2024 or 2025' },
        filingStatus: { type: 'string', enum: ['single','mfj','mfs','hoh','qss'] },
        income: {
          type: 'object',
          description: 'Income components in whole dollars',
          properties: {
            w2:                 { type: 'number' },
            taxableInterest:    { type: 'number' },
            ordinaryDividends:  { type: 'number' },
            qualifiedDividends: { type: 'number' },
            ltcg:               { type: 'number', description: 'long-term capital gain' },
            stcg:               { type: 'number', description: 'short-term capital gain' },
            scheduleEIncome:    { type: 'number', description: 'net rental income' },
            businessIncome:     { type: 'number', description: 'net Schedule C profit' },
            socialSecurity:     { type: 'number' },
            otherIncome:        { type: 'number' },
          },
        },
        adjustments: { type: 'object', description: 'above-the-line adjustments' },
        deductions:  { type: 'object', description: 'itemized deduction inputs; set type to "standard"/"itemized"/"auto"' },
        credits:     { type: 'object', description: 'credits + withholding (e.g. qualifyingChildren, w2FederalWithholding)' },
      },
      required: ['taxYear', 'filingStatus'],
    },
  },
  {
    name: 'retrieve_more_sources',
    description: 'Search the tax-law database for additional authoritative sources ' +
      '(IRS publications, code sections) when the provided sources are insufficient.',
    parameters: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'what to search for' },
        taxYear: { type: 'integer' },
      },
      required: ['query'],
    },
  },
];

// ─── Tool executors ─────────────────────────────────────────────────────────────

function execCalculateTax(args, accum) {
  const result = calculate(args || {});
  accum.calculationResult = result;        // capture for grounding + saving
  // Return a compact, model-readable rendering (not the whole object)
  return buildCalculationBlock(result);
}

async function execRetrieveSources(args, ctx, accum) {
  const excerpts = await retrieve(args.query, {
    taxYear:      args.taxYear || ctx.taxYear,
    jurisdiction: ctx.state || 'federal',
    topK: 6,
  });
  // Merge into the running source set (dedupe by sourceId+text)
  for (const e of excerpts) {
    const key = `${e.sourceId}:${(e.text || '').slice(0, 40)}`;
    if (!accum.sourceKeys.has(key)) { accum.sourceKeys.add(key); accum.sources.push(e); }
  }
  return formatForPrompt(excerpts);
}

// ─── Main orchestration ─────────────────────────────────────────────────────────

/**
 * @param {object} req
 * @param {string} req.userId
 * @param {string} req.question
 * @param {number} [req.taxYear]
 * @param {string} [req.filingStatus]
 * @param {string} [req.state]
 * @param {object} [req.scenario]          optional TaxInput to pre-run the engine
 * @param {string} [req.userDataSummary]   short summary of the user's tax data
 * @param {Array}  [req.history]           prior [{role, content}] turns
 * @param {string} [req.provider]          'ollama'|'groq'|'anthropic'
 * @returns {Promise<object>}
 */
async function runAdvisorTurn(req) {
  const startedAt = Date.now();
  const {
    userId, question, taxYear, filingStatus, state,
    scenario, userDataSummary, includeUserData = true,
    history = [], provider: providerName,
  } = req;

  if (!question || !question.trim()) throw new Error('question is required');

  const provider = getProvider(providerName);

  // Auto-build the user's data summary from normalized transactions when the
  // caller didn't supply one (and isn't running an explicit what-if scenario).
  // This is what makes the advisor reason over the user's ACTUAL accounts.
  let effectiveSummary = userDataSummary;
  if (!effectiveSummary && includeUserData && userId && taxYear && !scenario) {
    try {
      const { taxInput, breakdown } = await buildTaxInputForYear(userId, taxYear, { filingStatus });
      const s = buildDataSummary(taxInput, breakdown);
      if (s && !/No categorized tax data/i.test(s)) effectiveSummary = s;
    } catch (_) { /* DB empty or unavailable — fall through to the default */ }
  }
  effectiveSummary = effectiveSummary || 'No specific financial data was provided.';

  // 1. Risk flags
  const riskFlags = guardrails.detectRiskFlags(question);
  const esc       = guardrails.shouldEscalate(riskFlags);

  // 2. Initial RAG retrieval (graceful if unavailable)
  const accum = { sources: [], sourceKeys: new Set(), calculationResult: null };
  let ragError = null;
  try {
    const initial = await retrieve(question, { taxYear, jurisdiction: state || 'federal', topK: 8 });
    for (const e of initial) {
      const key = `${e.sourceId}:${(e.text || '').slice(0, 40)}`;
      if (!accum.sourceKeys.has(key)) { accum.sourceKeys.add(key); accum.sources.push(e); }
    }
  } catch (e) {
    ragError = e.message; // continue without sources; the model is told there are none
  }

  // 3. Pre-run the engine if a scenario was supplied
  if (scenario && typeof scenario === 'object') {
    try { accum.calculationResult = calculate({ taxYear, filingStatus, ...scenario }); }
    catch (e) { /* bad scenario — let the model ask for clarification */ }
  }

  // 4. Build system prompt + initial messages
  const ctx = { taxYear, filingStatus, state };
  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: question },
  ];

  let finalText = '';
  let usage = { input: 0, output: 0 };

  // 5. Tool-calling loop
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const system = buildSystemPrompt({
      taxYear, filingStatus, state,
      sourcesBlock:     accum.sources.length ? formatForPrompt(accum.sources)
                        : (ragError ? `Source retrieval is currently unavailable (${ragError}).`
                                    : 'No tax-law sources were retrieved for this question.'),
      calculationBlock: buildCalculationBlock(accum.calculationResult),
      userDataSummary: effectiveSummary,
    });

    // On the last allowed round, drop tools to force a text answer
    const toolsThisRound = round < MAX_TOOL_ROUNDS ? TOOLS : undefined;

    const out = await provider.complete({ system, messages, tools: toolsThisRound });
    usage.input  += out.usage?.input  || 0;
    usage.output += out.usage?.output || 0;

    if (out.toolCalls?.length) {
      // Record the assistant's tool-call turn
      messages.push({ role: 'assistant', content: out.text || '', toolCalls: out.toolCalls });
      // Execute each tool and append results
      for (const tc of out.toolCalls) {
        let resultText;
        try {
          if (tc.name === 'calculate_tax')          resultText = execCalculateTax(tc.args, accum);
          else if (tc.name === 'retrieve_more_sources') resultText = await execRetrieveSources(tc.args, ctx, accum);
          else resultText = `Unknown tool: ${tc.name}`;
        } catch (e) {
          resultText = `Tool error: ${e.message}`;
        }
        messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: resultText });
      }
      continue; // let the model see tool results
    }

    finalText = out.text || '';
    break;
  }

  // 6. Validate
  const validation = guardrails.validateAnswer({
    answer: finalText,
    sources: accum.sources,
    calculationResult: accum.calculationResult,
    taxYear,
    riskFlags,
    extraGroundingText: effectiveSummary,
  });

  // 7. Compose user-facing answer: prepend an unverified warning if needed,
  //    append escalation note + disclaimer.
  let answer = finalText;
  if (!validation.passed) {
    answer = `⚠ Note: parts of this answer could not be automatically verified ` +
             `(${validation.blocking.join('; ')}). Please treat the figures with caution ` +
             `and confirm with a professional.\n\n` + answer;
  }
  if (esc.escalate) answer += `\n\n${guardrails.ESCALATION_NOTE}`;
  answer += `\n\n— ${guardrails.DISCLAIMER}`;

  // 8. Persist calculation (if any) + log the session (best-effort)
  let calculationId = null;
  if (accum.calculationResult && userId) {
    calculationId = await saveCalculation(userId, taxYear, filingStatus, scenario || {}, accum.calculationResult)
      .catch(() => null);
  }
  const latencyMs = Date.now() - startedAt;
  if (userId) {
    await saveSession({
      userId, taxYear, filingStatus,
      userQuestion: question,
      conversationHistory: history,
      modelUsed: `${provider.name}/${provider.model}`,
      sources: accum.sources,
      calculationId,
      userDataSummary: effectiveSummary,
      finalAnswer: answer,
      riskFlags,
      validation,
      escalated: esc.escalate,
      escalationReason: esc.reason,
      usage, latencyMs,
    }).catch(() => {});
  }

  // 9. Return
  return {
    answer,
    citations: accum.sources.map(s => ({
      sourceName: s.sourceName, codeSection: s.codeSection,
      formNumber: s.formNumber, url: s.url, score: s.score,
    })),
    calculation: accum.calculationResult,
    calculationId,
    riskFlags,
    escalated: esc.escalate,
    escalationReason: esc.reason,
    validation,
    model: `${provider.name}/${provider.model}`,
    usage,
    latencyMs,
    ragAvailable: ragError === null,
  };
}

// ─── Persistence helpers (server-side; mirror tax-history schema) ───────────────

async function saveCalculation(userId, taxYear, filingStatus, input, result) {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO tax_calculations
       (id,user_id,tax_year,filing_status,label,source,
        agi,total_liability,balance_due,effective_rate,marginal_rate,
        input_snapshot,result_snapshot,engine_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, userId, taxYear || result.taxYear, filingStatus || result.filingStatus,
     null, 'advisor',
     result.agi || null, result.totalLiability || null, result.balanceDue || null,
     result.effectiveRate || null, result.marginalRate || null,
     JSON.stringify(input), JSON.stringify(result), '1.0']
  );
  return id;
}

async function saveSession(s) {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO ai_tax_sessions
       (id,user_id,tax_year,filing_status,user_question,conversation_history,
        model_used,retrieved_source_ids,retrieved_excerpts,calculation_id,
        user_data_snapshot,final_answer,citations,risk_flags,
        validation_passed,validation_details,disclaimer_shown,escalated,
        escalation_reason,tokens_used,latency_ms)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [id, s.userId, s.taxYear || null, s.filingStatus || null,
     s.userQuestion, JSON.stringify(s.conversationHistory || []),
     s.modelUsed,
     JSON.stringify(s.sources.map(x => x.sourceId).filter(Boolean)),
     JSON.stringify(s.sources.map(x => ({ sourceId: x.sourceId, sourceName: x.sourceName, score: x.score }))),
     s.calculationId || null,
     JSON.stringify({ summary: s.userDataSummary }),
     s.finalAnswer,
     JSON.stringify(s.sources.map(x => ({ source: x.sourceName, section: x.codeSection, url: x.url }))),
     JSON.stringify(s.riskFlags || []),
     s.validation?.passed ?? null,
     JSON.stringify(s.validation?.details || {}),
     true, s.escalated || false, s.escalationReason || null,
     (s.usage?.input || 0) + (s.usage?.output || 0), s.latencyMs || null]
  );
  return id;
}

// ─── Router ───────────────────────────────────────────────────────────────────

function makeRouter() {
  const router = express.Router();

  // GET /api/tax-advisor/status
  router.get('/status', async (_req, res) => {
    const providers = configuredProviders();
    const [ollamaUp, qdrantUp] = await Promise.all([
      ragEmbeddings.isAvailable().catch(() => false),
      ragVectorStore.isAvailable().catch(() => false),
    ]);
    res.json({
      providers,
      rag: { ollama: ollamaUp, qdrant: qdrantUp, ready: ollamaUp && qdrantUp },
      ready: (providers.groq || providers.anthropic || ollamaUp),
    });
  });

  // POST /api/tax-advisor/ask
  router.post('/ask', async (req, res) => {
    const {
      question, taxYear, filingStatus, state,
      scenario, userDataSummary, includeUserData, history, provider,
    } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'question is required' });
    }
    try {
      const result = await runAdvisorTurn({
        userId: req.user?.id,
        question, taxYear, filingStatus, state,
        scenario, userDataSummary, includeUserData, history, provider,
      });
      res.json(result);
    } catch (e) {
      console.error('[TaxAdvisor] ask error:', e.message);
      // Distinguish "provider not configured / unreachable" from other errors
      const code = /not configured|HTTP 4|HTTP 5|fetch failed|ECONNREFUSED/i.test(e.message) ? 503 : 500;
      res.status(code).json({
        error: code === 503
          ? 'The AI model backend is not available. Check that your provider (Ollama/Groq/Anthropic) is configured and running.'
          : 'Failed to process the question.',
        detail: e.message,
      });
    }
  });

  return router;
}

module.exports = { makeRouter, runAdvisorTurn, TOOLS };
