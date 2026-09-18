// Spoken punctuation for dictation mode (Phase 5). A person dictating says "full stop", "comma",
// "new paragraph"; the recogniser writes those words down. This turns them into the marks, and
// nothing else: it is applied only to a meeting recorded in dictation mode, never to a meeting
// of several people, where "delete that" and "full stop" are things people say.
//
// The command list is deliberately short and unambiguous. "period" and "colon" are not commands:
// both are ordinary nouns ("the trial period", "the colon") and a rule that ate them would do
// more harm in one medical dictation than good in a hundred.
#pragma once
#include <string>

namespace audionotes {

// "we will not ship, full stop new paragraph tell finance comma the invoice is late question mark"
// -> "We will not ship.\n\nTell finance, the invoice is late?"
// Case-insensitive, whole words; a comma or full stop the recogniser attached to the command word
// is absorbed; the letter after a sentence mark or a line break is capitalised; runs of spaces
// and doubled marks are collapsed. Text with no command word comes back byte for byte.
std::string applySpokenPunctuation(const std::string& text);

}  // namespace audionotes
