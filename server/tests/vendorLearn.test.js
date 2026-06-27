const { vendorKey, applyLearnedVendors, setVendorAndLearn, learnAuto } = require('../banking/vendor-learn');

const tx = (over = {}) => ({ id: 't1', desc: 'Audible*8D5QA2TN3 Amzn.com/billNJ', amount: -14.95, ...over });
const NOW = '2026-06-26T00:00:00.000Z';

describe('vendor-learn: merchant key', () => {
  test('collapses two noisy Audible descriptions to the same key', () => {
    expect(vendorKey('Audible*8D5QA2TN3 Amzn.com/billNJ'))
      .toBe(vendorKey('Audible*JR9AF56Z3 Amzn.com/billNJ'));
  });
});

describe('vendor-learn: applyLearnedVendors', () => {
  const mem = { [vendorKey('Audible*X')]: { vendor: 'Audible', source: 'user' } };

  test('fills a blank vendor from memory and flags it auto', () => {
    const { transactions, count } = applyLearnedVendors([tx()], mem);
    expect(count).toBe(1);
    expect(transactions[0]).toMatchObject({ vendor: 'Audible', vendorAuto: true });
  });

  test('never overwrites a manual (vendorAuto:false) value', () => {
    const { transactions, count } = applyLearnedVendors([tx({ vendor: 'My Audible', vendorAuto: false })], mem);
    expect(count).toBe(0);
    expect(transactions[0].vendor).toBe('My Audible');
  });

  test('refreshes a stale auto value when memory changes', () => {
    const { transactions } = applyLearnedVendors([tx({ vendor: 'OldName', vendorAuto: true })], mem);
    expect(transactions[0].vendor).toBe('Audible');
  });

  test('leaves transactions with no learned key untouched', () => {
    const { transactions, count } = applyLearnedVendors([tx({ desc: 'TOTALLY UNKNOWN MERCHANT 99' })], mem);
    expect(count).toBe(0);
    expect(transactions[0].vendor).toBeUndefined();
  });
});

describe('vendor-learn: setVendorAndLearn', () => {
  test('learns the pattern, marks the target manual, and backfills matching rows', () => {
    const txs = [
      tx({ id: 'a', desc: 'Audible*8D5QA2TN3 Amzn.com/billNJ' }),
      tx({ id: 'b', desc: 'Audible*JR9AF56Z3 Amzn.com/billNJ' }),
      tx({ id: 'c', desc: 'SPECTRUM 855-707-7328 MO' }),
    ];
    const { transactions, memory, updated } = setVendorAndLearn(txs, 'a', 'Audible', {}, { now: NOW });
    const byId = Object.fromEntries(transactions.map(t => [t.id, t]));

    expect(byId.a).toMatchObject({ vendor: 'Audible', vendorAuto: false });  // the edited row is manual
    expect(byId.b).toMatchObject({ vendor: 'Audible', vendorAuto: true });   // sibling backfilled as auto
    expect(byId.c.vendor).toBeUndefined();                                   // unrelated merchant untouched
    expect(memory[vendorKey('Audible*X')]).toMatchObject({ vendor: 'Audible', source: 'user' });
    expect(updated).toBe(2);
  });

  test('does not overwrite another row the user set by hand', () => {
    const txs = [
      tx({ id: 'a', desc: 'Audible*8D5 Amzn' }),
      tx({ id: 'b', desc: 'Audible*JR9 Amzn', vendor: 'Books (personal)', vendorAuto: false }),
    ];
    const { transactions } = setVendorAndLearn(txs, 'a', 'Audible', {});
    expect(transactions.find(t => t.id === 'b').vendor).toBe('Books (personal)');
  });

  test('clearing the From/To forgets the pattern and clears auto copies', () => {
    const txs = [
      tx({ id: 'a', desc: 'Audible*8D5 Amzn', vendor: 'Audible', vendorAuto: false }),
      tx({ id: 'b', desc: 'Audible*JR9 Amzn', vendor: 'Audible', vendorAuto: true }),
    ];
    const seeded = { [vendorKey('Audible*X')]: { vendor: 'Audible', source: 'user' } };
    const { transactions, memory } = setVendorAndLearn(txs, 'a', '', seeded);
    const byId = Object.fromEntries(transactions.map(t => [t.id, t]));

    expect(byId.a).toMatchObject({ vendor: '', vendorAuto: false });  // manual blank — won't be auto-refilled
    expect(byId.b.vendor).toBeUndefined();                            // auto copy cleared
    expect(memory[vendorKey('Audible*X')]).toBeUndefined();           // pattern forgotten
  });
});

describe('vendor-learn: learnAuto', () => {
  test('records machine names but never clobbers a user label', () => {
    const k = 'OCTOPUS CLEANING';
    const mem = learnAuto({ AUDIBLE: { vendor: 'Audible', source: 'user' } }, [
      { key: k, vendor: 'Octopus Cleaning' },
      { key: 'AUDIBLE', vendor: 'Wrong Guess' },
    ], { now: NOW });
    expect(mem[k]).toMatchObject({ vendor: 'Octopus Cleaning', source: 'auto' });
    expect(mem.AUDIBLE.vendor).toBe('Audible');   // user label preserved
  });
});
