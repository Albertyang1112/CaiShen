'use strict';
/**
 * retriever.js — Hybrid tax-law retrieval
 *
 * Pipeline:
 *   1. Embed the query (Ollama)
 *   2. Search Qdrant with a metadata filter that ALWAYS enforces:
 *        - is_current_law = true          (never retrieve superseded law)
 *        - tax_year matches OR is absent  (year-agnostic sources like IRC sections)
 *        - jurisdiction is federal OR the user's state
 *   3. Return ranked excerpts with source attribution for citation.
 *
 * The filter is the safety boundary: it is impossible for the AI to be handed
 * an excerpt from the wrong tax year or from superseded guidance.
 */

const { embed }  = require('./embeddings');
const { search } = require('./vectorStore');

/**
 * Build the Qdrant filter. Exported separately so it can be unit-tested
 * without any network calls.
 * @param {object} opts
 * @param {number} [opts.taxYear]
 * @param {string} [opts.jurisdiction='federal']
 * @returns {object} Qdrant filter
 */
function buildFilter({ taxYear, jurisdiction = 'federal' } = {}) {
  const must = [
    { key: 'is_current_law', match: { value: true } },
  ];

  if (taxYear) {
    // Accept documents tagged with this exact year OR documents with no year
    // (e.g. an IRC section that isn't year-specific).
    must.push({
      should: [
        { key: 'tax_year', match: { value: taxYear } },
        { is_empty: { key: 'tax_year' } },
      ],
    });
  }

  // Always allow federal; additionally allow the user's state if given.
  const jurisdictionShould = [{ key: 'jurisdiction', match: { value: 'federal' } }];
  if (jurisdiction && jurisdiction !== 'federal') {
    jurisdictionShould.push({ key: 'jurisdiction', match: { value: jurisdiction } });
  }
  must.push({ should: jurisdictionShould });

  return { must };
}

/**
 * Retrieve the most relevant tax-law excerpts for a query.
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.taxYear]
 * @param {string} [opts.jurisdiction='federal']
 * @param {number} [opts.topK=8]
 * @param {number} [opts.minScore=0]  drop hits below this cosine score
 * @returns {Promise<Array>} excerpts: { sourceId, sourceName, text, url, codeSection, formNumber, score }
 */
async function retrieve(query, { taxYear, jurisdiction = 'federal', topK = 8, minScore = 0 } = {}) {
  const vector = await embed(query);
  const filter = buildFilter({ taxYear, jurisdiction });
  const hits   = await search(vector, filter, topK);

  return hits
    .filter(h => (h.score ?? 0) >= minScore)
    .map(h => ({
      sourceId:    h.payload?.source_id    ?? null,
      sourceName:  h.payload?.source_name  ?? 'Unknown source',
      text:        h.payload?.text         ?? '',
      url:         h.payload?.url          ?? null,
      codeSection: h.payload?.code_section ?? null,
      formNumber:  h.payload?.form_number  ?? null,
      documentType:h.payload?.document_type?? null,
      taxYear:     h.payload?.tax_year     ?? null,
      score:       h.score ?? 0,
    }));
}

/**
 * Format retrieved excerpts into a prompt-ready block for the AI advisor.
 * Each excerpt is numbered so the model can cite "[Source 3]".
 * @param {Array} excerpts
 * @returns {string}
 */
function formatForPrompt(excerpts) {
  if (!excerpts.length) return 'No relevant tax-law sources were found for this query.';
  return excerpts.map((e, i) => {
    const ref = [
      e.sourceName,
      e.codeSection ? `(${e.codeSection})` : null,
      e.formNumber  ? `[${e.formNumber}]`  : null,
      e.taxYear     ? `— Tax Year ${e.taxYear}` : null,
    ].filter(Boolean).join(' ');
    return `[Source ${i + 1}] ${ref}\n${e.text}\n${e.url ? `URL: ${e.url}` : ''}`.trim();
  }).join('\n\n---\n\n');
}

module.exports = { retrieve, buildFilter, formatForPrompt };
