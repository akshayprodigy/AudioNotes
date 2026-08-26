// Prompt text, transcript chunking and the fold plan — the half of the LLM minutes path that
// needs no JSON parser.
//
// Split out of llm_minutes.cpp so Android can build it without nlohmann. The JNI layer notes that
// nlohmann was deliberately kept out of libaudionotes (~200 KB of template machinery to parse two
// small arrays); Android calls the prompt builders, the chunker and foldPlan, and never calls
// parseMinutesJson, so it has no reason to pay for the parser.
//
// The map/reduce prompt strings are kept in step with src/pipeline/summarize.ts. They are
// model-tuned artifacts: change them only against a measurement, and change both copies together.
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
         "Rules:\n"
         "- Leave a section with nothing under it EMPTY. Never write None, N/A, or a sentence "
         "saying there were none.\n"
         "- Omit the owner or the due date when it was not said. Never write that it was not "
         "said, not specified or not mentioned.\n"
         "- Put a line under QUESTIONS only if someone actually asked it and nobody answered.\n"
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
         "through, what was settled, and what was left open. Use only what the record supports.\n"
         "Rules:\n"
         "- Begin with the first sentence of the minutes. No title, no heading, no markdown.\n"
         "- No bullet points and no numbered lists.\n"
         "- Write about the MEETING, never about the record. Never write the words transcript, "
         "record, notes, or minutes.\n"
         "- Never say that something was not stated, not specified, not mentioned, not decided or "
         "not clarified. If a detail is missing, leave it out silently.\n"
         "- Do not mention how long the meeting was or when it started or ended.\n"
         "Start writing the minutes now:";
}

std::string summaryPrompt(const std::string& narrative) {
  return "Below are the minutes of a meeting.\n\n"
         "MINUTES:\n" + narrative + "\n\n"
         "Write 2 to 3 sentences saying what the meeting was about and where it ended up.\n"
         "Rules:\n"
         "- Plain prose. No list, no heading, no markdown.\n"
         "- Write about the MEETING, never about the record. Never write the words transcript, "
         "record, notes, or minutes.\n"
         "- Never say that something was not stated, not specified, not mentioned, not decided or "
         "not clarified. If a detail is missing, leave it out silently.\n"
         "- Do not mention how long the meeting was or when it started or ended.\n"
         "Start writing the summary now:";
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

std::string digestPrompt(const std::string& chunk) {
  return "Below is part of a meeting transcript.\n\n"
         "TRANSCRIPT:\n" + chunk + "\n\n"
         "In three or four sentences of plain prose, say what this part of the meeting was about "
         "and what the group worked through. Use only what the transcript supports.\n"
         "Rules:\n"
         "- Plain prose only. No heading, no bullet points, no numbered list, no markdown.\n"
         "- Never say that something was not stated, not specified or not decided. If a detail is "
         "missing, leave it out silently.\n"
         "Start writing now:";
}

std::string condensePrompt(const std::string& prose) {
  return "Below are accounts of consecutive parts of ONE meeting.\n\n"
         "ACCOUNT:\n" + prose + "\n\n"
         "Rewrite them as one shorter continuous account, in plain prose, keeping every distinct "
         "topic, decision and task.\n"
         "Rules:\n"
         "- Plain prose only. No heading, no bullet points, no numbered list, no markdown.\n"
         "- Never say that something was not stated, not specified or not decided.\n"
         "Start writing now:";
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

std::string stripMarkdown(const std::string& s) {
  std::string out;
  out.reserve(s.size());

  bool at_line_start = true;
  for (std::size_t i = 0; i < s.size();) {
    if (at_line_start) {
      std::size_t j = i;
      while (j < s.size() && (s[j] == ' ' || s[j] == '\t')) ++j;

      // A horizontal rule ("---", "***", "___") is invisible in markdown and three literal dashes
      // in plain text. Drop the whole line, including its newline, rather than leaving a stray row
      // of punctuation mid-document.
      std::size_t eol = s.find('\n', j);
      const std::size_t line_end = (eol == std::string::npos) ? s.size() : eol;
      if (line_end > j) {
        const char c0 = s[j];
        if (c0 == '-' || c0 == '*' || c0 == '_') {
          bool rule = true;
          std::size_t run = 0;
          for (std::size_t k = j; k < line_end; ++k) {
            if (s[k] == c0) { ++run; continue; }
            if (s[k] == ' ' || s[k] == '\t' || s[k] == '\r') continue;
            rule = false;
            break;
          }
          if (rule && run >= 3) {
            i = (eol == std::string::npos) ? s.size() : eol + 1;
            continue;  // still at a line start
          }
        }
      }

      // Heading markers, and the space after them. Indentation before a marker is skipped too.
      if (j < s.size() && s[j] == '#') {
        while (j < s.size() && s[j] == '#') ++j;
        while (j < s.size() && (s[j] == ' ' || s[j] == '\t')) ++j;
        i = j;
      }
      at_line_start = false;
      continue;
    }
    // Emphasis runs and inline code ticks carry no meaning once rendered as plain text.
    if (s[i] == '*' || s[i] == '`') {
      const char c = s[i];
      while (i < s.size() && s[i] == c) ++i;
      continue;
    }
    if (s[i] == '_' && i + 1 < s.size() && s[i + 1] == '_') {
      i += 2;
      continue;
    }
    if (s[i] == '\n') at_line_start = true;
    out += s[i];
    ++i;
  }

  // Trim leading and trailing whitespace, and collapse blank-line runs to one.
  std::string collapsed;
  collapsed.reserve(out.size());
  int newlines = 0;
  for (char c : out) {
    if (c == '\n') {
      if (++newlines > 2) continue;
    } else if (c != '\r') {
      newlines = 0;
    }
    collapsed += c;
  }
  std::size_t a = collapsed.find_first_not_of(" \t\r\n");
  if (a == std::string::npos) return "";
  std::size_t b = collapsed.find_last_not_of(" \t\r\n");
  return collapsed.substr(a, b - a + 1);
}

Narration narrate(const std::vector<MinuteUtt>& utterances,
                  const std::vector<MinuteSpk>& speakers, const GenerateFn& generate,
                  std::size_t notes_budget_chars) {
  Narration out;
  if (utterances.empty()) return out;

  const auto chunks = chunkTranscript(transcriptLines(utterances, speakers));
  if (chunks.empty()) return out;

  // What the narrative is written FROM decides how it reads. Measured 2026-08-26 on the real
  // NeoSym recording: given the extraction notes the model answered with "#### Actions:" and a
  // bullet list however firmly the prompt forbade headings, because a small model mirrors the
  // shape of its input. Given the dialogue itself it wrote four specific, flowing sentences.
  //
  // So a meeting that fits one prompt goes straight in, and a longer one is digested into prose
  // — never into lists, which nothing downstream needs now that the rule extractor owns the items.
  std::string source;
  if (chunks.size() == 1) {
    source = chunks[0];
  } else {
    std::vector<std::string> digests;
    digests.reserve(chunks.size());
    for (const auto& c : chunks) {
      std::string d = generate(digestPrompt(c), 320);
      if (!d.empty()) digests.push_back(stripMarkdown(d));
    }
    if (digests.empty()) return out;

    // Condense in groups until the account fits one prompt. Bounded at four rounds: foldPlan
    // refuses to group a single oversize entry, so one enormous digest would otherwise spin.
    for (int round = 0; round < 4; ++round) {
      const auto plan = foldPlan(digests, notes_budget_chars);
      if (plan.empty()) break;
      std::vector<std::string> next;
      std::vector<bool> grouped(digests.size(), false);
      for (const auto& group : plan) {
        std::string joined;
        for (int idx : group) {
          if (!joined.empty()) joined += "\n\n";
          joined += digests[static_cast<size_t>(idx)];
          grouped[static_cast<size_t>(idx)] = true;
        }
        std::string merged = generate(condensePrompt(joined), 320);
        next.push_back(merged.empty() ? joined : stripMarkdown(merged));
      }
      // Entries outside any group already fit; carry them through unchanged.
      for (size_t i = 0; i < digests.size(); ++i) {
        if (!grouped[i]) next.push_back(digests[i]);
      }
      digests = std::move(next);
    }

    for (size_t i = 0; i < digests.size(); ++i) {
      if (i) source += "\n\n";
      source += digests[i];
    }
  }

  // Progressive condensation. Only the narrative pays a full prefill; the other two read a few
  // hundred characters, and neither can contradict the one above it.
  out.narrative = stripMarkdown(generate(narrativePrompt(source), 640));
  if (out.narrative.empty()) return out;
  out.summary = stripMarkdown(generate(summaryPrompt(out.narrative), 192));
  if (out.summary.empty()) return out;
  out.headline = generate(headlinePrompt(out.summary), 48);
  return out;
}

}  // namespace audionotes
