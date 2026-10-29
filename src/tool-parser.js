'use strict';

 const LEGACY_OPEN_RE = /<\s*TOOL_CALL\s*>/i;
 const LEGACY_CLOSE_RE = /<\s*\/\s*TOOL_CALL\s*>/i;
 const DSML_CALLS_OPEN_RE = /<\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls)\s*>/i;
 const DSML_CALLS_CLOSE_RE = /<\s*\/\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls)\s*>/i;
 const OPEN_RE = /<\s*TOOL_CALL\s*>|<\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls)\s*>/i;
 const CLOSE_RE = DSML_CALLS_CLOSE_RE;
 const DSML_CALLS_BLOCK_RE = /<\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls)\s*>([\s\S]*?)<\s*\/\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls)\s*>/gi;
 const DSML_INVOKE_RE_SOURCE = '<\\s*[｜|]{1,2}\\s*DSML\\s*[｜|]{1,2}\\s*invoke\\b([^>]*)>([\\s\\S]*?)<\\s*\\/\\s*[｜|]{1,2}\\s*DSML\\s*[｜|]{1,2}\\s*(?:invoke)?\\s*>';
 const DSML_PARAMETER_RE_SOURCE = '<\\s*[｜|]{1,2}\\s*DSML\\s*[｜|]{1,2}\\s*parameter\\b([^>]*)>([\\s\\S]*?)<\\s*\\/\\s*[｜|]{1,2}\\s*DSML\\s*[｜|]{1,2}\\s*parameter\\s*>';
 const DSML_ORPHAN_TAG_RE = /<\s*\/?\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:(?:tool_calls|calls|invoke|parameter)\b[^>]*)?>/gi;

 function holdbackLen(s) {
     const max = Math.min(s.length, 48);
     const markers = [
         '<TOOL_CALL>',
         '<｜DSML｜tool_calls>',
         '<｜DSML｜ calls>',
         '<｜DSML｜calls>',
         '<｜｜DSML｜｜tool_calls>',
         '<｜｜DSML｜｜ calls>',
         '<｜｜DSML｜｜calls>',
         '<|DSML|tool_calls>',
         '<|DSML| calls>',
         '<||DSML||tool_calls>',
         '<||DSML|| calls>',
     ].map((marker) => marker.toLowerCase().replace(/\s+/g, ''));
     for (let len = max; len > 0; len--) {
         const tail = s.slice(-len).toLowerCase().replace(/\s+/g, '');
         if (markers.some((marker) => tail.length <= marker.length && marker.startsWith(tail))) {
             return len;
         }
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
     if (typeof str !== 'string') return null;
     str = str.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
     if (/^json\s*(?=\{|\[)/i.test(str)) str = str.replace(/^json\s*/i, '');
     // 1. Coba langsung
     try { return JSON.parse(str); } catch (e) {}

     // 2. Repair Windows paths: \\X is invalid JSON when X is not a valid escape character.
     //    Valid JSON escapes: \" \\ \/ \b \f \n \r \t \uXXXX
     try {
         const fixed = str.replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');
         return JSON.parse(fixed);
     } catch (e) {}

     // 3. Quote unquoted object keys and repair backslashes.
     try {
         let s = str.replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');
         s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
         return JSON.parse(s);
     } catch (e) {}

     // 4. Remove trailing commas and repair backslashes.
     try {
         let s = str.replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');
         s = s.replace(/,\s*([}\]])/g, '$1');
         return JSON.parse(s);
     } catch (e) {}

     // 5. Heuristic: escape quotes inside strings (for example, `echo \"hi\"`).
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
     if (!tc || typeof tc.name !== 'string' || !tc.name.trim()) return null;
     if (tc.input !== undefined &&
         (tc.input === null || typeof tc.input !== 'object' || Array.isArray(tc.input))) return null;
     const fixed = { name: tc.name, input: { ...(tc.input || {}) } };

     // Fix Glob: prepend a wildcard when the pattern has no asterisk.
     if (fixed.name === 'Glob' && typeof fixed.input.pattern === 'string' && fixed.input.pattern.indexOf('*') < 0) {
         const p = fixed.input.pattern.trim();
         if (p.startsWith('.')) {
             fixed.input.pattern = '*' + p;
         } else if (!p.includes('/') && !p.includes('.')) {
             fixed.input.pattern = '**/*.' + p;
         }
     }

     // Fix Grep: reject an empty pattern.
     if (fixed.name === 'Grep' && (!fixed.input.pattern || fixed.input.pattern === '')) {
         return null;
     }

     // Fix Bash: use forward slashes in Windows paths (Claude Code accepts either form).
     if (fixed.name === 'Bash' && typeof fixed.input.command === 'string') {
         fixed.input.command = fixed.input.command.replace(/C:\\\\/g, 'C:/').replace(/C:\\/g, 'C:/');
     }

     return fixed;
 }

 function readDsmlAttribute(attributes, name) {
     const matches = attributes.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*("([^"]*)"|'([^']*)')/g);
     for (const match of matches) {
         if (match[1].toLowerCase() === name.toLowerCase()) {
             return match[3] !== undefined ? match[3] : match[4];
         }
     }
     return null;
 }

 function stripDsmlTags(text) {
     return typeof text === 'string' ? text.replace(DSML_ORPHAN_TAG_RE, '') : '';
 }

 function parseDsmlToolBlock(raw) {
     const calls = [];
     const errors = [];
     const invokeRe = new RegExp(DSML_INVOKE_RE_SOURCE, 'gi');
     let match;
     let consumed = 0;

     while ((match = invokeRe.exec(raw)) !== null) {
         if (raw.slice(consumed, match.index).trim()) {
             errors.push('Unexpected content between DSML invoke blocks.');
         }
         consumed = invokeRe.lastIndex;
         const toolName = readDsmlAttribute(match[1], 'name');
         if (!toolName || !toolName.trim()) {
             errors.push('DSML invoke is missing a valid name attribute.');
             continue;
         }

         const body = match[2];
         const parameterRe = new RegExp(DSML_PARAMETER_RE_SOURCE, 'gi');
         const parameters = [...body.matchAll(parameterRe)];
         const remainder = body.replace(new RegExp(DSML_PARAMETER_RE_SOURCE, 'gi'), '').trim();
         const input = Object.create(null);
         let valid = true;
         if (remainder) {
             errors.push('Unexpected content inside DSML invoke for tool "' + toolName + '".');
             valid = false;
         }

         for (const parameter of parameters) {
             const parameterName = readDsmlAttribute(parameter[1], 'name');
             const stringFlag = readDsmlAttribute(parameter[1], 'string');
             const rawValue = parameter[2];
             if (!parameterName || !parameterName.trim()) {
                 errors.push('DSML parameter is missing a valid name attribute for tool "' + toolName + '".');
                 valid = false;
                 continue;
             }
             if (Object.prototype.hasOwnProperty.call(input, parameterName)) {
                 errors.push('Duplicate DSML parameter "' + parameterName + '" for tool "' + toolName + '".');
                 valid = false;
                 continue;
             }
             if (stringFlag !== 'true' && stringFlag !== 'false') {
                 errors.push('DSML parameter "' + parameterName + '" must declare string="true" or string="false".');
                 valid = false;
                 continue;
             }

             if (stringFlag === 'true') {
                 input[parameterName] = rawValue;
             } else {
                 try {
                     input[parameterName] = JSON.parse(rawValue.trim());
                 } catch (error) {
                     errors.push('DSML parameter "' + parameterName + '" contains invalid JSON: ' + (error.message || 'parse error'));
                     valid = false;
                 }
             }
         }

         if (valid) {
             const sanitized = sanitizeToolCall({ name: toolName, input });
             if (sanitized) calls.push(sanitized);
             else errors.push('DSML arguments were rejected by the tool-call sanitizer for tool "' + toolName + '".');
         }
     }

     if (consumed === 0) {
         errors.push('DSML calls block did not contain a complete invoke block.');
     } else if (raw.slice(consumed).trim()) {
         errors.push('Unexpected trailing content in DSML calls block.');
     }
     return { calls, errors };
 }

 function extractToolCallsFromText(text) {
     const calls = [];
     const errors = [];
     const seen = new Set();
     const addCall = (call) => {
         const signature = call.name + '|' + JSON.stringify(call.input || {});
         if (!seen.has(signature)) {
             seen.add(signature);
             calls.push(call);
         }
     };

     const legacyRegex = /<\s*TOOL_CALL\s*>[\s\S]*?(?:<\s*\/\s*TOOL_CALL\s*>|$)/gi;
     let cleaned = text.replace(legacyRegex, () => {
         errors.push('Legacy <TOOL_CALL> JSON is disabled; use DeepSeek DSML calls/invoke/parameter tags.');
         return '';
     });
     cleaned = cleaned.replace(/<\s*\/\s*TOOL_CALL\s*>/gi, '');

     let completeCallsBlocks = 0;
     cleaned = cleaned.replace(DSML_CALLS_BLOCK_RE, (_, payload) => {
         completeCallsBlocks++;
         const parsed = parseDsmlToolBlock(payload);
         for (const call of parsed.calls) addCall(call);
         errors.push(...parsed.errors);
         return '';
     });

     // Recover invoke blocks even when the model omits the outer calls wrapper.
     // Such output is still flagged as a malformed DSML attempt by the caller.
     let nakedInvokeCount = 0;
     const invokeRe = new RegExp(DSML_INVOKE_RE_SOURCE, 'gi');
     cleaned = cleaned.replace(invokeRe, (wholeInvoke) => {
         nakedInvokeCount++;
         const parsed = parseDsmlToolBlock(wholeInvoke);
         for (const call of parsed.calls) addCall(call);
         errors.push(...parsed.errors);
         return '';
     });
     if (nakedInvokeCount > 0 && /<\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls)\s*>/i.test(cleaned)) {
         errors.push('DSML calls wrapper was opened but not closed.');
     }
     if (nakedInvokeCount === 0 && /<\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls|invoke|parameter)\b/i.test(cleaned)) {
         errors.push('DSML markup was present but no complete invoke could be parsed.');
     }

     cleaned = stripDsmlTags(cleaned);
     return { calls, text: cleaned.trim(), errors, completeCallsBlocks };
 }


 class StreamParser {
     constructor(onText) {
         this.onText = onText;
         this.buf = '';
         this.mode = 'text';
         this.toolBuf = '';
         this.dsmlToolBlocks = [];
         this.disallowedLegacyBlocks = [];
         this.blockFormat = 'dsml';
         this._toolCallsCache = null;
         this.parseErrors = [];
         this.textOut = '';
         this.sawToolMarkup = false;
         this.sawUnsupportedToolMarkup = false;
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
                     this.blockFormat = /DSML/i.test(m[0]) ? 'dsml' : 'legacy';
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
                 const closingRe = this.blockFormat === 'dsml' ? DSML_CALLS_CLOSE_RE : LEGACY_CLOSE_RE;
                 const m = this.buf.match(closingRe);
                 if (m) {
                     this.toolBuf += this.buf.slice(0, m.index);
                     this.buf = this.buf.slice(m.index + m[0].length);
                     if (this.blockFormat === 'dsml') {
                         this.dsmlToolBlocks.push(this.toolBuf);
                     } else {
                         this.disallowedLegacyBlocks.push(this.toolBuf);
                         this.sawUnsupportedToolMarkup = true;
                         this.parseErrors.push({
                             chars: this.toolBuf.length,
                             reason: 'Legacy <TOOL_CALL> JSON is disabled; use DeepSeek DSML calls/invoke/parameter tags.',
                         });
                     }
                     this.toolBuf = '';
                     this.blockFormat = 'dsml';
                     this.mode = 'text';
                     continue;
                 }
                 // Keep a suffix buffered because a DSML closing marker can be split
                 // across successive DOM polls. Without this holdback, a partial delimiter
                 // may be mistaken for argument content.
                 const hold = Math.min(this.buf.length, 32);
                 const cut = this.buf.length - hold;
                 if (cut > 0) {
                     this.toolBuf += this.buf.slice(0, cut);
                     this.buf = this.buf.slice(cut);
                 }
                 return;
             }
         }
     }
     finish() {
         if (this.mode === 'text' && this.buf) {
             this._emitText(this.buf);
             this.buf = '';
         } else if (this.mode === 'tool') {
             const raw = this.toolBuf + this.buf;
             const closingRe = this.blockFormat === 'dsml' ? DSML_CALLS_CLOSE_RE : LEGACY_CLOSE_RE;
             const close = raw.match(closingRe);
             const isClosed = Boolean(close && close.index + close[0].length === raw.length);
             const payload = isClosed ? raw.slice(0, close.index) : raw;
             if (this.blockFormat === 'dsml') {
                 this.dsmlToolBlocks.push(payload);
             } else {
                 this.disallowedLegacyBlocks.push(payload);
                 this.sawUnsupportedToolMarkup = true;
                 this.parseErrors.push({
                     chars: payload.length,
                     reason: 'Legacy <TOOL_CALL> JSON is disabled; use DeepSeek DSML calls/invoke/parameter tags.',
                 });
             }
             this.incompleteToolBlock = !isClosed;
             this.toolBuf = '';
             this.buf = '';
             this.blockFormat = 'dsml';
             this.mode = 'text';
         }
     }
     toolCalls() {
         if (this._toolCallsCache) return this._toolCallsCache.map((call) => ({
             name: call.name,
             input: { ...call.input },
         }));

         const out = [];
         const seen = new Set();
         const addCall = (call) => {
             const signature = call.name + '|' + JSON.stringify(call.input || {});
             if (!seen.has(signature)) {
                 seen.add(signature);
                 out.push(call);
             }
         };

         for (const raw of this.dsmlToolBlocks) {
             const parsed = parseDsmlToolBlock(raw);
             for (const call of parsed.calls) addCall(call);
             for (const reason of parsed.errors) {
                 this.parseErrors.push({ chars: raw.length, reason });
             }
         }

         this.textOut = stripDsmlTags(this.textOut);
         this._toolCallsCache = out.map((call) => ({ name: call.name, input: { ...call.input } }));
         return out;
     }

 }

function parseToolCallsFromText(text) {
    if (typeof text !== 'string') {
        return { calls: [], text: '', invalidToolCall: true, parseErrors: [], extractionErrors: [] };
    }

    const parser = new StreamParser(() => {});
    parser.feed(text);
    parser.finish();

    const sawDsmlMarkup = /<\s*\/?\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls|invoke|parameter)\b/i.test(text);
    let calls = parser.toolCalls();
    let cleanedText = parser.textOut;
    let extractionErrors = [];

    if (calls.length === 0 && (cleanedText || sawDsmlMarkup)) {
        const extractionSource = sawDsmlMarkup ? text : cleanedText;
        const extracted = extractToolCallsFromText(extractionSource);
        if (extracted.calls.length > 0) calls = extracted.calls;
        cleanedText = extracted.text;
        extractionErrors = Array.isArray(extracted.errors) ? extracted.errors : [];
    }

    const invalidToolCall = (parser.sawToolMarkup &&
        (calls.length === 0 || parser.parseErrors.length > 0)) ||
        (sawDsmlMarkup &&
            (calls.length === 0 || parser.parseErrors.length > 0 || extractionErrors.length > 0));

    return {
        calls,
        text: cleanedText.trim(),
        invalidToolCall,
        parseErrors: parser.parseErrors.slice(),
        extractionErrors,
    };
}


module.exports = { StreamParser, tryParseJSON, tryParseJSON_v1, sanitizeToolCall, extractToolCallsFromText, holdbackLen, OPEN_RE, CLOSE_RE, parseDsmlToolBlock, stripDsmlTags, parseToolCallsFromText };
