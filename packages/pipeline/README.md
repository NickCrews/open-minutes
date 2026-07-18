# @open-minutes/pipeline

The offline processing pipeline that turns raw meeting audio into speaker-attributed transcripts in the database. It transcribes audio locally with sherpa-onnx (downloading ONNX models on demand), diarizes it into anonymous speaker turns with per-speaker voiceprint embeddings, aligns those turns with the transcript at the word level, and then matches voiceprints against known people (by cosine similarity against embeddings stored in the database) before inserting the resulting segments. Everything runs in-process with no external services or GPUs required.
