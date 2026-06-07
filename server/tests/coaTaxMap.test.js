const { classifyByCoa } = require('../tax-normalize/coa-map');

describe('classifyByCoa — COA account → tax classification', () => {
  test('income accounts map to income tax categories', () => {
    expect(classifyByCoa({ type:'income', subtype:'wage' }).taxCategory).toBe('wages');
    expect(classifyByCoa({ type:'income', subtype:'rental', propertyId:'p1' }).taxCategory).toBe('rental_income');
    expect(classifyByCoa({ type:'income', subtype:'interest' }).taxCategory).toBe('interest_taxable');
    expect(classifyByCoa({ type:'income', subtype:'investment' }).taxCategory).toBe('other_income');
    expect(classifyByCoa({ type:'income', subtype:'wage' }).normalizedBy).toBe('coa');
  });

  test('non-rental deductible expenses land on Schedule A', () => {
    const mi = classifyByCoa({ type:'expense', subtype:'mortgage' });
    expect(mi.taxCategory).toBe('mortgage_interest');
    expect(mi.schedule).toBe('A');
    const pt = classifyByCoa({ type:'expense', subtype:'tax' });
    expect(pt.taxCategory).toBe('property_tax');
    expect(pt.schedule).toBe('A');
  });

  test('rental (property-linked) expenses land on Schedule E', () => {
    expect(classifyByCoa({ type:'expense', subtype:'mortgage',    propertyId:'p' }).taxCategory).toBe('rental_mortgage_int');
    expect(classifyByCoa({ type:'expense', subtype:'maintenance', propertyId:'p' }).taxCategory).toBe('rental_repairs');
    expect(classifyByCoa({ type:'expense', subtype:'tax',         propertyId:'p' }).taxCategory).toBe('rental_taxes');
    expect(classifyByCoa({ type:'expense', subtype:'management',  propertyId:'p' }).schedule).toBe('E');
  });

  test('personal spending is non-deductible (aggregator ignores "personal")', () => {
    expect(classifyByCoa({ type:'expense', subtype:'personal' }).taxCategory).toBe('personal');
    expect(classifyByCoa({ type:'expense', subtype:'subscription' }).taxCategory).toBe('personal');
    expect(classifyByCoa({ type:'expense', subtype:'insurance' }).taxCategory).toBe('personal'); // homeowner's, not rental
  });

  test('balance-sheet accounts (asset/liability/equity) are excluded from tax', () => {
    expect(classifyByCoa({ type:'asset',     subtype:'bank' }).taxCategory).toBe('personal');
    expect(classifyByCoa({ type:'liability', subtype:'credit_card' }).taxCategory).toBe('personal');
    expect(classifyByCoa({ type:'equity',    subtype:'equity' }).taxCategory).toBe('personal');
  });

  test('unknown expense subtype / bad input → null (falls through to rules)', () => {
    expect(classifyByCoa({ type:'expense', subtype:'mystery' })).toBeNull();
    expect(classifyByCoa({ type:'weird' })).toBeNull();
    expect(classifyByCoa(null)).toBeNull();
  });
});
