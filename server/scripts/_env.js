'use strict';
// Shared env loader for dev scripts — mirrors server/index.js: load .env, then let a
// gitignored .env.local override (so scripts hit the SAME database as the running server,
// i.e. local Postgres in dev, Neon in prod). require('./_env') at the top of a script.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local'), override: true });
