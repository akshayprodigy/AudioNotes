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

// The narrative's shape, made a rule. Asked for "Done since last time: <sentences>" paragraphs,
// the 1.5B writer sometimes puts the section name alone on a line — with bullets under it, or as
// a markdown header over a paragraph (measured 17 Sep on the Mac; both on the same fixture, one
// prompt wording apart). Narrator.clean's stripLabels then drops the bare name as a form label
// and the sections are gone. This runs after stripMarkdown and before stripLabels: a line that is
// exactly one of the type's section names (any case, with or without a trailing colon) is joined
// with the lines that follow it, up to the next such line, into one paragraph — "<Name>: " then
// the fragments with any bullet marker removed, each capitalised and given a full stop if it has
// no end. Text before the first header is kept as it is. Identity for "general" and for any id
// without sections, and for a narrative already in the asked-for shape.
std::string foldSections(const std::string& text, const std::string& template_id);

}  // namespace audionotes
