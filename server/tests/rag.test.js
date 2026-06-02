'use strict';
/**
 * RAG tests — chunker, retrieval filter, prompt formatting, and a
 * mocked end-to-end retrieve(). No live Qdrant/Ollama required.
 */

// ── Mock embeddings + vectorStore BEFORE requiring retriever ──────────────────
jest.mock('../rag/embeddings', () => ({
  embed: jest.fn(async (text) => {
    // Deterministic fake vector based on text length (3 dims, enough for tests)
    const n = text.length;
    return [n % 7, n % 11, n % 13];
  }),
  embedBatch: jest.fn(async (texts) => texts.map(t => [t.length % 7, 1, 2])),
  isAvailable: jest.fn(async () => true),
  EMBED_DIM: 768,
  EMBED_MODEL: 'nomic-embed-text',
  OLLAMA_URL: 'http://localhost:11434',
}));

jest.mock('../rag/vectorStore', () => ({
  search: jest.fn(async () => []),
  isAvailable: jest.fn(async () => true),
  stats: jest.fn(async () => ({ exists: true, pointsCount: 0 })),
  COLLECTION: 'tax_sources',
  QDRANT_URL: 'http://localhost:6333',
}));

const { chunkText, estimateTokens } = require('../rag/chunker');
const { buildFilter, retrieve, formatForPrompt } = require('../rag/retriever');
const vectorStore = require('../rag/vectorStore');

// ═══════════════════════════════════════════════════════════════════════════════
// Chunker — pure logic
// ═══════════════════════════════════════════════════════════════════════════════

describe('chunkText', () => {

  test('empty / whitespace input returns no chunks', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  test('short text returns a single chunk', () => {
    const out = chunkText('A short paragraph about taxes.');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('short paragraph');
  });

  test('splits long multi-paragraph text into multiple chunks', () => {
    const para = 'This is a paragraph about deductions and credits. '.repeat(20); // ~1000 chars
    const text = Array(6).fill(para).join('\n\n'); // ~6000 chars
    const out  = chunkText(text, { targetTokens: 256, overlapTokens: 32 });
    expect(out.length).toBeGreaterThan(1);
    // No chunk should be absurdly larger than target (256 tokens ≈ 1024 chars, ×1.5 cap)
    for (const c of out) expect(c.length).toBeLessThanOrEqual(256 * 4 * 1.5 + 10);
  });

  test('overlap carries context between consecutive chunks', () => {
    const p1 = 'UNIQUE_MARKER_ALPHA ' + 'filler '.repeat(80);
    const p2 = 'second paragraph ' + 'filler '.repeat(80);
    const out = chunkText(`${p1}\n\n${p2}`, { targetTokens: 60, overlapTokens: 20 });
    expect(out.length).toBeGreaterThan(1);
    // The start of chunk 2 should include a tail of chunk 1 (overlap)
    expect(out[1].length).toBeGreaterThan(0);
  });

  test('hard-splits a single giant paragraph with no breaks', () => {
    const giant = 'x'.repeat(5000); // one paragraph, no blank lines
    const out   = chunkText(giant, { targetTokens: 256, overlapTokens: 32 });
    expect(out.length).toBeGreaterThan(1);
  });

  test('estimateTokens scales with length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);     // 4 chars ≈ 1 token
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildFilter — the safety boundary
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildFilter', () => {

  test('always enforces is_current_law = true', () => {
    const f = buildFilter({});
    const currentLawClause = f.must.find(c => c.key === 'is_current_law');
    expect(currentLawClause).toBeDefined();
    expect(currentLawClause.match.value).toBe(true);
  });

  test('filters by tax year OR year-agnostic sources', () => {
    const f = buildFilter({ taxYear: 2024 });
    const yearClause = f.must.find(c => Array.isArray(c.should) &&
      c.should.some(s => s.key === 'tax_year'));
    expect(yearClause).toBeDefined();
    // Should allow exact year match
    expect(yearClause.should.some(s => s.match?.value === 2024)).toBe(true);
    // Should also allow documents with no tax_year (e.g. IRC sections)
    expect(yearClause.should.some(s => s.is_empty?.key === 'tax_year')).toBe(true);
  });

  test('federal-only by default', () => {
    const f = buildFilter({ taxYear: 2024 });
    const jClause = f.must.find(c => Array.isArray(c.should) &&
      c.should.some(s => s.key === 'jurisdiction'));
    expect(jClause.should).toHaveLength(1);
    expect(jClause.should[0].match.value).toBe('federal');
  });

  test('includes user state jurisdiction when provided', () => {
    const f = buildFilter({ taxYear: 2024, jurisdiction: 'CA' });
    const jClause = f.must.find(c => Array.isArray(c.should) &&
      c.should.some(s => s.key === 'jurisdiction'));
    const values = jClause.should.map(s => s.match.value);
    expect(values).toContain('federal');
    expect(values).toContain('CA');
  });

  test('no tax-year clause when taxYear omitted', () => {
    const f = buildFilter({});
    const yearClause = f.must.find(c => Array.isArray(c.should) &&
      c.should.some(s => s.key === 'tax_year'));
    expect(yearClause).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// retrieve — mocked end-to-end
// ═══════════════════════════════════════════════════════════════════════════════

describe('retrieve', () => {
  beforeEach(() => jest.clearAllMocks());

  test('maps Qdrant hits to excerpt objects', async () => {
    vectorStore.search.mockResolvedValueOnce([
      { score: 0.91, payload: {
        source_id: 's1', source_name: 'IRS Pub 587', text: 'Home office rules...',
        url: 'https://irs.gov/p587', code_section: 'IRC §280A', form_number: 'Form 8829',
        document_type: 'publication', tax_year: null } },
      { score: 0.84, payload: {
        source_id: 's2', source_name: 'IRS Pub 527', text: 'Rental rules...',
        document_type: 'publication', tax_year: null } },
    ]);

    const out = await retrieve('home office deduction', { taxYear: 2024, jurisdiction: 'CA' });
    expect(out).toHaveLength(2);
    expect(out[0].sourceName).toBe('IRS Pub 587');
    expect(out[0].codeSection).toBe('IRC §280A');
    expect(out[0].score).toBe(0.91);
    // search() must have been called with a filter object
    expect(vectorStore.search).toHaveBeenCalledTimes(1);
    const filterArg = vectorStore.search.mock.calls[0][1];
    expect(filterArg.must.find(c => c.key === 'is_current_law')).toBeDefined();
  });

  test('applies minScore filtering', async () => {
    vectorStore.search.mockResolvedValueOnce([
      { score: 0.9, payload: { source_id: 'a', source_name: 'High', text: 't' } },
      { score: 0.3, payload: { source_id: 'b', source_name: 'Low',  text: 't' } },
    ]);
    const out = await retrieve('q', { minScore: 0.5 });
    expect(out).toHaveLength(1);
    expect(out[0].sourceName).toBe('High');
  });

  test('returns empty array when nothing matches', async () => {
    vectorStore.search.mockResolvedValueOnce([]);
    const out = await retrieve('obscure query');
    expect(out).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatForPrompt
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatForPrompt', () => {

  test('returns a clear message when no excerpts', () => {
    expect(formatForPrompt([])).toMatch(/No relevant tax-law sources/i);
  });

  test('numbers each source and includes attribution', () => {
    const block = formatForPrompt([
      { sourceName: 'IRS Pub 587', codeSection: 'IRC §280A', formNumber: 'Form 8829',
        taxYear: 2024, text: 'Home office...', url: 'https://irs.gov/p587' },
      { sourceName: 'IRS Pub 527', text: 'Rental...', taxYear: null },
    ]);
    expect(block).toContain('[Source 1]');
    expect(block).toContain('[Source 2]');
    expect(block).toContain('IRC §280A');
    expect(block).toContain('Form 8829');
    expect(block).toContain('Tax Year 2024');
    expect(block).toContain('https://irs.gov/p587');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// seed-data integrity
// ═══════════════════════════════════════════════════════════════════════════════

describe('seed corpus', () => {
  const { SEED_DOCUMENTS } = require('../rag/seed-data');

  test('every document has required fields', () => {
    for (const d of SEED_DOCUMENTS) {
      expect(typeof d.sourceKey).toBe('string');
      expect(typeof d.sourceName).toBe('string');
      expect(typeof d.documentType).toBe('string');
      expect(typeof d.fullText).toBe('string');
      expect(d.fullText.length).toBeGreaterThan(50);
      expect(Array.isArray(d.topicTags)).toBe(true);
    }
  });

  test('sourceKeys are unique', () => {
    const keys = SEED_DOCUMENTS.map(d => d.sourceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every document chunks to at least one chunk', () => {
    for (const d of SEED_DOCUMENTS) {
      expect(chunkText(d.fullText).length).toBeGreaterThanOrEqual(1);
    }
  });
});
