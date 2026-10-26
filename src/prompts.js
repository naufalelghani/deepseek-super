'use strict';

const { blocksOf, flattenContent, renderMessage, truncateTextPreservingEnds } = require('./content');
const { MAX_REPLAY } = require('./config');

const PROJECT_AND_LANGUAGE_INSTRUCTIONS = [
    '### PROJECT IDENTITY',
    'You are the assistant served through the deepseek-super project.',
    'The underlying model experience is DeepSeek, accessed through its official web interface at https://chat.deepseek.com/. This project uses browser automation to expose that web experience through an Anthropic Messages API-compatible interface so AI-agent clients such as Claude Code and similar tools can use it.',
    'Project name: deepseek-super.',
    'Project creator attribution: BYV Dev Unorganization (BYV). The creator’s real-world identity is undisclosed/stealth; do not guess, infer, or invent a personal identity.',
    'This is a compatibility gateway, not an official Anthropic product or a Claude model. Do not claim that the underlying model was created by Anthropic or that this project has an official relationship with Anthropic.',
    '',
    '### CONVERSATION LANGUAGE',
    'Use the language of the first user message in the conversation as the default language for all user-facing responses. Keep using that language in later turns, explanations, and after tool results, even when internal instructions or tool descriptions are in English. If the user explicitly asks to switch languages, follow that request. Do not default to English merely because these internal instructions are written in English.',
    'When raw command output or a tool protocol requires an exact format, preserve the raw output and protocol syntax. Apply the conversation-language rule to any explanatory prose.'
].join('\n');

const TOOL_RESULT_INSTRUCTIONS = [
    'Base claims on tool results that were actually received. Do not claim success unless the tool result confirms it.',
    'If the task is complete and the user requested raw output from a simple command, return only that output when it consists of one or more lines.',
    'For raw output, do not add an introduction or explanation unless requested.',
    'Do not wrap raw output in Markdown code fences, backticks, or language labels such as text.',
    'If the received results are not sufficient to complete the task, continue with the next necessary tool from the available list.',
    'Do not call another tool if the task is complete. If a tool fails, report the actual error that was returned.'
];

function toolsToPrompt(tools) {
    if (!tools || !tools.length) return '';

    const lines = [];
    lines.push('You have access to the tools provided by the client. These are the only tools available to you.');
    lines.push('');

    for (const tool of tools) {
        const schema = tool.input_schema || tool.parameters || {};
        const properties = schema.properties || {};
        const required = schema.required || [];
        const params = Object.keys(properties).map((key) => {
            const value = properties[key] || {};
            return `${key}${required.includes(key) ? '*' : ''}: ${value.type || 'any'}` +
                (value.description ? ` (${value.description})` : '');
        }).join('; ');
        lines.push(`- ${tool.name}(${params}): ${tool.description || ''}`);
    }

    lines.push('');
    lines.push('MANDATORY RULES:');
    lines.push('1. If the task requires file access, shell commands, search, or an action that one of the tools above can perform, you MUST use the appropriate tool.');
    lines.push('2. If the tool results already received are sufficient to complete the task, provide the final answer without another tool call. Otherwise, continue with the next appropriate tool.');
    lines.push('3. Use the DeepSeek DSML markup format for tool calls. Do not use the legacy <TOOL_CALL> JSON wrapper.');
    lines.push('4. Emit exactly ONE outer calls block for the whole assistant tool response, with one invoke block per requested tool. Do not repeat the calls wrapper.');
    lines.push('5. Use this DSML structure (the leading space after the DSML token in calls/invoke/parameter is intentional):');
    lines.push('<｜DSML｜ calls>');
    lines.push('<｜DSML｜ invoke name="Bash">');
    lines.push('<｜DSML｜ parameter name="command" string="true">pwd</｜DSML｜ parameter>');
    lines.push('</｜DSML｜ invoke>');
    lines.push('</｜DSML｜ calls>');
    lines.push('6. For string arguments, set string="true" and write the raw string value without JSON quoting or escaping.');
    lines.push('7. For numbers, booleans, null, arrays, and objects, set string="false" and write the value as valid JSON.');
    lines.push('8. Use each parameter name exactly as declared in the selected tool schema. Do not duplicate parameter names, invent tools, or add prose/Markdown inside the calls block.');
    lines.push('9. Do NOT write anything outside the DSML calls block when calling tools.');
    lines.push('10. Use plain text when the task is complete or no additional tool is needed.');
    lines.push('');
    lines.push('VALID DSML TOOL CALL EXAMPLE (formatting example only):');
    lines.push('<｜DSML｜ calls><｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="command" string="true">pwd</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>');
    lines.push('Put all requested tool invocations inside one calls block. Do not append closing DSML tags a second time.');
    lines.push('');
    lines.push('EXAMPLE — TOOL REQUIRED:');
    lines.push(`User: "Please help me use ${tools[0].name}."`);
    lines.push(`Assistant: <TOOL_CALL>{"tool":"${tools[0].name}","arguments":{...}}</TOOL_CALL>`);
    lines.push('');
    lines.push('EXAMPLE — NO TOOL NEEDED:');
    lines.push('User: "Who are you? Please answer in my language."');
    lines.push('Assistant: I am an assistant ready to help...');
    return lines.join('\n');
}

function buildFullPrompt(system, messages, tools) {
    const parts = [];
    if (system) parts.push('### SYSTEM\n' + flattenContent(system));
    parts.push(PROJECT_AND_LANGUAGE_INSTRUCTIONS);

    const last = messages[messages.length - 1] || { role: 'user', content: '' };
    const lastHasToolResult = blocksOf(last.content).some((block) => block.type === 'tool_result');

    const history = messages.slice(0, -1);
    if (history.length) {
        parts.push('### CONVERSATION HISTORY');
        for (const message of history) {
            parts.push(`[${message.role === 'assistant' ? 'ASSISTANT' : 'USER'}]\n${renderMessage(message)}`);
        }
    }

    // Keep tool schemas close to the latest request/results. The replay truncator
    // preserves the tail, so long histories cannot silently cut off the tool contract.
    const toolPrompt = toolsToPrompt(tools);
    if (toolPrompt) parts.push('### TOOLS\n' + toolPrompt);

    if (lastHasToolResult) {
        parts.push('=== TOOL RESULTS ===\n' + renderMessage(last));
        parts.push([
            '=== INSTRUCTIONS AFTER TOOL RESULTS ===',
            ...TOOL_RESULT_INSTRUCTIONS,
            'If the task still requires an action, call the next appropriate tool using the DeepSeek DSML calls/invoke/parameter format described in the tool contract.',
            'If the task is complete, provide the final answer without tool-call tags.'
        ].join('\n'));
    } else {
        parts.push('### LATEST USER MESSAGE\n' + renderMessage(last));
        parts.push('Respond as the assistant. If calling a tool, output only the <TOOL_CALL>...</TOOL_CALL> format.');
    }

    return parts.join('\n\n');
}

function buildResumePrompt(system, messages, tools, isToolResultTurn) {
    const last = messages[messages.length - 1] || { role: 'user', content: '' };

    if (isToolResultTurn) {
        const toolPrompt = toolsToPrompt(tools);
        const parts = [];
        if (system) parts.push('### SYSTEM\n' + flattenContent(system));
        parts.push(PROJECT_AND_LANGUAGE_INSTRUCTIONS);
        parts.push('=== SITUATION ===');
        parts.push('The client has executed a tool and provided its result. Continue the original task using the conversation context.');
        parts.push('');
        parts.push('=== LATEST TOOL RESULTS ===');
        const renderedToolResult = renderMessage(last);
        // Keep both the beginning and end of huge tool outputs. Important diagnostics
        // often appear at either boundary; the outer replay cap still bounds total size.
        parts.push(truncateTextPreservingEnds(
            renderedToolResult,
            Math.max(1024, Math.floor(MAX_REPLAY * 0.6))
        ));
        parts.push('');
        // Put the tool contract after potentially large results so bounded replay
        // truncation keeps the schemas needed for the next action.
        if (toolPrompt) parts.push('=== TOOLS AVAILABLE FOR THE NEXT STEP ===\n' + toolPrompt);
        parts.push('');
        parts.push('=== INSTRUCTIONS AFTER TOOL RESULTS ===');
        parts.push(...TOOL_RESULT_INSTRUCTIONS);
        parts.push('If the task is not complete, use the next required tool with one DeepSeek DSML calls block containing invoke/parameter tags.');
        parts.push('If the task is complete, provide the final answer without tool tags.');
        return parts.filter(Boolean).join('\n');
    }

    const parts = [];
    if (system) parts.push('### SYSTEM\n' + flattenContent(system));
    parts.push(PROJECT_AND_LANGUAGE_INSTRUCTIONS);

    const toolPrompt = toolsToPrompt(tools);
    if (toolPrompt) {
        parts.push('=== TOOLS AVAILABLE FOR THIS REQUEST ===\n' + toolPrompt);
    }
    parts.push('=== NEW USER REQUEST ===\n' + renderMessage(last));
    parts.push([
        '=== INSTRUCTIONS FOR THIS TURN ===',
        'Evaluate the latest request using the tool list provided immediately above.',
        'If the request requires file access, shell commands, search, or an action that one of the listed tools can perform, you MUST call the most appropriate tool now.',
        'Do not claim a tool is unavailable or substitute manual instructions when an appropriate tool is listed.',
        'For tool calls, output one DeepSeek DSML calls block containing one invoke per tool and parameter tags for its arguments. Do not use <TOOL_CALL> or a JSON wrapper.',
        'For each string parameter, use string="true" and raw text; for non-string values, use string="false" and valid JSON.',
        'Do not report file contents or execution results until the tool has actually been called and its result received.'
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
            '=== STOP: DO NOT CALL TOOLS ===',
            'Using ALL information already available in the context above,',
            'answer the user NOW in plain text.',
            '',
            'MANDATORY RULES:',
            '1. Do NOT emit DSML calls/invoke/parameter tags or legacy <TOOL_CALL> tags.',
            '2. Do NOT call any tools. All tools are disabled for this turn.',
            '3. If information is incomplete, answer with what is available and state the limitations.',
            '4. Respond in the language used in the first user message, unless the user explicitly asks to switch languages.',
            '',
            prompt
        ].join('\n');
    }
    if (force.mode === 'tool') {
        return '[REQUIRED: Call the tool "' + force.name + '" NOW. Respond ONLY with one DeepSeek DSML calls block containing an invoke named "' + force.name + '". Use parameter tags and the declared schema; do not emit legacy <TOOL_CALL> JSON.]\n\n' + prompt;
    }
    if (force.mode === 'any') {
        return '[REQUIRED: Call at least one tool from the list below. Do NOT answer in plain text.]\n\n' + prompt;
    }
    return prompt;
}


module.exports = {
    toolsToPrompt,
    buildFullPrompt,
    buildResumePrompt,
    parseToolChoice,
    applyForcedTool
};
