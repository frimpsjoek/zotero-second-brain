# Third-party components

| Component | Where | License |
|---|---|---|
| [snowflake-arctic-embed-s](https://huggingface.co/Snowflake/snowflake-arctic-embed-s) (int8 ONNX build) | downloaded from this repo's `model-arctic-s-v1` release | Apache-2.0 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.22.0-dev.20250409 | `content/engine-worker.js`, release assets `ort-wasm-simd-threaded.*` | MIT |
| [Transformers.js](https://github.com/huggingface/transformers.js) 3.8 | `content/engine-worker.js` | Apache-2.0 |
| [CodeMirror 6](https://codemirror.net) and [Lezer](https://lezer.codemirror.net) | `content/note-editor.js` | MIT |

The model files in the release are unchanged copies of the files published by Snowflake on Hugging Face; the
plugin checks each download against the SHA-256 listed in `content/local-index.js`.
