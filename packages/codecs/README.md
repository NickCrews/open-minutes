# @open-minutes/codecs

Decodes the audio meeting sites serve to the 16 kHz mono 16-bit WAV that
[`@open-minutes/audio`](../audio/README.md)'s models want, and re-encodes
YouTube's audio for the blob store:

- `OpusReader`: a WebM/Opus file's audio as 16 kHz mono samples, iterated a
  batch at a time. libopus is asked for 16 kHz mono directly.
- `OpusWriter`: 16 kHz mono samples, written in chunks, to a WebM/Opus file
  that decodes to exactly those samples and that browsers can play and seek.
- `encodeSpeechWebm`: an `OpusReader` piped into an `OpusWriter` at 24 kbps,
  the speech-quality copy of YouTube's audio that the blob store keeps (~11 MB
  per hour). A 90-minute meeting takes about a minute. Decoded, it matches
  the original to a correlation of ~0.997 on speech, at the same length.
- `webmOpusToWav`: an `OpusReader` written to WAV, for YouTube's audio and the
  blob store's copy.
- `mp3ToWav`: akleg.gov's MP3 recordings, from a buffer or a stream (so a
  multi-hour recording decodes as it downloads, in constant memory). MP3 can't
  be decoded straight to 16 kHz, so the channels are averaged and resampled
  with a polyphase windowed-sinc filter (`Resampler`). A 3-hour meeting takes
  about a minute and 160 MB of memory. Its WAV matches ffmpeg's
  (`-ar 16000 -ac 1`) to a correlation of 0.9999999, about 1 ms apart (ffmpeg
  trims the encoder delay).
- `decodeToWav`: either of the above, picked by the file's magic bytes
  (`audioFormatOf`).

The codecs are C libraries compiled to WebAssembly (`opus-decoder`,
`mpg123-decoder`, and `@evan/opus`'s WebAssembly build for encoding), so no
ffmpeg is needed and the same input gives the same bytes on every machine.
The tests pin those bytes, so an upgrade that changes the audio (and with it
the golden fixtures' `_audio_sha256`) shows up there first.

Sites' `SiteAdapter.downloadAudio` saves audio in the format the
site serves; `ensureWaveAudio` in `@open-minutes/audio/wav` decodes it with
this package.
