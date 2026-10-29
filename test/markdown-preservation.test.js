'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { readStateInPage } = require('../src/browser-dom');

async function withBrowser(t, fn) {
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (error) {
        t.skip('Playwright browser unavailable: ' + error.message);
        return;
    }
    try {
        await fn(browser);
    } finally {
        await browser.close();
    }
}

test('preserves Markdown formatting and table structure from the rendered DOM', async (t) => {
    await withBrowser(t, async (browser) => {
        const page = await browser.newPage();
        await page.setContent([
            '<div data-virtual-list-item-key="answer-1"><div class="ds-assistant-message-main-content">',
            '<div class="ds-markdown"><h2>Model provider</h2>',
            '<p>A <strong>bold</strong> and <em>italic</em> example with <code>code</code>.</p>',
            '<table><thead><tr><th>Provider</th><th>Auth</th></tr></thead><tbody>',
            '<tr><td>Anthropic</td><td>OAuth</td></tr><tr><td>OpenAI Codex</td><td>OpenAI OAuth</td></tr>',
            '</tbody></table><ul><li>First</li><li>Second</li></ul>',
            '<pre><code class="language-js">const answer = 42;</code></pre></div></div></div>'
        ].join(''));
        const state = await page.evaluate(readStateInPage, { final: true });
        assert.match(state.answerMarkdown, /^## Model provider/m);
        assert.match(state.answerMarkdown, /\*\*bold\*\*/);
        assert.match(state.answerMarkdown, /\*italic\*/);
        assert.match(state.answerMarkdown, /\x60code\x60/);
        assert.match(state.answerMarkdown, /\| Provider \| Auth \|/);
        assert.match(state.answerMarkdown, /\| --- \| --- \|/);
        assert.match(state.answerMarkdown, /\| Anthropic \| OAuth \|/);
        assert.match(state.answerMarkdown, /- First\n- Second/);
        assert.match(state.answerMarkdown, /\x60{3}js\nconst answer = 42;\n\x60{3}/);
    });
});

test('streams complete blocks only, keeping the stable Markdown prefix append-only', async (t) => {
    await withBrowser(t, async (browser) => {
        const page = await browser.newPage();
        await page.setContent([
            '<div data-virtual-list-item-key="answer-1"><div class="ds-assistant-message-main-content">',
            '<div class="ds-markdown"><h2>Title</h2><p>Completed <strong>paragraph</strong>.</p>',
            '<table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>',
            '</div></div></div>'
        ].join(''));
        const before = await page.evaluate(readStateInPage, { final: false });
        assert.match(before.answerMarkdownStable, /^## Title\n\n/);
        assert.match(before.answerMarkdownStable, /\*\*paragraph\*\*/);
        assert.doesNotMatch(before.answerMarkdownStable, /\| Name \| Value \|/);
        await page.locator('.ds-markdown').evaluate((root) => {
            const paragraph = document.createElement('p');
            paragraph.textContent = 'Next block.';
            root.appendChild(paragraph);
        });
        const after = await page.evaluate(readStateInPage, { final: false });
        assert.ok(after.answerMarkdownStable.startsWith(before.answerMarkdownStable));
        assert.match(after.answerMarkdownStable, /\| Name \| Value \|/);
    });
});

test('preserves Markdown tables inside mixed DSML Write tool-call output', async (t) => {
    await withBrowser(t, async (browser) => {
        const page = await browser.newPage();
        const opening = '<｜DSML｜ calls><｜DSML｜ invoke name="Write">' +
            '<｜DSML｜ parameter name="file_path" string="true">plan.md</｜DSML｜ parameter>' +
            '<｜DSML｜ parameter name="content" string="true"># Plan: Web AI Chat Streaming\n\n';
        const closing = '\n</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
        const escapeHTML = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        await page.setContent([
            '<div data-virtual-list-item-key="answer-1"><div class="ds-assistant-message-main-content">',
            '<div class="ds-markdown"><p>' + escapeHTML(opening + 'Daftar isi') + '</p>',
            '<table><thead><tr><th>No</th><th>Bagian</th><th>Isi utama</th></tr></thead><tbody>',
            '<tr><td>1</td><td>Ringkasan eksekutif</td><td>Keputusan stack</td></tr>',
            '<tr><td>2</td><td>Analisa pengguna</td><td>Segmen, jobs to be done</td></tr>',
            '</tbody></table><p>' + escapeHTML(closing) + '</p></div></div></div>'
        ].join(''));

        const state = await page.evaluate(readStateInPage, { final: true });
        assert.equal(state.answerIsProtocol, true);
        assert.match(state.answerMarkdown, /<｜DSML｜ invoke name="Write">/);
        assert.match(state.answerMarkdown, /\| No \| Bagian \| Isi utama \|/);
        assert.match(state.answerMarkdown, /\| --- \| --- \| --- \|/);
        assert.match(state.answerMarkdown, /\| 1 \| Ringkasan eksekutif \| Keputusan stack \|/);

        const { parseToolCallsFromText } = require('../src/tool-parser');
        const parsed = parseToolCallsFromText(state.answerMarkdown);
        assert.equal(parsed.invalidToolCall, false);
        assert.equal(parsed.calls.length, 1);
        assert.equal(parsed.calls[0].name, 'Write');
        assert.match(parsed.calls[0].input.content, /\| No \| Bagian \| Isi utama \|/);
        assert.match(parsed.calls[0].input.content, /\| 2 \| Analisa pengguna \| Segmen, jobs to be done \|/);
    });
});

test('keeps DSML tool-call output unchanged', async (t) => {
    await withBrowser(t, async (browser) => {
        const page = await browser.newPage();
        const dsml = '<｜DSML｜ calls><｜DSML｜ invoke name="Read"><｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
        const escapedDsml = dsml.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        await page.setContent(
            '<div data-virtual-list-item-key="answer-1"><div class="ds-assistant-message-main-content">' +
            '<div class="ds-markdown"><p>' + escapedDsml + '</p></div></div></div>'
        );
        const state = await page.evaluate(readStateInPage, { final: true });
        assert.equal(state.answerMarkdown, dsml);
        assert.equal(state.answerIsProtocol, true);
    });
});
