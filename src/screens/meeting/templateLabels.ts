/**
 * The seven meeting types (Phase 2, sub-project 6a), in table order — also the order the
 * Summary tab's sheet lists them in. "general" first: it is the fallback everything else falls
 * back to, not the type that scores highest.
 */
export const TEMPLATE_IDS = [
  'general', 'standup', 'one_on_one', 'client', 'interview', 'lecture', 'site_walk',
] as const;

export type TemplateId = (typeof TEMPLATE_IDS)[number];

const LABEL: Record<TemplateId, string> = {
  general: 'General',
  standup: 'Stand-up',
  one_on_one: 'One-to-one',
  client: 'Client call',
  interview: 'Interview',
  lecture: 'Lecture',
  site_walk: 'Site walk',
};

/** One line for the sheet row, under the label — what the narrative will cover. */
const HINT: Record<TemplateId, string> = {
  general: "Today's shape — no fixed sections.",
  standup: 'Done since last time, planned next, blockers.',
  one_on_one: 'Topics raised, agreed, follow-ups.',
  client: 'What was asked for, what was committed to, what is next.',
  interview: 'Background, questions and answers, strengths, concerns.',
  lecture: 'Key points, definitions, questions raised, to read or do.',
  site_walk: 'Observations, issues found, actions agreed.',
};

function isTemplateId(id: string): id is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(id);
}

/** "General" for null, undefined, and any id TemplateSuggester does not recognise. */
export function templateLabel(id: string | null | undefined): string {
  return id && isTemplateId(id) ? LABEL[id] : 'General';
}

export function templateHint(id: TemplateId): string {
  return HINT[id];
}
