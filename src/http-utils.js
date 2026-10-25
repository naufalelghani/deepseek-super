'use strict';

const { AUTH_TOKEN } = require('./config');

 function jsonError(res, status, type, message) {
     res.writeHead(status, { 'Content-Type': 'application/json' });
     res.end(JSON.stringify({ type: 'error', error: { type, message } }));
 }

 function readBody(req) {
     return new Promise((resolve, reject) => {
         const chunks = [];
         let size = 0;
         req.on('data', (c) => {
             size += c.length;
             if (size > 10 * 1024 * 1024) {
                 reject(new Error('body terlalu besar'));
                 req.destroy();
                 return;
             }
             chunks.push(c);
         });
         req.on('end', () => {
             let raw = Buffer.concat(chunks).toString('utf8');
             raw = raw.replace(/^\uFEFF/, '').replace(/^\xEF\xBB\xBF/, '');
             if (!raw.trim()) return resolve({});
             try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
         });
         req.on('error', reject);
     });
 }

 function checkAuth(req) {
     if (!AUTH_TOKEN) return true;
     const key = req.headers['x-api-key'];
     const auth = req.headers['authorization'] || '';
     const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
     return key === AUTH_TOKEN || bearer === AUTH_TOKEN;
 }

module.exports = { jsonError, readBody, checkAuth };
