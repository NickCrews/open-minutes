# @open-minutes/codecs

Decodes the audio meeting sites serve to the 16 kHz mono 16-bit WAV that
[`@open-minutes/audio`](../audio/README.md)'s models want:

- `webmOpusToWav`: YouTube's Opus-in-WebM, and the speech-quality re-encode
  kept in the blob store. libopus is asked for 16 kHz mono directly.
- `mp3ToWav`: akleg.gov's MP3 recordings, from a buffer or a stream (so a
  multi-hour recording decodes as it downloads, in constant memory). MP3 can't
  be decoded straight to 16 kHz, so the channels are averaged and resampled
  with a polyphase windowed-sinc filter (`Resampler`). A 3-hour meeting takes
  about a minute and 160 MB of memory. Its WAV matches ffmpeg's
  (`-ar 16000 -ac 1`) to a correlation of 0.9999999, about 1 ms apart (ffmpeg
  trims the encoder delay).
- `decodeToWav`: either of the above, picked by the file's magic bytes
  (`audioFormatOf`).

Both decoders are C libraries compiled to WebAssembly (`opus-decoder`,
`mpg123-decoder`), so no ffmpeg is needed and the same input gives the same
bytes on every machine. The tests pin those bytes, so a decoder upgrade that
changes the audio (and with it the golden fixtures' `_audio_sha256`) shows up
there first.

Sites' `SiteAdapter.downloadAudio` saves audio in the format the
site serves; `ensureWaveAudio` in `@open-minutes/audio/wav` decodes it with
this package.
