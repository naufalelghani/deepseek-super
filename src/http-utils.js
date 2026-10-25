'use strict';

const crypto = require('node:crypto');
const { AUTH_TOKEN } = require('./config');

function jsonError(res, status, type, message) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 10 * 1024 * 1024) {
                reject(new Error('Request body exceeds the 10 MB limit.'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            let raw = Buffer.concat(chunks).toString('utf8');
            raw = raw.replace(/^\uFEFF/, '').replace(/^\xEF\xBB\xBF/, '');
            if (!raw.trim()) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function safeEqualToken(candidate, expected = AUTH_TOKEN) {
    if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
    const candidateBuffer = Buffer.from(candidate, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (candidateBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

function checkAuth(req) {
    const key = req.headers['x-api-key'];
    const authorization = req.headers.authorization || '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    return safeEqualToken(key) || safeEqualToken(bearer);
}

function isAllowedHost(hostHeader, localPort) {
    if (typeof hostHeader !== 'string' || !hostHeader.trim()) return false;
    const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i.exec(hostHeader.trim());
    if (!match) return false;
    if (!match[2]) return true;
    const port = Number(match[2]);
    return port >= 1 && port <= 65535 && port === Number(localPort);
}

function isAllowedOrigin(origin, localPort) {
    // Non-browser HTTP clients normally omit Origin; they do not need CORS.
    if (origin === undefined || origin === '') return true;
    if (typeof origin !== 'string' || origin === 'null') return false;

    const configured = (process.env.CORS_ALLOWED_ORIGINS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    if (configured.includes(origin)) return true;

    let parsed;
    try {
        parsed = new URL(origin);
    } catch {
        return false;
    }

    if (parsed.protocol !== 'http:') return false;
    const localNames = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
    if (!localNames.has(parsed.hostname.toLowerCase())) return false;
    const originPort = parsed.port ? Number(parsed.port) : 80;
    return originPort === Number(localPort);
}

module.exports = {
    jsonError,
    readBody,
    checkAuth,
    safeEqualToken,
    isAllowedHost,
    isAllowedOrigin
};
