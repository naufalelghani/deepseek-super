'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

 const PORT = parseInt(process.env.PORT || '8787', 10);
 const MODEL_NAME = process.env.MODEL_NAME || 'deepseek-super';
 const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, '..', 'deepseek-profile');
 const AUTH_TOKEN = process.env.DEEPSEEK_SUPER_TOKEN || '';
 const POLL_MS = parseInt(process.env.POLL_MS || '200', 10);
 const STABLE_MS = parseInt(process.env.STABLE_MS || '4000', 10);
 const MAX_TURN_MS = parseInt(process.env.MAX_TURN_MS || '300000', 10);
 const HOLD_CHARS = 10;
 const MAX_REPLAY = parseInt(process.env.MAX_REPLAY || '60000', 10);
 const SESSION_TTL = 30 * 60 * 1000;

 const uuid = (p) => p + '_' + crypto.randomBytes(12).toString('hex');
 const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
 const approxTokens = (s) => Math.max(1, Math.ceil((s || '').length / 4));

module.exports = { PORT, MODEL_NAME, PROFILE_DIR, AUTH_TOKEN, POLL_MS, STABLE_MS, MAX_TURN_MS, HOLD_CHARS, MAX_REPLAY, SESSION_TTL, uuid, sha, approxTokens };
