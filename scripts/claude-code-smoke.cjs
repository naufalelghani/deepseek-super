'use strict';

// End-to-end test: real Claude Code CLI -> local Anthropic-compatible gateway.
// It uses a temporary workspace and only allows six bounded built-in tools.
// Prerequisites: the local 9Router gateway is running and ANTHROPIC_AUTH_TOKEN is set.
// Run: npm run test:claude-code

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BASE_URL = process.env.DEEPSEEK_SUPER_BASE_URL ||
  process.env.ANTHROPIC_BASE_URL ||
  'http://localhost:20128/v1';
const MODEL = process.env.ANTHROPIC_MODEL || 'byv-flash-2410';
const TOKEN = process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.DEEPSEEK_SUPER_TOKEN ||
  '';
const TIMEOUT_MS = Number.parseInt(process.env.CLAUDE_CODE_TEST_TIMEOUT_MS || '360000', 10);
const TEST_TOOLS = 'Bash,Read,Edit,Write,Glob,Grep';
const REQUIRED_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];

function quoteArg(value) {
  const text = String(value);
  if (process.platform === 'win32') {
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

function runClaude(prompt, settingsPath, cwd) {
  return new Promise((resolve, reject) => {
    const args = [
      '--restricted',
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--permission-mode', 'dontAsk',
      '--settings', settingsPath,
      '--tools', TEST_TOOLS,
      '--model', MODEL,
      '--max-turns', '12',
    ];

    const command = ['claude', ...args, prompt].map(quoteArg).join(' ');
    const child = spawn(command, [], {
      cwd,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: BASE_URL,
        ANTHROPIC_AUTH_TOKEN: TOKEN,
        ANTHROPIC_API_KEY: TOKEN,
        ANTHROPIC_MODEL: MODEL,
        // Register the 9Router combo model so Claude Code accepts this custom ID.
        ANTHROPIC_CUSTOM_MODEL_OPTION: MODEL,
        ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'byv-flash-2410 via 9Router',
        ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'Local model combo routed through 9Router',
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
        ' ms. Check that the local 9Router gateway and selected model are responding.'
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
        'Tidak dapat menjalankan Claude Code CLI. Pastikan perintah "claude" tersedia di PATH. ' +
        error.message
      ));
    });
    child.on('close', (code, signal) => {
      if (code !== 0) {
        finish(new Error(
          'Claude Code exit code=' + code + ' signal=' + signal +
          '\nSTDERR:\n' + (stderr || '(kosong)') +
          '\nSTDOUT (akhir):\n' + stdout.slice(-10000)
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
  console.log('Tools under test:', REQUIRED_TOOLS.join(', '));

  // Keep writes confined to an isolated temporary project rather than the repo.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-super-claude-test-'));
  const settingsPath = path.join(os.tmpdir(), 'deepseek-super-claude-settings-' + process.pid + '.json');

  fs.mkdirSync(path.join(workspace, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
    name: 'deepseek-super-claude-code-fixture',
    private: true,
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'TEST_PATTERN_FOUND\nordinary fixture line\n');
  fs.writeFileSync(path.join(workspace, 'nested', 'second.txt'), 'SECOND_FIXTURE\n');
  fs.writeFileSync(path.join(workspace, 'fixture-edit.txt'), 'EDIT_BEFORE\n');

  // Restricted mode confines built-in file tools to the temporary workspace.
  // Bash is only allowlisted for the exact safe command "pwd".
  fs.writeFileSync(settingsPath, JSON.stringify({
    // This key must be an actual built-in Anthropic model ID. The value is the
    // custom gateway model; this also suppresses the unrecognized-model diagnostic.
    modelOverrides: {
      'claude-sonnet-4-5-20250929': MODEL,
    },
    permissions: {
      allow: [
        'Read',
        'Glob',
        'Grep',
        'Edit',
        'Write',
        'Bash(pwd)',
      ],
    },
  }, null, 2));

  const prompt = [
    'This is a mandatory integration test. Use every one of these six tools, each for its named task; do not substitute a different tool.',
    'Perform the tasks sequentially: make exactly one tool call in each response, wait for its real result, then decide which next tool to use. Do not batch tool calls.',
    '1. Read: read package.json and identify its top-level name.',
    '2. Glob: find all files matching **/*.txt in the current workspace.',
    '3. Grep: search for the exact string TEST_PATTERN_FOUND in **/*.txt.',
    '4. Edit: in fixture-edit.txt replace EDIT_BEFORE with EDIT_AFTER.',
    '5. Write: create smoke-created.txt with exactly WRITE_OK as its contents.',
    '6. Bash: execute exactly the one command pwd. Do not chain commands.',
    'Do not execute any other shell command. Do not access files outside the current workspace. Do not use tools other than those requested.',
    'After every tool has returned a result, report the package name, files found by Glob, Grep match file, and output from pwd.',
  ].join(' ');

  try {
    console.log('Workspace:', workspace);
    console.log('\nRunning Claude Code in restricted mode; all file writes are isolated to a temp workspace ...');
    const { stdout, stderr } = await runClaude(prompt, settingsPath, workspace);
    const { events, nonJson } = parseStreamJson(stdout);

    const toolUses = findObjects(events, (value) =>
      value.type === 'tool_use' && typeof value.name === 'string'
    );
    const toolResults = findObjects(events, (value) =>
      value.type === 'tool_result' ||
      (typeof value.tool_use_id === 'string' && Object.prototype.hasOwnProperty.call(value, 'content'))
    );

    const missingTools = REQUIRED_TOOLS.filter((name) =>
      !toolUses.some((tool) => tool.name === name)
    );
    if (missingTools.length) {
      throw new Error(
        'Claude Code tidak memanggil semua tool wajib. Tidak terlihat: ' + missingTools.join(', ') +
        '\nTool yang terdeteksi: ' + toolUses.map((tool) => tool.name).join(', ') +
        '\nSTDOUT (akhir):\n' + stdout.slice(-10000)
      );
    }

    const pwdCall = toolUses.find((tool) =>
      tool.name === 'Bash' && tool.input &&
      typeof tool.input.command === 'string' &&
      tool.input.command.trim() === 'pwd'
    );
    if (!pwdCall) {
      throw new Error('Bash terdeteksi, tetapi command yang dijalankan bukan persis "pwd".\n' +
        JSON.stringify(toolUses.filter((tool) => tool.name === 'Bash').map((tool) => tool.input), null, 2));
    }

    if (toolResults.length < REQUIRED_TOOLS.length) {
      throw new Error(
        'Tidak semua tool result terlihat di output stream. Ditemukan ' + toolResults.length +
        ' result untuk ' + REQUIRED_TOOLS.length + ' tool wajib.\n' + stdout.slice(-10000)
      );
    }

    const missingToolResults = toolUses.filter((tool) =>
      REQUIRED_TOOLS.includes(tool.name) &&
      tool.id &&
      !toolResults.some((result) => result.tool_use_id === tool.id)
    );
    if (missingToolResults.length) {
      throw new Error(
        'Tool dipanggil tetapi result tidak ditemukan untuk ID: ' +
        missingToolResults.map((tool) => tool.name + ':' + tool.id).join(', ') +
        '\n' + stdout.slice(-10000)
      );
    }

    const editedFile = fs.readFileSync(path.join(workspace, 'fixture-edit.txt'), 'utf8');
    const writtenFilePath = path.join(workspace, 'smoke-created.txt');
    if (!editedFile.includes('EDIT_AFTER') || editedFile.includes('EDIT_BEFORE')) {
      throw new Error('Tool Edit tidak menghasilkan perubahan yang diharapkan. Isi file: ' + JSON.stringify(editedFile));
    }
    if (!fs.existsSync(writtenFilePath)) {
      throw new Error('Tool Write tidak membuat smoke-created.txt.');
    }
    const writtenFile = fs.readFileSync(writtenFilePath, 'utf8').trim();
    if (writtenFile !== 'WRITE_OK') {
      throw new Error('Isi smoke-created.txt tidak sesuai. Isi aktual: ' + JSON.stringify(writtenFile));
    }

    const finalText = events
      .filter((event) => event.type === 'result')
      .map((event) => event.result || '')
      .join('\n');

    for (const name of REQUIRED_TOOLS) console.log('PASS tool invoked:', name);
    console.log('PASS tool results observed:', toolResults.length);
    console.log('PASS Edit changed only the isolated fixture');
    console.log('PASS Write created the isolated fixture');
    console.log('PASS Bash command was exactly pwd');
    if (finalText) console.log('\nClaude Code final response:\n' + finalText);
    if (stderr.trim()) console.log('\nClaude Code diagnostics (stderr):\n' + stderr.trim().slice(-3000));
    if (nonJson.length) console.log('\nAdditional CLI output:\n' + nonJson.join('\n').slice(-2000));
    console.log('\nCLAUDE CODE INTEGRATION TEST PASSED');
  } finally {
    try { fs.unlinkSync(settingsPath); } catch {}
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  console.error('\nCLAUDE CODE INTEGRATION TEST FAILED');
  console.error(error && error.stack ? error.stack : error);
  console.error('\nEnsure npm start is running and Playwright Chrome is signed in to DeepSeek.');
  console.error('If gateway auth is enabled, set DEEPSEEK_SUPER_TOKEN to the same token used by the server.');
  process.exitCode = 1;
});
