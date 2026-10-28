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

test('keeps DSML tool-call output unchanged', async (t) => {
    await withBrowser(t, async (browser) => {
        const page = await browser.newPage();
        const dsml = '<｜DSML｜ calls><｜DSML｜ invoke name="Read"><｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
        await page.setContent(
            '<div data-virtual-list-item-key="answer-1"><div class="ds-assistant-message-main-content">' +
            '<div class="ds-markdown"><p>' + dsml + '</p></div></div></div>'
        );
        const state = await page.evaluate(readStateInPage, { final: true });
        assert.equal(state.answerMarkdown, dsml);
        assert.equal(state.answerIsProtocol, true);
    });
});
