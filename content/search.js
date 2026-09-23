/* The Second Brain search window: one search over notes, Zotero papers, PDFs and images. */
var SecondBrainSearch = {
	sb: null,
	hits: [],
	selected: -1,
	seq: 0,
	timer: null,
	mode: "library", // library | online | related

	init() {
		const args = window.arguments?.[0] ?? {};
		this.sb = args.SecondBrain;
		this.input = document.getElementById("query");
		this.source = document.getElementById("source");
		this.results = document.getElementById("results");
		this.status = document.getElementById("status");
		this.input.addEventListener("input", () => this.schedule());
		this.source.addEventListener("change", () => this.search());
		window.addEventListener("keydown", (e) => this.key(e));
		document.getElementById("mode-library").addEventListener("click", () => this.setMode("library"));
		document.getElementById("mode-online").addEventListener("click", () => this.setMode("online"));
		this.discover = new this.sb.Discover(this.sb);
		this.buildSources();
		if (args.related) this.showRelated(args.related);
		else if (args.mode) this.setMode(args.mode, false);
		else if (args.query) this.setQuery(args.query);
		this.input.focus();
	},

	setQuery(query) {
		if (this.mode === "related") this.setMode("library", false);
		this.input.value = query;
		this.search();
	},

	/** A checkbox per service (remembered), and Google Scholar as a link: it has no API to search from here. */
	buildSources() {
		const box = document.getElementById("sources");
		const el = (tag, cls, text) => this.sb.el(document, tag, cls, text);
		const chosen = new Set(this.discover.chosenSources());
		box.append(el("span", "", "Search in:"));
		for (const source of this.sb.Discover.SOURCES) {
			const label = el("label");
			const check = el("input");
			check.type = "checkbox";
			check.checked = chosen.has(source.id);
			check.dataset.source = source.id;
			check.addEventListener("change", () => {
				const ids = [...box.querySelectorAll("input[data-source]")].filter((c) => c.checked).map((c) => c.dataset.source);
				if (!ids.length) { check.checked = true; return; }
				Zotero.Prefs.set("extensions.secondbrain.sources", JSON.stringify(ids), true);
				if (this.input.value.trim()) this.search();
			});
			label.append(check, source.label);
			box.append(label);
		}
		const scholar = el("button", "scholar", "Google Scholar ↗");
		scholar.title = "Google Scholar has no API; this opens the same search in your browser";
		scholar.addEventListener("click", () => Zotero.launchURL(`https://scholar.google.com/scholar?q=${encodeURIComponent(this.input.value.trim())}`));
		box.append(scholar);
	},

	setMode(mode, run = true) {
		this.mode = mode;
		document.getElementById("sources").hidden = mode !== "online";
		document.getElementById("mode-library").classList.toggle("is-on", mode === "library");
		document.getElementById("mode-online").classList.toggle("is-on", mode !== "library");
		this.source.hidden = mode !== "library";
		this.input.placeholder = mode === "library" ? "Search notes, papers, PDFs and images by words or meaning…"
			: "Describe what you need, or search by title or author (all published papers, via OpenAlex)…";
		this.hits = [];
		this.results.replaceChildren();
		if (run) this.search();
		this.input.focus();
	},

	/** Everything related to a paper in the library that isn't in it yet (or is): OpenAlex's related works,
	 *  papers citing it, and its references. */
	async showRelated(key) {
		const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
		if (!item) return;
		this.setMode("related", false);
		this.input.value = "";
		this.input.placeholder = "Describe what you need, or search by title or author (all published papers, via OpenAlex)…";
		const seq = ++this.seq;
		this.status.textContent = `Finding papers related to “${item.getField("title")}”…`;
		try {
			const found = await this.discover.related(item);
			if (seq !== this.seq) return;
			if (!found) {
				this.status.textContent = "OpenAlex doesn't know this paper, so there's nothing related to show. Try searching by topic above.";
				return;
			}
			const total = found.groups.reduce((n, [, list]) => n + list.length, 0);
			this.status.textContent = `${total} papers related to “${found.work.title}” · Add saves one to your library (and the selected collection)`;
			this.renderPapers(found.groups);
		} catch (error) {
			if (seq === this.seq) this.status.textContent = `Couldn't reach OpenAlex: ${error.message}`;
		}
	},

	async searchOnline(query, seq) {
		this.status.textContent = "Searching published papers…";
		try {
			const results = await this.discover.search(query);
			if (seq !== this.seq) return;
			const missed = results.failed.length ? ` · ${results.failed.join(", ")} didn't answer` : "";
			this.status.textContent = (results.length ? `${results.length} papers · Add saves one to your library (and the selected collection)` : "No papers found.") + missed;
			this.renderPapers([["", results]]);
		} catch (error) {
			if (seq === this.seq) this.status.textContent = `Couldn't search: ${error.message}`;
		}
	},

	renderPapers(groups) {
		const el = (tag, cls, text) => this.sb.el(document, tag, cls, text);
		this.hits = [];
		this.results.replaceChildren();
		for (const [label, papers] of groups) {
			if (label) this.results.append(el("div", "group", `${label} · ${papers.length}`));
			for (const paper of papers) {
				const row = el("div", "paper");
				const main = el("div", "paper-main");
				main.append(el("div", "title", paper.title));
				const who = paper.authors.length > 2 ? `${paper.authors[0].split(" ").pop()} et al.` : paper.authors.map((a) => a.split(" ").pop()).join(" & ");
				main.append(el("div", "meta", [who, paper.year, paper.venue, paper.cites ? `cited ${paper.cites}×` : "", paper.pdf ? "free PDF" : ""].filter(Boolean).join(" · ")));
				if (paper.abstract) main.append(el("div", "abstract", paper.abstract));
				if (paper.sources?.length) main.append(el("div", "found-in", `Found in ${paper.sources.join(", ")}`));
				row.append(main);
				if (paper.key) {
					const have = el("span", "have", "In your library ✓");
					have.title = "Show it in the library";
					have.addEventListener("click", () => this.sb.open("zotero/" + paper.key));
					row.append(have);
				} else {
					const add = el("button", "add", "+ Add");
					add.title = paper.doi ? `Add to Zotero (looked up by DOI ${paper.doi})` : "Add to Zotero";
					add.addEventListener("click", async () => {
						add.disabled = true;
						add.textContent = "Adding…";
						try {
							const item = await this.discover.add(paper);
							paper.key = item.key;
							add.replaceWith(Object.assign(el("span", "have", "Added ✓"), { title: "Show it in the library", onclick: () => this.sb.open("zotero/" + item.key) }));
						} catch (error) {
							Zotero.logError(error);
							add.disabled = false;
							add.textContent = "Try again";
							add.title = `Couldn't add: ${error.message}`;
						}
					});
					row.append(add);
				}
				this.results.append(row);
			}
		}
	},

	schedule() {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.search(), 120);
	},

	async search() {
		const query = this.input.value.trim();
		const seq = ++this.seq;
		if (!query) {
			this.hits = [];
			this.results.replaceChildren();
			this.status.textContent = "Papers open in Zotero; notes, PDFs and images open in Obsidian.";
			return;
		}
		if (this.mode !== "library") return this.searchOnline(query, seq);
		this.status.textContent = "Searching…";
		let hits;
		try {
			hits = await this.sb.searchAll(query, 30, this.source.value);
		} catch (error) {
			if (seq === this.seq) this.status.textContent = this.sb.unreachable(error);
			return;
		}
		if (seq !== this.seq) return;
		this.hits = hits;
		this.selected = hits.length ? 0 : -1;
		this.status.textContent = hits.length ? `${hits.length} results · ↑↓ to move, Enter to open` : "No matches.";
		this.render();
	},

	render() {
		const el = (tag, cls, text) => this.sb.el(document, tag, cls, text);
		this.results.replaceChildren();
		this.hits.forEach((hit, index) => {
			const row = el("div", "hit" + (index === this.selected ? " is-selected" : ""));
			const head = el("div", "hit-head");
			const kind = this.sb.kind(hit.path);
			head.append(el("span", "badge" + (kind === "Zotero" ? " zotero" : ""), kind), el("span", "title", hit.title));
			row.append(head);
			const z = hit.zotero;
			const meta = z
				? [z.authors?.length > 2 ? `${z.authors[0].split(" ").pop()} et al.` : (z.authors ?? []).map((a) => a.split(" ").pop()).join(" & "), z.year, z.venue].filter(Boolean).join(" · ")
				: `${hit.path.includes("/") ? hit.path.slice(0, hit.path.lastIndexOf("/")) : "Vault"} · ${hit.modified}`;
			row.append(el("div", "meta", meta));
			for (const passage of hit.passages ?? []) {
				const p = el("div", "passage");
				if (passage.heading) p.append(el("div", "heading", passage.heading.split(" > ").pop()));
				p.append(el("div", "snippet", passage.snippet.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ")));
				row.append(p);
			}
			row.addEventListener("click", () => this.open(index));
			this.results.append(row);
		});
	},

	open(index) {
		const hit = this.hits[index];
		if (!hit) return;
		this.sb.open(hit.path);
		if (hit.path.startsWith("zotero/")) Zotero.getMainWindow()?.focus();
	},

	key(e) {
		if (e.key === "Escape") return window.close();
		if (!this.hits.length) return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			this.selected = Math.max(0, Math.min(this.hits.length - 1, this.selected + (e.key === "ArrowDown" ? 1 : -1)));
			this.render();
			this.results.children[this.selected]?.scrollIntoView({ block: "nearest" });
		} else if (e.key === "Enter") {
			e.preventDefault();
			this.open(this.selected);
		}
	},
};

// Zotero 8+ no longer offers the Zotero object as an XPCOM service; take it from the window that opened this one.
var Zotero = window.opener?.Zotero ?? Services.wm.getMostRecentWindow("navigator:browser")?.Zotero;
window.addEventListener("load", () => SecondBrainSearch.init());
