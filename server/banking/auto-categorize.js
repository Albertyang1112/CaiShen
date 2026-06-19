'use strict';
/**
 * auto-categorize.js — best-effort mapping of a raw bank transaction to a leaf in the
 * hierarchical chart, so the reports show real depth without hand-sorting everything.
 *
 * Two modes, chosen by the per-account context (`ctx.business`):
 *   • PERSONAL (default)  → Personal Income / Personal Expenses leaves.
 *   • BUSINESS            → Business Revenue / Business Expenses leaves, and big
 *                           equipment/furniture buys are CAPITALIZED as Business →
 *                           Fixed Assets (so they land on the Balance Sheet, not the P&L).
 *
 * Precedence (caller applies): a transaction's own coaId (manual categorization) always
 * wins; this is only the fallback for un-categorized transactions.
 *
 * Strategy per transaction:
 *   1. Transfers / credit-card payments → null (excluded from the reports entirely).
 *   2. Business + expense + fixed-asset merchant + amount ≥ threshold → a Fixed Asset
 *      leaf with { capital:true } (balance-sheet item, flagged for review by the caller).
 *   3. Income (amount > 0)  → an income leaf by description, else an "Other Income" group.
 *   4. Expense (amount < 0) → a MERCHANT match (leaf-level), else the spending-bucket
 *      fallback (tx.category → leaf).
 *
 * Every target is a DEFAULT leaf/group (present in buildDefaultChart) so the amount always
 * lands on a node the report tree renders.
 */
const { idForPath } = require('../accounting/categories');

// Leaf-id helpers, one per top-level section.
const PE = (...names) => idForPath(['Personal Expenses', ...names]);
const PI = (...names) => idForPath(['Personal Income', ...names]);
const BE = (...names) => idForPath(['Business Expenses', ...names]);
const BR = (...names) => idForPath(['Business Revenue', ...names]);
const BA = (...names) => idForPath(['Business Assets', ...names]);

// ── Personal: description keyword → specific expense leaf. First match wins. ──
const MERCHANT_RULES = [
  [/\b(starbucks|dunkin|peet'?s|philz|blue bottle|caribou|coffee bean|tim hortons|coffee)\b/i, PE('Food & Dining', 'Coffee Shops')],
  [/\b(mcdonald|chipotle|taco bell|burger king|wendy'?s|subway|kfc|chick-?fil-?a|popeye|panera|five guys|in-?n-?out|domino|pizza hut|papa john|shake shack|raising cane|jack in the box|sonic|arby)\b/i, PE('Food & Dining', 'Fast Food')],
  [/\b(uber eats|ubereats|doordash|door dash|grubhub|postmates|seamless|caviar|instacart)\b/i, PE('Food & Dining', 'Food Delivery')],
  [/\b(whole foods|trader joe|safeway|kroger|ralphs|vons|albertson|publix|wegman|sprouts|aldi|food 4 less|h-?e-?b|giant eagle|stop & shop|grocery|supermarket)\b/i, PE('Food & Dining', 'Groceries')],
  [/\b(costco|sam'?s club|bj'?s wholesale)\b/i, PE('Food & Dining', 'Groceries')],
  [/\b(liquor|winery|brewery|cocktail|spirits|bevmo|total wine|tavern|pub\b|bar &)\b/i, PE('Food & Dining', 'Alcohol & Bars')],
  [/\b(restaurant|grill|kitchen|bistro|cafe|café|diner|steakhouse|sushi|thai|ramen|cantina|eatery|noodle|bbq|taqueria|trattoria|osteria)\b/i, PE('Food & Dining', 'Restaurants')],

  [/\b(shell|chevron|exxon|mobil|arco|valero|texaco|circle k|conoco|phillips 66|sunoco|marathon|speedway|fuel|gas station|\bbp\b|\b76\b)\b/i, PE('Transportation', 'Gas & Fuel')],
  [/\b(uber|lyft)\b/i, PE('Transportation', 'Rideshare')],
  [/\b(parking|parkwhiz|spothero|paybyphone|laz parking|impark)\b/i, PE('Transportation', 'Parking')],
  [/\b(metro|transit|mta|bart|caltrain|amtrak|subway fare|toll|fastrak|e-?zpass)\b/i, PE('Transportation', 'Public Transit')],

  [/\b(netflix|hulu|disney\+?|hbo|max\.com|spotify|apple music|youtube premium|paramount|peacock|prime video)\b/i, PE('Entertainment', 'Streaming Services')],
  [/\b(steam|playstation|xbox|nintendo|epic games|riot games|twitch)\b/i, PE('Entertainment', 'Games')],
  [/\b(amc|cinemark|regal|movie|fandango|ticketmaster|stubhub|live nation)\b/i, PE('Entertainment', 'Movies & Events')],

  [/\b(amazon|amzn|walmart|target|ebay|etsy|aliexpress|temu|shein)\b/i, PE('Shopping', 'General Shopping')],
  [/\b(apple store|apple\.com|best buy|microsoft|newegg|micro center|gamestop|b&h photo)\b/i, PE('Shopping', 'Electronics')],

  [/\b(equinox|planet fitness|24 hour fitness|la fitness|lifetime fitness|gym|crossfit|orangetheory|peloton|barry'?s|soulcycle|pure barre)\b/i, PE('Personal Care', 'Gym & Fitness')],
  [/\b(sephora|ulta|salon|barber|haircut|nail|spa\b)\b/i, PE('Personal Care', 'Haircuts & Salon')],
  [/\b(nike|adidas|lululemon|h&m|zara|uniqlo|gap\b|old navy|nordstrom|macy'?s|forever 21|clothing|apparel|footlocker)\b/i, PE('Personal Care', 'Clothing')],

  [/\b(cvs|walgreens|rite aid|pharmacy|goodrx)\b/i, PE('Health & Medical', 'Pharmacy & Medicine')],
  [/\b(dental|dentist|orthodont)\b/i, PE('Health & Medical', 'Dentist')],
  [/\b(hospital|clinic|medical|physician|urgent care|kaiser|cvs minute)\b/i, PE('Health & Medical', 'Doctor')],

  [/\b(at&t|verizon|t-?mobile|sprint|mint mobile|cricket|boost mobile|google fi)\b/i, PE('Utilities', 'Mobile Phone')],
  [/\b(comcast|xfinity|spectrum|cox communications|centurylink|fios|frontier|internet)\b/i, PE('Utilities', 'Internet')],
  [/\b(pg&e|edison|duke energy|con ?ed|national grid|dominion|electric|power company|utility)\b/i, PE('Utilities', 'Electricity')],
  [/\b(water dept|water district|aqua|municipal water|water utility)\b/i, PE('Utilities', 'Water')],

  [/\b(adobe|notion|dropbox|icloud|google one|microsoft 365|github|openai|chatgpt|canva|figma|1password|nordvpn|patreon)\b/i, PE('Subscriptions & Memberships', 'Software & App Subscriptions')],

  [/\b(delta|united air|american air|southwest|jetblue|alaska air|spirit air|frontier air|airlines?|flight)\b/i, PE('Travel', 'Flights')],
  [/\b(marriott|hilton|hyatt|airbnb|booking\.com|expedia|hotels?\.com|motel|inn\b|resort)\b/i, PE('Travel', 'Hotels')],

  [/\b(home depot|lowe'?s|ace hardware|harbor freight|hardware)\b/i, PE('Household & Supplies', 'Tools & Hardware')],
  [/\b(ikea|wayfair|home goods|bed bath|williams.?sonoma|crate & barrel|west elm)\b/i, PE('Household & Supplies', 'Home Appliances')],
];

// Personal income description → income leaf (or the "Other Income" group as a catch-all).
const INCOME_RULES = [
  [/\b(payroll|direct dep|direct deposit|salary|adp|gusto|paychex|wages|biweekly)\b/i, PI('Employment', 'Salary & Wages')],
  [/\binterest\b/i, PI('Investment Income', 'Interest')],
  [/\bdividend/i, PI('Investment Income', 'Dividends')],
  [/\b(rent|rental|tenant)\b/i, PI('Rental & Property Income', 'Rental Income')],
  [/\b(refund|rebate|return)\b/i, PI('Other Income', 'Refunds')],
  [/\b(cash ?back|rewards|redemption|points)\b/i, PI('Other Income', 'Cashback & Rewards')],
  [/\b(tax ref|irs treas|tax refund|state refund)\b/i, PI('Other Income', 'Tax Refund')],
];
const INCOME_FALLBACK  = PI('Other Income');                 // the group, as a catch-all
const EXPENSE_FALLBACK = PE('Miscellaneous', 'Other / Uncategorized');

// CaiShen spending bucket (tx.category) → default personal expense leaf, when no merchant matched.
const BUCKET_MAP = {
  Dining:        PE('Food & Dining', 'Restaurants'),
  Coffee:        PE('Food & Dining', 'Coffee Shops'),
  Groceries:     PE('Food & Dining', 'Groceries'),
  Shopping:      PE('Shopping', 'General Shopping'),
  Tech:          PE('Shopping', 'Electronics'),
  Transport:     PE('Transportation', 'Gas & Fuel'),
  Travel:        PE('Travel', 'Flights'),
  Entertainment: PE('Entertainment', 'Entertainment'),
  Fitness:       PE('Personal Care', 'Gym & Fitness'),
  Health:        PE('Health & Medical', 'Doctor'),
  Subscriptions: PE('Subscriptions & Memberships', 'Software & App Subscriptions'),
  Utilities:     PE('Utilities', 'Electricity'),
  Other:         EXPENSE_FALLBACK,
};

// ── Business: description keyword → business expense leaf (rental-property oriented). ──
const BUSINESS_MERCHANT = [
  [/\b(plumb|roto-?rooter|drain)\b/i,                                    BE('Repair & Maintenance', 'Plumbing')],
  [/\b(hvac|air conditioning|furnace|heating & air|a\/c repair)\b/i,     BE('Repair & Maintenance', 'HVAC')],
  [/\b(electrician|electrical svc|electrical service|rewiring)\b/i,      BE('Repair & Maintenance', 'Electrical')],
  [/\b(cleaning|janitor|maid|molly maid|merry maids|housekeep)\b/i,      BE('Repair & Maintenance', 'Cleaning')],
  [/\b(home depot|lowe'?s|ace hardware|harbor freight|menards|true value|hardware)\b/i, BE('Repair & Maintenance', 'General Repairs & Maintenance')],
  [/\b(landscap|lawn|gardener|tree service|pest control|terminix|orkin|exterminat)\b/i, BE('Repair & Maintenance', 'General Repairs & Maintenance')],

  [/\b(property manage|propertymanage|appfolio|buildium|cozy|rentec)\b/i, BE('Rent & Facilities', 'Property Management Fees')],
  [/\b(pg&e|edison|duke energy|con ?ed|national grid|dominion|electric|power company|water dept|water district|sewer|utility|comcast|xfinity|spectrum|internet)\b/i, BE('Rent & Facilities', 'Utilities')],
  [/\b(hoa|home ?owners assoc|association dues)\b/i,                     BE('Rent & Facilities', 'Office Rent')],

  [/\b(state farm|allstate|farmers ins|liberty mutual|geico|nationwide|insurance)\b/i, BE('Insurance', 'Property Insurance')],
  [/\b(accountant|cpa|bookkeep|quickbooks|turbotax|tax prep)\b/i,        BE('Legal & Professional Fees', 'Accounting Fees')],
  [/\b(attorney|law firm|legal|lawyer|eviction)\b/i,                    BE('Legal & Professional Fees', 'Legal Fees')],
  [/\b(county tax|property tax|tax collector|assessor)\b/i,             BE('Taxes & Licenses', 'Property Tax')],

  [/\b(staples|office depot|officemax|ups store|fedex office)\b/i,       BE('Office / Administrative', 'Office Supplies')],
  [/\b(adobe|notion|dropbox|google one|microsoft 365|github|canva|figma|1password|zoom|docusign)\b/i, BE('Software & Technology', 'Software Subscriptions')],
  [/\b(zillow|apartments\.com|avail|rently|listing)\b/i,                BE('Marketing & Advertising', 'Online Ads')],

  [/\b(ikea|wayfair|home goods|bed bath|crate & barrel|west elm|ashley|furniture|mattress)\b/i, BE('Supplies', 'Home Appliances')],
  [/\b(amazon|amzn|walmart|target|costco)\b/i,                          BE('Supplies', 'General Supplies')],
  [/\b(shell|chevron|exxon|mobil|arco|valero|fuel|gas station)\b/i,      BE('Vehicle', 'Fuel')],
];

// Business spending bucket (tx.category) → business expense leaf, when no merchant matched.
const BUSINESS_BUCKET_MAP = {
  Utilities:     BE('Rent & Facilities', 'Utilities'),
  Shopping:      BE('Supplies', 'General Supplies'),
  Tech:          BE('Software & Technology', 'Software Subscriptions'),
  Subscriptions: BE('Software & Technology', 'Software Subscriptions'),
  Transport:     BE('Vehicle', 'Fuel'),
  Travel:        BE('Travel & Meals', 'Business Travel'),
  Dining:        BE('Travel & Meals', 'Client Meals'),
  Other:         BE('Miscellaneous', 'Other / Uncategorized'),
};
const BUSINESS_EXPENSE_FALLBACK = BE('Repair & Maintenance', 'General Repairs & Maintenance');

// Business income description → revenue leaf.
const BUSINESS_INCOME_RULES = [
  [/\b(rent|rental|tenant|lease)\b/i,     BR('Rental / Real Estate Revenue', 'Rent Income')],
  [/\b(late fee)\b/i,                     BR('Rental / Real Estate Revenue', 'Late Fees')],
  [/\b(application fee|app fee)\b/i,       BR('Rental / Real Estate Revenue', 'Application Fees')],
  [/\binterest\b/i,                       BR('Other Business Income', 'Interest Income')],
];
const BUSINESS_INCOME_FALLBACK = BR('Other Business Income', 'Other Income');

// ── Fixed-asset capitalization (business only) ──
// A big-ticket equipment/furniture/appliance/electronics buy on a business account is a
// capital asset, not an expense. Above the threshold + a merchant match → a Fixed Asset leaf.
const FA_EQUIPMENT  = BA('Fixed Assets', 'Equipment');
const FA_COMPUTERS  = BA('Fixed Assets', 'Computers & Electronics');
const FA_FURNITURE  = BA('Fixed Assets', 'Furniture & Fixtures');
const FA_APPLIANCES = BA('Fixed Assets', 'Appliances');
const FIXED_ASSET_MERCHANTS = [
  [/\b(ikea|wayfair|ashley|west elm|pottery barn|crate & barrel|la-?z-?boy|herman miller|steelcase|furniture|mattress|sectional|desk|sofa)\b/i, FA_FURNITURE],
  [/\b(best buy|apple store|apple\.com|dell|hp\.com|lenovo|microsoft store|newegg|micro center|b&h photo|samsung|tv\b|television|monitor|laptop|computer)\b/i, FA_COMPUTERS],
  [/\b(whirlpool|ge appliance|lg electronics|frigidaire|maytag|bosch|kitchenaid|appliance|refrigerator|washer|dryer|dishwasher|water heater|hvac unit|furnace)\b/i, FA_APPLIANCES],
  [/\b(home depot|lowe'?s|harbor freight|grainger|northern tool|milwaukee|dewalt|makita|equipment|machinery|generator|mower)\b/i, FA_EQUIPMENT],
];
// IRS de-minimis safe-harbor amount; adjustable. Business expense ≥ this at a fixed-asset
// merchant is capitalized rather than expensed.
const FIXED_ASSET_THRESHOLD = 2500;

// True for transfers / card payments that should never appear on a report.
function isTransfer(tx) {
  if ((tx.category || '').toLowerCase() === 'transfer') return true;
  const d = (tx.desc || '').toLowerCase();
  return /\b(transfer|payment thank you|autopay|online payment|card payment|bill pay|zelle|venmo cashout|withdrawal)\b/.test(d)
    && !/purchase|pos /.test(d);
}

// Heuristic seed: does this account look like a business account by name/subtype?
// Used as the DEFAULT when the user hasn't explicitly toggled the account (override).
function isLikelyBusiness(account) {
  if (!account) return false;
  const hay = `${account.name || ''} ${account.officialName || ''} ${account.subtype || ''} ${account.type || ''}`.toLowerCase();
  return /\b(business|commercial|llc|l\.l\.c|llp|inc\b|incorporated|corp|company|biz)\b/.test(hay);
}

/**
 * Resolve the business context for a transaction from the per-account settings map
 * ({ [accountId]: { business, propertyId } }) and an optional id→account map (for the
 * auto-detect seed). Explicit setting wins; otherwise fall back to the name heuristic.
 */
function resolveCtx(tx, settings = {}, accountsById = null) {
  const acctId  = tx && tx.account;
  const setting = acctId && settings ? settings[acctId] : null;
  const acct    = acctId && accountsById ? accountsById.get(acctId) : null;
  const business = (setting && typeof setting.business === 'boolean')
    ? setting.business
    : isLikelyBusiness(acct);
  return { business, propertyId: (setting && setting.propertyId) || (tx && tx.propertyId) || null };
}

/**
 * Fixed-asset leaf id for a business expense that should be capitalized, or null.
 * Business + expense + ≥ threshold + a fixed-asset merchant match.
 */
function fixedAssetGuess(tx, ctx = {}) {
  if (!ctx.business) return null;
  if (!tx || typeof tx.amount !== 'number' || tx.amount >= 0) return null;   // expense only
  if (Math.abs(tx.amount) < FIXED_ASSET_THRESHOLD) return null;
  const desc = tx.desc || '';
  for (const [rx, id] of FIXED_ASSET_MERCHANTS) if (rx.test(desc)) return id;
  return null;
}

/**
 * Best category leaf id for a transaction, or null to exclude it (transfers).
 * ctx.business switches between the personal and business rule sets.
 * Does NOT consult tx.coaId — the caller layers that on top.
 */
function autoCoaId(tx, ctx = {}) {
  if (!tx || typeof tx.amount !== 'number' || tx.amount === 0) return null;
  if (isTransfer(tx)) return null;
  const desc = tx.desc || '';

  if (ctx.business) {
    if (tx.amount > 0) {
      for (const [rx, id] of BUSINESS_INCOME_RULES) if (rx.test(desc)) return id;
      return BUSINESS_INCOME_FALLBACK;
    }
    for (const [rx, id] of BUSINESS_MERCHANT) if (rx.test(desc)) return id;
    return BUSINESS_BUCKET_MAP[tx.category] || BUSINESS_EXPENSE_FALLBACK;
  }

  if (tx.amount > 0) {
    for (const [rx, id] of INCOME_RULES) if (rx.test(desc)) return id;
    return INCOME_FALLBACK;
  }
  for (const [rx, id] of MERCHANT_RULES) if (rx.test(desc)) return id;
  return BUCKET_MAP[tx.category] || EXPENSE_FALLBACK;
}

/**
 * One-shot guess that callers use: returns { coaId, capital } or null.
 * capital:true means it's a Balance-Sheet fixed asset (not a P&L expense).
 */
function guessCategory(tx, ctx = {}) {
  if (!tx || typeof tx.amount !== 'number' || tx.amount === 0) return null;
  if (isTransfer(tx)) return null;
  const fa = fixedAssetGuess(tx, ctx);
  if (fa) return { coaId: fa, capital: true };
  const coaId = autoCoaId(tx, ctx);
  return coaId ? { coaId, capital: false } : null;
}

module.exports = {
  autoCoaId, guessCategory, fixedAssetGuess, isTransfer, isLikelyBusiness, resolveCtx,
  MERCHANT_RULES, BUCKET_MAP, FIXED_ASSET_THRESHOLD,
};
