'use strict';
/**
 * categories.js — hierarchical category seed for the Chart of Accounts.
 *
 * ONE combined chart. Every node carries:
 *   type  ∈ asset | liability | equity | income | expense   (decides BS vs P&L)
 *   scope ∈ personal | business                              (sections the reports)
 * both inherited from the node's top-level SECTION. Nesting is unlimited; a leaf the
 * user adds later (e.g. "Chipotle" under Food & Dining → Fast Food) is just another
 * node whose parentId points at "Fast Food".
 *
 * Two derived sets come out of one master tree:
 *   buildDefaultChart()      → the everyday/visible nodes, seeded on first access.
 *   categoryLibrary(have)    → the long-tail nodes the user can pull in later.
 * `lib:true` on a node marks it (and its whole subtree) as library-only.
 *
 * CURATION RULE: a category is DEFAULT only if a typical person/household spends on
 * it regularly (food, rent, utilities, gas, medicine, clothing, appliances…). It is
 * SITUATIONAL (lib) when it depends on a specific asset, lifestyle, or circumstance
 * not everyone has (snow removal, pool, gardening, pets, kids, hobbies, boats, niche
 * business lines). Whole groups that only some people need (Pets, Children & Family)
 * are lib groups — adding any leaf pulls the group in too.
 *
 * Ids are deterministic slugs of the name path, so seeding / adding-from-library is
 * idempotent (re-running never duplicates a node).
 */

function seg(s) {
  return String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function slug(names) { return 'cat_' + names.map(seg).join('__'); }

// Ten parentId=null roots, each with a fixed type + scope. Children nest
// group → category → leaf. `lib:true` = library-only (not seeded by default).
const SECTIONS = [
  // ═══════════════════════════ PERSONAL · INCOME ═══════════════════════════
  { name: 'Personal Income', type: 'income', scope: 'personal', children: [
    { name: 'Employment', children: [
      { name: 'Salary & Wages' }, { name: 'Bonus' }, { name: 'Commission' }, { name: 'Tips' }, { name: 'Reimbursements' },
      { name: 'Overtime', lib: true }, { name: 'Severance Pay', lib: true }, { name: 'Stipends', lib: true }, { name: 'Per Diem', lib: true }, { name: 'Paid Time Off', lib: true },
    ]},
    { name: 'Self-Employment & Side Income', children: [
      { name: 'Freelance / Contract' }, { name: 'Consulting' }, { name: 'Gig Work' }, { name: 'Reselling' },
      { name: 'Tutoring', lib: true }, { name: 'Coaching', lib: true }, { name: 'Royalties', lib: true }, { name: 'Affiliate / Ad Income', lib: true },
    ]},
    { name: 'Investment Income', children: [
      { name: 'Dividends' }, { name: 'Interest' }, { name: 'Capital Gains' }, { name: 'Crypto Gains' },
      { name: 'Bond Interest', lib: true }, { name: 'P2P Lending', lib: true }, { name: 'Royalty Income', lib: true },
    ]},
    { name: 'Rental & Property Income', children: [
      { name: 'Rental Income' }, { name: 'Late Fees' },
      { name: 'Airbnb / Short-Term', lib: true }, { name: 'Parking Income', lib: true }, { name: 'Laundry Income', lib: true }, { name: 'Pet Fees', lib: true }, { name: 'Utility Reimbursement', lib: true },
    ]},
    { name: 'Other Income', children: [
      { name: 'Tax Refund' }, { name: 'Cashback & Rewards' }, { name: 'Gifts Received' }, { name: 'Refunds' },
      { name: 'Gambling Winnings', lib: true }, { name: 'Inheritance', lib: true }, { name: 'Jury Duty', lib: true }, { name: 'Crowdfunding', lib: true },
      { name: 'Government Benefits', lib: true }, { name: 'Child Support Received', lib: true }, { name: 'Alimony Received', lib: true },
    ]},
  ]},

  // ═══════════════════════════ PERSONAL · EXPENSES ═══════════════════════════
  { name: 'Personal Expenses', type: 'expense', scope: 'personal', children: [
    { name: 'Housing', children: [
      { name: 'Rent' }, { name: 'Mortgage Interest' }, { name: 'Property Tax' }, { name: 'Home Insurance' }, { name: 'HOA Fees' },
      { name: 'Home Repairs' }, { name: 'Home Maintenance' }, { name: 'Furniture' }, { name: 'Home Decor' },
      { name: 'Pest Control', lib: true }, { name: 'Snow Removal', lib: true }, { name: 'Lawn Care', lib: true }, { name: 'Landscaping', lib: true },
      { name: 'Pool Maintenance', lib: true }, { name: 'Cleaning Service', lib: true }, { name: 'Security System', lib: true },
      { name: 'Storage Unit', lib: true }, { name: 'Moving Expenses', lib: true }, { name: 'Home Warranty', lib: true },
    ]},
    { name: 'Utilities', children: [
      { name: 'Electricity' }, { name: 'Gas' }, { name: 'Water' }, { name: 'Internet' }, { name: 'Mobile Phone' }, { name: 'Trash & Recycling' },
      { name: 'Sewer', lib: true }, { name: 'Cable TV', lib: true }, { name: 'Landline', lib: true }, { name: 'Propane', lib: true }, { name: 'Heating Oil', lib: true }, { name: 'Solar', lib: true },
    ]},
    { name: 'Food & Dining', children: [
      { name: 'Groceries' }, { name: 'Restaurants' }, { name: 'Fast Food' }, { name: 'Coffee Shops' }, { name: 'Food Delivery' }, { name: 'Drinks & Beverages' }, { name: 'Alcohol & Bars' },
      { name: 'Meal Kits', lib: true }, { name: 'Tea & Specialty Drinks', lib: true }, { name: 'Snacks', lib: true }, { name: 'Work Lunches', lib: true },
    ]},
    { name: 'Transportation', children: [
      { name: 'Gas & Fuel' }, { name: 'Car Insurance' }, { name: 'Car Repairs' }, { name: 'Car Maintenance' }, { name: 'Parking' }, { name: 'Tolls' }, { name: 'Public Transit' }, { name: 'Rideshare' }, { name: 'Registration & Fees' },
      { name: 'EV Charging', lib: true }, { name: 'Car Wash', lib: true }, { name: 'Roadside Assistance', lib: true }, { name: 'Rental Car', lib: true }, { name: 'Auto Loan Interest', lib: true }, { name: 'Taxi', lib: true },
    ]},
    { name: 'Health & Medical', children: [
      { name: 'Doctor' }, { name: 'Dentist' }, { name: 'Pharmacy & Medicine' }, { name: 'Health Insurance' }, { name: 'Vision' }, { name: 'Mental Health / Therapy' },
      { name: 'Urgent Care', lib: true }, { name: 'Hospital', lib: true }, { name: 'Specialist', lib: true }, { name: 'Lab Tests', lib: true }, { name: 'Chiropractic', lib: true },
      { name: 'Medical Equipment', lib: true }, { name: 'Vitamins & Supplements', lib: true },
    ]},
    { name: 'Personal Care', children: [
      { name: 'Haircuts & Salon' }, { name: 'Clothing' }, { name: 'Shoes' }, { name: 'Toiletries & Cosmetics' }, { name: 'Gym & Fitness' }, { name: 'Laundry & Dry Cleaning' },
      { name: 'Spa & Massage', lib: true }, { name: 'Nails', lib: true }, { name: 'Personal Trainer', lib: true }, { name: 'Skincare', lib: true },
    ]},
    { name: 'Household & Supplies', children: [
      { name: 'Household Supplies' }, { name: 'Home Appliances' }, { name: 'Cleaning Supplies' }, { name: 'Kitchen Supplies' }, { name: 'General Supplies' }, { name: 'Tools & Hardware' },
      { name: 'Gardening Supplies', lib: true }, { name: 'Seasonal & Holiday Decor', lib: true }, { name: 'Accessories & Small Gadgets', lib: true },
    ]},
    { name: 'Shopping', children: [
      { name: 'General Shopping' }, { name: 'Electronics' }, { name: 'Home Goods' }, { name: 'Books' },
      { name: 'Hobbies', lib: true }, { name: 'Sporting Goods', lib: true }, { name: 'Jewelry & Accessories', lib: true },
    ]},
    { name: 'Entertainment', children: [
      { name: 'Streaming Services' }, { name: 'Movies & Events' }, { name: 'Games' }, { name: 'Music' }, { name: 'Entertainment' },
      { name: 'Concerts', lib: true }, { name: 'Sports Events', lib: true }, { name: 'Amusement Parks', lib: true }, { name: 'Nightlife', lib: true },
      { name: 'Dance Classes', lib: true }, { name: 'Music Lessons', lib: true }, { name: 'Books & Magazines', lib: true },
    ]},
    { name: 'Subscriptions & Memberships', children: [
      { name: 'Software & App Subscriptions' }, { name: 'Streaming Subscriptions' }, { name: 'Memberships' }, { name: 'Cloud Storage' },
      { name: 'News Subscriptions', lib: true }, { name: 'Professional Memberships', lib: true }, { name: 'Subscription Boxes', lib: true },
    ]},
    { name: 'Insurance', children: [
      { name: 'Life Insurance' }, { name: 'Disability Insurance' },
      { name: 'Umbrella Insurance', lib: true }, { name: 'Pet Insurance', lib: true }, { name: 'Travel Insurance', lib: true }, { name: 'Long-Term Care', lib: true },
    ]},
    { name: 'Education', children: [
      { name: 'Tuition' }, { name: 'Books & Supplies' }, { name: 'Online Courses' }, { name: 'Student Loan Interest' },
      { name: 'Certifications', lib: true }, { name: 'Exam Fees', lib: true }, { name: 'Tutoring', lib: true }, { name: 'School Fees', lib: true },
    ]},
    { name: 'Travel', children: [
      { name: 'Flights' }, { name: 'Hotels' }, { name: 'Rental Cars' }, { name: 'Travel Meals' }, { name: 'Vacation Activities' },
      { name: 'Cruises', lib: true }, { name: 'Souvenirs', lib: true }, { name: 'Baggage Fees', lib: true }, { name: 'Travel Insurance', lib: true }, { name: 'Visa & Passport', lib: true },
    ]},
    { name: 'Gifts & Donations', children: [
      { name: 'Gifts' }, { name: 'Charitable Donations' },
      { name: 'Religious Giving', lib: true }, { name: 'Tips & Gratuity', lib: true }, { name: 'Family Support', lib: true },
    ]},
    { name: 'Taxes', children: [
      { name: 'Federal Income Tax' }, { name: 'State Income Tax' }, { name: 'Tax Prep Fees' },
      { name: 'Self-Employment Tax', lib: true }, { name: 'Vehicle Tax', lib: true }, { name: 'Tax Penalties', lib: true }, { name: 'Estimated Taxes', lib: true },
    ]},
    { name: 'Financial & Fees', children: [
      { name: 'Bank Fees' }, { name: 'ATM Fees' }, { name: 'Credit Card Interest' }, { name: 'Loan Interest' },
      { name: 'Wire Fees', lib: true }, { name: 'Foreign Transaction Fees', lib: true }, { name: 'Investment & Advisory Fees', lib: true }, { name: 'Late Fees', lib: true }, { name: 'Overdraft Fees', lib: true },
    ]},
    // Whole-group situational: only pulled in if the person has kids / pets.
    { name: 'Children & Family', lib: true, children: [
      { name: 'Childcare' }, { name: 'Kids Activities' }, { name: 'School Supplies' }, { name: 'Kids Clothing' }, { name: 'Toys' },
      { name: 'Diapers & Formula' }, { name: 'Babysitting' }, { name: 'Child Support Paid' }, { name: 'Allowance' }, { name: 'Elder Care' },
    ]},
    { name: 'Pets', lib: true, children: [
      { name: 'Pet Food' }, { name: 'Vet' }, { name: 'Pet Supplies' }, { name: 'Grooming' }, { name: 'Boarding' }, { name: 'Pet Insurance' }, { name: 'Pet Medication' }, { name: 'Pet Training' },
    ]},
    { name: 'Miscellaneous', children: [
      { name: 'Other / Uncategorized' },
      { name: 'Fines & Tickets', lib: true }, { name: 'Legal Fees', lib: true }, { name: 'Postage & Shipping', lib: true }, { name: 'Cash Withdrawal', lib: true },
    ]},
  ]},

  // ═══════════════════════════ BUSINESS · REVENUE ═══════════════════════════
  { name: 'Business Revenue', type: 'income', scope: 'business', children: [
    { name: 'Sales Revenue', children: [
      { name: 'Product Sales' }, { name: 'Service Sales' },
      { name: 'Wholesale Sales', lib: true }, { name: 'Online Sales', lib: true }, { name: 'Subscription Sales', lib: true },
    ]},
    { name: 'Service Revenue', children: [
      { name: 'Consulting Fees' }, { name: 'Professional Services' }, { name: 'Labor & Installation' },
      { name: 'Repair Revenue', lib: true }, { name: 'Maintenance Contracts', lib: true },
    ]},
    { name: 'Rental / Real Estate Revenue', children: [
      { name: 'Rent Income' }, { name: 'Late Fees' }, { name: 'Application Fees' },
      { name: 'Cleaning Fees', lib: true }, { name: 'Parking Income', lib: true }, { name: 'Pet Fees', lib: true },
    ]},
    { name: 'Other Business Income', children: [
      { name: 'Interest Income' }, { name: 'Other Income' },
      { name: 'Grant Income', lib: true }, { name: 'Affiliate Income', lib: true }, { name: 'Ad Revenue', lib: true },
    ]},
    { name: 'Contra-Revenue', children: [
      { name: 'Refunds & Returns' }, { name: 'Discounts' }, { name: 'Chargebacks', lib: true },
    ]},
  ]},

  // ═══════════════════════════ BUSINESS · EXPENSES ═══════════════════════════
  { name: 'Business Expenses', type: 'expense', scope: 'business', children: [
    { name: 'Cost of Goods Sold', children: [
      { name: 'Inventory / Materials' }, { name: 'Direct Labor' }, { name: 'Subcontractors' }, { name: 'Shipping Supplies' },
      { name: 'Freight-In', lib: true }, { name: 'Packaging', lib: true }, { name: 'Fulfillment Fees', lib: true },
    ]},
    { name: 'Payroll & Labor', children: [
      { name: 'Wages & Salaries' }, { name: 'Payroll Taxes' }, { name: 'Employee Benefits' },
      { name: 'Bonuses', lib: true }, { name: 'Workers Comp', lib: true }, { name: 'Retirement Match', lib: true }, { name: 'Recruiting', lib: true }, { name: 'Payroll Processing', lib: true },
    ]},
    { name: 'Legal & Professional Fees', children: [
      { name: 'Accounting Fees' }, { name: 'Bookkeeper' }, { name: 'Legal Fees' }, { name: 'Consultants' },
      { name: 'Background Check Fee', lib: true }, { name: 'Tax Preparation', lib: true }, { name: 'Registered Agent', lib: true }, { name: 'Virtual Assistants', lib: true },
    ]},
    { name: 'Office / Administrative', children: [
      { name: 'Office Supplies' }, { name: 'Advertising & Marketing' }, { name: 'Education & Training' }, { name: 'Subscriptions - Software & Apps' }, { name: 'Postage & Shipping' }, { name: 'Bank Fees' },
      { name: 'Printing', lib: true }, { name: 'Notary', lib: true }, { name: 'Dues & Memberships', lib: true },
    ]},
    { name: 'Software & Technology', children: [
      { name: 'Software Subscriptions' }, { name: 'Hosting & Cloud' }, { name: 'Domains' },
      { name: 'AI Tools', lib: true }, { name: 'Cybersecurity', lib: true }, { name: 'IT Support', lib: true }, { name: 'Hardware', lib: true },
    ]},
    { name: 'Marketing & Advertising', children: [
      { name: 'Online Ads' }, { name: 'Content & Design' }, { name: 'Email Marketing' },
      { name: 'Print Advertising', lib: true }, { name: 'Sponsorships', lib: true }, { name: 'Influencer Marketing', lib: true }, { name: 'Trade Shows', lib: true },
    ]},
    { name: 'Rent & Facilities', children: [
      { name: 'Office Rent' }, { name: 'Utilities' }, { name: 'Property Management Fees' },
      { name: 'Coworking Space', lib: true }, { name: 'Storage', lib: true }, { name: 'Janitorial', lib: true },
    ]},
    { name: 'Repair & Maintenance', children: [
      { name: 'Cleaning' }, { name: 'General Repairs & Maintenance' }, { name: 'Accessories & Small Gadgets' }, { name: 'HVAC' }, { name: 'Plumbing' }, { name: 'Electrical' },
      { name: 'Garage Repairs', lib: true }, { name: 'Gardener', lib: true }, { name: 'Pool Maintenance', lib: true }, { name: 'Pest Control', lib: true }, { name: 'Roofing', lib: true },
    ]},
    { name: 'Supplies', children: [
      { name: 'General Supplies' }, { name: 'Home Appliances' }, { name: 'Household Supplies' }, { name: 'Kitchen Supplies' },
      { name: 'Gardening Supplies', lib: true }, { name: 'Safety Supplies', lib: true },
    ]},
    { name: 'Travel & Meals', children: [
      { name: 'Business Travel' }, { name: 'Client Meals' }, { name: 'Lodging' },
      { name: 'Conference Travel', lib: true }, { name: 'Team Meals', lib: true },
    ]},
    { name: 'Vehicle', children: [
      { name: 'Fuel' }, { name: 'Repairs & Maintenance' }, { name: 'Insurance' }, { name: 'Registration' },
      { name: 'Lease Payments', lib: true }, { name: 'Mileage', lib: true },
    ]},
    { name: 'Insurance', children: [
      { name: 'General Liability' }, { name: 'Property Insurance' },
      { name: 'Professional Liability', lib: true }, { name: 'Commercial Auto', lib: true }, { name: 'Workers Comp', lib: true }, { name: 'Cyber Liability', lib: true },
    ]},
    { name: 'Taxes & Licenses', children: [
      { name: 'Business License' }, { name: 'Permits' }, { name: 'Property Tax' },
      { name: 'Franchise Tax', lib: true }, { name: 'Sales Tax', lib: true }, { name: 'Annual Report Fees', lib: true },
    ]},
    { name: 'Bank & Merchant Fees', children: [
      { name: 'Bank Service Fees' }, { name: 'Payment Processing' }, { name: 'Loan Interest' },
      { name: 'Stripe Fees', lib: true }, { name: 'PayPal Fees', lib: true }, { name: 'Wire Fees', lib: true },
    ]},
    { name: 'Depreciation & Amortization', children: [
      { name: 'Depreciation' }, { name: 'Amortization', lib: true },
    ]},
    { name: 'Miscellaneous', children: [
      { name: 'Other / Uncategorized' },
      { name: 'Donations', lib: true }, { name: 'Fines & Penalties', lib: true }, { name: 'Bad Debt', lib: true },
    ]},
  ]},

  // ═══════════════════════════ BALANCE SHEET ═══════════════════════════
  { name: 'Personal Assets', type: 'asset', scope: 'personal', children: [
    { name: 'Cash & Bank Accounts', children: [
      { name: 'Checking' }, { name: 'Savings' }, { name: 'Cash on Hand' },
      { name: 'Money Market', lib: true }, { name: 'Certificates of Deposit', lib: true }, { name: 'Venmo / PayPal / Cash App', lib: true }, { name: 'Emergency Fund', lib: true },
    ]},
    { name: 'Investments', children: [
      { name: 'Brokerage' }, { name: 'Stocks' }, { name: 'Crypto' },
      { name: 'Bonds', lib: true }, { name: 'Mutual Funds', lib: true }, { name: 'ETFs', lib: true }, { name: 'Precious Metals', lib: true }, { name: 'REITs', lib: true },
    ]},
    { name: 'Retirement', children: [
      { name: '401(k)' }, { name: 'IRA' }, { name: 'Roth IRA' },
      { name: '403(b)', lib: true }, { name: 'Pension', lib: true }, { name: 'HSA', lib: true }, { name: 'SEP IRA', lib: true },
    ]},
    { name: 'Real Estate', children: [
      { name: 'Primary Residence' }, { name: 'Rental Property' },
      { name: 'Vacation Home', lib: true }, { name: 'Land', lib: true },
    ]},
    { name: 'Vehicles', children: [
      { name: 'Car' },
      { name: 'Truck', lib: true }, { name: 'Motorcycle', lib: true }, { name: 'Boat', lib: true }, { name: 'RV', lib: true },
    ]},
    { name: 'Personal Property', children: [
      { name: 'Furniture' }, { name: 'Electronics' }, { name: 'Jewelry' },
      { name: 'Collectibles', lib: true }, { name: 'Art', lib: true }, { name: 'Watches', lib: true }, { name: 'Designer Bags', lib: true }, { name: 'Musical Instruments', lib: true },
    ]},
    { name: 'Other Assets', children: [
      { name: 'Receivables' },
      { name: 'Loans to Family / Friends', lib: true }, { name: 'Gift Cards', lib: true }, { name: 'Security Deposits', lib: true },
    ]},
  ]},

  { name: 'Personal Liabilities', type: 'liability', scope: 'personal', children: [
    { name: 'Credit Cards', children: [
      { name: 'Credit Card Balance' },
      { name: 'Store Card', lib: true }, { name: 'Charge Card', lib: true },
    ]},
    { name: 'Loans', children: [
      { name: 'Personal Loan' }, { name: 'Auto Loan' }, { name: 'Student Loan' },
      { name: 'Medical Loan', lib: true }, { name: '401(k) Loan', lib: true }, { name: 'Family Loan', lib: true },
    ]},
    { name: 'Mortgage & Real Estate Debt', children: [
      { name: 'Primary Mortgage' }, { name: 'Rental Mortgage' },
      { name: 'HELOC', lib: true }, { name: 'Second Mortgage', lib: true },
    ]},
    { name: 'Taxes Payable', children: [
      { name: 'Income Tax Payable' },
      { name: 'Property Tax Payable', lib: true }, { name: 'Estimated Tax Payable', lib: true },
    ]},
    { name: 'Other Liabilities', children: [
      { name: 'Other' }, { name: 'Security Deposits Held' },
      { name: 'Buy Now Pay Later', lib: true }, { name: 'Medical Bills', lib: true }, { name: 'Overdraft', lib: true },
    ]},
  ]},

  { name: 'Personal Net Worth', type: 'equity', scope: 'personal', children: [
    { name: 'Net Worth', children: [
      { name: 'Opening Net Worth' },
      { name: 'Owner Contributions', lib: true }, { name: 'Owner Withdrawals', lib: true },
    ]},
  ]},

  { name: 'Business Assets', type: 'asset', scope: 'business', children: [
    { name: 'Cash & Equivalents', children: [
      { name: 'Business Checking' }, { name: 'Business Savings' },
      { name: 'Petty Cash', lib: true }, { name: 'Stripe / Square Balance', lib: true }, { name: 'Undeposited Funds', lib: true },
    ]},
    { name: 'Accounts Receivable', children: [
      { name: 'Accounts Receivable' },
      { name: 'Retainage Receivable', lib: true }, { name: 'Notes Receivable', lib: true },
    ]},
    { name: 'Inventory', children: [
      { name: 'Inventory' },
      { name: 'Raw Materials', lib: true }, { name: 'Finished Goods', lib: true }, { name: 'Work in Progress', lib: true },
    ]},
    { name: 'Fixed Assets', children: [
      { name: 'Equipment' }, { name: 'Computers & Electronics' }, { name: 'Furniture & Fixtures' }, { name: 'Appliances' }, { name: 'Vehicles' },
      { name: 'Tools & Machinery', lib: true }, { name: 'Buildings', lib: true }, { name: 'Leasehold Improvements', lib: true }, { name: 'Accumulated Depreciation', lib: true },
    ]},
    { name: 'Intangible Assets', children: [
      { name: 'Goodwill', lib: true }, { name: 'Trademarks', lib: true }, { name: 'Patents', lib: true }, { name: 'Software', lib: true }, { name: 'Domains', lib: true },
    ]},
    { name: 'Other Assets', children: [
      { name: 'Prepaid Expenses', lib: true }, { name: 'Security Deposits', lib: true }, { name: 'Long-Term Investments', lib: true },
    ]},
  ]},

  { name: 'Business Liabilities', type: 'liability', scope: 'business', children: [
    { name: 'Accounts Payable', children: [
      { name: 'Accounts Payable' }, { name: 'Vendor Payable', lib: true },
    ]},
    { name: 'Credit Cards', children: [
      { name: 'Business Credit Card' },
    ]},
    { name: 'Tenant Deposits', children: [
      { name: 'Security Deposits Held' },
      { name: 'Last Month Rent Held', lib: true }, { name: 'Pet Deposits Held', lib: true },
    ]},
    { name: 'Loans', children: [
      { name: 'Business Loan' }, { name: 'Line of Credit' },
      { name: 'SBA Loan', lib: true }, { name: 'Equipment Loan', lib: true }, { name: 'Merchant Cash Advance', lib: true },
    ]},
    { name: 'Payroll Liabilities', children: [
      { name: 'Wages Payable', lib: true }, { name: 'Payroll Tax Payable', lib: true },
    ]},
    { name: 'Taxes Payable', children: [
      { name: 'Sales Tax Payable' },
      { name: 'Income Tax Payable', lib: true }, { name: 'Payroll Tax Payable', lib: true },
    ]},
    { name: 'Long-Term Debt', children: [
      { name: 'Commercial Mortgage', lib: true }, { name: 'Notes Payable', lib: true }, { name: 'Lease Liability', lib: true },
    ]},
  ]},

  { name: 'Business Equity', type: 'equity', scope: 'business', children: [
    { name: 'Equity', children: [
      { name: "Owner's Capital" }, { name: 'Owner Draws' }, { name: 'Retained Earnings' },
      { name: 'Contributions', lib: true }, { name: 'Distributions', lib: true }, { name: 'Common Stock', lib: true },
    ]},
  ]},
];

// Flatten the master tree once. DFS order = display order (parent before children).
function buildFull() {
  const full = [];
  const byId = new Map();
  function walk(node, ancestors, type, scope, parentId, inLib) {
    const names = [...ancestors, node.name];
    const id = slug(names);
    const lib = inLib || !!node.lib;
    const rec = { id, name: node.name, type, parentId, scope, lib, ancestors };
    full.push(rec);
    byId.set(id, rec);
    for (const c of node.children || []) walk(c, names, type, scope, id, lib);
  }
  for (const s of SECTIONS) walk(s, [], s.type, s.scope, null, false);
  return { full, byId };
}
const { full: FULL, byId: BY_ID } = buildFull();

function toNode(r) { return { id: r.id, name: r.name, type: r.type, parentId: r.parentId, scope: r.scope, active: true, system: true }; }

/** The everyday/visible chart, seeded on first access. */
function buildDefaultChart() { return FULL.filter(r => !r.lib).map(toNode); }

/** Library nodes the user can add, minus anything already in their chart. */
function categoryLibrary(haveIds = new Set()) {
  return FULL.filter(r => r.lib && !haveIds.has(r.id))
    .map(r => ({ ...toNode(r), parentPath: r.ancestors.join(' › ') }));
}

/**
 * Nodes to insert when adding a library entry: the entry itself plus any of its
 * ancestors not already present (ancestors-first so parents exist before children).
 * Returns null if the id isn't a known library entry.
 */
function resolveLibraryAdditions(id, haveIds = new Set()) {
  const rec = BY_ID.get(id);
  if (!rec || !rec.lib) return null;
  const chain = [];
  let cur = rec;
  while (cur && !haveIds.has(cur.id)) {
    chain.unshift(cur);
    cur = cur.parentId ? BY_ID.get(cur.parentId) : null;
  }
  return chain.map(toNode);
}

// Ids from the pre-hierarchy flat seed — used to detect an untouched legacy chart.
const OLD_DEFAULT_IDS = new Set([
  'a1000','a1010','a1200','a1210','a1220','a1600','l2100','l2200','e3000','e3100',
  'i4100','i4200','i4300','i4400','x5000','x5010','x5020','x5030','x5040','x5050',
  'x5060','x5070','x5100','x5110','x5120','x5130','x5200','x5210','x5900',
]);

// Resolve a category's id from its name path, e.g.
// idForPath(['Personal Expenses','Food & Dining','Coffee Shops']) → 'cat_...__coffee_shops'.
// Used by auto-categorization to target default leaves by path.
function idForPath(names) { return slug(names); }

module.exports = { buildDefaultChart, categoryLibrary, resolveLibraryAdditions, OLD_DEFAULT_IDS, idForPath };
