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

namespace {

// EMPTY for English, and that is the important part. These prompts are model-tuned artifacts —
// the file header says to change them only against a measurement — and English is the one
// configuration that has actually been measured. Adding "Write in English." to it would perturb
// the tuned path for every existing user in exchange for nothing, since an English transcript
// already produces English prose. Non-English is where the output language is currently
// undefined, so that is where an instruction is pure gain.
//
// Naming the language beats echoing a code: a model handed "Write in zz." either invents a
// language or leaks the code into its answer. Unknown codes therefore fall back to English.
std::string languageDirective(const std::string& code) {
  if (code == "hi") return "- Write in Hindi.\n";
  if (code == "es") return "- Write in Spanish.\n";
  if (code == "fr") return "- Write in French.\n";
  if (code == "de") return "- Write in German.\n";
  return std::string();
}

}  // namespace

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

std::string narrativePrompt(const std::string& notes, const std::string& language) {
  const std::string lang = languageDirective(language);
  // "Write the minutes" is itself the trigger: asked for minutes, the model reaches for the
  // MINUTES FORM it has seen thousands of times and fills it in — "Meeting Minutes", a Date &
  // Time line, an Attendees list, a numbered Agenda. On the IPD meeting it shipped the literal
  // string "Date & Time: [Current Date] at [Time]" to the reader and promoted an ASR mis-hearing
  // into a named attendee. So the word is gone from the instruction, and the form is refused
  // field by field rather than in the general terms the model was happy to ignore.
  return "Below is the record of one meeting. Write an account of it in plain prose, for someone "
         "who was not there.\n\n"
         "RECORD:\n" + notes + "\n\n"
         "Write three or four short paragraphs covering what the meeting was about, what the "
         "group worked through, what was settled and what was left open. Those four things are "
         "what to cover, NOT labels to copy down. Use only what the record supports.\n"
         "Rules:\n"
         "- Prose only, in full sentences grouped into paragraphs. This is NOT a form to fill in: "
         "no title, no heading, no Date line, no Attendees list, no Agenda, no numbered sections, "
         "no bullet points, no markdown.\n"
         "- Never write a placeholder such as [Date], [Time] or [Name]. If you do not know a "
         "detail, leave it out.\n"
         "- Do not list who was there, and do not give anyone a name or a title that the record "
         "does not give them.\n"
         "- Do not open with a title such as \"Meeting Summary\", and do not head or label any "
         "paragraph. No Topic line, no Date line, no Attendees line — not even to say they are "
         "unknown. The first thing you write is the first sentence of the account.\n"
         "- Write about the MEETING, never about the record. Never write the words transcript, "
         "record, notes, or minutes.\n"
         "- Never say that something was not stated, not specified, not mentioned, not decided or "
         "not clarified. If a detail is missing, leave it out silently.\n"
         "- Do not mention how long the meeting was or when it started or ended.\n"
         + lang +
         "Start writing now:";
}

std::string summaryPrompt(const std::string& narrative, const std::string& language) {
  const std::string lang = languageDirective(language);
  return "Below is an account of a meeting.\n\n"
         "ACCOUNT:\n" + narrative + "\n\n"
         "In about 70 words, say what the meeting was about and where it ended up.\n"
         "Rules:\n"
         "- Write at most 4 sentences, then stop. This is the short version: name the subject "
         "and where it ended up, and leave the detail out.\n"
         "- Plain prose. One paragraph. No list, no heading, no markdown.\n"
         "- Write flowing sentences. Do not string the subjects together as one long comma-"
         "separated list of everything that came up.\n"
         "- No title and no label. Start with the first sentence of the summary itself.\n"
         "- Write about the MEETING, never about the record. Never write the words transcript, "
         "record, notes, or minutes.\n"
         "- Never say that something was not stated, not specified, not mentioned, not decided or "
         "not clarified. If a detail is missing, leave it out silently.\n"
         "- Do not mention how long the meeting was or when it started or ended.\n"
         + lang +
         "Start writing the summary now:";
}

std::string headlinePrompt(const std::string& summary, const std::string& language) {
  const std::string lang = languageDirective(language);
  return "Below is a summary of a meeting.\n\n"
         "SUMMARY:\n" + summary + "\n\n"
         + lang +
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

std::string digestPrompt(const std::string& chunk, const std::string& language) {
  const std::string lang = languageDirective(language);
  return "Below is part of a meeting transcript.\n\n"
         "TRANSCRIPT:\n" + chunk + "\n\n"
         "In three or four sentences of plain prose, say what this part of the meeting was about "
         "and what the group worked through. Use only what the transcript supports.\n"
         "Rules:\n"
         "- Plain prose only. No heading, no bullet points, no numbered list, no markdown.\n"
         "- Never say that something was not stated, not specified or not decided. If a detail is "
         "missing, leave it out silently.\n"
         + lang +
         "Start writing now:";
}

std::string condensePrompt(const std::string& prose, const std::string& language) {
  const std::string lang = languageDirective(language);
  return "Below are accounts of consecutive parts of ONE meeting.\n\n"
         "ACCOUNT:\n" + prose + "\n\n"
         "Rewrite them as one shorter continuous account, in plain prose, keeping every distinct "
         "topic, decision and task.\n"
         "Rules:\n"
         "- Plain prose only. No heading, no bullet points, no numbered list, no markdown.\n"
         "- Never say that something was not stated, not specified or not decided.\n"
         + lang +
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

namespace {
// Longer than this and a line is prose, whatever punctuation it ends with.
constexpr std::size_t kMaxLabelChars = 60;
// A form field name ("Date & Time", "Attendees") is short. Anything longer before the colon is a
// clause, and the line is prose.
constexpr std::size_t kMaxFieldNameChars = 30;

std::string trimLine(const std::string& l) {
  const std::size_t a = l.find_first_not_of(" \t\r");
  if (a == std::string::npos) return std::string();
  const std::size_t b = l.find_last_not_of(" \t\r");
  return l.substr(a, b - a + 1);
}
}  // namespace

std::string stripLabels(const std::string& s) {
  std::vector<std::string> lines;
  for (std::size_t start = 0;;) {
    const std::size_t nl = s.find('\n', start);
    if (nl == std::string::npos) { lines.push_back(s.substr(start)); break; }
    lines.push_back(s.substr(start, nl - start));
    start = nl + 1;
  }

  // "Prose so far" gates the header rules: they apply only above the first real sentence, so a
  // colon inside the body can never be mistaken for a form field.
  bool prose_seen = false;
  std::vector<std::string> kept;
  for (std::size_t i = 0; i < lines.size(); ++i) {
    const std::string t = trimLine(lines[i]);
    bool drop = false;
    if (!t.empty()) {
      const char last = t.back();
      const bool ends_sentence = last == '.' || last == '!' || last == '?';
      if (!ends_sentence) {
        if (last == ':' && t.size() <= kMaxLabelChars) {
          drop = true;  // "What was settled:"
        } else if (!prose_seen) {
          // The header block of the form the model keeps reaching for: "Meeting Topic: ...",
          // "Date & Time: Not specified", "Attendees: Not listed". Denied the placeholders it
          // used to invent, it now asserts the absence instead — which is exactly what the
          // prompt forbids and the worse of the two failures.
          const std::size_t colon = t.find(':');
          const bool header_field =
              colon != std::string::npos && colon > 0 && colon <= kMaxFieldNameChars &&
              t.find_first_of(".!?") > colon && colon + 1 < t.size();
          // A lead title: the opening line, alone, with a blank line under it. Without the blank
          // line this is just a paragraph that has not reached its full stop yet.
          const bool lead_title = kept.empty() && t.size() <= kMaxLabelChars &&
                                  i + 1 < lines.size() && trimLine(lines[i + 1]).empty();
          drop = header_field || lead_title;
        }
      }
      if (!drop) prose_seen = true;
    }
    if (!drop) kept.push_back(lines[i]);
  }

  std::string out;
  for (std::size_t i = 0; i < kept.size(); ++i) {
    if (i) out += '\n';
    out += kept[i];
  }

  // Removing a label leaves the blank line that separated it behind.
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
  const std::size_t a = collapsed.find_first_not_of(" \t\r\n");
  if (a == std::string::npos) return "";
  const std::size_t b = collapsed.find_last_not_of(" \t\r\n");
  return collapsed.substr(a, b - a + 1);
}

std::string trimToSentence(const std::string& s) {
  // Closing punctuation may follow the terminator: a quoted sentence ends `."` and a parenthetical
  // ends `.)`. Keep those, so the cut does not leave an orphaned opener behind.
  auto is_closer = [](char c) { return c == '"' || c == '\'' || c == ')' || c == ']'; };

  std::size_t end = s.find_last_not_of(" \t\r\n");
  if (end == std::string::npos) return s;

  for (std::size_t i = end + 1; i-- > 0;) {
    const char c = s[i];
    if (c != '.' && c != '!' && c != '?') continue;

    // Everything between the terminator and the next real character must be closers or space,
    // otherwise this is a mid-word dot rather than the end of a sentence.
    std::size_t j = i + 1;
    while (j < s.size() && is_closer(s[j])) ++j;
    const bool ends_here = j >= s.size() || s[j] == ' ' || s[j] == '\t' || s[j] == '\r' ||
                           s[j] == '\n';
    if (!ends_here) continue;

    std::string cut = s.substr(0, j);
    std::size_t last = cut.find_last_not_of(" \t\r\n");
    if (last == std::string::npos) return s;
    return cut.substr(0, last + 1);
  }
  return s;
}

namespace {
// The formulaic closers the model reaches for, lowercased. Deliberately specific: each one is a
// statement ABOUT the meeting having failed to produce something, not an ordinary use of "not".
const char* const kAbsencePhrases[] = {
    "did not specify",   "did not conclude",    "did not state",      "did not mention",
    "did not decide",    "did not clarify",     "did not result in",  "was not specified",
    "were not specified", "was not mentioned",  "were not mentioned", "was not decided",
    "were not decided",  "no decisions were",   "no specific actions", "no further action",
    "not explicitly",    "remains unclear",     "remain unclear",
};

std::string toLower(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (char c : s) out += static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c);
  return out;
}

// Index just past the terminator that closes the second-to-last sentence, or npos when the text
// holds only one sentence.
std::size_t lastSentenceStart(const std::string& s) {
  const std::size_t end = s.find_last_not_of(" \t\r\n");
  if (end == std::string::npos) return std::string::npos;
  // Skip the final sentence's own terminator so it cannot match itself.
  std::size_t i = end;
  while (i > 0 && (s[i] == '.' || s[i] == '!' || s[i] == '?' || s[i] == '"' || s[i] == '\'' ||
                   s[i] == ')' || s[i] == ']')) {
    --i;
  }
  for (; i > 0; --i) {
    const char c = s[i];
    if (c != '.' && c != '!' && c != '?') continue;
    std::size_t j = i + 1;
    while (j < s.size() && (s[j] == '"' || s[j] == '\'' || s[j] == ')' || s[j] == ']')) ++j;
    if (j >= s.size()) continue;
    if (s[j] == ' ' || s[j] == '\t' || s[j] == '\r' || s[j] == '\n') return j;
  }
  return std::string::npos;
}
}  // namespace

namespace {
// Everything between a raw generation and the reader, in order: strip the markup, then the labels
// it was hiding under, then the closing caveat, and only then cut to a whole sentence — so
// trimming is the last word. Narrator.clean mirrors this exactly.
std::string clean(const std::string& raw) {
  return trimToSentence(dropAbsenceTail(stripLabels(stripMarkdown(raw))));
}
}  // namespace

std::string dropAbsenceTail(const std::string& s) {
  std::string out = s;
  // Two caveats in a row happen; more than that and something else is wrong, so stop rather than
  // eat the answer a sentence at a time.
  for (int round = 0; round < 2; ++round) {
    const std::size_t start = lastSentenceStart(out);
    if (start == std::string::npos) break;

    const std::string tail = toLower(out.substr(start));
    bool absence = false;
    for (const char* phrase : kAbsencePhrases) {
      if (tail.find(phrase) != std::string::npos) { absence = true; break; }
    }
    if (!absence) break;

    const std::string head = out.substr(0, start);
    const std::size_t last = head.find_last_not_of(" \t\r\n");
    if (last == std::string::npos) break;  // nothing would be left
    out = head.substr(0, last + 1);
  }
  return out.empty() ? s : out;
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
  out.narrative = clean(generate(narrativePrompt(source), 640));
  if (out.narrative.empty()) return out;
  out.summary = clean(generate(summaryPrompt(out.narrative), 192));
  if (out.summary.empty()) return out;
  out.headline = generate(headlinePrompt(out.summary), 48);
  return out;
}

}  // namespace audionotes
