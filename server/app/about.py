"""
The pages and files written for AI assistants as much as for people: /about, /faq, /llms.txt and
/llms-full.txt.

An assistant asked "what app records meetings on the phone without uploading them?" answers from
what it can read, and a marketing landing page is a poor source: claims are scattered across
cards, and the limits (English only, Android only) are not stated at all. So there is one plain
page that says what the product is, who it is for, what it does NOT do and what it costs, and the
same facts are published again as markdown for tools that prefer it (llmstxt.org).

Everything here is built from data -- ABOUT_SECTIONS, landing.FAQ, landing.PRICES and the blog's
posts -- and rendered twice (HTML and markdown) from the same source, so the page, the llms files
and the structured data cannot disagree and a new post appears in llms.txt without anyone editing
it. Only claims that are true of the shipped app belong in ABOUT_SECTIONS.
"""

from __future__ import annotations

import html
import re
from datetime import date
from typing import Callable

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, PlainTextResponse

from . import landing, seo
from .blog import _breadcrumb, _breadcrumb_jsonld, _split_front_matter
from .theme import site_header
from .branding import COMPANY_NAME, CONTACT_EMAIL, PRODUCT_NAME

#: Bumped when a fact on the about page changes; shown on the page as "Last updated".
ABOUT_UPDATED = "2026-10-24"

SUMMARY = (
    f"{PRODUCT_NAME} is an Android app that records meetings in English and writes the "
    "transcript, speakers and minutes entirely on the phone."
)
#: The quotable standalone definition: it names the maker and the category, so a one-sentence
#: lift of it is still accurate.
DEFINITION = (
    f"{PRODUCT_NAME} is an Android app by {COMPANY_NAME} that records meetings in English and "
    "writes the transcript, who said what, and the minutes — decisions, action items and open "
    "questions — entirely on your phone. Nothing is uploaded, no account is needed to use it, "
    "and once its one-time download is done it works with no signal."
)

#: Alternate-link tag every public page carries (see pages.layout) so a crawler that lands on any
#: page can find the summary.
LLMS_LINK = '<link rel="alternate" type="text/plain" title="LLM summary" href="/llms.txt">\n'

_LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_ANCHOR = re.compile(r'<a href="([^"]+)">(.*?)</a>', re.S)
_TAG = re.compile(r"<[^>]+>")


def _money(amount: str, cur: str) -> str:
    """'2499' -> '₹2,499'; '4.99' -> '$4.99'. The symbol and grouping people expect."""
    whole, _, frac = amount.partition(".")
    grouped = f"{int(whole):,}" + (f".{frac}" if frac else "")
    return ("₹" if cur == "INR" else "$") + grouped


def _pricing() -> list[str | list[str]]:
    p = landing.PRICES
    return [
        [f"Free: {_money(p['free']['INR'], 'INR')} forever, no account. Five meetings a month, "
         "up to one hour each; imports and dictations count as meetings. Transcript by "
         "speaker (tap a line to hear it), decisions, actions and open questions linked to the "
         "moment they were said, marking a moment to make a highlight, dictation with spoken "
         "punctuation, search for every word, and copy.",
         f"Pro in India: {_money(p['monthly']['INR'], 'INR')} per month or "
         f"{_money(p['yearly']['INR'], 'INR')} per year.",
         f"Pro elsewhere: {_money(p['monthly']['USD'], 'USD')} per month or "
         f"{_money(p['yearly']['USD'], 'USD')} per year."],
        "Pro starts with a 7-day free trial through Google Play. Payments are not refundable. "
        "Pro adds unlimited meetings of any length; export to MP3, PDF, SRT, Markdown and text; "
        "a summary and minutes in plain English written by a language model that runs on the "
        "phone and shaped to the kind of meeting; asking a meeting a question, with answers "
        "that point to the moment; search by meaning; threads; remembered voices (opt-in); "
        "custom spellings; dictated notes written up; a larger transcriber; and up to three "
        "devices. Notes already written stay readable if you stop paying.",
    ]


def sections() -> list[tuple[str, list[str | list[str]]]]:
    """
    The about page as (heading, blocks) pairs; a block is a paragraph (str) or bullets (list).

    Text may carry `[label](/path)` links; the HTML renderer escapes then links them, the
    markdown renderer makes them absolute. Built by a function because pricing and the Play link
    are read at call time.
    """
    play = landing.play_url()
    availability = (f"{PRODUCT_NAME} is on [Google Play]({play})." if play else
                    f"{PRODUCT_NAME} is not on Google Play publicly yet.")
    return [
        ("Who it is for", [
            "People who sit in meetings and need a record of them without sending the "
            "recording to someone else's server: managers and team leads who owe minutes "
            "after every call, consultants and freelancers with client conversations, and "
            "anyone who attends meetings where the content is confidential.",
        ]),
        ("What it does", [
            ["Records meetings in English, with the screen off, in other apps, or in a "
             "floating window. Long meetings are processed in the background and the phone "
             "notifies you when they are ready.",
             "Writes the transcript, separates the voices into speakers, and pulls out "
             "decisions, action items and open questions, each linked to the moment it was "
             "said.",
             "Does all of that on the phone. After a one-time download of its speech models "
             "it works with no signal."],
        ]),
        ("What it does not do", [
            ["It works in English only; no other language is supported.",
             "It is Android only; there is no iPhone version.",
             "It does not join video calls as a bot. It records through the phone.",
             "It does not sync meetings to a cloud. There is no web app to log in to."],
        ]),
        ("Pricing", _pricing()),
        ("Requirements", [
            "An Android phone with a 64-bit processor. Some Pro features need 4 GB of memory; "
            "the app checks your phone first and says what it cannot run. " + availability,
        ]),
        ("Privacy", [
            "Recordings, transcripts and notes stay on the phone. The app uses the network "
            "for three things: the one-time model download, checking a subscription, and "
            "opt-in crash reports, which are sent by Google's crash reporter and never carry "
            "content. The app counts its own network calls on a screen you can open. Read the "
            "full [privacy policy](/privacy), the [terms](/terms) and the "
            "[frequently asked questions](/faq).",
        ]),
        ("The company", [
            f"{PRODUCT_NAME} is made by {COMPANY_NAME}, based in Kolkata, India "
            f"([{landing.ORG_URL.removeprefix('https://')}]({landing.ORG_URL})). "
            f"Contact: [{CONTACT_EMAIL}](mailto:{CONTACT_EMAIL}).",
        ]),
    ]


def _inline_html(text: str) -> str:
    """Escape, then turn [label](target) into links (the escaped text cannot contain a tag)."""
    return _LINK.sub(lambda m: f'<a href="{m.group(2)}">{m.group(1)}</a>', html.escape(text))


def _inline_md(text: str) -> str:
    return _LINK.sub(lambda m: f"[{m.group(1)}]({_abs(m.group(2))})", text)


def _abs(target: str) -> str:
    return seo.absolute(target) if target.startswith("/") else target


def _pretty(iso: str) -> str:
    return date.fromisoformat(iso).strftime("%-d %B %Y")


def _blocks_html(blocks: list[str | list[str]]) -> str:
    return "".join(
        "<ul>" + "".join(f"<li>{_inline_html(i)}</li>" for i in b) + "</ul>"
        if isinstance(b, list) else f"<p>{_inline_html(b)}</p>" for b in blocks)


def _blocks_md(blocks: list[str | list[str]]) -> str:
    return "\n\n".join(
        "\n".join(f"- {_inline_md(i)}" for i in b) if isinstance(b, list) else _inline_md(b)
        for b in blocks)


def prose_footer() -> str:
    """The footer for the reading-style pages; the same links as the landing page's."""
    links = [("About", "/about"), ("FAQ", "/faq"), ("Blog", "/blog"), ("Privacy", "/privacy"),
             ("Terms", "/terms"), ("LLM summary", "/llms.txt")]
    return (
        '<footer class="site-foot"><div class="site-foot-in">'
        f"<span>&copy; {html.escape(COMPANY_NAME)}</span>"
        + "".join(f'<a href="{h}">{html.escape(t)}</a>' for t, h in links)
        + "</div></footer>"
    )


def _head() -> str:
    return '<link rel="stylesheet" href="/static/blog.css">\n'


def render_about() -> str:
    body = "".join(f"<h2>{html.escape(h)}</h2>{_blocks_html(b)}" for h, b in sections())
    return (
        site_header(html.escape(PRODUCT_NAME))
        + '<main class="blog-wrap"><article class="post">'
        + _breadcrumb([("Home", "/"), ("About", None)])
        + '<header class="post-head"><h1>What is Verbale?</h1>'
          f'<p class="byline">Last updated <time datetime="{ABOUT_UPDATED}">'
          f"{_pretty(ABOUT_UPDATED)}</time></p></header>"
        + f'<div class="prose"><p class="definition">{html.escape(DEFINITION)}</p>{body}</div>'
        + "</article></main>" + prose_footer()
    )


def render_faq() -> str:
    items = "".join(f"<h2>{html.escape(q)}</h2><p>{a}</p>" for q, a in landing.FAQ)
    return (
        site_header(html.escape(PRODUCT_NAME))
        + '<main class="blog-wrap"><article class="post">'
        + _breadcrumb([("Home", "/"), ("FAQ", None)])
        + '<header class="post-head"><h1>Frequently asked questions</h1>'
          f'<p class="byline">About {html.escape(PRODUCT_NAME)}, privacy and pricing. '
          'See also <a href="/about">what it is</a> and <a href="/blog">the blog</a>.</p></header>'
        + f'<div class="prose">{items}</div>'
        + "</article></main>" + prose_footer()
    )


def about_jsonld() -> list[dict]:
    site = seo.site_url()
    org, app = landing.home_jsonld(site)[0], landing.home_jsonld(site)[2]
    return [
        {"@context": "https://schema.org", "@type": "AboutPage", "name": f"What is {PRODUCT_NAME}?",
         "url": seo.absolute("/about"), "inLanguage": "en", "dateModified": ABOUT_UPDATED,
         "description": SUMMARY, "mainEntity": {k: v for k, v in app.items() if k != "@context"}},
        org,
        _breadcrumb_jsonld([("Home", "/"), ("About", "/about")]),
    ]


def faq_answer_md(answer_html: str) -> str:
    """An FAQ answer as markdown: links kept (made absolute), other tags dropped, entities decoded."""
    linked = _ANCHOR.sub(lambda m: f"[{_TAG.sub('', m.group(2))}]({_abs(m.group(1))})", answer_html)
    return html.unescape(_TAG.sub("", linked))


def about_md() -> str:
    parts = [f"# What is {PRODUCT_NAME}?\n\n{seo.absolute('/about')}\n\n{DEFINITION}"]
    parts += [f"## {h}\n\n{_blocks_md(b)}" for h, b in sections()]
    return "\n\n".join(parts) + f"\n\nLast updated {_pretty(ABOUT_UPDATED)}.\n"


def faq_md() -> str:
    body = "\n\n".join(f"### {q}\n\n{faq_answer_md(a)}" for q, a in landing.FAQ)
    return f"# Frequently asked questions\n\n{seo.absolute('/faq')}\n\n{body}\n"


def llms_txt(posts) -> str:
    """
    /llms.txt per llmstxt.org: title, one-line summary, key facts, then link lists.

    Built from the live posts list so a new post is listed with no edit here.
    """
    p = landing.PRICES
    facts = (
        f"{PRODUCT_NAME} works in English only and runs on 64-bit Android phones. Transcription, "
        "speaker separation and minutes happen on the device and nothing is uploaded. The free "
        "tier needs no account (five meetings a month, up to one hour each). Pro costs "
        f"{_money(p['monthly']['INR'], 'INR')}/month or {_money(p['yearly']['INR'], 'INR')}/year "
        f"in India, {_money(p['monthly']['USD'], 'USD')}/month or "
        f"{_money(p['yearly']['USD'], 'USD')}/year elsewhere, with a 7-day free trial through "
        "Google Play."
    )
    docs = [("About", "/about", f"What {PRODUCT_NAME} is, who it is for, what it does not do, pricing"),
            ("FAQ", "/faq", "Answers on privacy, the network, pricing and phones"),
            ("Privacy", "/privacy", "What data the app and the website handle"),
            ("Terms", "/terms", "Terms of service, including subscriptions")]
    lines = [f"# {PRODUCT_NAME}", "", f"> {SUMMARY}", "", facts, "", "## Docs", ""]
    lines += [f"- [{t}]({seo.absolute(path)}): {note}" for t, path, note in docs]
    lines += ["", "## Blog", ""]
    lines += [f"- [{post.title}]({seo.absolute(post.path)}.md): {post.description}" for post in posts]
    lines += ["", "## Optional", "",
              f"- [Full text]({seo.absolute('/llms-full.txt')}): the about page, the FAQ and every "
              "post in one file",
              f"- [Sitemap]({seo.absolute('/sitemap.xml')}): every page",
              f"- [Blog feed]({seo.absolute('/blog/feed.xml')}): new posts as RSS"]
    return "\n".join(lines) + "\n"


def llms_full(posts) -> str:
    """
    /llms-full.txt: the about page, the FAQ and every post as one markdown document.

    Posts are served as written minus the front matter (title and canonical URL are put back as a
    heading and a line, which is what an assistant needs to cite them).
    """
    rule = "\n\n---\n\n"
    chunks = [about_md(), faq_md()]
    for post in posts:
        _, body = _split_front_matter(post.raw, post.slug)
        chunks.append(f"# {post.title}\n\n{seo.absolute(post.path)}\n\n{body.strip()}\n")
    return rule.join(c.strip() for c in chunks) + "\n"


def register_about(app: FastAPI, layout: Callable[..., str]) -> None:
    """Mount the pages and files above; the blog must already be on `app.state.blog`."""

    def sitemap() -> list[seo.SitemapEntry]:
        return [seo.SitemapEntry("/about", ABOUT_UPDATED), seo.SitemapEntry("/faq")]

    seo.register_sitemap_entries(app, sitemap)

    @app.get("/about", response_class=HTMLResponse)
    def about() -> HTMLResponse:
        return HTMLResponse(layout(
            f"What is {PRODUCT_NAME}?", render_about(), SUMMARY, path="/about",
            head_extra=_head(), wrap=False, jsonld=about_jsonld()))

    @app.get("/faq", response_class=HTMLResponse)
    def faq() -> HTMLResponse:
        return HTMLResponse(layout(
            "Frequently asked questions", render_faq(),
            f"Answers about {PRODUCT_NAME}: privacy, what the app sends over the network, "
            "pricing, and which phones it runs on.",
            path="/faq", head_extra=_head(), wrap=False,
            jsonld=[landing.faq_jsonld(),
                    _breadcrumb_jsonld([("Home", "/"), ("FAQ", "/faq")])]))

    @app.get("/llms.txt")
    def llms() -> PlainTextResponse:
        return PlainTextResponse(llms_txt(app.state.blog.posts()),
                                 media_type="text/plain; charset=utf-8")

    @app.get("/llms-full.txt")
    def llms_full_txt() -> PlainTextResponse:
        return PlainTextResponse(llms_full(app.state.blog.posts()),
                                 media_type="text/plain; charset=utf-8")
