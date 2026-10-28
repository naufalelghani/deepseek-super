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

 function sessionKey(_system, messages) {
     const firstUser = messages.find((m) => m.role === 'user');
     // System/developer instructions can change during Claude Code compaction.
     // Keep the fingerprint tied to the complete first user message so those
     // changes do not fork an otherwise continuous gateway session.
     return sha(JSON.stringify({
         u1: firstUser ? flattenContent(firstUser.content) : '',
     }));
 }

 function truncateTextPreservingEnds(text, maxLength, marker = '[...content truncated...]\n') {
     if (typeof text !== 'string') return '';
     if (!Number.isInteger(maxLength) || maxLength < 1 || text.length <= maxLength) return text;
     if (maxLength <= marker.length) return text.slice(0, maxLength);
     const available = maxLength - marker.length;
     const headLength = Math.ceil(available * 0.4);
     const tailLength = available - headLength;
     return text.slice(0, headLength) + marker + (tailLength ? text.slice(-tailLength) : '');
 }

function nextMarkerIndex(text, fromIndex, markers) {
    let next = -1;
    for (const marker of markers) {
        const index = text.indexOf(marker, fromIndex);
        if (index !== -1 && (next === -1 || index < next)) next = index;
    }
    return next;
}

function truncateMarkedSection(text, startMarker, endMarkers, maxSectionLength, marker) {
    const start = text.indexOf(startMarker);
    if (start === -1) return text;

    const contentStart = start + startMarker.length;
    const end = nextMarkerIndex(text, contentStart, endMarkers);
    const endIndex = end === -1 ? text.length : end;
    if (endIndex - start <= maxSectionLength) return text;

    const content = text.slice(contentStart, endIndex);
    const contentBudget = Math.max(0, maxSectionLength - startMarker.length);
    const replacement = contentBudget > 0
        ? truncateTextPreservingEnds(content, contentBudget, marker)
        : '';
    return text.slice(0, contentStart) + replacement + text.slice(endIndex);
}

function compactToolSection(text, maxLength) {
    const startMarkers = [
        '### TOOLS\n',
        '=== TOOLS AVAILABLE FOR THIS REQUEST ===\n',
        '=== TOOLS AVAILABLE FOR THE NEXT STEP ===\n',
    ];
    let start = -1;
    let marker = '';
    for (const candidate of startMarkers) {
        const index = text.indexOf(candidate);
        if (index !== -1 && (start === -1 || index < start)) {
            start = index;
            marker = candidate;
        }
    }
    if (start === -1) return text;

    const contentStart = start + marker.length;
    const end = nextMarkerIndex(text, contentStart, [
        '\n### LATEST USER MESSAGE\n',
        '\n=== TOOL RESULTS ===',
        '\n=== LATEST TOOL RESULTS ===',
        '\n=== ORIGINAL USER REQUEST ===',
        '\n=== INSTRUCTIONS AFTER TOOL RESULTS ===',
        '\n=== NEW USER REQUEST ===',
        '\n=== SITUATION ===',
        '\n=== INSTRUCTIONS FOR THIS TURN ===',
    ]);
    const endIndex = end === -1 ? text.length : end;
    const section = text.slice(start, endIndex);
    if (section.length <= maxLength) return text;

    const compactLines = (descriptionLimit, propertyDescriptionLimit, omitExamples) => {
        let skipExampleDetail = false;
        const lines = section.split('\n');
        const compacted = [];
        for (const originalLine of lines) {
            let line = originalLine;
            if (omitExamples && (
                line.startsWith('EXAMPLE: TOOL REQUIRED') ||
                line.startsWith('EXAMPLE: NO TOOL NEEDED')
            )) {
                skipExampleDetail = true;
                continue;
            }
            if (skipExampleDetail) {
                skipExampleDetail = false;
                continue;
            }
            if (omitExamples && line.startsWith('<｜DSML｜ calls><｜DSML｜ invoke name="Bash">')) {
                compacted.push('DSML example omitted; follow the mandatory format rules above.');
                continue;
            }
            if (omitExamples && line.startsWith('VALID DSML TOOL CALL EXAMPLE')) {
                compacted.push('VALID DSML EXAMPLE: follow the declared invoke and parameter format.');
                continue;
            }
            line = line.replace(/\(([^)]{35,})\)/g, (_match, description) => {
                if (propertyDescriptionLimit <= 0) return '(details omitted)';
                return '(' + description.slice(0, propertyDescriptionLimit) +
                    (description.length > propertyDescriptionLimit ? '...' : '') + ')';
            });
            if (line.startsWith('- ')) {
                const separator = line.lastIndexOf('): ');
                if (separator !== -1) {
                    const description = line.slice(separator + 3);
                    const shortened = descriptionLimit <= 0
                        ? ''
                        : description.slice(0, descriptionLimit) +
                            (description.length > descriptionLimit ? '...' : '');
                    line = line.slice(0, separator + 3) + shortened;
                }
            }
            compacted.push(line);
        }
        return compacted.join('\n');
    };

    let compacted = compactLines(120, 48, true);
    if (compacted.length > maxLength) compacted = compactLines(32, 12, true);
    if (compacted.length > maxLength) compacted = compactLines(0, 0, true);
    if (compacted.length > maxLength) {
        // Rare oversized schema fallback. Keep the beginning and end of the tool
        // contract, and mark that some middle schema metadata was omitted.
        compacted = truncateTextPreservingEnds(
            compacted,
            maxLength,
            '\n[...middle tool metadata omitted to fit MAX_REPLAY...]\n'
        );
    }
    return text.slice(0, start) + compacted + text.slice(endIndex);
}

function truncateReplay(text) {
    if (typeof text !== 'string') return '';
    if (text.length <= MAX_REPLAY) return text;

    const warning = '[WARNING: conversation replay was truncated; oversized system instructions, history, and tool results were compacted where needed. Project policy, available tool schemas, and the latest request were prioritized.]';
    const policyStart = text.indexOf('### ASSISTANT IDENTITY');

    // Keep the bounded head/tail strategy for unstructured prompt formats.
    if (policyStart === -1) {
        const marker = '\n\n[WARNING: conversation replay was truncated; middle content was omitted and earlier context may be missing.]\n\n';
        const headLength = Math.min(4000, Math.max(0, MAX_REPLAY - marker.length));
        const tailLength = Math.max(0, MAX_REPLAY - headLength - marker.length);
        return text.slice(0, headLength) + marker +
            (tailLength > 0 ? text.slice(-tailLength) : '');
    }

    // The gateway's project policy follows the caller's potentially huge system
    // prompt. Split there so truncation cannot silently remove HUMANIZER/language rules.
    const policyEndMarkers = [
        '\n### CONVERSATION HISTORY\n',
        '\n### TOOLS\n',
        '\n### LATEST USER MESSAGE\n',
        '\n=== TOOLS AVAILABLE FOR THIS REQUEST ===',
        '\n=== NEW USER REQUEST ===',
        '\n=== SITUATION ===',
        '\n=== LATEST TOOL RESULTS ===',
        '\n=== TOOL RESULTS ===',
    ];
    const policyEnd = nextMarkerIndex(text, policyStart, policyEndMarkers);
    const endIndex = policyEnd === -1 ? text.length : policyEnd;
    const systemOriginal = text.slice(0, policyStart).trimEnd();
    const policy = text.slice(policyStart, endIndex).trim();
    const restOriginal = policyEnd === -1 ? '' : text.slice(endIndex).trimStart();

    let systemLimit = Math.min(8000, Math.floor(MAX_REPLAY * 0.16));
    let historyLimit = Math.min(5000, Math.floor(MAX_REPLAY * 0.08));
    let resultLimit = Math.min(12000, Math.floor(MAX_REPLAY * 0.20));

    const toolSectionLimit = Math.max(1000, Math.min(28000, Math.floor(MAX_REPLAY * 0.48)));
    const compactedRestOriginal = compactToolSection(restOriginal, toolSectionLimit);

    const render = () => {
        let rest = compactedRestOriginal;
        rest = truncateMarkedSection(
            rest,
            '### CONVERSATION HISTORY\n',
            [
                '\n### TOOLS\n',
                '\n### LATEST USER MESSAGE\n',
                '\n=== TOOL RESULTS ===',
                '\n=== TOOLS AVAILABLE FOR THIS REQUEST ===',
                '\n=== NEW USER REQUEST ===',
                '\n=== SITUATION ===',
                '\n=== LATEST TOOL RESULTS ===',
            ],
            historyLimit,
            '[...earlier conversation history compacted...]\n'
        );
        rest = truncateMarkedSection(
            rest,
            '=== LATEST TOOL RESULTS ===\n',
            [
                '\n=== TOOLS AVAILABLE FOR THE NEXT STEP ===',
                '\n=== INSTRUCTIONS AFTER TOOL RESULTS ===',
            ],
            resultLimit,
            '[...middle of latest tool result omitted...]\n'
        );
        rest = truncateMarkedSection(
            rest,
            '=== TOOL RESULTS ===\n',
            ['\n=== ORIGINAL USER REQUEST ===', '\n=== INSTRUCTIONS AFTER TOOL RESULTS ==='],
            resultLimit,
            '[...middle of tool result omitted...]\n'
        );

        const system = systemLimit > 0
            ? truncateTextPreservingEnds(
                systemOriginal,
                systemLimit,
                '\n[...external system instructions compacted; beginning and end retained...]\n'
            )
            : '';
        return [system, policy, warning, rest.trim()].filter(Boolean).join('\n\n');
    };

    let replay = render();
    for (const limitName of ['historyLimit', 'resultLimit', 'systemLimit']) {
        let attempts = 0;
        while (replay.length > MAX_REPLAY && attempts < 5) {
            const limits = { historyLimit, resultLimit, systemLimit };
            const current = limits[limitName];
            if (current <= 0) break;
            const excess = replay.length - MAX_REPLAY;
            const next = Math.max(0, current - Math.max(excess + 32, Math.ceil(current / 2)));
            if (limitName === 'historyLimit') historyLimit = next;
            else if (limitName === 'resultLimit') resultLimit = next;
            else systemLimit = next;
            replay = render();
            attempts++;
        }
    }

    if (replay.length > MAX_REPLAY) {
        // Last resort for unusually large tool catalogs: sacrifice system/history
        // context first, then bound the remaining tool/request section from both ends.
        const rest = truncateMarkedSection(
            truncateMarkedSection(
                truncateMarkedSection(
                    compactedRestOriginal,
                    '### CONVERSATION HISTORY\n',
                    [
                        '\n### TOOLS\n',
                        '\n### LATEST USER MESSAGE\n',
                        '\n=== TOOL RESULTS ===',
                        '\n=== TOOLS AVAILABLE FOR THIS REQUEST ===',
                        '\n=== NEW USER REQUEST ===',
                        '\n=== SITUATION ===',
                        '\n=== LATEST TOOL RESULTS ===',
                    ],
                    0,
                    '[...history omitted...]\n'
                ),
                '=== LATEST TOOL RESULTS ===\n',
                ['\n=== TOOLS AVAILABLE FOR THE NEXT STEP ===', '\n=== INSTRUCTIONS AFTER TOOL RESULTS ==='],
                0,
                '[...tool result omitted...]\n'
            ),
            '=== TOOL RESULTS ===\n',
            ['\n=== ORIGINAL USER REQUEST ===', '\n=== INSTRUCTIONS AFTER TOOL RESULTS ==='],
            0,
            '[...tool result omitted...]\n'
        ).trim();
        const budget = Math.max(0, MAX_REPLAY - policy.length - warning.length - 4);
        const boundedRest = truncateTextPreservingEnds(
            rest,
            budget,
            '\n[...remaining tool/request context compacted to fit MAX_REPLAY...]\n'
        );
        replay = [policy, warning, boundedRest].filter(Boolean).join('\n\n');
    }

    if (replay.length <= MAX_REPLAY) return replay;

    // A very small custom MAX_REPLAY may not fit all mandatory text.
    return truncateTextPreservingEnds(
        replay,
        MAX_REPLAY,
        '\n[...critical replay content truncated to fit MAX_REPLAY...]\n'
    );
}

module.exports = { blocksOf, flattenContent, renderMessage, sessionKey, truncateReplay, truncateTextPreservingEnds };
