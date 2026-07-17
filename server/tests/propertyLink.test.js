'use strict';
// "Add this property?" flow: question creation/dedup, reply handling (name/yes/no),
// property creation, policy linking, and the vault refile.

const pl = require('../banking/property-link');

function mkQuery(calls, openRows = []) {
  return (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT payload FROM txn_messages/.test(sql)) return Promise.resolve({ rows: openRows });
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
}
function mkIO(store = {}) {
  return { read: (f) => (f in store ? store[f] : null), write: (f, v) => { store[f] = v; }, _store: store };
}

const PAYLOAD = { policyId: 'pol1', address: '654 Alcita Ct', carrier: 'CEA', coverageType: 'earthquake',
                  fileId: 'file_x', year: '2026' };

describe('createPropertyQuestion', () => {
  test('queues an open question with the address', async () => {
    const calls = [];
    const q = await pl.createPropertyQuestion(mkQuery(calls), 'u1', PAYLOAD);
    expect(q.text).toContain('654 Alcita Ct');
    expect(q.text).toContain('CEA earthquake');
    const ins = calls.find(c => /INSERT INTO txn_messages/.test(c.sql));
    expect(ins.sql).toContain("'property'");
    expect(ins.sql).toContain("'open'");
  });
  test('dedupes by normalized address across open/asked questions', async () => {
    const openRows = [{ payload: JSON.stringify({ address: '654 ALCITA CT.' }) }];
    const q = await pl.createPropertyQuestion(mkQuery([], openRows), 'u1', PAYLOAD);
    expect(q).toBeNull();
  });
  test('no address → no question', async () => {
    expect(await pl.createPropertyQuestion(mkQuery([]), 'u1', { ...PAYLOAD, address: null })).toBeNull();
  });
});

describe('handlePropertyAnswer', () => {
  const q = { id: 'txm_1', payload: PAYLOAD };

  test("'no' leaves everything unassigned", async () => {
    const calls = [];
    const io = mkIO({ 'properties.json': [] });
    const res = await pl.handlePropertyAnswer(mkQuery(calls), io, 'u1', q, 'no');
    expect(res.replies[0]).toContain('Left unassigned');
    expect(io._store['properties.json']).toEqual([]);                 // nothing created
    expect(calls.some(c => /UPDATE insurance_policies/.test(c.sql))).toBe(false);
    expect(calls.some(c => /state='answered'/.test(c.sql))).toBe(true);
  });

  test('a name creates the property, links the policy, and refiles the bill', async () => {
    const calls = [];
    const io = mkIO({
      'properties.json': [],
      'vault.json': { folders: [{ id: 'f1', name: 'Insurance', path: 'Insurance', parentId: null }],
                      files: [{ id: 'file_x', name: 'CEA Earthquake 7491 Jul 2026.pdf', folderId: 'f1', folderPath: 'Insurance/CEA/2026' }] },
    });
    const res = await pl.handlePropertyAnswer(mkQuery(calls), io, 'u1', q, 'Alcita');
    expect(res.replies[0]).toContain('Added Alcita (654 Alcita Ct)');
    expect(res.replies[0]).toContain('Insurance/Alcita/2026');
    const props = io._store['properties.json'];
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ name: 'Alcita', address: '654 Alcita Ct' });
    const upd = calls.find(c => /UPDATE insurance_policies SET property_id/.test(c.sql));
    expect(upd.params[0]).toBe('pol1');
    expect(upd.params[1]).toBe(props[0].id);
    const vf = io._store['vault.json'].files[0];
    expect(vf.folderPath).toBe('Insurance/Alcita/2026');              // refiled by property name
    expect(io._store['vault.json'].folders.some(f => f.path === 'Insurance/Alcita/2026')).toBe(true);
  });

  test("'yes' names the property by its address; existing match is reused, not duplicated", async () => {
    const calls = [];
    const io = mkIO({ 'properties.json': [{ id: 'p9', name: 'Alcita', address: '654 Alcita Ct, Orange County' }] });
    const res = await pl.handlePropertyAnswer(mkQuery(calls), io, 'u1', q, 'yes');
    expect(io._store['properties.json']).toHaveLength(1);             // reused, no duplicate
    const upd = calls.find(c => /UPDATE insurance_policies SET property_id/.test(c.sql));
    expect(upd.params[1]).toBe('p9');
    expect(res.replies[0]).toContain('Alcita');
  });

  test('garbage-length reply re-asks instead of creating a junk property', async () => {
    const io = mkIO({ 'properties.json': [] });
    const res = await pl.handlePropertyAnswer(mkQuery([]), io, 'u1', q, 'x');
    expect(res.replies[0]).toContain("Reply with a short name");
    expect(io._store['properties.json']).toEqual([]);
  });
});

describe('moveVaultFile', () => {
  test('creates missing folder segments and moves the entry', () => {
    const io = mkIO({ 'vault.json': { folders: [], files: [{ id: 'f1', name: 'a.pdf', folderPath: 'Unsorted', folderId: null }] } });
    expect(pl.moveVaultFile(io, 'f1', 'Insurance/Haas/2026')).toBe(true);
    const meta = io._store['vault.json'];
    expect(meta.files[0].folderPath).toBe('Insurance/Haas/2026');
    expect(meta.folders.map(f => f.path)).toEqual(['Insurance', 'Insurance/Haas', 'Insurance/Haas/2026']);
  });
  test('unknown file → false, no write', () => {
    const io = mkIO({ 'vault.json': { folders: [], files: [] } });
    expect(pl.moveVaultFile(io, 'nope', 'X/Y')).toBe(false);
  });
});
