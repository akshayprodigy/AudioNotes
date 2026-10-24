"""
The landing page.

Separate from pages.py because it is a different job. The other four pages are forms — short,
functional, read once, and correct when they are boring. This one has to explain a product to
somebody who arrived from a link and owes us nothing, and it carries its own stylesheet, its own
shell and a WebGL hero to do it. Keeping them in one module would mean one CSS block trying to
serve both, which is how landing pages end up looking like settings screens.

What it does not carry is anyone else's JavaScript. No font CDN, no analytics, no tag manager, no
embedded video. The headline claims nothing leaves your phone; a network tab full of other
people's domains would undercut that before a visitor read a word of it, and the people most
likely to check are the people most likely to buy.
"""

from __future__ import annotations

import html
import os
import re

from .branding import COMPANY_NAME, PRODUCT_NAME
from .theme import TOGGLE


def play_url() -> str:
    """
    Where the Play listing lives, from the PLAY_URL environment variable.

    Empty until the app is published — the hero then shows an honest "coming to Google Play" line
    instead of a button that 404s, which is the one thing worse than having no button at all. Read
    at call time so going live is an env change and a restart, not a code change.
    """
    return os.environ.get("PLAY_URL", "").strip()


#: The publisher, for the Organization structured data.
ORG_NAME = "InnoCore Labs"
ORG_URL = "https://innocorelabs.com"
ORG_ADDRESS = {"@type": "PostalAddress", "addressLocality": "Kolkata", "addressCountry": "IN"}

#: What Pro costs, in one place. The structured data reads it now and the pricing card will too, so
#: a price change is one edit rather than a search for every number that quotes it.
PRICES = {
    "free": {"INR": "0", "USD": "0"},
    "monthly": {"INR": "300", "USD": "4.99"},
    "yearly": {"INR": "2500", "USD": "39.99"},
}

#: The questions people ask, as (question, answer-html) pairs. One list so the landing page,
#: a future /faq page and the FAQPage structured data can never disagree about what the answers are.
FAQ: list[tuple[str, str]] = [
    ("Is my audio really never uploaded?",
     "Yes. Transcription, speaker separation and the minutes all run on the device. The "
     "app uses the network for three things: downloading the speech models the first time "
     "you open it, checking a subscription if you have one, and sending a crash report if "
     "you switched those on. None of the three carries any of your content, and the app "
     "has a screen that counts every call it makes so you can check rather than trust."),
    ("Does it report crashes?",
     "Only if you say yes. You are asked once, it is off until then, and you can withdraw "
     "at any time in Settings. A report carries the stack trace of the failure, the app "
     "version and the model of phone &mdash; never your audio, transcripts or notes. It "
     "goes to Google Crashlytics, and because Crashlytics sends it rather than the app, it "
     "is the one thing the network screen cannot count. It says so, there, in those words."),
    ("Why is there a download when I first open it?",
     "The speech models are not bundled into the app, which would otherwise be far too "
     "large for the store. They are about 96 MB, download once, and then the app works "
     "with no connection at all. Pro adds larger models, about 1.3 GB in all, which "
     "download in the background as soon as you subscribe or start the trial; you can "
     "keep using the app while they do."),
    ("What happens if I stop paying?",
     "Recording, transcripts, speakers, copying and the rule-based minutes keep working "
     "&mdash; those are the free tier and they do not expire, and every meeting you have "
     "already recorded stays exactly as it is, at whatever length it was. New recordings go "
     "back to the free allowance of five meetings a month, up to an hour each, and search by "
     "meaning goes back to Pro. Searching for a word stays free."),
    ("Why is Free limited to five meetings a month?",
     "Because the alternative was advertising, and an app that reads your meetings should "
     "not also be selling your attention. Five meetings of up to an hour each is roughly "
     "one a week, enough to see the whole thing work &mdash; transcript, speakers, "
     "minutes &mdash; on your own meetings before deciding. Imports and "
     "dictations count as meetings. A recording that reaches the hour stops there and is "
     "still transcribed in full, and when the month's five are used your saved meetings "
     "stay open to listen to, search, edit and copy. Nothing you recorded is ever thrown "
     "away. The count starts again on the first of the month."),
    ("Do I need an account?",
     "No. There is nothing to sign up for. Subscribing happens in the app through Google "
     "Play, and the account that carries it between your devices is created by the "
     "purchase itself. To have it deleted, see "
     '<a href="/delete-account">deleting your account</a>.'),
    ("Which phones does it work on?",
     "Android, on 64-bit devices. It is doing real speech recognition locally, so a "
     "recent mid-range phone or better will be noticeably quicker than an old one."),
]



def _icon(path: str) -> str:
    return (
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
        f'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{path}</svg>'
    )


SHIELD = _icon('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>')
MIC = _icon(
    '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/>'
    '<path d="M12 17v5"/>'
)
USERS = _icon(
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>'
    '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>'
)
PEN = _icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>')
BOLT = _icon('<path d="M13 2 3 14h8l-1 8 10-12h-8z"/>')
LOCK = _icon('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>')
TICK = _icon('<path d="M20 6 9 17l-5-5"/>')


def _feature(icon: str, title: str, body: str, delay: str) -> str:
    return f"""
      <div class="card rise {delay}">
        <div class="ico">{icon}</div>
        <h3>{html.escape(title)}</h3>
        <p>{html.escape(body)}</p>
      </div>"""


def _step(n: str, title: str, body: str, delay: str) -> str:
    return f"""
      <div class="card rise {delay}">
        <div class="num">{html.escape(n)}</div>
        <h3>{html.escape(title)}</h3>
        <p>{html.escape(body)}</p>
      </div>"""


def _faq(q: str, a: str) -> str:
    return f"""
      <details>
        <summary>{html.escape(q)}</summary>
        <p>{a}</p>
      </details>"""


def faq_html() -> str:
    """The FAQ as <details> blocks, in list order."""
    return "".join(_faq(q, a) for q, a in FAQ)


def _plain(answer_html: str) -> str:
    """
    An FAQ answer as the plain text structured data wants: no tags, entities decoded.

    Regex tag-stripping is only safe because FAQ is trusted static markup written in this file;
    never feed it user input.
    """
    return html.unescape(re.sub(r"<[^>]+>", "", answer_html))


def faq_jsonld() -> dict:
    """schema.org FAQPage built from FAQ, so the markup and the structured data cannot drift."""
    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {"@type": "Question", "name": q,
             "acceptedAnswer": {"@type": "Answer", "text": _plain(a)}}
            for q, a in FAQ
        ],
    }


def home_jsonld(site: str) -> list[dict]:
    """
    Structured data for the home page: who makes it, what the site is, what the app is and costs,
    and the FAQ. `site` is the absolute origin, because schema.org consumers ignore relative URLs.
    """
    offers = [{"@type": "Offer", "name": "Free", "price": PRICES["free"][cur],
               "priceCurrency": cur} for cur in ("INR", "USD")]
    for period, label, iso, unit in (("monthly", "Pro monthly", "P1M", "month"),
                                     ("yearly", "Pro yearly", "P1Y", "year")):
        for cur in ("INR", "USD"):
            price = PRICES[period][cur]
            offers.append({
                "@type": "Offer", "name": label, "category": "subscription",
                "price": price, "priceCurrency": cur,
                "priceSpecification": {
                    "@type": "UnitPriceSpecification", "price": price, "priceCurrency": cur,
                    "billingDuration": iso, "unitText": unit,
                },
            })
    app = {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": PRODUCT_NAME,
        "applicationCategory": "BusinessApplication",
        "operatingSystem": "Android",
        "description": "Records meetings and writes the minutes entirely on your phone: "
                       "transcript, speakers, decisions and action items, with no upload.",
        "offers": offers,
    }
    if play_url():
        app["downloadUrl"] = app["installUrl"] = play_url()
    return [
        {"@context": "https://schema.org", "@type": "Organization", "name": ORG_NAME,
         "url": ORG_URL, "logo": f"{site}/static/logo.svg",
         "email": "admin@innocorelabs.com",
         "address": ORG_ADDRESS},
        {"@context": "https://schema.org", "@type": "WebSite", "name": PRODUCT_NAME,
         "url": f"{site}/"},
        app,
        faq_jsonld(),
    ]


#: The footer's links, shared with the reading pages' footer so the two cannot drift apart.
FOOTER_LINKS = [("About", "/about"), ("FAQ", "/faq"), ("Blog", "/blog"), ("Privacy", "/privacy"),
                ("Terms", "/terms"), ("LLM summary", "/llms.txt"),
                ("Delete your account", "/delete-account")]


def money(period: str, cur: str) -> str:
    """
    One price as the page shows it, from PRICES.

    Rupees use Western thousands grouping (2,500), which is also what Indian grouping gives below
    ₹99,999; a price past that would need lakh grouping (1,00,000) and so a helper of its own.
    """
    amount = PRICES[period][cur]
    if cur == "INR":
        return "&#8377;" + f"{int(amount):,}"
    return "$" + html.escape(amount)


#: The screenshot strip: (file, caption, is_pro, alt). Captions are the Play listing headlines, so
#: the site and the store say the same thing. The summary write-up and Ask are Pro features, so
#: they carry the pill rather than implying the free tier has them.
SHOTS = [
    ("recording", "Just hit record", False,
     "The recording screen of the app while a meeting is being captured"),
    ("summary", "Your meeting, written up", True,
     "The Summary tab: a plain-English write-up of the meeting"),
    ("decisions", "Every decision, with proof", False,
     "The Decisions list, each with a play button that jumps to the moment it was said"),
    ("actions", "Who owes what, by when", False,
     "The Actions tab: action items with owners, and dates where one was said"),
    ("ask", "Ask the meeting anything", True,
     "The Ask screen: answers that each cite the part of the meeting they came from"),
]


def shots_section() -> str:
    figs = "".join(
        f"""
      <figure class="shot rise d{i % 3}" role="listitem">
        <div class="shot-frame"><img src="/static/shots/{f}.webp" alt="{html.escape(alt)}"
             width="540" height="1135" loading="lazy" decoding="async"></div>
        <figcaption>{html.escape(cap)}{' <span class="pro-pill">Pro</span>' if pro else ''}</figcaption>
      </figure>"""
        for i, (f, cap, pro, alt) in enumerate(SHOTS)
    )
    return f"""
<section id="see">
  <div class="shell">
    <div class="section-head center rise">
      <h2>See it on a real meeting</h2>
      <p class="sub">Screens from the app itself.</p>
    </div>
    <div class="shots" role="list" aria-label="App screenshots">{figs}
    </div>
  </div>
</section>
"""


def blog_section(cards: list[str]) -> str:
    """
    The newest posts as cards. `cards` is markup from blog.post_card(), passed in rather than
    imported here (blog.py imports this module, so importing it back would be circular); one card
    renderer means the teaser cannot drift from the index. Returns "" when there are no cards, so
    the page never shows a heading over nothing.
    """
    if not cards:
        return ""
    return f"""
<section id="from-blog">
  <div class="shell">
    <div class="section-head blog-head-row rise">
      <h2>From the blog</h2>
      <a class="all-posts" href="/blog">All posts &rarr;</a>
    </div>
    <div class="from-blog rise d1">{"".join(cards)}</div>
  </div>
</section>
"""


def footer_links() -> str:
    return "\n    ".join(f'<a href="{h}">{html.escape(t)}</a>' for t, h in FOOTER_LINKS)


def site_footer() -> str:
    """
    The footer for every page except the landing page (which lays its own out): one set of links
    on /blog, the posts, /about, /faq and the legal pages, styled by theme.THEME_CSS.
    """
    return (
        '<footer class="site-foot"><div class="site-foot-in">'
        f"<span>&copy; {html.escape(COMPANY_NAME)}</span>"
        + "".join(f'<a href="{h}">{html.escape(t)}</a>' for t, h in FOOTER_LINKS)
        + "</div></footer>"
    )


def hero_cta() -> str:
    """The primary call to action, which depends on whether there is an app to send anyone to."""
    url = play_url()
    if url:
        return (
            f'<a class="btn btn-primary" href="{html.escape(url)}">Get it on Google Play</a>'
            '<a class="btn btn-ghost" href="#how">See how it works</a>'
        )
    # No Play listing yet, and nothing else to send anyone to: the app is the only way in, and
    # there is no account to create on the web. So the page asks for attention rather than a
    # signup it cannot honour.
    return '<a class="btn btn-primary" href="#how">See how it works</a>'


def hero_note() -> str:
    if play_url():
        return "Free to use, with no account. Android."
    return "Coming to Google Play. The free tier needs no account at all."


def body(device_limit: int, blog_cards: list[str] | None = None) -> str:
    name = html.escape(PRODUCT_NAME)
    return f"""
<nav class="nav">
  <div class="shell nav-in">
    <a class="brand" href="/"><img src="/static/logo.svg" alt="">{name}</a>
    <span class="nav-spacer"></span>
    <div class="nav-links">
      <a class="hide-sm" href="#how">How it works</a>
      <a class="hide-sm" href="#pricing">Pricing</a>
      <a href="/blog">Blog</a>
      <a class="hide-sm" href="/faq">FAQ</a>
      {TOGGLE}
    </div>
  </div>
</nav>

<header class="hero">
  <canvas id="field" aria-hidden="true"></canvas>
  <div class="shell hero-in">
    <span class="eyebrow rise"><span class="dot"></span>Everything runs on your phone</span>
    <h1 class="rise d1">Meeting notes that <span class="grad">never leave your phone</span></h1>
    <p class="lede rise d2">
      {name} records the meeting, writes the transcript, works out who said what and pulls out the
      decisions and the actions &mdash; all on the device in your hand. There is no server here
      that could hold a recording, because nothing is ever uploaded.
    </p>
    <div class="cta-row rise d3">{hero_cta()}</div>
    <p class="cta-note rise d3">{html.escape(hero_note())}</p>

    <div class="stage rise d3">
      <div class="phone">
        <div class="screen">
          <div class="screen-top">
            <span class="pill">READY</span>
            <span class="screen-title">Tuesday standup</span>
          </div>
          <div class="screen-body">
            <div class="k">SUMMARY</div>
            <div class="line w92"></div>
            <div class="line w80"></div>
            <div class="line w62"></div>
            <div class="chips">
              <span class="chip">3 actions</span>
              <span class="chip">2 decisions</span>
              <span class="chip">4 speakers</span>
            </div>
            <div class="wave" aria-hidden="true">{
              ''.join(
                f'<i style="animation-delay:{i * 0.09:.2f}s"></i>' for i in range(18)
              )
            }</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</header>

<section id="how" class="band">
  <div class="shell">
    <div class="section-head center rise">
      <h2>Three taps, then nothing to do</h2>
      <p class="sub">
        Start it before the meeting, put the phone down, and read the notes afterwards. It keeps
        recording with the screen off, or in a small window over whatever else you are doing.
      </p>
    </div>
    <div class="grid g3">
      {_step("01", "Record",
             "Hit record and put the phone down. It keeps going with the screen off, through "
             "other apps, and in a floating window if you want to watch it work.", "")}
      {_step("02", "It listens",
             "Speech becomes text, and voices are separated into speakers you can name. Both "
             "happen on the phone, with no network at all.", "d1")}
      {_step("03", "Read the minutes",
             "Decisions, action items and open questions, pulled out of what was actually said "
             "and ready to copy or send on.", "d2")}
    </div>
  </div>
</section>

{shots_section()}

<section>
  <div class="shell">
    <div class="section-head rise">
      <h2>Built the hard way, on purpose</h2>
      <p class="sub">
        Running speech recognition on a phone is slower and far more work than sending audio to a
        data centre. It is also the only version of this that can promise what the headline
        promises.
      </p>
    </div>
    <div class="grid g3">
      {_feature(SHIELD, "Your meeting is not uploaded",
                "No recording, transcript or summary ever leaves the device. There is no bucket "
                "somewhere with your meetings in it, because there is no bucket.", "")}
      {_feature(MIC, "Records the way meetings happen",
                "Screen off, in your pocket, or floating over the call you are already on. Long "
                "meetings survive the phone locking, ringing and being put away.", "d1")}
      {_feature(USERS, "Knows who spoke",
                "Voices are separated into speakers and kept apart through the transcript, so "
                "the minutes can attribute a decision to the person who made it.", "d2")}
      {_feature(PEN, "Minutes, not a wall of text",
                "Decisions, actions and open questions are pulled out of the transcript, with "
                "the line they came from still attached.", "")}
      {_feature(BOLT, "Works with no signal",
                "On a train, in a basement, on a plane. The models live on the phone, so the "
                "network is only ever needed to download them once.", "d1")}
      {_feature(LOCK, "Encrypted where it sits",
                "The database on the device is encrypted, and you can export or delete "
                "everything at any time without asking anybody.", "d2")}
    </div>

    <div class="claim rise" style="margin-top:48px">
      <div class="ico" style="background:transparent;color:var(--green);width:40px;height:40px">
        {SHIELD}
      </div>
      <div>
        <strong>No account needed to use it</strong>
        <p>
          The free tier asks for nothing &mdash; no email, no sign-up, no profile. An account
          exists only to carry a subscription across your devices, and you can delete it, and
          everything attached to it, from your account page.
        </p>
      </div>
    </div>
  </div>
</section>

<section id="pricing" class="band">
  <div class="shell">
    <div class="section-head center rise">
      <h2>Free forever. Pro when you want prose.</h2>
      <p class="sub">
        Everything that makes the app useful is free and stays free. Pro adds a second model that
        writes the meeting up in sentences &mdash; and it runs on your phone too.
      </p>
    </div>
    <div class="grid g2">
      <div class="card tier rise">
        <h3>Free</h3>
        <div class="price">{money("free", "INR")}<small> / {money("free", "USD")} forever</small></div>
        <ul class="feat">
          <li><span class="tick">{TICK}</span>5 meetings each month, up to 1 hour each</li>
          <li><span class="tick">{TICK}</span>Full transcript, separated by speaker</li>
          <li><span class="tick">{TICK}</span>Decisions, actions and open questions</li>
          <li><span class="tick">{TICK}</span>Search every word across your saved meetings</li>
          <li><span class="tick">{TICK}</span>Copy any meeting's write-up to the clipboard</li>
          <li><span class="tick">{TICK}</span>No account, nothing expires</li>
        </ul>
        <a class="btn btn-ghost" href="#how">See how it works</a>
      </div>
      <div class="card tier pro rise d1">
        <h3>Pro</h3>
        <div class="price">7 days free<small> &nbsp;then {money("monthly", "INR")}/month or {money("yearly", "INR")}/year</small></div>
        <p class="price-usd">{money("monthly", "USD")}/month or {money("yearly", "USD")}/year outside India</p>
        <ul class="feat">
          <li><span class="tick">{TICK}</span>Everything in Free</li>
          <li><span class="tick">{TICK}</span>As many meetings as you like, of any length &mdash; a
              ninety-minute meeting in one go</li>
          <li><span class="tick">{TICK}</span>Export: MP3, PDF, SRT, Markdown, text &mdash; the
              minutes as a document, or the original recording as an MP3</li>
          <li><span class="tick">{TICK}</span>Search by meaning, so a question finds the answer even
              when the words differ</li>
          <li><span class="tick">{TICK}</span>The summary and the minutes written in plain
              English, by a model on your own phone</li>
          <li><span class="tick">{TICK}</span>A larger, more accurate transcriber for strong
              accents, crosstalk and bad rooms</li>
          <li><span class="tick">{TICK}</span>Up to {device_limit} devices on one subscription</li>
          <li><span class="tick">{TICK}</span>Everything already written stays readable if you
              stop paying</li>
        </ul>
        <p class="muted">The trial starts in the app. Nothing to sign up for here.</p>
      </div>
    </div>
  </div>
</section>

{blog_section(blog_cards or [])}

<section>
  <div class="shell">
    <div class="section-head rise"><h2>Questions people actually ask</h2></div>
    <div class="rise d1" style="margin-top:26px">
      {faq_html()}
    </div>
  </div>
</section>

<section class="band">
  <div class="shell section-head center rise">
    <h2>Your meetings, kept to yourself</h2>
    <p class="sub">Free to start, no account, and nothing to cancel.</p>
    <div class="cta-row" style="margin-top:28px">{hero_cta()}</div>
  </div>
</section>

<footer>
  <div class="shell foot-in">
    <span>&copy; InnoCore Labs</span>
    <span class="nav-spacer"></span>
    {footer_links()}
  </div>
</footer>
"""
