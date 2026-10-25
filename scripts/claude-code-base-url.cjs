'use strict';

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8787';

/**
 * Claude Code appends /v1/messages to ANTHROPIC_BASE_URL.
 * Accept a conventional SDK-style URL ending in /v1, but normalize it to the
 * provider root before passing it to Claude Code.
 */
function normalizeClaudeCodeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid gateway base URL: ' + value);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Gateway base URL must use http:// or https://.');
  }
  if (url.username || url.password) {
    throw new Error('Do not place credentials in DEEPSEEK_SUPER_BASE_URL; use an API token environment variable.');
  }

  const pathname = url.pathname.replace(/\/v1\/?$/, '');
  const basePath = pathname && pathname !== '/' ? pathname.replace(/\/$/, '') : '';
  return url.origin + basePath + url.search;
}

function isDefaultLocalGateway(value) {
  try {
    const url = new URL(normalizeClaudeCodeBaseUrl(value));
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === 8787 &&
      (url.pathname === '/' || url.pathname === '');
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_GATEWAY_URL,
  normalizeClaudeCodeBaseUrl,
  isDefaultLocalGateway,
};
