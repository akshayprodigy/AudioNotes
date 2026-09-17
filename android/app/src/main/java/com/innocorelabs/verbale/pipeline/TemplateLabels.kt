package com.innocorelabs.verbale.pipeline

/**
 * What a meeting type wears — the Summary tab's chip and the sheet that changes it. Mirror of
 * src/screens/meeting/templateLabels.ts, against cpp/tests/golden/template_labels.json, the same
 * pairing RecordLabels.kt keeps with recordLabels.ts.
 *
 * "General" for null and for any id TemplateSuggester or a person's remembered choice does not
 * recognise — never a blank chip, and never a throw over a column that is legitimately NULL until
 * the rule pass first runs.
 */
object TemplateLabels {
  private val LABEL = mapOf(
    "general" to "General",
    "standup" to "Stand-up",
    "one_on_one" to "One-to-one",
    "client" to "Client call",
    "interview" to "Interview",
    "lecture" to "Lecture",
    "site_walk" to "Site walk",
  )

  fun labelFor(templateId: String?): String = LABEL[templateId] ?: "General"
}
