'use strict';
// core/db.js — environment-aware connection guard (pure functions; no DB needed).
// Production is guarded by an EXPLICIT host (PROD_DB_HOST), so hosted Supabase remains a
// valid dev/build database while the real prod DB (e.g. AWS RDS/Aurora) is protected.
const { classifyDbUrl, dbSafety } = require('../core/db');

const LOCAL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SUPA  = 'postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres';
const RDS   = 'postgresql://u:pw@caishen-prod.abc.us-west-2.rds.amazonaws.com:5432/caishen';
const RDS_HOST = 'caishen-prod.abc.us-west-2.rds.amazonaws.com';

describe('classifyDbUrl', () => {
  test('extracts host + detects local', () => {
    expect(classifyDbUrl(LOCAL).isLocal).toBe(true);
    expect(classifyDbUrl(SUPA).isLocal).toBe(false);
    expect(classifyDbUrl(SUPA).host).toBe('db.abcdefgh.supabase.co');
    expect(classifyDbUrl(RDS).host).toBe(RDS_HOST);
  });
});

describe('dbSafety', () => {
  test('dev pointed at the designated prod host → THROW', () => {
    expect(dbSafety('development', RDS, { prodHost: RDS_HOST }).action).toBe('throw');
    expect(dbSafety(undefined, RDS, { prodHost: RDS_HOST }).action).toBe('throw');   // unset env = development
  });
  test('dev building against hosted Supabase (NOT the prod host) → ok', () => {
    expect(dbSafety('development', SUPA, { prodHost: RDS_HOST }).action).toBe('ok');
  });
  test('dev/testing against local → ok', () => {
    expect(dbSafety('development', LOCAL, { prodHost: RDS_HOST }).action).toBe('ok');
    expect(dbSafety('test', LOCAL, {}).action).toBe('ok');
  });
  test('no PROD_DB_HOST set → never throws in dev (just logs)', () => {
    expect(dbSafety('development', RDS, {}).action).toBe('ok');
    expect(dbSafety('development', SUPA, {}).action).toBe('ok');
  });
  test('production pointed at local → WARN', () => {
    expect(dbSafety('production', LOCAL, { prodHost: RDS_HOST }).action).toBe('warn');
  });
  test('production pointed at the prod host → ok', () => {
    expect(dbSafety('production', RDS, { prodHost: RDS_HOST }).action).toBe('ok');
  });
  test('DB_ALLOW_UNSAFE override lets a non-prod process hit the prod host', () => {
    expect(dbSafety('development', RDS, { prodHost: RDS_HOST, allowUnsafe: true }).action).toBe('ok');
  });
});
