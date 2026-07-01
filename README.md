# InTruth — press-conference companion (Firefox fork)

> **This is a fork.** The original project is
> [rpanigrahi222/intruth-factcheck](https://github.com/rpanigrahi222/intruth-factcheck),
> a real-time fact-checking Chrome extension. All credit for the original idea and
> implementation goes to its author. This fork adapts it into a personal
> **press-conference companion for Firefox**, and that is where all new development
> happens (`firefox-extension/`).

## What this fork does

Follow a live press conference (or speech, debate, interview) playing in a browser
tab and, in real time:

- **Transcribe** the audio — Gladia real-time API (14 languages + auto-detect) or a
  local Whisper model as fallback (no key needed).
- **Translate** everything except Spanish/English into Spanish, line by line.
- **Extract neutral key points** — announcements, figures, commitments, notable
  quotes, geopolitical positions — written in Spanish, attributed to the
  participants you define. No verdicts, no interpretation: just what was said.
- **Learn from your feedback** — 👎 discards a point (and teaches it to avoid similar
  ones), ⭐ on selected transcript text adds a missed point (and teaches it to look
  for more). Every few feedbacks the examples are auto-distilled into a short list of
  editable rules ("Reglas aprendidas" in the popup) that are applied every time.
- **Summarize on demand** — a narrative summary in Spanish, plus a full session
  export (transcript with timecodes, key points, summary) as an HTML report.
- **Verify on demand** — per-key-point web-grounded verification. *Currently
  disabled:* web search is not usable on Groq's free tier; the code path is kept for
  when a search-capable provider is configured.

## Main differences from the original

| | Original (Chrome) | This fork (Firefox) |
|---|---|---|
| Browser | Chrome MV3 | Firefox MV2, loads as a temporary add-on |
| Audio | `tabCapture` | The page's own `<video>/<audio>` element — including players inside cross-origin iframes (e.g. Vimeo embeds) — or a system loopback input device. No installs required. |
| Output | Instant TRUE/FALSE-style verdicts per claim | Neutral key points in Spanish; verification only on demand |
| Languages | English | 14 languages + auto-detect, auto-translation to Spanish |
| AI providers | Anthropic key in the browser | Groq (free, default) / Gemini / Claude behind a small proxy (`proxy/`, deployable on Railway) so no API key ever lives in the browser; access gated by a shared token |
| Personalization | — | Feedback learning (examples + auto-distilled editable rules), participants bar, draggable/resizable panel |

## Repository layout

- `firefox-extension/` — the fork's extension (active development)
- `proxy/` — minimal proxy that keeps all API keys server-side (Railway)
- `realtime-factcheck/` — the original Chrome extension, kept for reference

## Running the Firefox extension

1. Open `about:debugging` → *This Firefox* → *Load Temporary Add-on…* and pick
   `firefox-extension/manifest.json`.
2. In the extension popup choose **Proxy** mode and set the proxy URL + token
   (or provide your own API keys directly), the source language and, optionally,
   the participants.
3. Open the page with the video, **press play (unmuted)**, then hit *Start*.

Settings and learned rules persist across restarts (fixed add-on id), even as a
temporary add-on.

## Limitations

Transcription and key-point extraction are AI-based and imperfect: expect occasional
misheard names, missed points or clumsy phrasing. Nothing is ever presented as
fact-checked unless an explicit verification ran and is marked as such. Transcript
text is sent to the transcription/AI providers you configure — bring your own keys,
nothing is collected by this repo.

## License

MIT (same as the original project).
