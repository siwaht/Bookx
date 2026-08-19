# Provider Capability Notes

## ElevenLabs

Official documentation confirms API-key authentication for its text-to-speech and speech-to-text capabilities. Bookx should expose voice, model, language, speech settings, long-form segmentation, continuity context, and output storage controls. ElevenLabs positions Multilingual v2 for stable long-form synthesis, Flash for lower-latency use, and Eleven v3 for expressive/multi-speaker work. Its documentation advises splitting large text into segments and using surrounding-text context to preserve prosody.

Sources:

- https://elevenlabs.io/docs/overview/capabilities/text-to-speech
- https://elevenlabs.io/docs/overview/capabilities/speech-to-text
- https://elevenlabs.io/docs/api-reference/authentication

## Deepgram

Official documentation positions Deepgram as a single provider for pre-recorded transcription, real-time streaming transcription, turn-based conversational transcription, and text-to-speech. For Bookx, the practical connection controls are an API key, transcription mode, model/language selection, diarization or multichannel options, and a separate text-to-speech model/voice selection.

Sources:

- https://developers.deepgram.com/docs/stt/getting-started
- https://developers.deepgram.com/docs/text-to-speech
- https://developers.deepgram.com/docs/tts-rest

## Fish Audio

Fish Audio documents API-key authentication and text-to-speech via its `POST /v1/tts` endpoint. Bookx should offer model selection, saved voice/reference selection, output format, speed, and streaming-vs-complete-file controls. The documentation distinguishes production-oriented `s2.1-pro`, a free development variant, previous-generation models, and direct or reusable voice-cloning workflows. For long-form work, it supports chunk controls and streaming output.

Source:

- https://docs.fish.audio/features/text-to-speech

## Cloudflare Workers AI

Cloudflare Workers AI provides a model catalog spanning text generation and audio capabilities. Bookx should treat its connection as account-scoped, requiring an account identifier and an API token with Workers AI permissions, then expose selectable task-compatible model IDs rather than hardcoding providers. This supports routing to Cloudflare-hosted language models as well as transcription and speech-generation models when available in the selected account/catalog.

Source:

- https://developers.cloudflare.com/workers-ai/models/

## OpenAI

OpenAI documents a unified audio model surface spanning file and realtime transcription, text-to-speech, speech-to-speech, audio-capable chat, and lower-latency realtime sessions. Bookx should keep the API key server-side, expose a bounded file workflow for narration/transcription, and reserve realtime configuration for interactive voice production. The connection UI should offer audio task routing, model selection, voice/output format selection, and an optional OpenAI-compatible endpoint for other language-model providers.

Source:

- https://developers.openai.com/api/docs/guides/audio

## Cloudflare MeloTTS repair note

The official Cloudflare Workers AI model page identifies `@cf/myshell-ai/melotts` as **Text-to-Speech**. Its required text field is `prompt`, with an optional `lang` field that defaults to `en`. Bookx should use this verified account-accessible model and request shape for its default Cloudflare narration route rather than the unavailable `@cf/deepgram/aura-2-en` model.

Source:

- https://developers.cloudflare.com/workers-ai/models/melotts/
