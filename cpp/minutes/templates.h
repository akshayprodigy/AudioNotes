// The seven meeting types Phase 2 ships (moat feature #13, docs/PRODUCT_RESEARCH_2026-09.md §2.4):
// stand-up, one-to-one, client call, interview, lecture, site walk, and general. A type changes
// only the SECTIONS the narrator's prose covers — the transcript, the rule-based items, the
// classifier and exports are unchanged (see the Phase 2 brief, docs/superpowers/specs/
// 2026-09-17-phase-2-meeting-templates-brief.md §1).
#pragma once
#include <string>
#include <vector>

namespace audionotes {

// In table order — the order a tied TemplateSuggester score breaks by, and the order the Summary
// tab's sheet lists them in. "general" is first because it is the fallback everything else falls
// back to, not because it scores highest.
extern const char* const kTemplateIds[7];
constexpr std::size_t kTemplateIdsCount = 7;

// The sections a Pro narrative covers for a type, in the order they should appear. Empty for
// "general" (today's narrative, unchanged) and for any id TemplateSuggester or a person's
// remembered choice does not recognise — an unrecognised id is general in every language that
// reads this table.
std::vector<std::string> sectionsFor(const std::string& template_id);

}  // namespace audionotes
