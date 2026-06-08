'use strict';
/**
 * tax-form-parser.js
 *
 * Sends a US tax form PDF to the Claude API and parses the structured response
 * into worksheet-ready field values.
 *
 * Exported:
 *   extractTaxFormData(buffer, filename)  → { formType, taxYear, issuerName, boxes }
 *   mapToWorksheetFields(forms)           → partial worksheet delta (additive)
 *   detectFormTypeFromFilename(filename)  → 'W-2' | '1099-INT' | … | null
 */

const CLAUDE_PROMPT = `You are a US tax document data extractor.
You will receive a PDF of a single US tax form (W-2, 1099-INT, 1099-DIV, 1099-B, 1099-NEC, 1099-MISC, 1099-R, SSA-1099, 1098, 1098-E, or similar).
Extract ALL numeric box values and return ONLY a raw JSON object — no markdown fences, no explanation.

Use this exact structure (include only fields that appear in the document; omit absent fields):
{
  "formType": "W-2",
  "taxYear": 2024,
  "issuerName": "Employer or Payer Name",
  "recipientName": "Employee or Recipient Name",
  "boxes": {
    "box1":   0,
    "box2":   0,
    "box3":   0,
    "box4":   0,
    "box5":   0,
    "box6":   0,
    "box7Code": "",
    "box8":   0,
    "box1a":  0,
    "box1b":  0,
    "box2a":  0,
    "box3":   0,
    "box4":   0,
    "box5":   0,
    "box7":   0,
    "box8":   0,
    "box9":   0,
    "box10":  0,
    "box11":  0,
    "box12":  0,
    "box13":  0,
    "box14":  0,
    "box15":  0,
    "box16":  0,
    "netGainLoss": 0,
    "grossDistribution": 0,
    "taxableAmount": 0,
    "federalTaxWithheld": 0,
    "interestOnStudentLoans": 0,
    "mortgageInterestReceived": 0,
    "outstandingMortgagePrincipal": 0,
    "refundOfOverpaidInterest": 0
  }
}

Field guide (only include what's actually on the form):
- W-2:        box1=wages, box2=fed withheld, box3=SS wages, box4=SS tax, box5=Medicare wages, box6=Medicare tax
- 1099-INT:   box1=taxable interest, box2=early withdrawal, box3=US savings bond interest, box4=fed withheld, box8=tax-exempt interest
- 1099-DIV:   box1a=total ordinary dividends, box1b=qualified dividends, box2a=total capital gain, box4=fed withheld
- 1099-B:     netGainLoss=net proceeds minus cost basis (positive=gain, negative=loss), box4=fed withheld
- 1099-NEC:   box1=nonemployee compensation, box4=fed withheld
- 1099-MISC:  box3=other income, box4=fed withheld, box7=nonemployee comp
- 1099-R:     box1=gross distribution, box2a=taxable amount, box4=fed withheld
- SSA-1099:   box5=net benefits, box6=voluntary fed withheld
- 1098:       box1=mortgage interest received, box2=outstanding principal, box3=refund of overpaid interest, box5=mortgage insurance premiums
- 1098-E:     box1=student loan interest received`;

/**
 * Send one PDF buffer to Claude and return raw extracted data.
 * @param {Buffer} buffer        PDF bytes
 * @param {string} [filename]   Optional filename hint for the prompt
 * @returns {Promise<{formType,taxYear,issuerName,recipientName,boxes}>}
 */
async function extractTaxFormData(buffer, filename = '') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_anthropic_api_key_here') {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const axios  = require('axios');
  const base64 = buffer.toString('base64');

  const filenameHint = filename
    ? ` The file is named "${filename}".`
    : '';

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model:      'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role:    'user',
        content: [
          {
            type:   'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          },
          {
            type: 'text',
            text: CLAUDE_PROMPT + filenameHint + '\n\nExtract all box values from this tax document now.',
          },
        ],
      }],
    },
    {
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      timeout: 60000,
    }
  );

  const raw  = response.data.content[0].text.replace(/```json|```/g, '').trim();
  const data = JSON.parse(raw);
  return data;
}

/**
 * Map an array of extracted form objects into a partial worksheet delta.
 * All values are additive (multiple W-2s sum together, etc.).
 * Zero-valued fields are omitted so callers can merge with existing data.
 *
 * @param {Array<{formType,boxes}>} forms
 * @returns {{ income?: {}, payments?: {} }}
 */
function mapToWorksheetFields(forms) {
  const delta = {
    income:   {},
    payments: {},
  };

  const add = (section, key, val) => {
    const n = parseFloat(val) || 0;
    if (n !== 0) delta[section][key] = (delta[section][key] || 0) + n;
  };

  for (const form of forms) {
    const t = (form.formType || '').toUpperCase().replace(/\s/g, '');
    const b = form.boxes || {};

    if (t === 'W-2' || t === 'W2') {
      add('income',   'w2',                      b.box1);
      add('payments', 'w2FederalWithholding',     b.box2);
      add('payments', 'w2SocialSecurityWithholding', b.box4);
      add('payments', 'w2MedicareWithholding',    b.box6);

    } else if (t === '1099-INT' || t === '1099INT') {
      add('income', 'taxableInterest',   b.box1);
      add('income', 'taxExemptInterest', b.box8);
      add('payments', 'w2FederalWithholding', b.box4); // withholding

    } else if (t === '1099-DIV' || t === '1099DIV') {
      add('income', 'ordinaryDividends',  b.box1a);
      add('income', 'qualifiedDividends', b.box1b);
      add('income', 'capitalGains',       b.box2a); // total cap-gain distributions
      add('payments', 'w2FederalWithholding', b.box4);

    } else if (t === '1099-B' || t === '1099B') {
      // Net gain/loss goes to Schedule D → capitalGains
      const net = parseFloat(b.netGainLoss) || 0;
      if (net !== 0) add('income', 'capitalGains', net);
      add('payments', 'w2FederalWithholding', b.box4);

    } else if (t === '1099-NEC' || t === '1099NEC') {
      add('income', 'businessIncome', b.box1);
      add('payments', 'w2FederalWithholding', b.box4);

    } else if (t === '1099-MISC' || t === '1099MISC') {
      // box3 = other income; box7 = nonemployee comp → business income
      add('income', 'otherIncome',    b.box3);
      add('income', 'businessIncome', b.box7);
      add('payments', 'w2FederalWithholding', b.box4);

    } else if (t === '1099-R' || t === '1099R') {
      // Taxable amount (box2a); if blank use gross (box1) as fallback
      const taxable = parseFloat(b.box2a) || parseFloat(b.box1) || 0;
      // Distinguish pension/annuity vs IRA — without more context default to IRA
      add('income', 'iraDistributions', taxable);
      add('payments', 'w2FederalWithholding', b.box4);

    } else if (t === 'SSA-1099' || t === 'SSA1099') {
      // SS benefits: up to 85% taxable depending on income — worksheet stores raw box5
      // User can adjust; we pre-fill with 85% of box5 as a conservative estimate
      const raw = parseFloat(b.box5) || 0;
      const taxable = Math.round(raw * 0.85 * 100) / 100;
      if (taxable !== 0) add('income', 'socialSecurity', taxable);
      add('payments', 'w2FederalWithholding', b.box6);

    } else if (t === '1098') {
      // Mortgage interest → itemized deductions (no direct income field)
      // We surface this in the UI but the delta structure doesn't cover deductions yet.
      // Store as a note in delta for the UI to handle.
      if (!delta._deductionHints) delta._deductionHints = [];
      delta._deductionHints.push({
        label: 'Mortgage Interest (1098)',
        key:   'mortgageInterest',
        value: parseFloat(b.box1) || 0,
        issuer: form.issuerName || '',
      });

    } else if (t === '1098-E' || t === '1098E') {
      // Student loan interest → adjustments
      if (!delta.adjustments) delta.adjustments = {};
      const amt = parseFloat(b.box1) || parseFloat(b.interestOnStudentLoans) || 0;
      if (amt !== 0) delta.adjustments.studentLoanInterest = (delta.adjustments.studentLoanInterest || 0) + amt;
    }
  }

  // Strip empty top-level sections
  for (const k of Object.keys(delta)) {
    if (k.startsWith('_')) continue;
    if (typeof delta[k] === 'object' && Object.keys(delta[k]).length === 0) {
      delete delta[k];
    }
  }

  return delta;
}

/**
 * Detect the likely tax form type from a filename, with no API call.
 * Returns e.g. 'W-2', '1099-INT', '1099-DIV', '1099-B', '1099-NEC',
 *              '1099-MISC', '1099-R', 'SSA-1099', '1098', '1098-E', or null.
 */
function detectFormTypeFromFilename(filename) {
  const name = (filename || '').toUpperCase();
  if (/\bSSA[-_]?1099\b/.test(name))                     return 'SSA-1099';
  if (/\b1099[-_]?INT\b/.test(name))                     return '1099-INT';
  if (/\b1099[-_]?DIV\b/.test(name))                     return '1099-DIV';
  if (/\b1099[-_]?NEC\b/.test(name))                     return '1099-NEC';
  if (/\b1099[-_]?MISC\b/.test(name))                    return '1099-MISC';
  if (/\b1099[-_]?R\b/.test(name))                       return '1099-R';
  if (/\b1099[-_]?B\b/.test(name))                       return '1099-B';
  if (/\b1099\b/.test(name))                             return '1099-MISC'; // generic fallback
  if (/\b1098[-_]?E\b/.test(name))                       return '1098-E';
  if (/\b1098\b/.test(name))                             return '1098';
  if (/\bW[-_]?2\b/.test(name))                          return 'W-2';
  return null;
}

module.exports = { extractTaxFormData, mapToWorksheetFields, detectFormTypeFromFilename };
