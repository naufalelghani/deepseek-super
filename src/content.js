'use strict';

const { sha, MAX_REPLAY } = require('./config');

 function blocksOf(content) {
     if (content == null) return [];
     if (typeof content === 'string') return [{ type: 'text', text: content }];
     if (Array.isArray(content)) return content;
     return [];
 }

 function flattenContent(content) {
     return blocksOf(content).map((b) => {
         if (b.type === 'text') return b.text || '';
         if (typeof b.text === 'string') return b.text;
         return '';
     }).join('');
 }

 function renderMessage(m) {
     const parts = [];
     for (const b of blocksOf(m.content)) {
        if (b.type === 'text') {
            if (b.text) parts.push(b.text);
        } else if (b.type === 'tool_use') {
            parts.push(`[Memanggil tool ${b.name} dengan input: ${JSON.stringify(b.input || {})}]`);
        } else if (b.type === 'tool_result') {
             const txt = typeof b.content === 'string' ? b.content : flattenContent(b.content);
             parts.push(`[Hasil tool ${b.tool_use_id || ''}\n${txt}`);
        } else if (b.type === 'image') {
            parts.push('[gambar tidak didukung]');
        } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
            // skip
        } else if (b.type === 'document') {
             parts.push('[dokumen tidak didukung]');
        }
     }
     return parts.join('\n');
 }

 function sessionKey(system, messages) {
     const firstUser = messages.find((m) => m.role === 'user');
     return sha(JSON.stringify({
         sys: flattenContent(system).slice(0, 300),
         u1: firstUser ? flattenContent(firstUser.content).slice(0, 800) : '',
     }));
 }
 function truncateReplay(text) {
     if (text.length <= MAX_REPLAY) return text;
     const head = text.slice(0, 4000);
     const tail = text.slice(-(MAX_REPLAY - 4000));
     return head + '\n\n[... riwayat dipotong ...]\n\n' + tail;
 }

module.exports = { blocksOf, flattenContent, renderMessage, sessionKey, truncateReplay };