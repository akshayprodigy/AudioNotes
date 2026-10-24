# Website launch checklist

For the founder, after branch `website-seo-blog` is merged to main. Site: https://verbale.innocorelabs.com

## 1. Deploy

From `server/`: `VERBALE_HOST=root@69.62.82.85 ./deploy/deploy.sh` (see `server/README.md`, "Deploying").
It rsyncs the code, runs `docker compose up -d --build` and waits for `/healthz`. It never touches
the server's `.env` or the database. This release adds the Python package `markdown==3.11.2`
(`server/requirements.txt`); the image rebuild installs it, nothing to do by hand.

Before deploying, run `cd server && .venv/bin/pytest -q`. Posts are parsed at startup, so a
malformed post would stop the whole server (and the app's licence API) from booting.

nginx rate-limits `/static` under the general 60 r/m + burst 20 zone. That is fine for now; if
503s appear in the logs, loosen it with a dedicated `/static` location.

Smoke test (each should return 200 and sensible content):

```
for p in / /blog /blog/offline-meeting-notes-android /blog/offline-meeting-notes-android.md \
  /blog/feed.xml /sitemap.xml /robots.txt /llms.txt /llms-full.txt /about /faq; do
  printf '%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://verbale.innocorelabs.com$p"
done
```

Then paste the home page and one blog link into WhatsApp, Slack or LinkedIn's Post Inspector
(https://www.linkedin.com/post-inspector/). A card with the Verbale image and title should show.
Try the light/dark toggle once.

## 2. Google Search Console

1. Go to https://search.google.com/search-console, "Add property", choose **Domain**, enter
   `innocorelabs.com`. Add the TXT record it gives you at your DNS host, then Verify (can take
   minutes to hours). A domain property covers the `verbale.` subdomain.
2. Sitemaps (left menu), submit `https://verbale.innocorelabs.com/sitemap.xml`.
3. URL inspection (top bar): paste the home URL and one blog post URL, press "Request indexing".
4. Rich Results Test, https://search.google.com/test/rich-results : test the home page (expect
   FAQ and software application), `/faq` (FAQ) and a blog post (article). Warnings are fine, errors are not.

## 3. Bing Webmaster Tools

Bing's index also feeds ChatGPT search and several other assistants, so this matters.
1. https://www.bing.com/webmasters, sign in, choose **Import from Google Search Console**.
2. Check the sitemap is listed under Sitemaps; if not, submit the same sitemap URL.
3. If a "Turn on IndexNow" option is shown, say yes. It tells Bing about new pages sooner.

## 4. When the Play listing is public

1. On the server edit `/opt/verbale/.env` and set
   `PLAY_URL=https://play.google.com/store/apps/details?id=com.innocorelabs.verbale`
   (already listed in `.env.example`, empty). `docker-compose.yml` has `env_file: .env`, so it
   reaches the app.
2. `cd /opt/verbale && docker compose up -d`
3. What changes: the "Get it on Google Play" button appears on the home page and under each blog
   post (instead of "See how it works"), and `downloadUrl` / `installUrl` are added to the
   structured data. Check by viewing the home page.

## 5. Backlinks

Search engines and AI assistants trust a site that others link to. Add a link to
https://verbale.innocorelabs.com from innocorelabs.com (a product page or the footer), the
InnoCore Labs LinkedIn page, and any other company profile (Google Business, Crunchbase, Product
Hunt later). Use the words "Verbale, offline meeting notes for Android".

## 6. AI assistants

Already done: `robots.txt` allows GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended,
Applebot-Extended and others; `/llms.txt` and `/llms-full.txt` summarise the product; `/about`
defines what Verbale is, with a visible last-updated date. A few weeks after launch, ask ChatGPT,
Claude and Perplexity "What is Verbale meeting notes app?" and note what they say. Being cited
mostly follows being indexed by Bing and Google and being linked from elsewhere (step 5), so
there is nothing more to switch on.

## 7. Adding a blog post

1. Create `server/app/content/blog/<slug>.md`. Copy the format of an existing post:

```
---
title: Offline meeting notes on Android: no internet needed
description: 70 to 155 characters, what the post answers.
date: 2026-10-24
tags: Guides, Android
cover: offline-meeting-notes
cover_alt: Brand gradient cover titled "...", describing the image.
shot: summary
---
Opening paragraph that answers the question directly.

## First heading
...
## FAQ

### A question?
The answer.
```
   `updated: YYYY-MM-DD` is an optional extra field. `shot` must be one of: `actions`, `ask`,
   `decisions`, `mom`, `privacy`, `recording`, `review`, `summary`.
2. From `server/`: `.venv/bin/python tools/make_images.py` (needs the pinned Pillow 12.2.0 from
   `requirements-dev.txt`; another version dirties git with changed image bytes). Commit the images.
3. `cd server && .venv/bin/pytest -q`
4. Commit, then deploy as in step 1.

The test `test_real_posts_meet_the_content_bar` (`server/tests/test_blog.py`) fails a post that
breaks any rule: title at most 65 characters; description 70 to 155; at least 3 `##` headings;
exactly one `## FAQ` with at least 3 `###` questions; at least 1 screenshot from `/static/shots/`;
at least 2 links to other posts (`](/blog/slug)`); at least 600 words; no em dash; and none of
these words: whisper, qwen, llama, gpt, otter, fireflies, game-changer, unlock (no model or competitor names).

Keyword ideas for the next posts: `docs/store/aso-keywords.md`.

## 8. Keep these true

- When a fact on the site changes, update `ABOUT_UPDATED` in `server/app/about.py`.
- `PRICES` in `server/app/landing.py` is the only place prices live. Change it there.
- Settled facts (founder-confirmed 24 Oct 2026), the same on the site and the Play listing:
  - Download size: about 96 MB for the four required models; Pro adds about 1.3 GB of larger
    models, downloaded in the background when someone subscribes or starts the trial.
  - India price: ₹300 / month and ₹2,500 / year (Play's rounding, kept); USD $4.99 / $39.99.
    Single source: `PRICES` in `server/app/landing.py`.
