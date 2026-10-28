'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DATABASE_PATH, SESSION_TTL, uuid } = require('./config');

const SCHEMA_VERSION = 1;
const TRACE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_TRACE_EVENTS = 20000;
const SENSITIVE_DETAIL_KEY = /(?:^|_)(?:authorization|cookie|token|secret|password|api_key|access_key|raw_prompt|prompt_text|content|command|input|url|path|query|email)(?:_|$)/i;

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const result = {};
  for (const [key, value] of Object.entries(details).slice(0, 40)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) {
      result[key] = '[redacted]';
    } else if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      result[key] = value;
    } else if (typeof value === 'string') {
      result[key] = value.length > 160 ? value.slice(0, 157) + '...' : value;
    } else {
      result[key] = '[omitted]';
    }
  }
  return result;
}

function createStateStore(options = {}) {
  const databasePath = options.databasePath || DATABASE_PATH;
  const sessionTtlMs = options.sessionTtlMs || SESSION_TTL;
  const now = options.now || Date.now;
  const makeId = options.uuid || uuid;
  const Database = options.Database || require('better-sqlite3');

  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const db = new Database(databasePath, { timeout: 5000 });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  const currentSchemaVersion = db.pragma('user_version', { simple: true });
  if (currentSchemaVersion > SCHEMA_VERSION) {
    db.close();
    throw new Error('The observability database schema is newer than this gateway supports.');
  }

  db.exec(
    "CREATE TABLE IF NOT EXISTS sessions (" +
    "session_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, " +
    "ended_at INTEGER, status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'closed')));" +
    "CREATE TABLE IF NOT EXISTS session_keys (" +
    "session_key TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, " +
    "deepseek_url TEXT, active_thread_id TEXT, thread_generation INTEGER NOT NULL DEFAULT 0, " +
    "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS threads (" +
    "thread_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, " +
    "generation INTEGER NOT NULL, deepseek_url TEXT, status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'expired')), " +
    "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER, rotation_reason TEXT, " +
    "message_count_at_creation INTEGER, UNIQUE(session_id, generation));" +
    "CREATE TABLE IF NOT EXISTS requests (" +
    "request_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL, " +
    "thread_id TEXT REFERENCES threads(thread_id) ON DELETE SET NULL, thread_generation INTEGER, model TEXT NOT NULL, " +
    "stream INTEGER NOT NULL, message_count INTEGER NOT NULL, client_tool_count INTEGER NOT NULL, input_prompt_chars INTEGER, " +
    "replay_prompt_chars INTEGER, final_prompt_chars INTEGER, omitted_prompt_chars INTEGER NOT NULL DEFAULT 0, " +
    "prompt_truncated INTEGER NOT NULL DEFAULT 0, resumed INTEGER, rotation_reason TEXT, stop_reason TEXT, tool_call_count INTEGER, " +
    "completion_source TEXT, status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'error', 'cancelled')), " +
    "error_code TEXT, started_at INTEGER NOT NULL, completed_at INTEGER);" +
    "CREATE TABLE IF NOT EXISTS events (" +
    "event_id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT REFERENCES requests(request_id) ON DELETE CASCADE, " +
    "session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL, thread_id TEXT REFERENCES threads(thread_id) ON DELETE SET NULL, " +
    "occurred_at INTEGER NOT NULL, level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')), " +
    "event_type TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}');" +
    "CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at);" +
    "CREATE INDEX IF NOT EXISTS idx_threads_session_generation ON threads(session_id, generation);" +
    "CREATE INDEX IF NOT EXISTS idx_requests_started_at ON requests(started_at);" +
    "CREATE INDEX IF NOT EXISTS idx_requests_session_started ON requests(session_id, started_at);" +
    "CREATE INDEX IF NOT EXISTS idx_events_request_id ON events(request_id, event_id);" +
    "CREATE INDEX IF NOT EXISTS idx_events_occurred_at ON events(occurred_at);"
  );
  db.pragma('user_version = ' + SCHEMA_VERSION);

  const getSessionRow = db.prepare(
    'SELECT k.*, s.status AS session_status FROM session_keys k ' +
    'JOIN sessions s ON s.session_id = k.session_id WHERE k.session_key = ?'
  );
  const updateSessionTouch = db.prepare(
    'UPDATE session_keys SET last_seen_at = ?, expires_at = ? WHERE session_key = ?'
  );
  const updateSessionLastSeen = db.prepare(
    'UPDATE sessions SET last_seen_at = ? WHERE session_id = ?'
  );
  const expireThread = db.prepare(
    "UPDATE threads SET status = 'expired', ended_at = ?, updated_at = ? WHERE thread_id = ? AND status = 'active'"
  );
  const expireSession = db.prepare(
    "UPDATE sessions SET status = 'expired', ended_at = ?, last_seen_at = ? WHERE session_id = ?"
  );
  const deleteSessionKey = db.prepare('DELETE FROM session_keys WHERE session_key = ?');

  function mappedSession(row, extra = {}) {
    if (!row) return null;
    return {
      url: row.deepseek_url || null,
      ts: row.updated_at,
      sessionId: row.session_id,
      threadId: row.active_thread_id || null,
      generation: row.thread_generation,
      expiresAt: row.expires_at,
      sessionKey: row.session_key,
      ...extra,
    };
  }

  function expireAlias(row, timestamp) {
    if (!row) return;
    const expire = () => {
      if (row.active_thread_id) expireThread.run(timestamp, timestamp, row.active_thread_id);
      expireSession.run(timestamp, timestamp, row.session_id);
      deleteSessionKey.run(row.session_key);
    };
    if (db.inTransaction) expire();
    else db.transaction(expire)();
  }

  function touchSession(row, timestamp) {
    updateSessionTouch.run(timestamp, timestamp + sessionTtlMs, row.session_key);
    updateSessionLastSeen.run(timestamp, row.session_id);
  }

  function ensureSession(sessionKey) {
    if (typeof sessionKey !== 'string' || !sessionKey) {
      throw new TypeError('A non-empty session key is required.');
    }
    const timestamp = now();
    let row = getSessionRow.get(sessionKey);
    if (row && row.expires_at <= timestamp) {
      expireAlias(row, timestamp);
      row = null;
    }
    if (!row) {
      const sessionId = makeId('sess');
      const create = db.transaction(() => {
        db.prepare("INSERT INTO sessions (session_id, created_at, last_seen_at, status) VALUES (?, ?, ?, 'active')")
          .run(sessionId, timestamp, timestamp);
        db.prepare("INSERT INTO session_keys (session_key, session_id, deepseek_url, active_thread_id, thread_generation, created_at, updated_at, last_seen_at, expires_at) VALUES (?, ?, NULL, NULL, 0, ?, ?, ?, ?)")
          .run(sessionKey, sessionId, timestamp, timestamp, timestamp, timestamp + sessionTtlMs);
      });
      create();
      row = getSessionRow.get(sessionKey);
      return mappedSession(row, { created: true });
    }
    touchSession(row, timestamp);
    row = getSessionRow.get(sessionKey);
    return mappedSession(row, { created: false });
  }

  function getSession(sessionKey) {
    if (typeof sessionKey !== 'string' || !sessionKey) return null;
    const timestamp = now();
    const row = getSessionRow.get(sessionKey);
    if (!row) return null;
    if (row.expires_at <= timestamp) {
      expireAlias(row, timestamp);
      return null;
    }
    touchSession(row, timestamp);
    return mappedSession(getSessionRow.get(sessionKey), { created: false });
  }

  function setSession(sessionKey, url, metadata = {}) {
    if (typeof url !== 'string' || !url) return ensureSession(sessionKey);
    ensureSession(sessionKey);
    const current = getSessionRow.get(sessionKey);
    if (!current) throw new Error('Could not resolve the gateway session for persistence.');
    const timestamp = now();
    if (current.deepseek_url === url && current.active_thread_id) {
      const update = db.transaction(() => {
        db.prepare('UPDATE session_keys SET updated_at = ?, last_seen_at = ?, expires_at = ? WHERE session_key = ?')
          .run(timestamp, timestamp, timestamp + sessionTtlMs, sessionKey);
        updateSessionLastSeen.run(timestamp, current.session_id);
        db.prepare("UPDATE threads SET updated_at = ? WHERE thread_id = ? AND status = 'active'")
          .run(timestamp, current.active_thread_id);
      });
      update();
      return mappedSession(getSessionRow.get(sessionKey), { created: false });
    }

    const generation = current.thread_generation + 1;
    const threadId = makeId('thr');
    const rotationReason = metadata.rotationReason || (current.deepseek_url ? 'thread_changed' : 'initial');
    const change = db.transaction(() => {
      if (current.active_thread_id) {
        db.prepare("UPDATE threads SET status = 'archived', ended_at = ?, updated_at = ? WHERE thread_id = ? AND status = 'active'")
          .run(timestamp, timestamp, current.active_thread_id);
      }
      db.prepare("INSERT INTO threads (thread_id, session_id, generation, deepseek_url, status, created_at, updated_at, rotation_reason, message_count_at_creation) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)")
        .run(
          threadId,
          current.session_id,
          generation,
          url,
          timestamp,
          timestamp,
          rotationReason,
          Number.isInteger(metadata.messageCount) ? metadata.messageCount : null
        );
      db.prepare('UPDATE session_keys SET deepseek_url = ?, active_thread_id = ?, thread_generation = ?, updated_at = ?, last_seen_at = ?, expires_at = ? WHERE session_key = ?')
        .run(url, threadId, generation, timestamp, timestamp, timestamp + sessionTtlMs, sessionKey);
      updateSessionLastSeen.run(timestamp, current.session_id);
    });
    change();
    return mappedSession(getSessionRow.get(sessionKey), { created: current.thread_generation === 0 });
  }

  function recordEvent(event = {}) {
    const timestamp = now();
    const detailsJson = JSON.stringify(sanitizeDetails(event.details));
    db.prepare('INSERT INTO events (request_id, session_id, thread_id, occurred_at, level, event_type, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        event.requestId || null,
        event.sessionId || null,
        event.threadId || null,
        timestamp,
        ['debug', 'info', 'warn', 'error'].includes(event.level) ? event.level : 'info',
        String(event.type || 'event').slice(0, 80),
        detailsJson.length > 4096 ? '{"omitted":"details exceeded size limit"}' : detailsJson
      );
  }

  function prune(timestamp) {
    const retentionCutoff = timestamp - TRACE_RETENTION_MS;
    const expired = db.prepare('SELECT * FROM session_keys WHERE expires_at <= ?').all(timestamp);
    for (const row of expired) expireAlias(row, timestamp);
    db.prepare('DELETE FROM requests WHERE started_at < ?').run(retentionCutoff);
    db.prepare('DELETE FROM events WHERE event_id NOT IN (SELECT event_id FROM events ORDER BY event_id DESC LIMIT ?)')
      .run(MAX_TRACE_EVENTS);
    db.prepare("DELETE FROM sessions WHERE status <> 'active' AND ended_at IS NOT NULL AND ended_at < ?")
      .run(retentionCutoff);
  }

  function recordRequestStart(request) {
    const timestamp = now();
    const insert = db.transaction(() => {
      prune(timestamp);
      db.prepare('INSERT INTO requests (request_id, message_id, model, stream, message_count, client_tool_count, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          request.requestId,
          request.messageId,
          String(request.model || 'unknown').slice(0, 120),
          request.stream ? 1 : 0,
          Math.max(0, Number(request.messageCount) || 0),
          Math.max(0, Number(request.clientToolCount) || 0),
          'started',
          timestamp
        );
      recordEvent({
        requestId: request.requestId,
        type: 'request.received',
        details: {
          model: String(request.model || 'unknown').slice(0, 120),
          stream: Boolean(request.stream),
          message_count: Math.max(0, Number(request.messageCount) || 0),
          client_tool_count: Math.max(0, Number(request.clientToolCount) || 0),
        },
      });
    });
    insert();
  }

  function linkRequestToSession(requestId, session, metadata = {}) {
    if (!session) return;
    const sessionId = session.sessionId || null;
    const threadId = session.threadId || null;
    const generation = Number.isInteger(session.generation) ? session.generation : null;
    const link = db.transaction(() => {
      db.prepare('UPDATE requests SET session_id = ?, thread_id = ?, thread_generation = ?, resumed = ?, rotation_reason = ? WHERE request_id = ?')
        .run(
          sessionId,
          threadId,
          generation,
          typeof metadata.resumed === 'boolean' ? (metadata.resumed ? 1 : 0) : null,
          metadata.rotationReason || null,
          requestId
        );
      // The request.received event is written before browser-session lookup.
      // Backfill its correlation fields once the session/thread are known.
      db.prepare("UPDATE events SET session_id = COALESCE(session_id, ?), thread_id = COALESCE(thread_id, ?) WHERE request_id = ? AND event_type = 'request.received'")
        .run(sessionId, threadId, requestId);
    });
    link();
  }

  function recordPromptMetrics(requestId, metrics) {
    const prompt = metrics || {};
    db.prepare('UPDATE requests SET input_prompt_chars = ?, replay_prompt_chars = ?, final_prompt_chars = ?, omitted_prompt_chars = ?, prompt_truncated = ? WHERE request_id = ?')
      .run(
        Math.max(0, Number(prompt.inputPromptChars) || 0),
        Math.max(0, Number(prompt.replayPromptChars) || 0),
        Math.max(0, Number(prompt.finalPromptChars) || 0),
        Math.max(0, Number(prompt.omittedPromptChars) || 0),
        prompt.truncated ? 1 : 0,
        requestId
      );
    recordEvent({
      requestId,
      type: prompt.truncated ? 'prompt.compacted' : 'prompt.ready',
      details: {
        input_prompt_chars: Math.max(0, Number(prompt.inputPromptChars) || 0),
        replay_prompt_chars: Math.max(0, Number(prompt.replayPromptChars) || 0),
        final_prompt_chars: Math.max(0, Number(prompt.finalPromptChars) || 0),
        omitted_prompt_chars: Math.max(0, Number(prompt.omittedPromptChars) || 0),
        truncated: Boolean(prompt.truncated),
      },
    });
  }

  function finishRequest(request) {
    const timestamp = now();
    const status = ['completed', 'error', 'cancelled'].includes(request.status)
      ? request.status
      : 'completed';
    const stopReason = request.stopReason || null;
    const completionSource = request.completionSource || 'unknown';
    db.prepare('UPDATE requests SET status = ?, completed_at = ?, stop_reason = ?, tool_call_count = ?, completion_source = ?, error_code = ? WHERE request_id = ?')
      .run(
        status,
        timestamp,
        stopReason,
        Number.isInteger(request.toolCallCount) ? request.toolCallCount : null,
        String(completionSource).slice(0, 60),
        request.errorCode ? String(request.errorCode).slice(0, 100) : null,
        request.requestId
      );
    recordEvent({
      requestId: request.requestId,
      sessionId: request.sessionId || null,
      threadId: request.threadId || null,
      type: status === 'completed' ? 'request.completed' : 'request.' + status,
      level: status === 'error' ? 'error' : status === 'cancelled' ? 'warn' : 'info',
      details: {
        stop_reason: stopReason,
        tool_call_count: Number.isInteger(request.toolCallCount) ? request.toolCallCount : null,
        completion_source: String(completionSource).slice(0, 60),
        error_code: request.errorCode ? String(request.errorCode).slice(0, 100) : null,
      },
    });
  }

  function listThreads(sessionId) {
    return db.prepare('SELECT thread_id AS threadId, session_id AS sessionId, generation, deepseek_url AS url, status, created_at AS createdAt, ended_at AS endedAt, rotation_reason AS rotationReason, message_count_at_creation AS messageCountAtCreation FROM threads WHERE session_id = ? ORDER BY generation')
      .all(sessionId);
  }

  function getRequest(requestId) {
    return db.prepare('SELECT * FROM requests WHERE request_id = ?').get(requestId) || null;
  }

  function listRecentRequests(limit = 20) {
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return db.prepare('SELECT request_id AS requestId, message_id AS messageId, session_id AS sessionId, thread_id AS threadId, thread_generation AS threadGeneration, model, stream, message_count AS messageCount, client_tool_count AS clientToolCount, input_prompt_chars AS inputPromptChars, replay_prompt_chars AS replayPromptChars, final_prompt_chars AS finalPromptChars, omitted_prompt_chars AS omittedPromptChars, prompt_truncated AS promptTruncated, resumed, rotation_reason AS rotationReason, stop_reason AS stopReason, tool_call_count AS toolCallCount, completion_source AS completionSource, status, error_code AS errorCode, started_at AS startedAt, completed_at AS completedAt FROM requests ORDER BY started_at DESC LIMIT ?')
      .all(boundedLimit);
  }

  function listEvents(requestId, limit = 200) {
    const boundedLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
    return db.prepare('SELECT event_id AS eventId, request_id AS requestId, session_id AS sessionId, thread_id AS threadId, occurred_at AS occurredAt, level, event_type AS type, details_json AS detailsJson FROM events WHERE request_id = ? ORDER BY event_id LIMIT ?')
      .all(requestId, boundedLimit).map((event) => ({
        ...event,
        details: JSON.parse(event.detailsJson),
        detailsJson: undefined,
      }));
  }

  function close() {
    if (db.open) db.close();
  }

  return {
    db,
    getSession,
    ensureSession,
    setSession,
    recordEvent,
    recordRequestStart,
    linkRequestToSession,
    recordPromptMetrics,
    finishRequest,
    listThreads,
    getRequest,
    listRecentRequests,
    listEvents,
    close,
  };
}

let singleton = null;
let initializationError = null;

function getStateStore() {
  if (singleton) return singleton;
  if (initializationError) throw initializationError;
  try {
    singleton = createStateStore();
    return singleton;
  } catch (error) {
    initializationError = error;
    throw error;
  }
}

module.exports = { createStateStore, getStateStore, sanitizeDetails };
