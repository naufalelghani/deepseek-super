'use strict';

const { uuid } = require('./config');

 class StreamSink {
     constructor(res, model, inTokens) {
         this.res = res;
         this.model = model;
         this.index = -1;
         this.open = null;
         this.inTokens = inTokens;
         this.outChars = 0;
         this.msgId = uuid('msg');
         this.send('message_start', {
             type: 'message_start',
             message: {
                 id: this.msgId,
                 type: 'message',
                 role: 'assistant',
                 model,
                 content: [],
                 stop_reason: null,
                 stop_sequence: null,
                 usage: { input_tokens: inTokens, output_tokens: 0 },
             },
         });
     }
     send(event, data) {
         if (this.res.destroyed || this.res.writableEnded) return false;
         return this.res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
     }
     _closeOpen() {
         if (this.open !== null) {
             this.send('content_block_stop', { type: 'content_block_stop', index: this.index });
             this.open = null;
         }
     }
     stopBlock() { this._closeOpen(); }
     startThinking() {
         this._closeOpen();
         this.index++;
         this.open = 'thinking';
         this.send('content_block_start', {
             type: 'content_block_start',
             index: this.index,
             content_block: { type: 'thinking', thinking: '' },
         });
     }
     thinkingDelta(t) {
         if (!t) return;
         this.outChars += t.length;
         this.send('content_block_delta', {
             type: 'content_block_delta',
             index: this.index,
             delta: { type: 'thinking_delta', thinking: t },
         });
     }
     startText() {
         this._closeOpen();
         this.index++;
         this.open = 'text';
         this.send('content_block_start', {
             type: 'content_block_start',
             index: this.index,
             content_block: { type: 'text', text: '' },
         });
     }
     textDelta(t) {
         if (!t) return;
         this.outChars += t.length;
         this.send('content_block_delta', {
             type: 'content_block_delta',
             index: this.index,
             delta: { type: 'text_delta', text: t },
         });
     }
     emitText(text) {
         if (!text) return;
         this._closeOpen();
         this.index++;
         this.open = 'text';
         this.send('content_block_start', {
             type: 'content_block_start',
             index: this.index,
             content_block: { type: 'text', text: '' },
         });
         this.outChars += text.length;
         this.send('content_block_delta', {
             type: 'content_block_delta',
             index: this.index,
             delta: { type: 'text_delta', text },
         });
         this._closeOpen();
     }
     toolBlock(name, input) {
         this._closeOpen();
         this.index++;
         const id = uuid('toolu');
         this.open = 'tool';
         this.send('content_block_start', {
             type: 'content_block_start',
             index: this.index,
             content_block: { type: 'tool_use', id, name, input: {} },
         });
         const json = JSON.stringify(input || {});
         this.outChars += json.length;
         this.send('content_block_delta', {
             type: 'content_block_delta',
             index: this.index,
             delta: { type: 'input_json_delta', partial_json: json },
         });
     }
     finish(stopReason) {
         this._closeOpen();
         this.send('message_delta', {
             type: 'message_delta',
             delta: { stop_reason: stopReason, stop_sequence: null },
             usage: { output_tokens: Math.max(1, Math.ceil(this.outChars / 4)) },
         });
         this.send('message_stop', { type: 'message_stop' });
     }
 }

module.exports = { StreamSink };
