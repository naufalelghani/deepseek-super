'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);

  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error(
      'Google Chrome executable was not found. Set CHROME_PATH or install Chrome in a standard Windows location.'
    );
  }
  return executable;
}

function listChromeProcessesUsingProfile(profileDir) {
  const absoluteProfile = path.resolve(profileDir);

  if (process.platform === 'win32') {
    const script = [
      '$profile = ' + psQuote(absoluteProfile),
      '$ids = @(Get-CimInstance Win32_Process |',
      '  Where-Object { $_.Name -eq ''chrome.exe'' -and $_.CommandLine -and $_.CommandLine.IndexOf($profile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine.Contains(''--user-data-dir'') } |',
      '  ForEach-Object { $_.ProcessId })',
      'if ($ids.Count -gt 0) { ConvertTo-Json -InputObject $ids -Compress }',
    ].join('; ');

    let output;
    try {
      output = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      const detail = error.stderr ? String(error.stderr).trim() : error.message;
      throw new Error('Could not check whether the project Chrome profile is in use: ' + detail);
    }

    if (!output) return [];
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map(Number)
      .filter(Number.isSafeInteger);
  }

  const output = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return output.split(/\r?\n/)
    .filter((line) => line.includes(absoluteProfile) && line.includes('--user-data-dir='))
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
    .filter(Number.isSafeInteger);
}

function assertProfileAvailable(profileDir) {
  const processIds = listChromeProcessesUsingProfile(profileDir);
  if (processIds.length > 0) {
    throw new Error(
      'The project Chrome profile is already in use by Chrome PID(s): ' +
      processIds.join(', ') +
      '. Close every Chrome window using this project profile, then retry.'
    );
  }
}

async function openManualChrome(profileDir, url) {
  fs.mkdirSync(profileDir, { recursive: true });
  assertProfileAvailable(profileDir);

  const executable = findChromeExecutable();
  const args = [
    '--new-window',
    '--user-data-dir=' + path.resolve(profileDir),
    url,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });

    child.once('error', (error) => reject(new Error(
      'Could not start the regular Chrome login window: ' + error.message
    )));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

  return executable;
}

module.exports = {
  assertProfileAvailable,
  findChromeExecutable,
  listChromeProcessesUsingProfile,
  openManualChrome,
};
