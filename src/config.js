'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function parseBoundedInteger(value, min, max) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
    return parsed;
}

function readIntegerEnv(name, fallback, min, max) {
    const raw = process.env[name];
    const parsed = parseBoundedInteger(raw, min, max);
    if (parsed !== null) return parsed;
    if (raw !== undefined && String(raw).trim() !== '') {
        console.warn('[config] invalid ' + name + '; using safe default ' + fallback);
    }
    return fallback;
}

const PORT = readIntegerEnv('PORT', 8787, 1, 65535);
const MODEL_NAME = process.env.MODEL_NAME || 'deepseek-super';
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, '..', 'deepseek-profile');
const AUTH_TOKEN_FILE = path.join(__dirname, '..', '.deepseek-super-token');
const DATABASE_PATH = path.resolve(process.env.DEEPSEEK_SUPER_DB_PATH || path.join(__dirname, '..', 'data', 'deepseek-super.sqlite3'));

function readExistingToken() {
    const saved = fs.readFileSync(AUTH_TOKEN_FILE, 'utf8').trim();
    if (!saved) {
        const error = new Error('Local API token file is empty: ' + AUTH_TOKEN_FILE);
        error.code = 'EMPTY_LOCAL_TOKEN';
        throw error;
    }
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
        if (error.code === 'EMPTY_LOCAL_TOKEN') {
            // Recover from an empty file left by an interrupted upgrade from an
            // older non-atomic token writer. Concurrent removals are harmless.
            try { fs.unlinkSync(AUTH_TOKEN_FILE); } catch (unlinkError) {
                if (unlinkError.code !== 'ENOENT') throw unlinkError;
            }
        } else if (error.code !== 'ENOENT') {
            throw error;
        }
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
const POLL_MS = readIntegerEnv('POLL_MS', 200, 50, 5000);
const STABLE_MS = readIntegerEnv('STABLE_MS', 4000, 500, 60000);
const MAX_TURN_MS = readIntegerEnv('MAX_TURN_MS', 300000, 1000, 3600000);
const HOLD_CHARS = 10;
const MAX_REPLAY = readIntegerEnv('MAX_REPLAY', 60000, 8192, 1000000);
const SESSION_TTL = 30 * 60 * 1000;
const MAX_PENDING_TURNS = readIntegerEnv('MAX_PENDING_TURNS', 8, 1, 64);

const uuid = (prefix) => prefix + '_' + crypto.randomBytes(12).toString('hex');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const approxTokens = (value) => Math.max(1, Math.ceil((value || '').length / 4));

module.exports = {
    PORT,
    MODEL_NAME,
    PROFILE_DIR,
    AUTH_TOKEN,
    AUTH_TOKEN_FILE,
    DATABASE_PATH,
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
    approxTokens,
    parseBoundedInteger
};
