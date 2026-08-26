// Prompt text, transcript chunking and the fold plan — the half of the LLM minutes path that
// needs no JSON parser.
//
// Split out of llm_minutes.cpp so Android can build it without nlohmann. The JNI layer notes that
// nlohmann was deliberately kept out of libaudionotes (~200 KB of template machinery to parse two
// small arrays); Android calls the prompt builders, the chunker and foldPlan, and never calls
// parseMinutesJson, so it has no reason to pay for the parser.
//
// The map/reduce prompt strings are copied VERBATIM from src/pipeline/summarize.ts — they are
// model-tuned artifacts, not prose to be improved.
#include "minutes/llm_minutes.h"

#include <cstddef>
#include <unordered_map>

namespace audionotes {

std::vector<std::string> transcriptLines(const std::vector<MinuteUtt>& utterances,
                                         const std::vector<MinuteSpk>& speakers) {
  std::unordered_map<std::string, std::string> name_by_id;
  for (const auto& s : speakers) name_by_id[s.id] = s.display_name;
  std::vector<std::string> out;
  out.reserve(utterances.size());
  for (const auto& u : utterances) {
    std::string who = "Speaker";
    if (!u.speaker_id.empty()) {
      auto it = name_by_id.find(u.speaker_id);
      if (it != name_by_id.end()) who = it->second;
    }
    out.push_back(who + ": " + u.text);
  }
  return out;
}

std::vector<std::string> chunkTranscript(const std::vector<std::string>& lines,
                                         size_t max_chars) {
  std::vector<std::string> chunks;
  std::string cur;
  for (const auto& line : lines) {
    if (cur.size() + line.size() + 1 > max_chars && !cur.empty()) {
      chunks.push_back(cur);
      cur.clear();
    }
    cur += (cur.empty() ? "" : "\n") + line;
  }
  if (!cur.empty()) chunks.push_back(cur);
  return chunks;
}

std::string mapPrompt(const std::string& chunk) {
  return "Below is part of a meeting transcript. Extract only what is explicitly stated. "
         "List decisions, action items (with owner and any due date), and open questions. "
         "Be concise and factual; do not invent anything.\n\n"
         "TRANSCRIPT:\n" + chunk + "\n\n"
         "Format:\nDECISIONS:\n- ...\nACTIONS:\n- <task> \xE2\x80\x94 <owner> (due <when>)\nQUESTIONS:\n- ...";
}

std::string reducePrompt(const std::string& notes) {
  return "These are notes from consecutive parts of ONE meeting. Merge them into final minutes. "
         "Remove duplicates. Only include what the notes support.\n\n"
         "NOTES:\n" + notes + "\n\n"
         "Respond with ONLY a JSON object, no prose, in exactly this shape. Replace every "
         "angle-bracket description with real text from the notes, and use an empty array when a "
         "section has nothing in it:\n"
         "{\"summary\":\"<2-3 sentence overview>\",\"decisions\":[\"<a decision that was made>\"],"
         "\"actions\":[{\"text\":\"<what will be done>\",\"owner\":\"<who>\",\"due\":\"<when, or empty>\"}],"
         "\"questions\":[\"<a question left unanswered>\"]}";
}

std::string narrativePrompt(const std::string& notes) {
  return "Below is the record of one meeting. Write the minutes as plain prose for someone who was "
         "not there.\n\n"
         "RECORD:\n" + notes + "\n\n"
         "Write three or four short paragraphs: what the meeting was about, what the group worked "
         "through, what was settled, and what was left open. Use only what the record supports. "
         "Do not use headings, bullet points, or numbered lists. Do not comment on what the record "
         "does or does not contain. Start writing the minutes now:";
}

std::string summaryPrompt(const std::string& narrative) {
  return "Below are the minutes of a meeting.\n\n"
         "MINUTES:\n" + narrative + "\n\n"
         "Write 2 to 3 sentences saying what the meeting was about and where it ended up. Write "
         "plain prose. Do not list items, do not use headings, and do not comment on what the "
         "minutes do or do not contain. Start writing the summary now:";
}

std::string headlinePrompt(const std::string& summary) {
  return "Below is a summary of a meeting.\n\n"
         "SUMMARY:\n" + summary + "\n\n"
         "In ONE sentence of at most 15 words, say what this meeting was about. Write only that "
         "sentence, with no label, no quotation marks and no trailing notes:";
}

std::string foldPrompt(const std::string& notes) {
  return "These are notes from consecutive parts of ONE meeting. Merge them into a single set of "
         "notes. Remove duplicates. Keep every distinct decision, action and question. Do not "
         "summarise them away.\n\n"
         "NOTES:\n" + notes + "\n\n"
         "Format:\nDECISIONS:\n- ...\nACTIONS:\n- <task> \xE2\x80\x94 <owner> (due <when>)\n"
         "QUESTIONS:\n- ...";
}

std::vector<std::vector<int>> foldPlan(const std::vector<std::string>& notes,
                                       std::size_t max_chars) {
  std::vector<std::vector<int>> plan;
  std::size_t total = 0;
  for (const auto& n : notes) total += n.size() + 2;  // "\n\n" join
  if (total <= max_chars) return plan;

  std::vector<int> group;
  std::size_t joined = 0;
  for (std::size_t i = 0; i < notes.size(); ++i) {
    const std::size_t cost = notes[i].size() + 2;
    if (!group.empty() && joined + cost > max_chars) {
      if (group.size() >= 2) plan.push_back(group);
      group.clear();
      joined = 0;
    }
    group.push_back(static_cast<int>(i));
    joined += cost;
  }
  if (group.size() >= 2) plan.push_back(group);
  return plan;
}

}  // namespace audionotes
