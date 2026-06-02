'use strict';
/**
 * Tax Advisor tests — guardrails, prompt, providers, and full orchestration.
 *
 * The orchestration tests mock the LLM provider, the RAG retriever, and the DB,
 * but use the REAL deterministic tax engine, so the retrieve→calculate→validate
 * wiring is exercised end-to-end.
 */

// ── Mocks (must precede requires) ───────────────────────────────────────────────

// LLM provider — scriptable per test via providers.__complete
jest.mock('../tax-advisor/providers', () => {
  const actual = jest.requireActual('../tax-advisor/providers');
  const complete = jest.fn();
  return {
    ...actual, // keep real toOpenAITools / toAnthropicTools
    __complete: complete,
    getProvider: () => ({ name: 'test', model: 'test-model', complete }),
    configuredProviders: () => ({
      ollama: true, groq: false, anthropic: false, default: 'ollama',
      models: { ollama: 'qwen2.5:32b-instruct' },
    }),
  };
});

// RAG retriever — mock retrieve(), keep formatForPrompt/buildFilter real
jest.mock('../rag/retriever', () => {
  const actual = jest.requireActual('../rag/retriever');
  return { ...actual, retrieve: jest.fn(async () => []) };
});

// RAG infra (only used by /status) — stub
jest.mock('../rag/embeddings',  () => ({ isAvailable: jest.fn(async () => true),  embed: jest.fn(), EMBED_MODEL: 'nomic-embed-text', OLLAMA_URL: 'http://localhost:11434' }));
jest.mock('../rag/vectorStore', () => ({ isAvailable: jest.fn(async () => true), search: jest.fn(), stats: jest.fn(async () => ({ pointsCount: 0 })), COLLECTION: 'tax_sources', QDRANT_URL: 'http://localhost:6333' }));

// DB — no-op
jest.mock('../db', () => ({ query: jest.fn(async () => ({ rows: [] })), initSchema: jest.fn() }));

// ── Imports ─────────────────────────────────────────────────────────────────────
const guardrails = require('../tax-advisor/guardrails');
const { buildSystemPrompt, buildCalculationBlock, CORE_RULES } = require('../tax-advisor/prompt');
const { toOpenAITools, toAnthropicTools } = require('../tax-advisor/providers');
const { runAdvisorTurn } = require('../tax-advisor');
const providers = require('../tax-advisor/providers');
const retriever = require('../rag/retriever');

const mockComplete = providers.__complete;

// ════════════════════════════════════════════════════════════════════════════════
// GUARDRAILS
// ════════════════════════════════════════════════════════════════════════════════

describe('guardrails — risk detection', () => {
  test('detects audit as critical', () => {
    const flags = guardrails.detectRiskFlags('I got an IRS audit letter, what now?');
    expect(flags.some(f => f.flag === 'audit' && f.severity === 'critical')).toBe(true);
  });
  test('detects crypto as high', () => {
    const flags = guardrails.detectRiskFlags('How do I report my bitcoin staking rewards?');
    expect(flags.some(f => f.flag === 'crypto')).toBe(true);
  });
  test('detects foreign accounts as critical', () => {
    const flags = guardrails.detectRiskFlags('Do I need to file an FBAR for my foreign bank account?');
    expect(flags.some(f => f.flag === 'foreign' && f.severity === 'critical')).toBe(true);
  });
  test('clean question yields no flags', () => {
    expect(guardrails.detectRiskFlags('What is the standard deduction for a single filer?')).toEqual([]);
  });
});

describe('guardrails — escalation', () => {
  test('any critical flag escalates', () => {
    const r = guardrails.shouldEscalate([{ flag: 'audit', severity: 'critical' }]);
    expect(r.escalate).toBe(true);
    expect(r.reason).toMatch(/audit/);
  });
  test('two high flags escalate', () => {
    const r = guardrails.shouldEscalate([
      { flag: 'crypto', severity: 'high' }, { flag: 'large_capital_gains', severity: 'high' },
    ]);
    expect(r.escalate).toBe(true);
  });
  test('single high flag does not escalate', () => {
    expect(guardrails.shouldEscalate([{ flag: 'crypto', severity: 'high' }]).escalate).toBe(false);
  });
  test('no flags → no escalation', () => {
    expect(guardrails.shouldEscalate([]).escalate).toBe(false);
  });
});

describe('guardrails — citations', () => {
  test('detects [Source N] markers', () => {
    expect(guardrails.checkCitations('You can deduct it [Source 2].', []).hasCitations).toBe(true);
  });
  test('detects source name verbatim', () => {
    const r = guardrails.checkCitations('Per IRS Publication 587, exclusive use is required.',
      [{ sourceName: 'IRS Publication 587' }]);
    expect(r.hasCitations).toBe(true);
  });
  test('detects citation phrasing', () => {
    expect(guardrails.checkCitations('According to IRC §280A, the area must be exclusive.', []).hasCitations).toBe(true);
  });
  test('no citation detected in plain text', () => {
    expect(guardrails.checkCitations('Yes you probably can deduct that.', []).hasCitations).toBe(false);
  });
});

describe('guardrails — dollar amount extraction', () => {
  test('parses comma-formatted amounts', () => {
    expect(guardrails.normalizeAmount('$14,600')).toBe('14600');
  });
  test('parses millions', () => {
    expect(guardrails.normalizeAmount('$1.2 million')).toBe('1200000');
  });
  test('parses k suffix', () => {
    expect(guardrails.normalizeAmount('$5k')).toBe('5000');
  });
  test('extracts multiple amounts from text', () => {
    const amts = guardrails.extractDollarAmounts('AGI was $80,000 and tax was $9,500.');
    expect(amts).toContain('80000');
    expect(amts).toContain('9500');
  });
});

describe('guardrails — number grounding', () => {
  const calc = {
    agi: 80000, totalLiability: 9500,
    steps: [{ label: 'AGI', value: 80000 }, { label: 'Tax', value: 9500 }],
  };
  test('numbers from the engine are grounded', () => {
    const grounded = guardrails.collectGroundedNumbers(calc, []);
    const r = guardrails.checkNumbersGrounded('Your AGI is $80,000 and tax is $9,500.', grounded);
    expect(r.allGrounded).toBe(true);
  });
  test('invented numbers are flagged', () => {
    const grounded = guardrails.collectGroundedNumbers(calc, []);
    const r = guardrails.checkNumbersGrounded('Your refund will be $44,321.', grounded);
    expect(r.allGrounded).toBe(false);
    expect(r.ungrounded).toContain('44321');
  });
  test('±1 rounding is tolerated', () => {
    const grounded = guardrails.collectGroundedNumbers({ steps: [{ value: 9500 }] }, []);
    const r = guardrails.checkNumbersGrounded('Tax is $9,501.', grounded);
    expect(r.allGrounded).toBe(true);
  });
  test('amounts in sources count as grounded', () => {
    const grounded = guardrails.collectGroundedNumbers(null,
      [{ text: 'The 2024 standard deduction is $14,600 for single filers.' }]);
    const r = guardrails.checkNumbersGrounded('You get the $14,600 standard deduction.', grounded);
    expect(r.allGrounded).toBe(true);
  });
});

describe('guardrails — tax year', () => {
  test('correct year passes', () => {
    expect(guardrails.checkTaxYear('For 2024 the deduction is higher.', 2024).correctYear).toBe(true);
  });
  test('wrong year is flagged', () => {
    const r = guardrails.checkTaxYear('Back in 2019 the rule was different.', 2024);
    expect(r.correctYear).toBe(false);
    expect(r.wrongYears).toContain(2019);
  });
  test('no year mentioned is fine', () => {
    expect(guardrails.checkTaxYear('The standard deduction reduces taxable income.', 2024).correctYear).toBe(true);
  });
});

describe('guardrails — validateAnswer', () => {
  const sources = [{ sourceName: 'IRS Pub 587', text: 'exclusive use required' }];
  const calc = { agi: 80000, steps: [{ label: 'AGI', value: 80000 }] };

  test('clean answer passes', () => {
    const v = guardrails.validateAnswer({
      answer: 'Per IRS Pub 587, your AGI of $80,000 qualifies. [Source 1]',
      sources, calculationResult: calc, taxYear: 2024,
    });
    expect(v.passed).toBe(true);
  });
  test('wrong tax year blocks', () => {
    const v = guardrails.validateAnswer({
      answer: 'In 2018 you could deduct this [Source 1].',
      sources, calculationResult: calc, taxYear: 2024,
    });
    expect(v.passed).toBe(false);
    expect(v.blocking.join(' ')).toMatch(/tax year/i);
  });
  test('ungrounded number with a calc blocks', () => {
    const v = guardrails.validateAnswer({
      answer: 'Your refund is $55,123 [Source 1].',
      sources, calculationResult: calc, taxYear: 2024,
    });
    expect(v.passed).toBe(false);
    expect(v.blocking.join(' ')).toMatch(/dollar amounts/i);
  });
  test('missing citation is a warning, not blocking', () => {
    const v = guardrails.validateAnswer({
      answer: 'Your AGI is $80,000.', sources, calculationResult: calc, taxYear: 2024,
    });
    expect(v.passed).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/cite/i);
  });
  test('extraGroundingText grounds user-stated numbers', () => {
    const v = guardrails.validateAnswer({
      answer: 'With your $200,000 salary, you are in a high bracket. [Source 1]',
      sources, calculationResult: null, taxYear: 2024,
      extraGroundingText: 'User W-2 wages: $200,000',
    });
    expect(v.details.ungroundedAmounts).not.toContain('200000');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// PROMPT
// ════════════════════════════════════════════════════════════════════════════════

describe('prompt builder', () => {
  test('system prompt always includes the core rules', () => {
    const p = buildSystemPrompt({ taxYear: 2024, filingStatus: 'single' });
    expect(p).toContain('STRICT RULES');
    expect(p).toContain('NUMBERS');
    expect(p).toContain('CITATIONS');
    expect(p).toContain('Tax Year: 2024');
  });
  test('includes sources and calculation blocks', () => {
    const p = buildSystemPrompt({
      taxYear: 2024,
      sourcesBlock: 'SOURCE_BLOCK_MARKER',
      calculationBlock: 'CALC_BLOCK_MARKER',
    });
    expect(p).toContain('SOURCE_BLOCK_MARKER');
    expect(p).toContain('CALC_BLOCK_MARKER');
  });
  test('buildCalculationBlock renders steps and summary', () => {
    const block = buildCalculationBlock({
      taxYear: 2024, filingStatus: 'single',
      agi: 80000, taxableIncome: 65400, totalLiability: 9500, balanceDue: 1500,
      effectiveRate: 0.119, marginalRate: 0.22,
      steps: [{ label: 'W-2 Wages', value: 80000, irsRef: '1040 Line 1a' }],
      assumptions: ['Assumed standard deduction'], warnings: [],
    });
    expect(block).toContain('W-2 Wages');
    expect(block).toContain('$80,000');
    expect(block).toContain('Total tax liability');
    expect(block).toContain('Assumed standard deduction');
  });
  test('buildCalculationBlock handles null', () => {
    expect(buildCalculationBlock(null)).toMatch(/No calculation/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// PROVIDERS — tool schema conversion
// ════════════════════════════════════════════════════════════════════════════════

describe('providers — tool conversion', () => {
  const tools = [{ name: 'calc', description: 'd', parameters: { type: 'object', properties: {} } }];
  test('toOpenAITools wraps in function type', () => {
    const o = toOpenAITools(tools);
    expect(o[0].type).toBe('function');
    expect(o[0].function.name).toBe('calc');
  });
  test('toAnthropicTools uses input_schema', () => {
    const a = toAnthropicTools(tools);
    expect(a[0].name).toBe('calc');
    expect(a[0].input_schema).toBeDefined();
  });
  test('empty tools → undefined', () => {
    expect(toOpenAITools([])).toBeUndefined();
    expect(toAnthropicTools(undefined)).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// ORCHESTRATION — runAdvisorTurn (real engine, mocked LLM + RAG + DB)
// ════════════════════════════════════════════════════════════════════════════════

describe('runAdvisorTurn', () => {
  beforeEach(() => {
    mockComplete.mockReset();
    retriever.retrieve.mockReset();
    retriever.retrieve.mockResolvedValue([]); // default: no sources
  });

  test('simple Q&A appends disclaimer and passes validation', async () => {
    retriever.retrieve.mockResolvedValue([
      { sourceId: 's1', sourceName: 'IRS Pub 17', text: 'The standard deduction reduces taxable income.', codeSection: 'IRC §63' },
    ]);
    mockComplete.mockResolvedValueOnce({
      text: 'The standard deduction reduces your taxable income. [Source 1]',
      toolCalls: [], usage: { input: 100, output: 30 },
    });

    const r = await runAdvisorTurn({
      userId: 'u1', question: 'What does the standard deduction do?', taxYear: 2024,
    });
    expect(r.answer).toContain('standard deduction');
    expect(r.answer).toContain(guardrails.DISCLAIMER);
    expect(r.validation.passed).toBe(true);
    expect(r.citations).toHaveLength(1);
    expect(r.escalated).toBe(false);
  });

  test('tool-calling: model calls calculate_tax, then answers with grounded number', async () => {
    retriever.retrieve.mockResolvedValue([]);
    // Round 1: model requests a calculation
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 't1', name: 'calculate_tax', args: { taxYear: 2024, filingStatus: 'single', income: { w2: 80000 } } }],
      usage: { input: 200, output: 20 },
    });
    // Round 2: model answers using a number the engine produced (AGI = 80,000)
    mockComplete.mockResolvedValueOnce({
      text: 'Based on the calculation, your AGI is $80,000.',
      toolCalls: [], usage: { input: 300, output: 40 },
    });

    const r = await runAdvisorTurn({
      userId: 'u1', question: 'What is my tax on an $80k salary?', taxYear: 2024, filingStatus: 'single',
    });
    expect(r.calculation).not.toBeNull();
    expect(r.calculation.agi).toBe(80000);
    expect(r.validation.details.numbersGrounded).toBe(true);
    expect(mockComplete).toHaveBeenCalledTimes(2);
  });

  test('escalates on a high-risk question and appends the escalation note', async () => {
    retriever.retrieve.mockResolvedValue([]);
    mockComplete.mockResolvedValueOnce({
      text: 'Audits can be stressful; gather your records.', toolCalls: [],
    });
    const r = await runAdvisorTurn({
      userId: 'u1', question: 'I am being audited by the IRS, what should I do?', taxYear: 2024,
    });
    expect(r.escalated).toBe(true);
    expect(r.answer).toContain(guardrails.ESCALATION_NOTE);
    expect(r.riskFlags.some(f => f.flag === 'audit')).toBe(true);
  });

  test('survives RAG being down (ragAvailable=false) and still answers', async () => {
    retriever.retrieve.mockRejectedValue(new Error('Qdrant unreachable'));
    mockComplete.mockResolvedValueOnce({ text: 'I can explain in general terms.', toolCalls: [] });
    const r = await runAdvisorTurn({ userId: 'u1', question: 'Explain deductions.', taxYear: 2024 });
    expect(r.ragAvailable).toBe(false);
    expect(r.answer).toContain('I can explain');
  });

  test('flags an answer with an invented number when a calc was run', async () => {
    retriever.retrieve.mockResolvedValue([]);
    mockComplete.mockResolvedValueOnce({
      text: 'Your refund will be exactly $1,234,567.', toolCalls: [],
    });
    const r = await runAdvisorTurn({
      userId: 'u1', question: 'Estimate my taxes.', taxYear: 2024, filingStatus: 'single',
      scenario: { income: { w2: 50000 } }, // triggers a real engine run up front
    });
    expect(r.calculation).not.toBeNull();
    expect(r.validation.passed).toBe(false);
    expect(r.answer).toMatch(/could not be automatically verified/i);
  });

  test('rejects empty question', async () => {
    await expect(runAdvisorTurn({ userId: 'u1', question: '   ' })).rejects.toThrow(/question is required/);
  });
});
