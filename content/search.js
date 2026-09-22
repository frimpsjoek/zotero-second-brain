/* The Second Brain search window: one search over notes, Zotero papers, PDFs and images. */
var SecondBrainSearch = {
	sb: null,
	hits: [],
	selected: -1,
	seq: 0,
	timer: null,

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
		if (args.query) this.setQuery(args.query);
		this.input.focus();
	},

	setQuery(query) {
		this.input.value = query;
		this.search();
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

var Zotero = Components.classes["@zotero.org/Zotero;1"].getService(Components.interfaces.nsISupports).wrappedJSObject;
window.addEventListener("load", () => SecondBrainSearch.init());
