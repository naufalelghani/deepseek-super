'use strict';

// This function is serialized into the Qwen page by Playwright.
function readQwenStateInPage(options = {}) {
  const finalSnapshot = options.final === true;
  const assistantItems = Array.from(
    document.querySelectorAll('.qwen-chat-message.qwen-chat-message-assistant')
  );
  const last = assistantItems.length ? assistantItems[assistantItems.length - 1] : null;
  const response = last
    ? (last.querySelector('.response-message-content.t2t.phase-answer') ||
      last.querySelector('.response-message-content'))
    : null;
  const answer = response ? (response.innerText || response.textContent || '') : '';

  const statusTitleElement = last
    ? last.querySelector('.qwen-chat-thinking-status-card-title-text')
    : null;
  const statusTitle = statusTitleElement
    ? (statusTitleElement.innerText || statusTitleElement.textContent || '').trim()
    : '';
  const statusCard = last ? last.querySelector('.qwen-chat-thinking-status-card') : null;
  const statusClass = statusCard && typeof statusCard.className === 'string'
    ? statusCard.className
    : '';
  const statusComplete = /completed|complete|finished|done/i.test(statusTitle) ||
    /status-card-completed/i.test(statusClass);

  const copyButton = last
    ? last.querySelector('.response-message-footer-actions button[aria-label="Copy"]')
    : null;
  const composer = document.querySelector('textarea.message-input-textarea');
  const sendButton = document.querySelector('button.send-button[aria-label="Send"]');
  const responseNode = last ? last.querySelector('.chat-response-message') : null;
  const answerKey = responseNode ? (responseNode.id || null) : null;

  const isVisible = (element) => {
    if (!element || element.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity || 1) !== 0 &&
      rect.width > 0 &&
      rect.height > 0;
  };

  const protocolPattern = /<\s*\/?\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls|invoke|parameter)\b/i;
  const richMarkdown = Boolean(response && response.querySelector('pre, table, ul, ol, blockquote'));
  const links = response
    ? Array.from(response.querySelectorAll('a[href]')).map((anchor) => ({
        text: (anchor.innerText || anchor.textContent || '').trim(),
        url: anchor.href || anchor.getAttribute('href') || '',
      })).filter((link) => /^https?:\/\//i.test(link.url))
    : [];

  return {
    count: assistantItems.length,
    answerKey,
    answer,
    answerMarkdown: answer,
    answerMarkdownStable: finalSnapshot ? answer : '',
    answerIsProtocol: protocolPattern.test(answer),
    answerHasRichMarkdown: richMarkdown,
    answerLinks: links,
    think: '',
    composerReady: isVisible(composer),
    sendButtonEnabled: Boolean(sendButton && !sendButton.disabled),
    completionSignalAvailable: Boolean(statusTitle || isVisible(copyButton)),
    isGenerating: Boolean(statusCard && !statusComplete),
    statusTitle,
    statusComplete,
    copyAvailable: isVisible(copyButton),
  };
}

module.exports = { readQwenStateInPage };
