'use strict';
/**
 * chunker.js — Split documents into overlapping chunks for embedding
 *
 * Pure logic, no I/O — fully unit-testable.
 *
 * Strategy:
 *   - Split on paragraph boundaries (blank lines) first, so we never break
 *     mid-sentence when we can avoid it.
 *   - Accumulate paragraphs until we approach the target token budget.
 *   - Carry a small overlap (tail of the previous chunk) into the next chunk
 *     so context that spans a boundary isn't lost during retrieval.
 *   - Hard-split any single paragraph that exceeds 1.5× the target.
 *
 * Token estimation: tax/legal English averages ~4 characters per token.
 */

const CHARS_PER_TOKEN = 4;

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.targetTokens=512]  approximate tokens per chunk
 * @param {number} [opts.overlapTokens=64]  approximate overlap between chunks
 * @returns {string[]} non-empty chunk strings
 */
function chunkText(text, { targetTokens = 512, overlapTokens = 64 } = {}) {
  if (!text || !text.trim()) return [];

  const targetChars  = targetTokens  * CHARS_PER_TOKEN;
  const overlapChars  = overlapTokens * CHARS_PER_TOKEN;

  const paragraphs = text
    .split(/\n\s*\n/)
    .map(p => p.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    // If adding this paragraph would overflow and we already have content,
    // close the current chunk and seed the next with an overlap tail.
    if (current && current.length + para.length + 2 > targetChars) {
      chunks.push(current.trim());
      const tail = overlapChars > 0 ? current.slice(-overlapChars) : '';
      current = tail ? `${tail}\n\n${para}` : para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Hard-split pathologically long chunks (e.g. a single giant paragraph).
  const maxChars = Math.floor(targetChars * 1.5);
  return chunks.flatMap(c =>
    c.length > maxChars ? hardSplit(c, targetChars, overlapChars) : [c]
  );
}

/** Fixed-width split with overlap, for content with no paragraph breaks. */
function hardSplit(text, size, overlap) {
  const step = Math.max(1, size - overlap);
  const out  = [];
  for (let i = 0; i < text.length; i += step) {
    out.push(text.slice(i, i + size).trim());
    if (i + size >= text.length) break;
  }
  return out.filter(Boolean);
}

/** Rough token count for budgeting / logging. */
function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

module.exports = { chunkText, estimateTokens, CHARS_PER_TOKEN };
