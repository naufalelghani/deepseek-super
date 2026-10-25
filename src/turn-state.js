'use strict';

function hasNewAssistantResponse(previous, current) {
  if (!current) return false;
  const previousKey = previous && previous.answerKey;
  const currentKey = current.answerKey;
  if (currentKey && currentKey !== previousKey) return true;
  const previousAnswer = previous && previous.answer;
  return Boolean(current.answer && current.answer !== previousAnswer);
}

module.exports = { hasNewAssistantResponse };
