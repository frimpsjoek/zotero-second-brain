# Second Brain for Zotero

A Zotero 7+ plugin for reading and writing about papers.

- **Notes on each paper, inside Zotero.** A large Markdown editor in the item pane (and beside an open PDF) with
  live formatting, images you paste, and `[@citekey]` citations to other papers in your library. New highlights
  you make in the PDF can be added to the note as linked quotes. Notes are plain Markdown files on your computer.
- **Similar papers and search by meaning, on your computer.** Download the search model once (about 45 MB) from
  the plugin's settings. It reads the title and abstract of every paper in your library and shows how close other
  papers are to the one you're looking at. Nothing is sent anywhere.
- **Free PDFs.** Right-click papers → *Find PDF (free sources)* tries Unpaywall, arXiv, OpenAlex,
  Semantic Scholar and Europe PMC after Zotero's own resolvers.
- **Focus.** One button hides the rest of the item pane and makes the note wider.

It works on its own. If you also run the optional Second Brain server (a local index of an Obsidian vault and
your Zotero library), notes sync both ways with an Obsidian vault, and search covers your vault too.

## Install

1. Download `second-brain-<version>.xpi` from the [latest release](https://github.com/frimpsjoek/zotero-second-brain/releases/latest).
2. In Zotero: **Tools → Plugins**, then the gear menu → **Install Plugin From File…**, and pick the file.
3. Open **Zotero Settings → Second Brain** to download the search model, choose where notes are kept, and add
   your email for Unpaywall and OpenAlex.

Zotero checks this repository for updates.

## Where things are kept

| What | Where |
|---|---|
| Paper notes (without the server) | `<Zotero data directory>/second-brain/notes/`, or a folder you choose. Each file has a `zotero-key` in its front matter. |
| Search model and index | `<Zotero data directory>/second-brain/model`, `runtime`, `index` (Settings → Remove deletes them) |
| Settings | Zotero preferences, `extensions.secondbrain.*` |

## Unpaywall and OpenAlex keys

Each user sets up their own. The settings page has these steps with buttons that open each page:

1. **OpenAlex** (free; a key gives 10× more lookups a day): create an account at
   [openalex.org](https://openalex.org), copy your key from
   [openalex.org/settings/api](https://openalex.org/settings/api), and paste it into **OpenAlex API key**.
2. **Unpaywall** (free; no sign-up): type your email. Unpaywall now runs on OpenAlex data and also accepts a
   key, so you can try your OpenAlex key in **Unpaywall API key**; if **Test keys** says "Invalid api_key", clear
   it and the email is used.
3. Press **Test keys**. Both should say "works ✓".

Nothing here is required: without keys the PDF finder still tries arXiv, Semantic Scholar and Europe PMC. Keys
and email are sent only to those services.

## Building

```sh
./build.sh   # builds the editor and engine bundles, then dist/second-brain-<version>.xpi and dist/update.json
```

The search engine is [Transformers.js](https://github.com/huggingface/transformers.js) with ONNX Runtime Web,
running `snowflake-arctic-embed-s` in a few web workers. See [THIRD_PARTY.md](THIRD_PARTY.md) for licenses.

## License

MIT
