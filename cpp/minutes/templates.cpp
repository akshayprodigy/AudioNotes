#include "minutes/templates.h"

#include <unordered_map>

namespace audionotes {

const char* const kTemplateIds[7] = {
    "general", "standup", "one_on_one", "client", "interview", "lecture", "site_walk",
};

namespace {

// Section names, in the order the narrative should cover them. Every string here is also what
// the narrator opens a paragraph with, followed by a colon — see the coverage instruction built
// in narrativePrompt (llm_prompts.cpp).
const std::unordered_map<std::string, std::vector<std::string>>& sectionTable() {
  static const std::unordered_map<std::string, std::vector<std::string>> table = {
      {"standup", {"Done since last time", "Planned next", "Blockers"}},
      {"one_on_one", {"Topics raised", "Agreed", "Follow-ups"}},
      {"client",
       {"What the client asked for", "What we committed to", "Risks and open points",
        "Next steps"}},
      {"interview",
       {"Background", "Questions and answers", "Strengths", "Concerns", "Next step"}},
      {"lecture", {"Key points", "Definitions and terms", "Questions raised", "To read or do"}},
      {"site_walk", {"Observations", "Issues found", "Actions agreed"}},
  };
  return table;
}

}  // namespace

std::vector<std::string> sectionsFor(const std::string& template_id) {
  const auto& table = sectionTable();
  const auto it = table.find(template_id);
  if (it == table.end()) return {};
  return it->second;
}

}  // namespace audionotes
