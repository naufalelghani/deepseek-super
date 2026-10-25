'use strict';

const { blocksOf, flattenContent, renderMessage } = require('./content');

const TOOL_RESULT_INSTRUCTIONS = [
    'Jawab berdasarkan hasil tool yang benar-benar diterima. Jangan mengklaim berhasil jika hasil tool tidak mengonfirmasinya.',
    'Jika seluruh tugas sudah selesai dan user meminta output mentah dari perintah sederhana, keluarkan hasilnya saja bila hasilnya satu baris atau beberapa baris.',
    'Untuk output mentah tersebut, jangan tambahkan pengantar atau penjelasan jika tidak diminta.',
    'Jangan bungkus output mentah dengan Markdown code fence, backtick, atau label bahasa seperti text.',
    'Jika hasil yang diterima belum cukup untuk menyelesaikan tugas, lanjutkan dengan tool lain yang diperlukan dari daftar tersedia.',
    'Jangan panggil tool lagi jika tugas sudah selesai. Jika tool gagal, laporkan error yang benar-benar diterima.'
];

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
     lines.push('1. Jika tugas memerlukan file, shell, pencarian, atau aksi yang dapat dilakukan oleh salah satu tool di atas, WAJIB gunakan tool yang sesuai.');
     lines.push('2. Jika hasil tool yang sudah diterima cukup untuk menyelesaikan tugas, jawab final tanpa memanggil tool lagi. Jika belum cukup, lanjutkan dengan tool berikutnya.');
     lines.push('3. Format SATU tool: <TOOL_CALL>{"tool":"<nama>","arguments":{...}}</TOOL_CALL>');
     lines.push('4. Format BEBERAPA tool: <TOOL_CALL>[{...},{...}]</TOOL_CALL>');
     lines.push('5. JANGAN tulis apapun di luar tag <TOOL_CALL> saat memanggil tool.');
     lines.push('6. Jawab teks biasa jika tugas sudah selesai atau tidak memerlukan tool tambahan.');
     lines.push('7. Semua string dan key harus mengikuti JSON valid. Escape tanda kutip ganda di dalam nilai string dengan aturan JSON standar.');
     lines.push('8. Jangan gunakan backtick atau single quote sebagai pengganti escape JSON.');
     lines.push('');
     lines.push('CONTOH TOOL CALL VALID:');
     lines.push('<TOOL_CALL>{"tool":"Bash","arguments":{"command":"pwd"}}</TOOL_CALL>');
     lines.push('Contoh ini hanya menunjukkan format. Pilih tool dan argumen sesuai permintaan user.');
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

     // Keep tool schemas available on every turn so the model can continue a multi-step task.
     const tp = toolsToPrompt(tools);
     if (tp) parts.push('### TOOLS\n' + tp);

     const history = messages.slice(0, -1);
     if (history.length) {
         parts.push('### RIWAYAT PERCAKAPAN');
         for (const m of history) {
             parts.push(`[${m.role === 'assistant' ? 'ASSISTANT' : 'USER'}]\n${renderMessage(m)}`);
         }
     }

     if (lastHasToolResult) {
         parts.push('=== HASIL TOOL ===\n' + renderMessage(last));
         parts.push([
             '=== INSTRUKSI SETELAH HASIL TOOL ===',
             ...TOOL_RESULT_INSTRUCTIONS,
             'Jika tugas masih memerlukan tindakan, panggil tool berikutnya dengan format <TOOL_CALL>...</TOOL_CALL> dan JSON valid.',
             'Jika tugas sudah selesai, berikan jawaban final tanpa tag tool.',
         ].join('\n'));
     } else {
         parts.push('### PESAN TERBARU\n' + renderMessage(last));
         parts.push('Jawab sebagai ASSISTANT. Jika memanggil tool, gunakan format <TOOL_CALL>...</TOOL_CALL> saja.');
     }
     return parts.join('\n\n');
 }

 function buildResumePrompt(system, messages, tools, isToolResultTurn) {
     const last = messages[messages.length - 1] || { role: 'user', content: '' };
     if (isToolResultTurn) {
         const toolPrompt = toolsToPrompt(tools);
         const parts = [];
         if (system) parts.push('### SYSTEM\n' + flattenContent(system));
         parts.push('=== SITUASI ===');
         parts.push('Client telah menjalankan tool dan mengirim hasilnya. Lanjutkan tugas awal yang tersimpan dalam konteks percakapan ini.');
         if (toolPrompt) parts.push('=== TOOLS AVAILABLE FOR THE NEXT STEP ===\n' + toolPrompt);
         parts.push('');
         parts.push('=== HASIL TOOL TERBARU ===');
         parts.push(renderMessage(last));
         parts.push('');
         parts.push('=== INSTRUKSI SETELAH HASIL TOOL ===');
         parts.push(...TOOL_RESULT_INSTRUCTIONS);
         parts.push('Jika tugas belum selesai, gunakan tool berikutnya yang diperlukan dengan format <TOOL_CALL>...</TOOL_CALL> dan JSON valid.');
         parts.push('Jika tugas sudah selesai, berikan jawaban final tanpa tag tool.');
         return parts.filter(Boolean).join('\n');
     }
     const parts = [];
     if (system) parts.push('### SYSTEM\n' + flattenContent(system));
     const toolPrompt = toolsToPrompt(tools);
     if (toolPrompt) {
         parts.push('=== TOOLS AVAILABLE FOR THIS REQUEST ===\n' + toolPrompt);
     }
     parts.push('=== NEW USER REQUEST ===\n' + renderMessage(last));
     parts.push([
         '=== INSTRUKSI UNTUK GILIRAN INI ===',
         'Evaluasi permintaan terbaru berdasarkan daftar tool yang disertakan tepat di atas.',
         'Jika permintaan memerlukan file, shell, pencarian, atau aksi yang dapat dilakukan oleh salah satu tool, WAJIB panggil tool yang paling sesuai sekarang.',
         'Jangan mengklaim tool tidak tersedia dan jangan memberi langkah manual sebagai pengganti jika tool yang sesuai ada di daftar.',
         'Untuk tool call, keluarkan hanya format <TOOL_CALL>{"tool":"<nama-tool>","arguments":{...}}</TOOL_CALL> dengan JSON valid.',
         'Jangan menjawab hasil pembacaan atau eksekusi sebelum tool benar-benar dipanggil dan hasilnya diterima.'
     ].join('\n'));
     return parts.join('\n\n');
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
