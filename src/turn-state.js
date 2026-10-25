'use strict';

function hasNewAssistantResponse(previous, current) {
  if (!current) return false;
  const previousKey = previous && previous.answerKey;
  const currentKey = current.answerKey;
  if (currentKey && currentKey !== previousKey) return true;
  const previousAnswer = previous && previous.answer;
  return Boolean(current.answer && current.answer !== previousAnswer);
}

// This signal is only useful after a generation/stop control has actually been
// observed during the current turn. Otherwise callers should use the idle timer.
function isResponseComplete(state) {
  return Boolean(
    state &&
    state.completionSignalAvailable === true &&
    state.isGenerating === false &&
    state.sendButtonEnabled === true
  );
}

module.exports = { hasNewAssistantResponse, isResponseComplete };
