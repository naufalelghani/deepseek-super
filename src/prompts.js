'use strict';

const { blocksOf, flattenContent, renderMessage } = require('./content');

 function toolsToPrompt(tools) {
     if (!tools || !tools.length) return '';
     const lines = [];
     lines.push('Kamu punya akses ke tools yang disediakan client. Ini satu-satunya cara memakai tool.');
     lines.push('');
     for (const t of tools) {
         const schema = t.input_schema || t.parameters || {};
         const props = schema.properties || {};
         const req = schema.required || [];
         const params = Object.keys(props).map((k) => {
             const v = props[k] || {};
             return `${k}${req.indexOf(k) >= 0 ? '*' : ''}: ${v.type || 'any'}` +
                 (v.description ? ` (${v.description})` : '');
         }).join('; ');
         lines.push(`- ${t.name}(${params}): ${t.description || ''}`);
     }
     lines.push('');
     lines.push('ATURAN WAJIB:');
     lines.push('1. Jika user bertanya hal yang relevan dengan salah satu tool di atas, WAJIB panggil tool tersebut.');
     lines.push('2. JANGAN menjawab dari pengetahuan sendiri jika ada tool yang cocok.');
     lines.push('3. Format SATU tool: <TOOL_CALL>{"tool":"<nama>","arguments":{...}}</TOOL_CALL>');
     lines.push('4. Format BEBERAPA tool: <TOOL_CALL>[{...},{...}]</TOOL_CALL>');
     lines.push('5. JANGAN tulis apapun di luar tag <TOOL_CALL> saat memanggil tool.');
     lines.push('6. Jawab teks biasa HANYA jika tidak ada tool yang relevan.');
     lines.push('7. WAJIB escape setiap tanda kutip ganda (") di dalam nilai string JSON sebagai \\"');
     lines.push('   Contoh BENAR: {"tool":"Bash","arguments":{"command":"cd \\"C:/path\\" && ls"}}');
     lines.push('   Contoh SALAH: {"tool":"Bash","arguments":{"command":"cd "C:/path" && ls"}}');
     lines.push('8. JANGAN pakai backtick atau single quote sebagai pengganti escape.');
     lines.push('');
     lines.push('CONTOH ? user butuh tool:');
     lines.push(`User: "tolong bantu saya dengan ${tools[0].name}"`);
     lines.push(`Assistant: <TOOL_CALL>{"tool":"${tools[0].name}","arguments":{...}}</TOOL_CALL>`);
     lines.push('');
     lines.push('CONTOH ? tidak butuh tool:');
     lines.push('User: "siapa kamu?"');
     lines.push('Assistant: Saya adalah agent yang siap membantu...');
     return lines.join('\n');
 }

 function buildFullPrompt(system, messages, tools) {
     const parts = [];
     if (system) parts.push('### SYSTEM\n' + flattenContent(system));

     const last = messages[messages.length - 1] || { role: 'user', content: '' };
     const lastHasToolResult = blocksOf(last.content).some((b) => b.type === 'tool_result');

     // HANYA sertakan tools kalau turn ini BUKAN tool_result
     if (!lastHasToolResult) {
         const tp = toolsToPrompt(tools);
         if (tp) parts.push('### TOOLS\n' + tp);
     }

     const history = messages.slice(0, -1);
     if (history.length) {
         parts.push('### RIWAYAT PERCAKAPAN');
         for (const m of history) {
             parts.push(`[${m.role === 'assistant' ? 'ASSISTANT' : 'USER'}]\n${renderMessage(m)}`);
         }
     }

     if (lastHasToolResult) {
         parts.push('=== HASIL TOOL ===\n' + renderMessage(last));
         parts.push('=== INSTRUKSI WAJIB ===\nJawab user SEKARANG dalam teks biasa berdasarkan data di atas. JANGAN menulis <TOOL_CALL> atau tag apapun.');
     } else {
         parts.push('### PESAN TERBARU\n' + renderMessage(last));
         parts.push('Jawab sebagai ASSISTANT. Jika memanggil tool, gunakan format <TOOL_CALL>...</TOOL_CALL> saja.');
     }
     return parts.join('\n\n');
 }

 function buildResumePrompt(system, messages, tools, isToolResultTurn) {
     const last = messages[messages.length - 1] || { role: 'user', content: '' };
     if (isToolResultTurn) {
         return [
             '=== SITUASI ===',
             'Kamu SUDAH memanggil tool. Hasilnya sudah tersedia di bawah.',
             'JANGAN memanggil tool lagi. JANGAN mengulang tool call sebelumnya.',
             '',
             '=== HASIL TOOL ===',
             renderMessage(last),
             '',
             '=== INSTRUKSI WAJIB ===',
             'Jawab user SEKARANG dalam teks biasa berdasarkan data di atas.',
             'JANGAN menulis <TOOL_CALL> atau tag apapun.',
             'JANGAN memanggil tool apa pun.',
         ].join('\n');
     }
     return renderMessage(last);
 }
 function parseToolChoice(toolChoice) {
     if (!toolChoice) return { mode: 'auto' };
     if (typeof toolChoice === 'string') return { mode: toolChoice };
     if (toolChoice.type === 'tool' && toolChoice.name) {
         return { mode: 'tool', name: toolChoice.name };
     }
     return { mode: toolChoice.type || 'auto' };
 }

 function applyForcedTool(prompt, force) {
     if (force.mode === 'none') {
         return [
             '=== STOP: JANGAN PANGGIL TOOL ===',
             'Berdasarkan SEMUA informasi yang sudah ada di konteks di atas,',
             'jawab user SEKARANG dalam teks biasa.',
             '',
             'ATURAN WAJIB:',
             '1. JANGAN menulis <TOOL_CALL> atau tag apapun.',
             '2. JANGAN memanggil tool. Semua tool dinonaktifkan untuk turn ini.',
             '3. Jika informasi tidak lengkap, jawab dengan yang ada + sebutkan keterbatasan.',
             '4. Jawab dalam bahasa user.',
             '',
             prompt,
         ].join('\n');
     }
     if (force.mode === 'tool') {
         return '[WAJIB: Panggil tool "' + force.name + '" SEKARANG. Balas HANYA dengan ' +
             '<TOOL_CALL>{"tool":"' + force.name + '","arguments":{...}}</TOOL_CALL>]\n\n' + prompt;
     }
     if (force.mode === 'any') {
         return '[WAJIB: Panggil minimal satu tool dari daftar di bawah. JANGAN jawab teks biasa.]\n\n' + prompt;
     }
     return prompt;
 }

 function synthesizeToolCall(force, tools) {
     const makeInput = (spec) => {
         const input = {};
         const props = (spec.input_schema && spec.input_schema.properties) || {};
         for (const k of Object.keys(props)) {
             const t = props[k].type;
             input[k] = t === 'number' ? 0 : t === 'boolean' ? false : t === 'array' ? [] : t === 'object' ? {} : '';
         }
         return input;
     };
     if (force.mode === 'tool') {
         const spec = tools.find((t) => t.name === force.name);
         if (!spec) return null;
         return { name: force.name, input: makeInput(spec) };
     }
     if (force.mode === 'any' && tools.length > 0) {
         const spec = tools[0];
         return { name: spec.name, input: makeInput(spec) };
     }
     return null;
 }

module.exports = { toolsToPrompt, buildFullPrompt, buildResumePrompt, parseToolChoice, applyForcedTool, synthesizeToolCall };
