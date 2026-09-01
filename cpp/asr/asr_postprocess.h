// Everything that must happen to model output before anything else is allowed to see it.
//
// This was inside whisper's decode loop, which made it whisper's private habit rather than a
// property of the layer. Both hazards it guards are load-bearing: an invalid UTF-8 byte makes
// nlohmann's dump() throw (uncaught, that is a SIGABRT after a whole meeting has processed) and
// ART's NewStringUTF abort the VM. An engine author who has not read that history must not be
// able to reintroduce it by writing a new engine.
#pragma once
#include <string>

namespace audionotes {

// One raw model segment, made safe and presentable. Returns "" when nothing survives, which the
// caller drops rather than emitting an empty utterance.
std::string normalizeSegmentText(const std::string& raw);

}  // namespace audionotes
