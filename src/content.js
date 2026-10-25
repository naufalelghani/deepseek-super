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
             parts.push(`[Tool call ${b.name} with input: ${JSON.stringify(b.input || {})}]`);
         } else if (b.type === 'tool_result') {
             const txt = typeof b.content === 'string' ? b.content : flattenContent(b.content);
             parts.push(`[Tool result ${b.tool_use_id || ''}]:\n${txt}`);
         } else if (b.type === 'image') {
             parts.push('[image unsupported]');
         } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
             // skip
         } else if (b.type === 'document') {
             parts.push('[document unsupported]');
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
      const marker = '\n\n[WARNING: conversation replay was truncated; middle content was omitted and earlier context may be missing.]\n\n';
      const headLength = Math.min(4000, Math.max(0, MAX_REPLAY - marker.length));
      const tailLength = Math.max(0, MAX_REPLAY - headLength - marker.length);
      const head = text.slice(0, headLength);
      const tail = tailLength > 0 ? text.slice(-tailLength) : '';
      return head + marker + tail;
  }

module.exports = { blocksOf, flattenContent, renderMessage, sessionKey, truncateReplay };
