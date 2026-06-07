'use strict';
/**
 * seed-data.js — Starter tax-law corpus for the RAG store.
 *
 * These are concise, FACTUAL reference entries written for retrieval testing
 * and initial coverage of the most common questions. Each carries full source
 * attribution (publication, URL, code section, tax year).
 *
 * IRS publications are U.S. Government works in the public domain
 * (17 U.S.C. § 105). The production ingestion pipeline should pull the full
 * official PDFs from irs.gov; this seed is a curated starter set.
 *
 * IMPORTANT: figures here mirror server/tax-engine/data.js. When you update the
 * engine's annual numbers, update or re-ingest these entries too (or supersede
 * the prior-year version).
 */

const SEED_DOCUMENTS = [
  // ── Standard deduction ─────────────────────────────────────────────────────
  {
    sourceKey:    'std-deduction-2024',
    sourceName:   'IRS — Standard Deduction (Tax Year 2024)',
    documentType: 'publication',
    url:          'https://www.irs.gov/publications/p17',
    jurisdiction: 'federal',
    taxYear:      2024,
    codeSection:  'IRC §63(c)',
    formNumber:   '1040 Line 12',
    topicTags:    ['standard_deduction', 'deductions', 'filing_status'],
    fullText: `Standard Deduction for Tax Year 2024.

The standard deduction reduces the income on which you are taxed. For tax year 2024 the basic standard deduction amounts by filing status are: Single $14,600; Married Filing Jointly $29,200; Married Filing Separately $14,600; Head of Household $21,900; Qualifying Surviving Spouse $29,200.

Taxpayers who are age 65 or older OR blind receive an additional standard deduction. For 2024 the additional amount is $1,950 for single and head-of-household filers, and $1,550 per qualifying condition for married filers. A taxpayer who is both 65+ and blind receives the additional amount twice.

You take either the standard deduction or your total itemized deductions (Schedule A), whichever is larger. Most taxpayers benefit from the standard deduction. You generally cannot take the standard deduction if you are married filing separately and your spouse itemizes.`,
  },
  {
    sourceKey:    'std-deduction-2025',
    sourceName:   'IRS — Standard Deduction (Tax Year 2025)',
    documentType: 'publication',
    url:          'https://www.irs.gov/publications/p17',
    jurisdiction: 'federal',
    taxYear:      2025,
    codeSection:  'IRC §63(c)',
    formNumber:   '1040 Line 12',
    topicTags:    ['standard_deduction', 'deductions', 'filing_status'],
    fullText: `Standard Deduction for Tax Year 2025.

For tax year 2025 the basic standard deduction amounts by filing status are: Single $15,000; Married Filing Jointly $30,000; Married Filing Separately $15,000; Head of Household $22,500; Qualifying Surviving Spouse $30,000.

The additional standard deduction for taxpayers age 65 or older or blind is $2,000 for single and head-of-household filers, and $1,600 per qualifying condition for married filers.

Choose the larger of the standard deduction or total itemized deductions. These amounts are adjusted annually for inflation.`,
  },

  // ── Home office deduction ──────────────────────────────────────────────────
  {
    sourceKey:    'home-office-deduction',
    sourceName:   'IRS Publication 587 — Business Use of Your Home',
    documentType: 'publication',
    url:          'https://www.irs.gov/publications/p587',
    jurisdiction: 'federal',
    taxYear:      null, // rules are stable across years
    codeSection:  'IRC §280A',
    formNumber:   'Form 8829',
    topicTags:    ['home_office', 'schedule_c', 'business_deduction', 'self_employment'],
    fullText: `Business Use of Your Home (Home Office Deduction).

To claim a home office deduction you must use part of your home regularly AND exclusively for your trade or business, and it must generally be your principal place of business. "Exclusive use" means the area is used only for business — a room used as both an office and a guest bedroom does not qualify. Regular use means you use the area for business on a continuing basis, not occasionally.

There are two methods to figure the deduction. The Simplified Method allows a deduction of $5 per square foot of the home used for business, up to a maximum of 300 square feet ($1,500 maximum). The Regular Method (Form 8829) deducts the actual expenses of the home office based on the percentage of the home used for business — including a share of mortgage interest or rent, utilities, insurance, repairs, and depreciation.

Employees who receive a W-2 generally CANNOT claim the home office deduction for tax years 2018 through 2025 because the Tax Cuts and Jobs Act suspended the miscellaneous itemized deduction for unreimbursed employee expenses. The deduction is primarily available to self-employed taxpayers reporting on Schedule C. The home office deduction generally cannot create or increase a business loss; amounts disallowed by the income limit may carry over.`,
  },

  // ── Rental income & expenses ───────────────────────────────────────────────
  {
    sourceKey:    'rental-income-expenses',
    sourceName:   'IRS Publication 527 — Residential Rental Property',
    documentType: 'publication',
    url:          'https://www.irs.gov/publications/p527',
    jurisdiction: 'federal',
    taxYear:      null,
    codeSection:  'IRC §469',
    formNumber:   'Schedule E',
    topicTags:    ['rental_income', 'schedule_e', 'depreciation', 'passive_activity'],
    fullText: `Residential Rental Property — Income and Expenses.

Rental income and expenses are reported on Schedule E. You must report all rental income, including advance rent and security deposits you keep. Deductible rental expenses include mortgage interest, property tax, operating expenses, repairs, insurance, management fees, and depreciation.

Repairs (which keep property in good operating condition, like fixing a leak or repainting) are deductible in the year incurred. Improvements (which add value or prolong the property's life, like a new roof or addition) must be capitalized and depreciated. Residential rental property is depreciated over 27.5 years using the straight-line method.

Rental real estate is generally a passive activity. Passive losses can usually only offset passive income. However, under the special $25,000 allowance, taxpayers who actively participate in rental real estate may deduct up to $25,000 of rental losses against non-passive income; this allowance phases out between $100,000 and $150,000 of modified adjusted gross income. Real estate professionals who meet material participation tests are not subject to the passive activity limits on their rental activities. Disallowed passive losses carry forward to future years.

When you sell rental property, depreciation you claimed (or could have claimed) is subject to depreciation recapture, generally taxed at a maximum rate of 25% (unrecaptured Section 1250 gain).`,
  },

  // ── Self-employment tax ────────────────────────────────────────────────────
  {
    sourceKey:    'self-employment-tax-2024',
    sourceName:   'IRS — Self-Employment Tax (Schedule SE, Tax Year 2024)',
    documentType: 'publication',
    url:          'https://www.irs.gov/businesses/small-businesses-self-employed/self-employment-tax-social-security-and-medicare-taxes',
    jurisdiction: 'federal',
    taxYear:      2024,
    codeSection:  'IRC §1401',
    formNumber:   'Schedule SE',
    topicTags:    ['self_employment', 'schedule_se', 'schedule_c', 'medicare', 'social_security'],
    fullText: `Self-Employment Tax for Tax Year 2024.

Self-employment (SE) tax is the Social Security and Medicare tax for individuals who work for themselves. The combined SE tax rate is 15.3%: 12.4% for Social Security plus 2.9% for Medicare.

You figure SE tax on Schedule SE. First multiply net self-employment earnings (net Schedule C profit) by 92.35% to get the SE tax base. The 12.4% Social Security portion applies only up to the annual Social Security wage base, which is $168,600 for 2024; earnings above that are not subject to the Social Security portion. The 2.9% Medicare portion applies to all net SE earnings with no cap.

You can deduct one-half of your SE tax as an above-the-line adjustment to income (Schedule 1), which reduces your adjusted gross income (but not the SE tax itself). You generally must pay SE tax and file Schedule SE if your net earnings from self-employment were $400 or more. Additional Medicare Tax of 0.9% applies to self-employment income above $200,000 (single) or $250,000 (married filing jointly).`,
  },

  // ── QBI deduction ──────────────────────────────────────────────────────────
  {
    sourceKey:    'qbi-deduction-2024',
    sourceName:   'IRS — Qualified Business Income Deduction (Tax Year 2024)',
    documentType: 'publication',
    url:          'https://www.irs.gov/newsroom/qualified-business-income-deduction',
    jurisdiction: 'federal',
    taxYear:      2024,
    codeSection:  'IRC §199A',
    formNumber:   'Form 8995 / 8995-A',
    topicTags:    ['qbi', 'section_199a', 'self_employment', 'pass_through', 'deductions'],
    fullText: `Qualified Business Income (QBI) Deduction — Section 199A, Tax Year 2024.

The QBI deduction allows eligible self-employed and pass-through business owners to deduct up to 20% of their qualified business income. It is taken on Form 8995 (simplified) or Form 8995-A. QBI generally includes net income from a sole proprietorship (Schedule C), partnership, S corporation, or qualifying rental activity, but excludes capital gains, dividends, and wage income.

For 2024, if your total taxable income is at or below $191,950 (single) or $383,900 (married filing jointly), you generally get the full 20% deduction using Form 8995. Above those thresholds, limitations phase in over the next $50,000 (single) / $100,000 (MFJ): the deduction becomes limited by the W-2 wages the business paid and the unadjusted basis of qualified property. For a Specified Service Trade or Business (SSTB) — such as health, law, accounting, consulting, or financial services — the deduction phases out completely once taxable income exceeds the top of the phase-out range ($241,950 single / $433,900 MFJ for 2024).

The overall QBI deduction cannot exceed 20% of taxable income minus net capital gains (including qualified dividends).`,
  },

  // ── Capital gains & qualified dividends ────────────────────────────────────
  {
    sourceKey:    'capital-gains-2024',
    sourceName:   'IRS — Capital Gains and Qualified Dividends (Tax Year 2024)',
    documentType: 'publication',
    url:          'https://www.irs.gov/taxtopics/tc409',
    jurisdiction: 'federal',
    taxYear:      2024,
    codeSection:  'IRC §1(h)',
    formNumber:   'Schedule D',
    topicTags:    ['capital_gains', 'qualified_dividends', 'schedule_d', 'investments', 'niit'],
    fullText: `Capital Gains and Qualified Dividends for Tax Year 2024.

A capital gain or loss is the difference between your basis (usually what you paid) and the amount you realize when you sell a capital asset. Holding period matters: assets held one year or less produce short-term capital gains, taxed at ordinary income rates. Assets held more than one year produce long-term capital gains, taxed at preferential rates of 0%, 15%, or 20%.

For 2024, the long-term capital gains rate is 0% if taxable income is at or below $47,025 (single) or $94,050 (married filing jointly); 15% up to $518,900 (single) or $583,750 (MFJ); and 20% above those amounts. Qualified dividends are taxed at the same preferential long-term capital gains rates. Long-term gains and qualified dividends "stack" on top of ordinary income when determining which rate bracket applies.

Higher-income taxpayers may also owe the Net Investment Income Tax (NIIT) of 3.8% on the lesser of net investment income or the amount by which modified AGI exceeds $200,000 (single) or $250,000 (married filing jointly). Capital losses offset capital gains; up to $3,000 of net capital loss ($1,500 if married filing separately) can offset ordinary income per year, with the remainder carried forward.`,
  },

  // ── Child Tax Credit ───────────────────────────────────────────────────────
  {
    sourceKey:    'child-tax-credit-2024',
    sourceName:   'IRS — Child Tax Credit (Tax Year 2024)',
    documentType: 'publication',
    url:          'https://www.irs.gov/credits-deductions/individuals/child-tax-credit',
    jurisdiction: 'federal',
    taxYear:      2024,
    codeSection:  'IRC §24',
    formNumber:   'Schedule 8812',
    topicTags:    ['child_tax_credit', 'credits', 'dependents'],
    fullText: `Child Tax Credit for Tax Year 2024.

The Child Tax Credit is worth up to $2,000 per qualifying child under age 17 at the end of the tax year. A qualifying child must have a valid Social Security number, be claimed as your dependent, and meet relationship, residency, and support tests. It is claimed on Schedule 8812.

The credit begins to phase out when modified adjusted gross income exceeds $400,000 (married filing jointly) or $200,000 (all other filers). The credit is reduced by $50 for each $1,000 (or fraction thereof) of income above the threshold.

Up to $1,700 per child of the Child Tax Credit is refundable for 2024 as the Additional Child Tax Credit (ACTC), meaning you can receive it even if it exceeds your tax liability. The refundable portion is generally limited to 15% of earned income above $2,500. A separate $500 nonrefundable Credit for Other Dependents is available for dependents who do not qualify for the Child Tax Credit.`,
  },

  // ── Estimated taxes & safe harbor ──────────────────────────────────────────
  {
    sourceKey:    'estimated-taxes-safe-harbor',
    sourceName:   'IRS — Estimated Taxes and Underpayment Penalty',
    documentType: 'publication',
    url:          'https://www.irs.gov/businesses/small-businesses-self-employed/estimated-taxes',
    jurisdiction: 'federal',
    taxYear:      null,
    codeSection:  'IRC §6654',
    formNumber:   'Form 1040-ES / Form 2210',
    topicTags:    ['estimated_taxes', 'safe_harbor', 'underpayment_penalty', 'self_employment'],
    fullText: `Estimated Taxes and the Underpayment Penalty.

The U.S. tax system is pay-as-you-go. If you do not have enough tax withheld from wages, you generally must make quarterly estimated tax payments using Form 1040-ES. This commonly applies to self-employed individuals, investors, and landlords. The 2024 quarterly due dates are April 15, June 17, September 16 (2024), and January 15, 2025.

You can avoid an underpayment penalty by meeting a safe harbor. Generally, you owe no penalty if you pay, through withholding and timely estimated payments, the smaller of: (1) 90% of the current year's tax, or (2) 100% of the prior year's total tax. If your prior-year adjusted gross income was more than $150,000 ($75,000 if married filing separately), the prior-year safe harbor rises to 110% of the prior year's tax.

There is also no penalty if the total tax owed after withholding is less than $1,000. The penalty is calculated on Form 2210 and is effectively interest on the underpaid amount for the period it was unpaid. Withholding is treated as paid evenly throughout the year, while estimated payments are credited when actually made — so increasing withholding late in the year can still cover earlier quarters.`,
  },
];

module.exports = { SEED_DOCUMENTS };
