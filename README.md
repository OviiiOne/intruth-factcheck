# InTruth — press-conference companion (Firefox fork)

> **This is a fork.** The original project is
> [rpanigrahi222/intruth-factcheck](https://github.com/rpanigrahi222/intruth-factcheck),
> a real-time fact-checking Chrome extension. All credit for the original idea and
> implementation goes to its author. This fork adapts it into a personal
> **press-conference companion for Firefox**, and that is where all new development
> happens (`firefox-extension/`).

## What this fork does

![The InTruth overlay following a live speech: timecoded transcript at the top, extracted key points below — each with speaker, category, quote, verify button and 👎 feedback](docs/overlay-example.jpg)

Follow a live press conference (or speech, debate, interview) playing in a browser
tab and, in real time:

- **Transcribe** the audio — Gladia real-time API (14 languages + auto-detect) or a
  local Whisper model as fallback (no key needed).
- **Translate** every language you haven't marked as "understood" into your working
  language, line by line.
- **Extract neutral key points** — announcements, figures, commitments, notable
  quotes, geopolitical positions — attributed to the participants you define.
  No verdicts, no interpretation: just what was said.
- **Learn from your feedback** — 👎 discards a point (and teaches it to avoid similar
  ones), ⭐ on selected transcript text adds a missed point (and teaches it to look
  for more). Every few feedbacks the examples are auto-distilled into a short list of
  editable rules ("Reglas aprendidas" in the popup) that are applied every time.
- **Summarize on demand** — a narrative summary, plus a full session export
  (transcript with timecodes, key points, summary) as an HTML report.
- **Bilingual** — the popup has an "Idioma / Language" switch (Español | English)
  that drives both the interface and the language the AI writes in (key points,
  summary, learned rules). It defaults to your browser's language.
- **Verify on demand** — per-key-point web-grounded verification. *Currently
  disabled:* web search is not usable on Groq's free tier; the code path is kept for
  when a search-capable provider is configured.

## Main differences from the original

| | Original (Chrome) | This fork (Firefox) |
|---|---|---|
| Browser | Chrome MV3 | Firefox MV2, loads as a temporary add-on |
| Audio | `tabCapture` | The page's own `<video>/<audio>` element — including players inside cross-origin iframes (e.g. Vimeo embeds) — or a system loopback input device. No installs required. |
| Output | Instant TRUE/FALSE-style verdicts per claim | Neutral key points; verification only on demand |
| Languages | English | 14 languages + auto-detect; bilingual UI/output (Español \| English); configurable list of languages that skip translation |
| AI providers | Anthropic key in the browser | Groq (free, default) / Gemini / Claude behind a small proxy (`proxy/`, deployable on Railway) so no API key ever lives in the browser; access gated by a shared token |
| Personalization | — | Feedback learning (examples + auto-distilled editable rules), participants bar, draggable/resizable panel |

## Repository layout

- `firefox-extension/` — the fork's extension (active development)
- `proxy/` — minimal proxy that keeps all API keys server-side (Railway)
- `realtime-factcheck/` — the original Chrome extension, kept for reference

## Installing

**Regular install (recommended):** download the signed `.xpi` from the
[Releases page](https://github.com/OviiiOne/intruth-factcheck/releases) and
open it with Firefox (double-click, or drag it onto a Firefox window). The
extension installs permanently — no developer mode needed.

**Development (temporary add-on):** open `about:debugging` → *This Firefox* →
*Load Temporary Add-on…* and pick `firefox-extension/manifest.json`. It unloads
when Firefox closes, but settings and learned rules persist (fixed add-on id).

## Using it

1. In the extension popup choose **Proxy** mode and set the proxy URL + token
   (or provide your own API keys directly), the source language and, optionally,
   the participants.
2. Open the page with the video, **press play (unmuted)**, then hit *Start*.

## Limitations

Transcription and key-point extraction are AI-based and imperfect: expect occasional
misheard names, missed points or clumsy phrasing. Nothing is ever presented as
fact-checked unless an explicit verification ran and is marked as such. Transcript
text is sent to the transcription/AI providers you configure — bring your own keys,
nothing is collected by this repo.

## License

MIT (same as the original project).
