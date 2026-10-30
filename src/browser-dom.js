'use strict';

// Self-contained so Playwright can serialize this function into the page context.
function readStateInPage(options = {}) {
    const finalSnapshot = options.final === true;
    const items = document.querySelectorAll('[data-virtual-list-item-key]');
    let last = null;
    for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].querySelector('.ds-assistant-message-main-content')) {
            last = items[i];
            break;
        }
    }

    const stopSelector = [
        'button[aria-label*="stop" i]', 'button[title*="stop" i]',
        '[data-testid*="stop" i]', '[class*="stop" i]',
        'button[aria-label*="停止"]', 'button[title*="停止"]', '[data-testid*="停止"]'
    ].join(',');
    const isVisible = (element) => {
        if (!element || element.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
            Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const stopCandidates = Array.from(document.querySelectorAll(stopSelector));
    const stopButtonVisible = stopCandidates.some(isVisible);
    const primaryButton = document.querySelector('.bf38813a .ds-button--primary');
    const primaryLabel = primaryButton ? [
        primaryButton.getAttribute('aria-label') || '',
        primaryButton.getAttribute('title') || '',
        primaryButton.innerText || '',
        typeof primaryButton.className === 'string' ? primaryButton.className : '',
        Array.from(primaryButton.querySelectorAll('[aria-label],[title],svg,[class]'))
            .map((el) => [
                el.getAttribute('aria-label') || '', el.getAttribute('title') || '',
                typeof el.className === 'string' ? el.className : ''
            ].join(' ')).join(' ')
    ].join(' ') : '';
    const primaryIsStop = /stop|cancel|停止|取消/i.test(primaryLabel);
    const composerTextarea = document.querySelector('textarea[placeholder="Message DeepSeek"]');
    const composerTextareaVisible = isVisible(composerTextarea);
    const primaryButtonVisible = isVisible(primaryButton);
    // Composer readiness is separate from Send enabled state: after a response,
    // the empty textarea can correctly leave the Send button disabled.
    const composerReady = Boolean(composerTextareaVisible && primaryButtonVisible && !primaryIsStop);
    const isGenerating = stopButtonVisible || primaryIsStop;
    const sendButtonEnabled = Boolean(primaryButton && !primaryIsStop &&
        !primaryButton.classList.contains('ds-button--disabled') &&
        !primaryButton.hasAttribute('disabled') &&
        primaryButton.getAttribute('aria-disabled') !== 'true');
    const completionSignalAvailable = Boolean(primaryButton &&
        (stopCandidates.length > 0 || primaryIsStop));
    // Expose UI-state diagnostics for fallback logging without changing detection.
    const completionDebug = {
        primaryButtonFound: Boolean(primaryButton),
        primaryLabel: primaryLabel.replace(/\s+/g, ' ').trim().slice(0, 120),
        primaryIsStop,
        primaryDisabledClass: Boolean(primaryButton && primaryButton.classList.contains('ds-button--disabled')),
        primaryDisabledAttr: Boolean(primaryButton && primaryButton.hasAttribute('disabled')),
        primaryAriaDisabled: primaryButton ? primaryButton.getAttribute('aria-disabled') : null,
        stopCandidateCount: stopCandidates.length,
        stopButtonVisible,
        textareaFound: Boolean(composerTextarea),
        textareaVisible: composerTextareaVisible,
        primaryButtonVisible,
        composerReady
    };

    const thinkElement = last ? last.querySelector('.ds-think-content .ds-markdown') : null;
    const answerElement = last ? last.querySelector('.ds-assistant-message-main-content') : null;
    const think = thinkElement ? thinkElement.innerText : '';
    const answer = answerElement ? answerElement.innerText : '';
    const answerLinks = answerElement
        ? Array.from(answerElement.querySelectorAll('a[href]')).map((anchor) => ({
            text: (anchor.innerText || anchor.getAttribute('aria-label') || anchor.getAttribute('title') || '').trim(),
            url: anchor.href || anchor.getAttribute('href') || ''
        })).filter((link) => /^https?:\/\//i.test(link.url))
        : [];
    const markdownRoot = answerElement
        ? (answerElement.querySelector('.ds-markdown') || answerElement)
        : null;

    function serializeMarkdown(root, isFinal) {
        if (!root) return { markdown: '', stableMarkdown: '', protocolOutput: false, hasRichMarkdown: false };
        const rawText = root.innerText || root.textContent || '';

        // Keep pure tool-protocol output byte-for-byte stable. When protocol markup
        // shares a rendered response with rich Markdown (especially HTML tables),
        // serialize the DOM instead: innerText flattens cells and loses Markdown pipes.
        const protocolPattern = /<\s*\/?\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls|invoke|parameter)\b/i;
        const legacyToolPattern = /<\s*\/?\s*TOOL_CALL\b/i;
        const hasProtocolOutput = protocolPattern.test(rawText) || legacyToolPattern.test(rawText);
        const hasRichMarkdown = Boolean(root.querySelector(
            'table,h1,h2,h3,h4,h5,h6,ul,ol,pre,blockquote,hr,strong,b,em,i,del,s,strike,code,a[href],img[src],sub,sup,.katex-display'
        ));
        if (hasProtocolOutput && !hasRichMarkdown) {
            return {
                markdown: rawText,
                stableMarkdown: isFinal ? rawText : rawText.slice(0, Math.max(0, rawText.length - 64)),
                protocolOutput: true,
                hasRichMarkdown
            };
        }

        const blockTags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'HR']);
        const isBlockElement = (node) => {
            if (!node || node.nodeType !== 1) return false;
            if (blockTags.has(node.tagName)) return true;
            return Boolean(node.classList && (
                node.classList.contains('katex-display') || node.classList.contains('ds-markdown-paragraph')
            ));
        };
        function hasBlockDescendant(element) {
            for (const child of Array.from(element.children || [])) {
                if (isBlockElement(child) || hasBlockDescendant(child)) return true;
            }
            return false;
        }
        function renderInline(node) {
            if (!node) return '';
            if (node.nodeType === 3) return node.nodeValue || '';
            if (node.nodeType !== 1) return '';
            const tag = node.tagName;
            const children = () => Array.from(node.childNodes).map(renderInline).join('');
            if (tag === 'BR') return '  \n';
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'BUTTON' || tag === 'SVG') return '';
            if (node.classList && node.classList.contains('katex')) {
                const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
                if (annotation) return '$' + annotation.textContent + '$';
            }
            if (tag === 'STRONG' || tag === 'B') return '**' + children() + '**';
            if (tag === 'EM' || tag === 'I') return '*' + children() + '*';
            if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return '~~' + children() + '~~';
            if (tag === 'CODE') {
                const tick = String.fromCharCode(96);
                const text = node.textContent || '';
                const runs = text.match(/\x60+/g) || [];
                const fence = tick.repeat(Math.max(1, ...runs.map((run) => run.length + 1)));
                const padding = text && (/^\s|\s$/.test(text) || text.includes(tick)) ? ' ' : '';
                return fence + padding + text + padding + fence;
            }
            if (tag === 'A') {
                const label = children();
                const href = node.getAttribute('href');
                if (!href || href.startsWith('javascript:') || href.startsWith('data:')) return label;
                return '[' + label + '](' + href.replace(/\)/g, '%29').replace(/\s/g, '%20') + ')';
            }
            if (tag === 'IMG') {
                const alt = (node.getAttribute('alt') || '').replace(/\]/g, '\\]');
                const src = node.getAttribute('src') || '';
                if (!src || src.startsWith('data:') || src.startsWith('javascript:')) return alt;
                return '![' + alt + '](' + src.replace(/\)/g, '%29').replace(/\s/g, '%20') + ')';
            }
            if (tag === 'SUP') return '^(' + children() + ')';
            if (tag === 'SUB') return '~' + children() + '~';
            return children();
        }
        function directListItems(list) {
            return Array.from(list.children).filter((child) => child.tagName === 'LI');
        }
        function renderList(list, depth) {
            const ordered = list.tagName === 'OL';
            const start = Number.parseInt(list.getAttribute('start') || '1', 10) || 1;
            const lines = [];
            directListItems(list).forEach((item, index) => {
                const nested = Array.from(item.children).filter((child) => child.tagName === 'UL' || child.tagName === 'OL');
                const clone = item.cloneNode(true);
                Array.from(clone.querySelectorAll('ul,ol')).forEach((sublist) => sublist.remove());
                const content = renderInline(clone).replace(/\s*\n\s*/g, ' ').trim();
                lines.push(' '.repeat(depth) + (ordered ? (start + index) + '. ' : '- ') + content);
                nested.forEach((sublist) => lines.push(renderList(sublist, depth + 2)));
            });
            return lines.join('\n');
        }
        function renderTable(table) {
            const rows = Array.from(table.querySelectorAll('tr')).filter((row) => row.closest('table') === table);
            if (!rows.length) return '';
            const foundHeader = rows.findIndex((row) => Array.from(row.cells).some((cell) => cell.tagName === 'TH'));
            const headerIndex = foundHeader >= 0 ? foundHeader : 0;
            const allValues = rows.map((row) => Array.from(row.cells).map((cell) =>
                renderInline(cell).replace(/\s*\n\s*/g, ' ').trim().replace(/\|/g, '\\|')
            ));
            const columnCount = Math.max(1, ...allValues.map((cells) => cells.length));
            const normalizeRow = (cells) => Array.from({ length: columnCount }, (_, i) => cells[i] || '');
            const header = normalizeRow(allValues[headerIndex]);
            const lines = ['| ' + header.join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |'];
            allValues.forEach((cells, index) => {
                if (index !== headerIndex) lines.push('| ' + normalizeRow(cells).join(' | ') + ' |');
            });
            return lines.join('\n');
        }
        function collectUnits(container) {
            const units = [];
            let inlineNodes = [];
            const flushInline = () => {
                if (!inlineNodes.length) return;
                const text = inlineNodes.map(renderInline).join('').trim();
                if (text) units.push(text);
                inlineNodes = [];
            };
            Array.from(container.childNodes).forEach((child) => {
                if (child.nodeType === 3) {
                    if ((child.nodeValue || '').trim()) inlineNodes.push(child);
                    return;
                }
                if (child.nodeType !== 1) return;
                if (isBlockElement(child)) {
                    flushInline();
                    const text = renderBlock(child).trim();
                    if (text) units.push(text);
                } else if (child.tagName === 'DIV' && hasBlockDescendant(child)) {
                    flushInline();
                    units.push(...collectUnits(child));
                } else {
                    inlineNodes.push(child);
                }
            });
            flushInline();
            return units;
        }
        function renderBlock(node) {
            if (!node || node.nodeType !== 1) return renderInline(node).trim();
            const tag = node.tagName;
            if (/^H[1-6]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + renderInline(node).trim();
            if (tag === 'P') return renderInline(node).trim();
            if (tag === 'PRE') {
                const code = node.querySelector('code') || node;
                const source = code.textContent || '';
                const languageMatch = ((code.className || '') + ' ' + (node.className || '')).match(/language-([a-z0-9_+-]+)/i);
                const tick = String.fromCharCode(96);
                const runs = source.match(/\x60+/g) || [];
                const fence = tick.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
                return fence + (languageMatch ? languageMatch[1] : '') + '\n' + source.replace(/\n+$/, '') + '\n' + fence;
            }
            if (tag === 'TABLE') return renderTable(node);
            if (tag === 'UL' || tag === 'OL') return renderList(node, 0);
            if (tag === 'BLOCKQUOTE') {
                const content = collectUnits(node).join('\n\n') || renderInline(node).trim();
                return content.split('\n').map((line) => '> ' + line).join('\n');
            }
            if (tag === 'HR') return '---';
            if (node.classList && node.classList.contains('katex-display')) {
                const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
                if (annotation) return '$$\n' + annotation.textContent + '\n$$';
            }
            return collectUnits(node).join('\n\n') || renderInline(node).trim();
        }

        const units = collectUnits(root);
        const markdown = units.join('\n\n').trim() || rawText.trim();
        if (isFinal) return { markdown, stableMarkdown: markdown, protocolOutput: hasProtocolOutput, hasRichMarkdown };
        // Hold the active trailing block; earlier block serialization is append-only.
        const stableUnits = units.slice(0, -1);
        return {
            markdown,
            stableMarkdown: stableUnits.length ? stableUnits.join('\n\n') + '\n\n' : '',
            protocolOutput: hasProtocolOutput,
            hasRichMarkdown
        };
    }

    const result = serializeMarkdown(markdownRoot, finalSnapshot);
    return {
        count: items.length,
        answerKey: last ? (last.getAttribute('data-virtual-list-item-key') || null) : null,
        think,
        answer,
        answerLinks,
        answerMarkdown: result.markdown,
        answerMarkdownStable: result.stableMarkdown,
        answerIsProtocol: result.protocolOutput,
        answerHasRichMarkdown: result.hasRichMarkdown,
        isGenerating,
        sendButtonEnabled,
        composerReady,
        completionSignalAvailable,
        completionDebug
    };
}

module.exports = { readStateInPage };
