'use strict';

const { SESSION_TTL, uuid } = require('./config');
const { getStateStore } = require('./state-store');

// In-memory fallback keeps the gateway usable if the local database cannot open.
// The warning is emitted once so a degraded database does not flood the console.
const sessions = new Map();
let fallbackWarningLogged = false;

function warnFallback(error) {
  if (fallbackWarningLogged) return;
  fallbackWarningLogged = true;
  console.warn('[state-store] SQLite unavailable; session persistence and request tracing are degraded: ' +
    (error && error.message ? error.message : String(error)));
}

function fallbackGetSession(key) {
  const session = sessions.get(key);
  if (!session) return null;
  if (Date.now() - session.ts > SESSION_TTL) {
    sessions.delete(key);
    return null;
  }
  return session;
}

function getSession(key) {
  try {
    const session = getStateStore().getSession(key);
    if (session) sessions.set(key, session);
    else sessions.delete(key);
    return session;
  } catch (error) {
    warnFallback(error);
    return fallbackGetSession(key);
  }
}

function ensureSession(key) {
  try {
    const session = getStateStore().ensureSession(key);
    sessions.set(key, session);
    return session;
  } catch (error) {
    warnFallback(error);
    const existing = fallbackGetSession(key);
    if (existing) return { ...existing, created: false };
    const session = {
      url: null,
      ts: Date.now(),
      sessionId: uuid('sess'),
      threadId: null,
      generation: 0,
      created: true,
      inMemoryFallback: true,
    };
    sessions.set(key, session);
    return session;
  }
}

function setSession(key, url, metadata = {}) {
  try {
    const session = getStateStore().setSession(key, url, metadata);
    sessions.set(key, session);
    return session;
  } catch (error) {
    warnFallback(error);
    const current = fallbackGetSession(key);
    const sameThread = current && current.url === url && current.threadId;
    const session = {
      ...(current || {}),
      url,
      ts: Date.now(),
      sessionId: current ? current.sessionId : uuid('sess'),
      threadId: sameThread ? current.threadId : uuid('thr'),
      generation: sameThread ? current.generation : ((current && current.generation) || 0) + 1,
      created: !current,
      inMemoryFallback: true,
    };
    sessions.set(key, session);
    return session;
  }
}

module.exports = { getSession, ensureSession, setSession, sessions };
