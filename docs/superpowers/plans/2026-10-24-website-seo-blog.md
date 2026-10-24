# Website: SEO, ASO, AI-assistant readiness, blog, light/dark — plan

Date: 24 Oct 2026 · Branch: `website-seo-blog` · Built subagent-driven (Sonnet), Opus oversees.

## Why

verbale.innocorelabs.com is one landing page served by the licence server (`server/app/`). Audit
(24 Oct):

- Live copy is stale ("Meetings up to 15 minutes", free export). The repo copy is current but
  undeployed.
- `robots.txt` allow-lists four paths, so anything new is blocked. No `sitemap.xml`, no canonical,
  no JSON-LD.
- Nothing for AI assistants: no `llms.txt`, no plain factual pages they can quote.
- No blog. No Play link (listing not public yet, `PLAY_URL = ""`).
- Dark mode follows the OS only; there is no toggle. The founder wants **light by default** with a
  toggle, on every page.

## Constraints every task carries

- Work in `server/` on branch `website-seo-blog`. Never push. Never deploy (deploy is the founder's
  yes).
- **Zero third-party requests** from any page (no CDN, fonts, analytics) — the landing page's
  stated principle (`server/app/static/landing.css` header). System font stack.
- TDD with pytest (`server/.venv/bin/pytest -q`, baseline 199 passed). Test first, watched failing.
  Each task names a mutant (applied with python, not sed) that must turn a test red; restore after.
- Server-rendered Python in the style of `pages.py` / `landing.py`: module docstrings explaining
  *why*, `html.escape` on every interpolated string, 4-space Python, 2-space CSS/JS.
- Only new dependency allowed: `markdown==3.11.2` (pinned in `requirements.txt`). Pillow is a
  dev-time tool dependency only (`requirements-dev.txt`), never imported by the app.
- Every claim on any page must be in the **Facts sheet** below. No screen or post names a model
  (no "Whisper", "Qwen", "Llama", "bge"). No named competitors.
- Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. `git status` clean
  at the end.

## Facts sheet (the only product claims allowed)

- Verbale records meetings in **English** and writes the transcript, speakers and minutes **on the
  phone**. Nothing is uploaded. Works with no signal after a one-time model download (do not state
  a size in new copy).
- Android, 64-bit phones. Some Pro features need 4 GB of memory; the app checks before downloading
  or buying.
- Recording continues with the screen off, in other apps, and in a small floating window
  (picture-in-picture). Long meetings process in the background and notify when ready.
- Free, forever, no account: 5 meetings a month, up to 1 hour each (imports and dictations count);
  full transcript separated by speaker, tap a line to hear it; decisions, actions, open questions,
  each linked to the moment it was said; mark a moment → highlight; dictation with spoken
  punctuation; search every word; copy any write-up.
- Pro (monthly ₹299 or yearly ₹2,499 in India; $4.99 / $39.99 elsewhere; 7-day free trial via
  Google Play): unlimited meetings of any length; export MP3, PDF, SRT, Markdown, text; summary and
  minutes written in plain English by a language model on the phone, shaped to the meeting type
  (stand-up, client call, interview, lecture); Ask a meeting a question, answer points at the
  moment or says nothing settles it; search by meaning; threads across tagged meetings; remembered
  voices (opt-in, on-device, forget in one tap); custom spellings; dictated notes written up; larger
  transcriber for accents and bad rooms; up to 3 devices. Written notes stay readable if you stop
  paying. Payments are not refundable; the trial is how to try it.
- Network use: model download, subscription check, opt-in crash reports (Crashlytics; never
  content). The app has a screen counting every network call it makes.
- Company: InnoCore Labs, Kolkata, India. Contact admin@innocorelabs.com. Site
  https://verbale.innocorelabs.com. App id `com.innocorelabs.verbale`.

## Design direction

Keep the landing page's look (`landing.css`: indigo `--primary #4A56D2`, violet `--primary-2`,
soft cards, radius 18/26, generous whitespace). Blog reading column ~68ch, 18px body, 1.7 line
height, real hierarchy, styled code/quote/table/figure. Both themes must be checked by eye
(headless Chrome screenshots at 390px and 1280px wide, light and dark).

---

## Task 1 — Theme: light by default, toggle on every page

- One theme mechanism for `landing.css` and the forms CSS in `pages.py`: tokens on `:root`
  (light), dark tokens under `:root[data-theme="dark"]`. Remove the `prefers-color-scheme` blocks.
  `color-scheme` follows the theme.
- Tiny inline script in `<head>` (in `layout()`) sets `data-theme` from `localStorage['theme']`
  before paint, default `light`, try/catch around storage. A `?theme=dark|light` query parameter
  overrides (and is stored), so a link or a headless screenshot can pick the theme.
- A toggle button (sun/moon inline SVG, `aria-label`, `aria-pressed`) in the nav of every page
  (landing nav, and a slim shared header for the form/legal pages that today have none). Toggling
  updates `data-theme`, `localStorage`, and `<meta name="theme-color">`.
- `landing.js` WebGL hero reads the theme from `data-theme` (MutationObserver on `<html>`), not
  `matchMedia`.
- Tests: `/`, `/privacy`, `/terms`, `/delete-account` contain the head script and the toggle; no
  `prefers-color-scheme` left in served CSS; dark tokens are under `[data-theme="dark"]`.
- Mutant: default theme in the head script changed to `dark` → a test fails.
- Accept: screenshots of `/` and `/privacy` in both themes look right; no flash of dark on load.

## Task 2 — SEO foundation

- `layout()` gains `path` (for `<link rel="canonical">` and `og:url`, absolute via
  `PUBLIC_BASE_URL`, default `https://verbale.innocorelabs.com`), `og_type`, `image`, and
  `jsonld` (list of dicts → `<script type="application/ld+json">`, JSON-escaped so `</script>` in
  data cannot break out).
- FAQ moves into a data list in `landing.py` (question, answer-html) used by the landing page,
  the new `/faq` page, and `FAQPage` JSON-LD.
- Home JSON-LD: `Organization` (InnoCore Labs, logo, email), `WebSite`, `SoftwareApplication`
  (`applicationCategory: BusinessApplication`, `operatingSystem: Android`, `offers` free + Pro).
- `PLAY_URL` from env `PLAY_URL` (default empty); when set, `SoftwareApplication.downloadUrl` and
  the hero button use it.
- `robots.txt`: allow everything except `/admin` and `/api/`; explicit `Allow: /` groups for
  GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, PerplexityBot,
  Google-Extended, Applebot-Extended, CCBot; `Sitemap:` line.
- `/sitemap.xml` built from one registry of public pages (and, after Task 3, every post with its
  `lastmod`). Includes `/delete-account`; excludes admin and api.
- A styled 404 page for unknown HTML paths (keeps API 404s JSON).
- Tests for each of the above, including JSON-LD parses as JSON and has the expected `@type`s.
- Mutant: drop `Disallow: /admin` → test fails.

## Task 3 — Blog engine

- Posts: `server/app/content/blog/<slug>.md` with front matter (`title`, `description` ≤160,
  `date`, `updated` optional, `tags`, `cover` image base name, `cover_alt`). Parsed and rendered
  once at startup (cached), with `markdown` extensions `extra`, `toc`, `sane_lists`.
- Routes: `/blog` (index: cards with cover, title, description, date, reading time, tag), `/blog/
  {slug}` (article: breadcrumb, title, date/updated, reading time, cover `<picture>` webp with
  width/height, table of contents from h2s, body, "Try Verbale" CTA card, 2–3 related posts by
  shared tag), `/blog/{slug}.md` (raw markdown, `text/markdown`), `/blog/feed.xml` (RSS 2.0).
- Per-article meta: canonical, `og:type=article`, `article:published_time`, per-post OG image
  `/static/blog/<cover>-og.png`, JSON-LD `BlogPosting` (headline, dates, author Organization,
  image) + `BreadcrumbList`.
- Images in markdown body get `loading="lazy"` and `decoding="async"`.
- Sitemap and nav include the blog. Ship with one short placeholder post under `tests/` fixtures
  only — real posts come in Task 5; the app must render `/blog` with zero posts gracefully.
- Tests: parse/front-matter validation (missing title → startup error), routes, RSS validity
  (parses as XML), JSON-LD, sitemap contains posts, unknown slug → 404, path traversal slug
  rejected.
- Mutant: reading-time or sort order (newest first) broken → test fails.

## Task 4 — Images that are ready

- `server/tools/make_images.py` (Pillow, Nunito from `../assets/fonts/`), run by hand, outputs
  committed under `server/app/static/blog/` and `server/app/static/shots/`:
  - Per post: cover `<cover>.webp` 1600×900 and `<cover>-og.png` 1200×630 — brand gradient
    (indigo→violet, subtle grain/glow), the post title in Nunito ExtraBold, "Verbale" wordmark,
    and a phone-framed real app screenshot from `docs/store/screenshots/` chosen per post
    (front matter `shot`). Reads titles from the posts so re-running regenerates everything.
  - `shots/<name>.webp` resized (540 wide) copies of the eight store screenshots for use in posts
    and on the landing page.
  - Site `og.png` regenerated in the same style.
- Each file under 250 KB (covers) / 120 KB (shots). A test asserts every post's `cover` and OG
  files exist and every `/static/shots/*` referenced by any post exists.
- Mutant: a post referencing a missing image → test fails.

## Task 5 — Content: five posts

Written for people searching, not for us. 900–1,500 words each, practical, specific, honest about
limits (English only, Android only). Each: a direct answer in the first paragraph (what AI
assistants quote), h2 sections, at least one real screenshot with alt text, a short FAQ section at
the end, and internal links to two other posts and the landing page.

1. `offline-meeting-notes-android` — How to take meeting notes on Android with no internet.
2. `why-meeting-notes-should-stay-on-your-phone` — What cloud note-takers do with your audio, and
   what on-device changes.
3. `minutes-of-meeting-template` — How to write minutes of meeting (MOM), with a copyable template
   and what Verbale fills in automatically.
4. `on-device-vs-cloud-transcription` — The honest trade-offs: speed, accuracy, privacy, battery.
5. `how-to-record-a-meeting-on-your-phone` — Placement, consent, long meetings, screen-off.

Every claim checked against the Facts sheet by the spec reviewer.

## Task 6 — AI-assistant readiness

- `/llms.txt` (llmstxt.org format: `# Verbale`, `> summary`, sections linking `/about`, `/faq`,
  pricing anchor, every post's `.md`), `/llms-full.txt` (about + FAQ + all posts as plain markdown).
- `/about`: a factual "What is Verbale" page — one-paragraph definition, who it is for, what it
  does / does not do, pricing, requirements, privacy, company — with `AboutPage` + `Organization`
  JSON-LD. `/faq` page from the shared FAQ data with `FAQPage` JSON-LD.
- Both in sitemap and footer. Tests for each.
- Mutant: a post missing from `llms.txt` → test fails.

## Task 7 — Landing refresh

- Nav: How it works · Pricing · Blog · FAQ · theme toggle. Footer: Blog, About, FAQ, Privacy,
  Terms, Delete account, © InnoCore Labs.
- A "See it" screenshot strip (real app images from `static/shots/`, lazy, alt text) and a "From
  the blog" section showing the three newest posts.
- Pricing card shows ₹ and $ prices from one constant; copy matches the Facts sheet; FAQ download
  size stays out of new copy (see open questions).
- Tests for the new sections and links. Screenshots in both themes at 390 and 1280.

## Task 8 — ASO + founder handoff doc

- `docs/store/aso-keywords.md`: the keyword set the site and Play listing share, where each one
  appears (title, short, full description, which post), and any listing-copy fixes.
- `docs/website-launch.md`: what the founder does after deploy — Google Search Console + Bing
  Webmaster Tools (verify, submit sitemap), set `PLAY_URL` when the listing is public, link from
  innocorelabs.com, how to add a post (write md → run make_images.py → commit → deploy).

## Open questions for the founder (not blocking)

- Download size: landing FAQ says ~114 MB, Play listing says ~96 MB. New copy states no size.
- India price: memory says Play rounded to ₹300/₹2,500; the site says ₹299/₹2,499.
