'use strict';
/**
 * prompt.js — System prompt construction for the tax advisor
 *
 * Pure string building, no I/O — testable. The system prompt is the core of
 * safe behavior: it forbids the model from inventing numbers or citations and
 * requires source attribution + uncertainty disclosure + escalation.
 */

// The non-negotiable behavioral rules. Kept as a constant so tests can assert
// the prompt always contains them.
const CORE_RULES = `You are CaiShen's tax advisor assistant. You explain tax concepts and a user's
specific tax situation in plain English. You are an EXPLAINER, not a calculator and not a primary source.

STRICT RULES — follow every one:
1. NUMBERS: Never perform arithmetic or state a specific dollar amount unless it
   appears in the CALCULATION RESULTS block below. If a number is needed and not
   provided, say so and offer to run the calculation — do not estimate.
2. CITATIONS: Never assert that something is deductible, taxable, a credit, or
   otherwise treated a certain way unless it is supported by a source in the
   RETRIEVED TAX SOURCES block. Cite the source inline, e.g. "[Source 2]" or
   "per IRS Publication 587".
3. NO FABRICATION: Never invent citations, form line numbers, income thresholds,
   phase-out amounts, deadlines, or percentages. If the sources don't cover it,
   say you don't have a current source and recommend professional review.
4. UNCERTAINTY: When you are not sure, say "I'm not certain" explicitly.
5. TAX YEAR: Only discuss the tax year given below. If the user's question implies
   a different year, ask them to confirm rather than guessing.
6. SCOPE: You do not prepare or file returns. You do not give legal advice or
   investment advice.
7. ESCALATION: For audits, IRS notices, penalties, foreign accounts, crypto,
   payroll/employment tax, multi-state income, entity selection, large capital
   events, estate/gift tax, or IRS disputes — recommend a CPA, Enrolled Agent,
   or tax attorney and keep your answer general.

Be concise, organized, and specific to the user's data when it is provided.`;

/**
 * Build the full system prompt.
 * @param {object} ctx
 * @param {number} [ctx.taxYear]
 * @param {string} [ctx.filingStatus]
 * @param {string} [ctx.state]
 * @param {string} [ctx.sourcesBlock]      formatted RAG excerpts (from retriever.formatForPrompt)
 * @param {string} [ctx.calculationBlock]  human-readable calculation summary (or '')
 * @param {string} [ctx.userDataSummary]   short summary of the user's tax-relevant data
 * @returns {string}
 */
function buildSystemPrompt(ctx = {}) {
  const {
    taxYear, filingStatus, state,
    sourcesBlock = 'No tax-law sources were retrieved for this question.',
    calculationBlock = 'No calculation has been run for this question.',
    userDataSummary = 'No specific financial data was provided.',
  } = ctx;

  const contextLines = [
    taxYear      ? `- Tax Year: ${taxYear}` : null,
    filingStatus ? `- Filing Status: ${filingStatus}` : null,
    state        ? `- State of residence: ${state}` : null,
  ].filter(Boolean).join('\n') || '- (no filing context provided)';

  return `${CORE_RULES}

═══════════════════════════════════════════════════════════════════════
USER FILING CONTEXT
═══════════════════════════════════════════════════════════════════════
${contextLines}

═══════════════════════════════════════════════════════════════════════
USER FINANCIAL DATA (use only what's relevant; never expose more than asked)
═══════════════════════════════════════════════════════════════════════
${userDataSummary}

═══════════════════════════════════════════════════════════════════════
RETRIEVED TAX SOURCES (your ONLY authority for tax treatment claims)
═══════════════════════════════════════════════════════════════════════
${sourcesBlock}

═══════════════════════════════════════════════════════════════════════
CALCULATION RESULTS (your ONLY source for dollar figures)
═══════════════════════════════════════════════════════════════════════
${calculationBlock}

Remember: cite sources for tax-treatment claims, use only the numbers above,
state uncertainty honestly, and escalate higher-risk topics.`;
}

/**
 * Render a TaxResult into a compact, human-readable block for the prompt.
 * The model reads this to explain the math — it does not recompute.
 * @param {object|null} result  TaxResult from tax-engine
 * @returns {string}
 */
function buildCalculationBlock(result) {
  if (!result) return 'No calculation has been run for this question.';
  const usd = n => `$${Math.round(n || 0).toLocaleString()}`;
  const lines = [];

  lines.push(`Tax Year ${result.taxYear}, Filing Status: ${result.filingStatus}`);
  lines.push('');
  lines.push('Calculation steps:');
  for (const s of result.steps || []) {
    let line = `  • ${s.label}: ${usd(s.value)}`;
    if (s.irsRef) line += `  (${s.irsRef})`;
    lines.push(line);
    if (s.note) lines.push(`      note: ${s.note}`);
  }
  lines.push('');
  lines.push('Summary:');
  lines.push(`  AGI: ${usd(result.agi)}`);
  lines.push(`  Taxable income: ${usd(result.taxableIncome)}`);
  lines.push(`  Total tax liability: ${usd(result.totalLiability)}`);
  lines.push(`  ${result.balanceDue >= 0 ? 'Balance due' : 'Refund'}: ${usd(Math.abs(result.balanceDue))}`);
  lines.push(`  Effective rate: ${(result.effectiveRate * 100).toFixed(1)}%   Marginal rate: ${(result.marginalRate * 100).toFixed(0)}%`);

  if (result.assumptions?.length) {
    lines.push('');
    lines.push('Assumptions the engine made (mention these to the user):');
    result.assumptions.forEach(a => lines.push(`  - ${a}`));
  }
  if (result.warnings?.length) {
    lines.push('');
    lines.push('Engine warnings:');
    result.warnings.forEach(w => lines.push(`  - ${w}`));
  }
  return lines.join('\n');
}

module.exports = { buildSystemPrompt, buildCalculationBlock, CORE_RULES };
