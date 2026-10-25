'use strict';

// End-to-end integration test: real Claude Code CLI -> local Anthropic-compatible gateway.
// Prerequisites: npm start is running and Playwright is logged in to chat.deepseek.com.
// Run from the repo root: npm run test:claude-code

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BASE_URL = process.env.DEEPSEEK_SUPER_BASE_URL || 'http://127.0.0.1:8787';
const MODEL = process.env.ANTHROPIC_MODEL || 'deepseek-super';
const TOKEN = process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.DEEPSEEK_SUPER_TOKEN ||
  'any';
const TIMEOUT_MS = Number.parseInt(process.env.CLAUDE_CODE_TEST_TIMEOUT_MS || '360000', 10);

function quoteArg(value) {
  const text = String(value);
  if (process.platform === 'win32') {
    // CMD-style quoting; arguments here are controlled by this script, not user input.
    return '"' + text.replace(/"/g, '\\"') + '"';
  }
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function findObjects(root, predicate, found = []) {
  if (!root || typeof root !== 'object') return found;
  if (predicate(root)) found.push(root);
  if (Array.isArray(root)) {
    for (const item of root) findObjects(item, predicate, found);
  } else {
    for (const value of Object.values(root)) findObjects(value, predicate, found);
  }
  return found;
}

function parseStreamJson(stdout) {
  const events = [];
  const nonJson = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      nonJson.push(trimmed);
    }
  }
  return { events, nonJson };
}

function runClaude(prompt, settingsPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '--bare',
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--permission-mode', 'dontAsk',
      '--settings', settingsPath,
      '--model', MODEL,
      '--max-turns', '8',
    ];

    // Quote every argument explicitly because the Windows Claude command may be a .cmd shim.
    const command = ['claude', ...args, prompt].map(quoteArg).join(' ');
    const child = spawn(command, [], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: BASE_URL,
        ANTHROPIC_AUTH_TOKEN: TOKEN,
        ANTHROPIC_MODEL: MODEL,
        // Ensure a personal API key cannot override the local gateway token.
        ANTHROPIC_API_KEY: '',
      },
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let finished = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(
        'Claude Code timed out after ' + TIMEOUT_MS +
        ' ms. Check the gateway logs and whether the DeepSeek browser session is logged in.'
      ));
    }, TIMEOUT_MS);

    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      finish(new Error(
        'Tidak dapat menjalankan Claude Code CLI. Pastikan perintah "claude" terpasang dan ada di PATH. ' +
        error.message
      ));
    });
    child.on('close', (code, signal) => {
      if (code !== 0) {
        finish(new Error(
          'Claude Code exit code=' + code + ' signal=' + signal +
          '\nSTDERR:\n' + (stderr || '(kosong)') +
          '\nSTDOUT (akhir):\n' + stdout.slice(-8000)
        ));
        return;
      }
      finish(null, { stdout, stderr });
    });
  });
}

async function main() {
  console.log('Claude Code CLI integration test');
  console.log('Gateway:', BASE_URL);
  console.log('Model:', MODEL);
  console.log('Working directory:', process.cwd());

  // The temporary permission config only permits reading files and running pwd.
  // dontAsk mode denies any other tool rather than requesting interactive approval.
  const settingsPath = path.join(
    os.tmpdir(),
    'deepseek-super-claude-code-smoke-' + process.pid + '.json'
  );
  fs.writeFileSync(settingsPath, JSON.stringify({
    permissions: {
      allow: ['Read', 'Bash(pwd)'],
      deny: ['Edit', 'Write', 'NotebookEdit'],
    },
  }, null, 2));

  const prompt = [
    'Integration test only.',
    'Use the Read tool to read package.json in the current working directory and determine its top-level name.',
    'Use the Bash tool to execute exactly one shell command: pwd.',
    'Do not execute any other shell commands. Do not edit or create project files.',
    'Do not answer from assumptions; use the actual tool outputs.',
    'In your final response, include the package name and the output of pwd.',
  ].join(' ');

  try {
    console.log('\nRunning Claude Code; only Read and Bash(pwd) are permitted ...');
    const { stdout, stderr } = await runClaude(prompt, settingsPath);
    const { events, nonJson } = parseStreamJson(stdout);

    const toolUses = findObjects(
      events,
      (value) => value.type === 'tool_use' && typeof value.name === 'string'
    );
    const toolResults = findObjects(
      events,
      (value) => value.type === 'tool_result' ||
        (typeof value.tool_use_id === 'string' && Object.prototype.hasOwnProperty.call(value, 'content'))
    );
    const readUses = toolUses.filter((tool) => tool.name === 'Read');
    const bashUses = toolUses.filter((tool) => tool.name === 'Bash');
    const pwdCall = bashUses.find((tool) =>
      tool.input && typeof tool.input.command === 'string' &&
      tool.input.command.trim() === 'pwd'
    );

    if (readUses.length === 0) {
      throw new Error('Claude Code selesai tetapi stream tidak menunjukkan pemanggilan tool Read.\n' + stdout.slice(-8000));
    }
    if (bashUses.length === 0) {
      throw new Error('Claude Code selesai tetapi stream tidak menunjukkan pemanggilan tool Bash.\n' + stdout.slice(-8000));
    }
    if (!pwdCall) {
      throw new Error('Tool Bash dipanggil, tetapi command yang terdeteksi bukan persis "pwd".\n' +
        JSON.stringify(bashUses.map((tool) => tool.input), null, 2));
    }
    if (toolResults.length < 2) {
      throw new Error('Stream belum menunjukkan hasil kedua tool. tool_result count=' + toolResults.length +
        '\n' + stdout.slice(-8000));
    }

    const finalEvents = events.filter((event) => event.type === 'result');
    const finalText = finalEvents.map((event) => event.result || '').join('\n');
    console.log('PASS Claude Code CLI completed');
    console.log('PASS tool Read invoked:', JSON.stringify(readUses[0].input || {}));
    console.log('PASS tool Bash invoked:', JSON.stringify(pwdCall.input));
    console.log('PASS tool results observed:', toolResults.length);
    if (finalText) console.log('\nClaude Code final response:\n' + finalText);
    if (stderr.trim()) console.log('\nClaude Code diagnostics (stderr):\n' + stderr.trim().slice(-3000));
    if (nonJson.length) {
      // Stream-json may include human-readable stderr-like lines on stdout for some CLI versions.
      console.log('\nAdditional CLI output:\n' + nonJson.join('\n').slice(-2000));
    }
    console.log('\nCLAUDE CODE INTEGRATION TEST PASSED');
  } finally {
    try { fs.unlinkSync(settingsPath); } catch {}
  }
}

main().catch((error) => {
  console.error('\nCLAUDE CODE INTEGRATION TEST FAILED');
  console.error(error && error.stack ? error.stack : error);
  console.error('\nEnsure npm start is running and its Playwright Chrome is signed in to DeepSeek.');
  console.error('If the server token is enabled, set DEEPSEEK_SUPER_TOKEN in this terminal before running the test.');
  process.exitCode = 1;
});
