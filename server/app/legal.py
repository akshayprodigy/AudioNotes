"""
The privacy policy and the terms.

**These are drafts and have not been reviewed by a lawyer.** They are written to be accurate about
what this system actually does, which is the part an engineer can get right and a template cannot:
every claim below is checkable against store.py, and the list of what the server holds IS the
schema. Have somebody qualified read them before launch.

Two of them exist because Play requires a privacy policy at a public URL, and because a
subscription sold direct needs terms that say what is being sold. Accuracy matters more than usual
here: the app is marketed on a privacy promise, and a policy that overclaims is worse than one that
is merely dull.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import HTMLResponse

from .branding import COMPANY_NAME, CONTACT_EMAIL, LEGAL_UPDATED, PRODUCT_NAME
from .store import DEVICE_LIMIT


def _privacy() -> str:
    return f"""<h1>Privacy</h1>
<p class="muted">Last updated {LEGAL_UPDATED}</p>

<div class="card">
  <h2 style="margin-top:0">The short version</h2>
  <p>Your recordings, transcripts and minutes are made on your phone and stay on your phone. We
     have never received one and there is nowhere on our server to put one. What we hold is an
     email address and whether you have paid.</p>
</div>

<h2>What happens on your phone</h2>
<p>{PRODUCT_NAME} records audio, converts it to text, separates the speakers and writes the
   minutes — all of it on the device, using models downloaded once to that device. None of this
   involves us. The audio, the transcript, the speaker labels, the summary and the minutes are
   stored in an encrypted database on your phone and are never transmitted anywhere.</p>
<p>If you export a backup, that file is encrypted with a passphrase you choose and is written
   wherever you send it. We never see it, and we cannot open it or recover the passphrase.</p>

<h2>What we hold, if you make an account</h2>
<p>An account is only needed for a subscription. The app works without one.</p>
<ul>
  <li>Your email address.</li>
  <li>Your password, stored as a scrypt hash. We cannot read it.</li>
  <li>Your subscription status, the paid-through date, and the subscription id our payment
      provider gave us.</li>
  <li>For each device you sign in on: a random identifier the app generated for itself, the dates
      it was first and last seen, and a hashed renewal credential. This identifier is not your
      advertising ID, not your Android ID, and not tied to your hardware — it is a random number
      the app made up, and reinstalling produces a different one.</li>
  <li>If you ask for a password reset, a hashed single-use token for one hour.</li>
</ul>

<h2>What we do not hold</h2>
<p>No recording. No transcript. No summary. No minutes. No meeting title. No participant name. Not
   a count of how many meetings you have made, or when, or how long they were. There is no column
   for any of it, which is a stronger statement than a promise not to look.</p>
<p>We use no analytics, no crash reporting, no advertising and no third-party trackers of any
   kind. There is no SDK in this app reporting to anyone.</p>

<h2>When the app contacts us</h2>
<ul>
  <li><strong>First run:</strong> it downloads the speech models. That request reaches our file
      host, or the original publisher's, and carries nothing but the file name.</li>
  <li><strong>Signing in:</strong> your email, your password and the device identifier.</li>
  <li><strong>About once a week, if you subscribe:</strong> the device identifier and its renewal
      credential, to get a fresh licence. Nothing about your meetings is sent, because nothing
      about your meetings is on our side to compare it to.</li>
</ul>
<p>That is the complete list. If you never make an account, the app contacts us once, to fetch the
   models, and then never again.</p>

<h2>Payments</h2>
<p>Subscriptions are bought and billed through Google Play. Your payment details go to Google and
   never to us — we receive only a purchase identifier and whether it is paid. Google's own privacy
   policy governs what they hold.</p>

<h2>Server logs</h2>
<p>Our web server keeps ordinary access logs — IP address, time, the page requested — as any web
   server does. They are used to keep the service running and are not combined with your account
   or used to build a profile.</p>

<h2>Permissions the app asks for</h2>
<ul>
  <li><strong>Microphone:</strong> to record. It is the app.</li>
  <li><strong>Notifications:</strong> to show recording and processing progress.</li>
  <li><strong>Battery optimisation exemption:</strong> so a long meeting finishes processing
      instead of being killed halfway.</li>
</ul>

<h2>Keeping and deleting</h2>
<p>We keep your account until you delete it. You can delete it yourself from
   <a href="/account">your account page</a>: that cancels the subscription and erases the account,
   the devices and the subscription record. It does not touch anything on your phones, because we
   cannot reach it.</p>

<h2>Children</h2>
<p>{PRODUCT_NAME} is not directed at children under 13 and we do not knowingly hold data from
   them.</p>

<h2>Changes</h2>
<p>If this policy changes materially, the date at the top changes and the new version is here. We
   will not start collecting something this page says we do not.</p>

<h2>Contact</h2>
<p>{COMPANY_NAME} — <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a></p>
"""


def _terms() -> str:
    return f"""<h1>Terms</h1>
<p class="muted">Last updated {LEGAL_UPDATED}</p>

<h2>What you get</h2>
<p>{PRODUCT_NAME} is an app that records meetings and writes notes about them on your own device.
   Recording, transcription, speaker separation and rule-based minutes are free and stay free. A
   subscription adds the written summary and the narrated minutes, produced by a model that also
   runs on your device.</p>

<h2>The subscription</h2>
<ul>
  <li>Bought in the app and billed monthly through Google Play until cancelled.</li>
  <li>One subscription covers up to {DEVICE_LIMIT} devices. You can change which devices from your
      account page.</li>
  <li>Cancel any time in Google Play, under Subscriptions. Deleting your account here cancels it
      too. Access continues to the end of the period you have already paid for; we do not cut it
      short.</li>
  <li>If a payment fails, Google retries. Paid features keep working while it does, and for three
      days after.</li>
</ul>

<h2>Refunds</h2>
<p>Write to <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a> within 7 days of a charge you did
   not intend and we will refund it. Beyond that, cancelling stops the next charge rather than
   reversing the last one.</p>

<h2>Recording other people</h2>
<p>This is the important one. Laws about recording conversations differ by country and by state,
   and in many places recording someone without their knowledge is illegal. Whether you may record
   a given meeting is your responsibility, not ours. The app shows a visible recording indicator
   for this reason. Please tell the room.</p>

<h2>What the notes are worth</h2>
<p>Transcription and summarisation are done by machine learning models, and they get things wrong.
   Names are misspelled, numbers are misheard, and a summary can omit or distort what mattered.
   The output is a helpful record, not a verbatim transcript and not a legal one. Check anything
   that matters against the audio, which the app keeps for you.</p>

<h2>Your data</h2>
<p>Your recordings and notes are yours. They live on your device and we have no access to them —
   which also means we cannot recover them for you if you lose the device or forget a backup
   passphrase. Keep backups.</p>

<h2>Acceptable use</h2>
<p>Do not use {PRODUCT_NAME} to break the law, and do not share one subscription beyond the
   {DEVICE_LIMIT} devices it covers.</p>

<h2>Ending things</h2>
<p>You can delete your account at any time from your account page. We may end an account that is
   being used unlawfully or to abuse the service, and will refund any unused period if we do.</p>

<h2>No warranty, and the limit of what we owe</h2>
<p>The software is provided as it is. To the extent the law allows, {COMPANY_NAME} is not liable
   for indirect or consequential loss, and our total liability for any claim is limited to what you
   paid us in the twelve months before it.</p>

<h2>Law</h2>
<p>These terms are governed by the laws of India, and the courts of India have jurisdiction.</p>

<h2>Contact</h2>
<p>{COMPANY_NAME} — <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a></p>
"""


def register_legal(app: FastAPI, layout) -> None:
    @app.get("/privacy", response_class=HTMLResponse)
    def privacy() -> HTMLResponse:
        return HTMLResponse(layout(
            "Privacy", _privacy() + _footer(),
            f"What {PRODUCT_NAME} holds, which is an email address and whether you have paid. "
            "Your recordings, transcripts and minutes never leave your phone.",
        ))

    @app.get("/terms", response_class=HTMLResponse)
    def terms() -> HTMLResponse:
        return HTMLResponse(layout(
            "Terms", _terms() + _footer(),
            f"The terms for using {PRODUCT_NAME}: what the subscription covers, what the notes "
            "are worth, and whose responsibility it is to tell the room it is being recorded.",
        ))


def _footer() -> str:
    return """<p class="muted" style="margin-top:32px">
       <a href="/">Home</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> ·
       <a href="/account">Your account</a>
     </p>"""
