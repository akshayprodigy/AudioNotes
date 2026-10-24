# Keywords: Play listing and website

One keyword set for both. Play has no "keywords" field. It indexes the **title, short description
and full description**, then ranks by installs, ratings and engagement. The website is indexed by
Google and Bing on its page titles, headings and text.

Limits: title 30, short description 80, full description 4000 characters. Current copy is in
`docs/play-console.md` under "Listing copy". Site copy: `server/app/landing.py` (h1: "Meeting notes
that never leave your phone"), posts in `server/app/content/blog/`.

Post shorthand: **Offline** = "Offline meeting notes on Android: no internet needed"; **MOM** =
"Minutes of meeting (MOM) template: free, with an example"; **Record** = "How to record a meeting
on your phone and get usable notes"; **vs Cloud** = "On-device vs cloud transcription: the honest
trade-offs"; **Privacy** = "Keep meeting recordings on your phone: the privacy case".

| Keyword | Intent | Where it appears now | Gap |
|---|---|---|---|
| offline meeting notes | Finds a notes app that works without signal | Play title, short description ("Offline"), full description; Offline (title); Privacy | Landing headline says "never leave your phone", not "offline". Fine, the blog covers it |
| meeting notes app | Highest-volume "install something" search | Play title ("Meeting Notes"); landing text | No post targets "meeting notes app" itself |
| meeting minutes / minutes of meeting / MOM | Wants minutes written, often India-based business English | MOM (title and h2s); full description says "minutes" only | **Play full description never says "minutes of meeting" or "MOM"** (only in the keyword note). Short description has "minutes" |
| meeting recorder | Wants to record a call or room | Full description (one mention in the keyword note only); Record (title) | Not in title or short description; add to the short and full description |
| transcribe meeting | Wants audio turned into text | Full description ("transcript"); Record, Offline, vs Cloud | "Transcribe" verb absent from Play copy; no post titled for it |
| voice recorder with transcription | Replacing a plain recorder app | Not in Play copy beyond "voice recorder" in the keyword note | Gap on both Play and site |
| private / on-device transcription | Privacy-led, often work or legal | Play short description ("no upload"), full description; Privacy, vs Cloud (titles) | Covered on the site; Play uses "private" lightly |
| AI meeting notes | Very high volume, crowded | Not used on Play or in the landing copy | Gap. Only use it where true: Verbale does write notes with a language model (Pro). Do not put it in the title |
| action items | Wants who-owes-what | Full description; landing (structured data, Actions screenshot); MOM (h2 "Action items") | No post targets it |
| meeting summary | Wants a short recap | Full description ("summary"); landing (Summary screenshot); Offline (cover image only) | No post targets it |
| Android | Platform filter | Offline (title), Record (tags); Play listing is Android by nature | Not in Play copy; do not add, Play already knows |

## Recommended Play listing changes

Only two, both claims the app already makes (the app has a MOM tab, records meetings, and works
offline after the first download). Title stays as it is: it is already 30/30 and carries the two
best terms.

**Short description (limit 80)**

- Current (79): `Records English meetings, writes the minutes on your phone. Offline, no upload.`
- Option A (74): `English meeting recorder: writes the minutes (MOM) on your phone. Offline.`
- Option B (76): `English meeting recorder that writes minutes (MOM) on your phone. No upload.`
- Both keep "English" (the one-star-review guard in `docs/play-console.md`) and add "meeting
  recorder" and "MOM". A keeps "Offline", B keeps "No upload"; each drops the other. Pick A if
  "offline" matters more in search (it is already in the title).

**Full description, first paragraph (limit 4000, the whole text is far below it)**

- Current (136): `Verbale records a meeting in English and writes the minutes on your phone. Nothing is uploaded, because there is no server to upload to.`
- Proposed (248): `Verbale is an offline meeting recorder for Android. It records a meeting in English and writes the minutes of meeting (MOM) on your phone: transcript by speaker, decisions, action items. Nothing is uploaded, because there is no server to upload to.`
- Trade: puts "meeting recorder", "minutes of meeting", "MOM", "transcript", "action items" in the
  first lines, where Play weights text most. Elsewhere, if natural, say "voice recorder with
  transcription" once in the How it works paragraph. Do not stuff a list of terms.

## Next five blog posts

Each must still pass the content bar (see `docs/website-launch.md`).

1. **Best meeting notes app for Android: what to look for** · primary: meeting notes app
2. **How to transcribe a meeting recording on your phone** · primary: transcribe meeting
3. **Action items from a meeting: how to write them so they get done** · primary: action items
4. **How to write a meeting summary in five minutes** · primary: meeting summary
5. **Voice recorder or meeting recorder: what the difference is** · primary: voice recorder with transcription

An "AI meeting notes" post is worth writing once there is something specific and true to say about
how the notes are written on the phone; hold it until then.
