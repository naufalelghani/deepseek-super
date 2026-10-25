'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = parseInt(process.env.PORT || '8787', 10);
const MODEL_NAME = process.env.MODEL_NAME || 'deepseek-super';
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, '..', 'deepseek-profile');
const AUTH_TOKEN_FILE = path.join(__dirname, '..', '.deepseek-super-token');

function readExistingToken() {
    const saved = fs.readFileSync(AUTH_TOKEN_FILE, 'utf8').trim();
    if (!saved) throw new Error('Local API token file is empty: ' + AUTH_TOKEN_FILE);
    return saved;
}

function loadAuthToken() {
    const fromEnvironment = (process.env.DEEPSEEK_SUPER_TOKEN || '').trim();
    if (fromEnvironment) {
        return { token: fromEnvironment, source: 'environment' };
    }

    try {
        return { token: readExistingToken(), source: 'local token file' };
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    // Create a complete temporary file first, then hard-link it to the final
    // path. The final token path becomes visible only after the content exists,
    // so parallel Node test workers cannot read a half-written empty token.
    const generated = crypto.randomBytes(32).toString('hex');
    const tempPath = AUTH_TOKEN_FILE + '.' + process.pid + '.' +
        crypto.randomBytes(6).toString('hex') + '.tmp';

    fs.writeFileSync(tempPath, generated + '\n', { flag: 'wx', mode: 0o600 });
    try {
        try {
            fs.linkSync(tempPath, AUTH_TOKEN_FILE);
            return { token: generated, source: 'generated local token file' };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            return { token: readExistingToken(), source: 'local token file' };
        }
    } finally {
        try { fs.unlinkSync(tempPath); } catch {}
    }
}

const auth = loadAuthToken();
const AUTH_TOKEN = auth.token;
const AUTH_TOKEN_SOURCE = auth.source;
const POLL_MS = parseInt(process.env.POLL_MS || '200', 10);
const STABLE_MS = parseInt(process.env.STABLE_MS || '4000', 10);
const MAX_TURN_MS = parseInt(process.env.MAX_TURN_MS || '300000', 10);
const HOLD_CHARS = 10;
const MAX_REPLAY = parseInt(process.env.MAX_REPLAY || '60000', 10);
const SESSION_TTL = 30 * 60 * 1000;
const MAX_PENDING_TURNS = Math.max(1, parseInt(process.env.MAX_PENDING_TURNS || '8', 10));

const uuid = (prefix) => prefix + '_' + crypto.randomBytes(12).toString('hex');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const approxTokens = (value) => Math.max(1, Math.ceil((value || '').length / 4));

module.exports = {
    PORT,
    MODEL_NAME,
    PROFILE_DIR,
    AUTH_TOKEN,
    AUTH_TOKEN_FILE,
    AUTH_TOKEN_SOURCE,
    POLL_MS,
    STABLE_MS,
    MAX_TURN_MS,
    HOLD_CHARS,
    MAX_REPLAY,
    MAX_PENDING_TURNS,
    SESSION_TTL,
    uuid,
    sha,
    approxTokens
};
