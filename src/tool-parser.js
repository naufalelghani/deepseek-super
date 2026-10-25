'use strict';

 const OPEN_RE = /<\s*TOOL_CALL\s*>/i;
 const CLOSE_RE = /<\s*\/\s*TOOL_CALL\s*>/i;

 function holdbackLen(s) {
     const max = Math.min(s.length, 16);
     const canon = '<tool_call>';
     for (let len = max; len > 0; len--) {
         const tail = s.slice(-len).toLowerCase().replace(/\s+/g, '');
         let ok = true;
         for (let i = 0; i < tail.length; i++) {
             if (tail[i] !== canon[i]) { ok = false; break; }
         }
         if (ok) return len;
     }
     return 0;
 }

 function tryParseJSON_v1(str) {
     try { return JSON.parse(str); } catch (e) {}
     try {
         const fixed = str.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
         return JSON.parse(fixed);
     } catch (e) {}
     try {
         const stripped = str.replace(/,\s*([}\]])/g, '$1');
         return JSON.parse(stripped);
     } catch (e) {}
     return null;
 }

 function tryParseJSON(str) {
     // 1. Coba langsung
     try { return JSON.parse(str); } catch (e) {}

     // 2. Fix backslash Windows path: \X (X bukan escape valid) → \\X
     //    Valid JSON escapes: \" \\ \/ \b \f \n \r \t \uXXXX
     try {
         const fixed = str.replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');
         return JSON.parse(fixed);
     } catch (e) {}

     // 3. Quote keys yang tidak di-quote + backslash fix
     try {
         let s = str.replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');
         s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
         return JSON.parse(s);
     } catch (e) {}

     // 4. Strip trailing comma + backslash fix
     try {
         let s = str.replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');
         s = s.replace(/,\s*([}\]])/g, '$1');
         return JSON.parse(s);
     } catch (e) {}

     // 5. Heuristic: escape quote di tengah string (untuk kasus `echo "hi"`)
     try {
         let s = str.replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');
         let out = '';
         let inString = false,
             escapeNext = false;
         for (let i = 0; i < s.length; i++) {
             const ch = s[i];
             if (escapeNext) {
                 out += ch;
                 escapeNext = false;
                 continue;
             }
             if (ch === '\\') {
                 out += ch;
                 escapeNext = true;
                 continue;
             }
             if (ch === '"') {
                 if (!inString) {
                     inString = true;
                     out += ch;
                     continue;
                 }
                 let j = i + 1;
                 while (j < s.length && /\s/.test(s[j])) j++;
                 const next = s[j];
                 if (next === ':' || next === ',' || next === '}' || next === ']' || next === undefined) {
                     inString = false;
                     out += ch;
                 } else {
                     out += '\\"';
                 }
                 continue;
             }
             out += ch;
         }
         return JSON.parse(out);
     } catch (e) {}

     return null;
 }

 function sanitizeToolCall(tc) {
     const fixed = { name: tc.name, input: Object.assign({}, tc.input || {}) };

     // Fix Glob: pattern tanpa * → tambah *
     if (fixed.name === 'Glob' && typeof fixed.input.pattern === 'string' && fixed.input.pattern.indexOf('*') < 0) {
         const p = fixed.input.pattern.trim();
         if (p.startsWith('.')) {
             fixed.input.pattern = '*' + p;
         } else if (!p.includes('/') && !p.includes('.')) {
             fixed.input.pattern = '**/*.' + p;
         }
     }

     // Fix Grep: pattern kosong → tolak
     if (fixed.name === 'Grep' && (!fixed.input.pattern || fixed.input.pattern === '')) {
         return null;
     }

     // Fix Bash: forward slash untuk Windows path (Claude Code terima keduanya)
     if (fixed.name === 'Bash' && typeof fixed.input.command === 'string') {
         fixed.input.command = fixed.input.command.replace(/C:\\\\/g, 'C:/').replace(/C:\\/g, 'C:/');
     }

     return fixed;
 }

 function extractToolCallsFromText(text) {
     const calls = [];
     const regex = /<\s*TOOL_CALL\s*>\s*([\s\S]*?)\s*<\s*\/\s*TOOL_CALL\s*>/gi;
     let m;
     while ((m = regex.exec(text)) !== null) {
         const parsed = tryParseJSON(m[1].trim());
         if (parsed) {
             const arr = Array.isArray(parsed) ? parsed : [parsed];
             for (const x of arr) {
                 if (x && (x.tool || x.name)) {
                     const sanitized = sanitizeToolCall({
                         name: x.tool || x.name,
                         input: x.arguments || x.input || {},
                     });
                     if (sanitized) calls.push(sanitized);
                 }
             }
         }
     }
     const cleaned = text.replace(regex, '').trim();
     return { calls, text: cleaned };
 }

 class StreamParser {
     constructor(onText) {
         this.onText = onText;
         this.buf = '';
         this.mode = 'text';
         this.toolBuf = '';
         this.toolBlocks = [];
         this.textOut = '';
         this.sawToolMarkup = false;
         this.incompleteToolBlock = false;
     }
     feed(chunk) {
         if (!chunk) return;
         this.buf += chunk;
         this._process();
     }
     _emitText(t) {
         if (!t) return;
         this.textOut += t;
         this.onText(t);
     }
     _process() {
         for (;;) {
             if (this.mode === 'text') {
                 const m = this.buf.match(OPEN_RE);
                 if (m) {
                     this.sawToolMarkup = true;
                     this._emitText(this.buf.slice(0, m.index));
                     this.buf = this.buf.slice(m.index + m[0].length);
                     this.mode = 'tool';
                     this.toolBuf = '';
                     continue;
                 }
                 const hold = holdbackLen(this.buf);
                 const cut = this.buf.length - hold;
                 if (cut > 0) {
                     this._emitText(this.buf.slice(0, cut));
                     this.buf = this.buf.slice(cut);
                 }
                 return;
             }
             if (this.mode === 'tool') {
                 const m = this.buf.match(CLOSE_RE);
                 if (m) {
                     this.toolBuf += this.buf.slice(0, m.index);
                     this.buf = this.buf.slice(m.index + m[0].length);
                     this.toolBlocks.push(this.toolBuf);
                     this.toolBuf = '';
                     this.mode = 'text';
                     continue;
                 }
                 this.toolBuf += this.buf;
                 this.buf = '';
                 return;
             }
         }
     }
     finish() {
         if (this.mode === 'text' && this.buf) {
             this._emitText(this.buf);
             this.buf = '';
         } else if (this.mode === 'tool') {
             // Preserve an unterminated payload for parsing/retry, not as user-facing text.
             this.incompleteToolBlock = true;
             this.toolBlocks.push(this.toolBuf);
             this.toolBuf = '';
             this.buf = '';
             this.mode = 'text';
         }
     }
     toolCalls() {
         const out = [];
         const seen = {};
         for (const raw of this.toolBlocks) {
             const parsed = tryParseJSON(raw.trim());
             if (!parsed) continue;
             const arr = Array.isArray(parsed) ? parsed : [parsed];
             for (const x of arr) {
                 if (!x) continue;
                 const name = x.tool || x.name;
                 const input = x.arguments || x.input || {};
                 if (typeof name === 'string' && name) {
                     const sanitized = sanitizeToolCall({ name, input });
                     if (sanitized) {
                         // Dedupe: hindari block duplikat dari model
                         const sig = sanitized.name + '|' + JSON.stringify(sanitized.input);
                         if (!seen[sig]) {
                             seen[sig] = true;
                             out.push(sanitized);
                         }
                     }
                 }
             }
         }
         return out;
     }
 }

module.exports = { StreamParser, tryParseJSON, tryParseJSON_v1, sanitizeToolCall, extractToolCallsFromText, holdbackLen, OPEN_RE, CLOSE_RE };
