'use strict';

const { SESSION_TTL } = require('./config');

 const sessions = new Map();

 function getSession(key) {
     const s = sessions.get(key);
     if (!s) return null;
     if (Date.now() - s.ts > SESSION_TTL) { sessions.delete(key); return null; }
     return s;
 }

 function setSession(key, url) {
     sessions.set(key, { url, ts: Date.now() });
     if (sessions.size > 200) {
         const oldest = [...sessions.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
         if (oldest) sessions.delete(oldest[0]);
     }
 }

module.exports = { getSession, setSession, sessions };