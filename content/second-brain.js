/* global Zotero, Services, IOUtils, TextDecoder */
// Loaded into bootstrap.js's scope. Everything the plugin does lives here.

SecondBrain = {
	id: null,
	rootURI: null,
	online: false, // the Second Brain server (Obsidian index) answered recently; everything else works without it
	paneID: null,
	menuIDs: [],
	columnKey: null,
	indexState: {}, // Zotero key -> { state, full_text }, from /zotero/status
	statusTimer: null,
	fixing: null, // { stop } while "Fix missing PDFs" runs
	editors: new Set(), // open paper-note editors (item pane and tabs)
	noteTabs: new Map(), // Zotero key -> tab id of the paper's note tab

	init({ id, rootURI }) {
		this.id = id;
		this.rootURI = rootURI;
		this.registerSection();
		this.registerMenus();
		this.registerColumn();
		this.autoQuote = Zotero.Prefs.get("extensions.secondbrain.autoQuote", true) ?? true;
		this.focusMode = Zotero.Prefs.get("extensions.secondbrain.focus", true) ?? false;
		Zotero.SecondBrain = this; // for Zotero's Run JavaScript window and tests
		this.local = new this.LocalStore(this);
		this.obsidian = new this.ObsidianStore(this);
		this.localIndex = new this.LocalIndex(this);
		Zotero.uiReadyPromise.then(() => this.localIndex.start());
		this.prefObservers = ["color.background", "color.text", "color.accent", "color.highlight"].map((name) =>
			Zotero.Prefs.registerObserver(`extensions.secondbrain.${name}`, () => {
				for (const editor of this.editors) editor.applyColors();
			}, true));
		Zotero.PreferencePanes.register({
			pluginID: this.id, src: "chrome://second-brain/content/preferences.xhtml", scripts: ["chrome://second-brain/content/preferences.js"],
			label: "Second Brain", image: rootURI + "content/icon20.svg",
		}).then((id) => { this.prefPaneID = id; }).catch((error) => Zotero.logError(error));
		this.notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids) => this.zoteroChanged(event, ids),
		}, ["item"], "second-brain");
		this.refreshIndexState();
		this.statusTimer = setInterval(() => this.refreshIndexState(), 60000);
		this.editsTimer = setInterval(() => this.applyObsidianEdits(), 5000);
	},

	shutdown() {
		for (const id of this.prefObservers ?? []) Zotero.Prefs.unregisterObserver(id);
		this.localIndex?.close();
		delete Zotero.SecondBrain;
		clearInterval(this.statusTimer);
		clearInterval(this.editsTimer);
		if (this.notifierID) Zotero.Notifier.unregisterObserver(this.notifierID);
		// the flush below is async and may not finish before Zotero quits; keep unsaved text to restore next time
		const drafts = this.drafts();
		for (const editor of this.editors) if (editor.cm && (editor.dirty || editor.saving)) drafts[editor.key] = { text: editor.cm.getText(), hash: editor.hash };
		this.saveDrafts(drafts);
		for (const editor of this.editors) editor.flush().finally(() => editor.destroy());
		const tabs = Zotero.getMainWindow()?.Zotero_Tabs;
		for (const id of this.noteTabs.values()) tabs?.close(id);
		if (this.fixing) this.fixing.stop = true;
		if (this.columnKey) Zotero.ItemTreeManager.unregisterColumn(this.columnKey);
		if (this.paneID) Zotero.ItemPaneManager.unregisterSection(this.paneID);
		for (const menuID of this.menuIDs) Zotero.MenuManager.unregisterMenu(menuID);
		for (const win of Zotero.getMainWindows()) this.removeFromWindow(win);
	},

	addToWindow(window) {
		window.MozXULElement.insertFTLIfNeeded("second-brain.ftl");
		this.addToolbarSearch(window);
	},

	removeFromWindow(window) {
		const doc = window.document;
		doc.querySelector('[href="second-brain.ftl"]')?.remove();
		for (const id of ["second-brain-tb-search", "second-brain-tb-results", "second-brain-style"]) doc.getElementById(id)?.remove();
		for (const details of doc.querySelectorAll("item-details")) details.classList.remove("sb-focus");
	},

	// ------------------------------------------------------------------ server

	/** Obsidian vault name, for obsidian://open links (settings). */
	get vault() {
		return Zotero.Prefs.get("extensions.secondbrain.vault", true) || "Second-Brain";
	},

	get server() {
		return (Zotero.Prefs.get("extensions.secondbrain.server", true) || "http://127.0.0.1:27182").replace(/\/+$/, "");
	},

	/** Notes go to the Obsidian vault while the Second Brain server runs, otherwise to the local folder. */
	store() {
		const where = Zotero.Prefs.get("extensions.secondbrain.notesIn", true) || "auto";
		return where === "local" || !this.online ? this.local : this.obsidian;
	},

	isOffline(error) {
		return !error?.status || error.status === 0 || /ECONNREFUSED|NS_ERROR|timed out/i.test(String(error?.message ?? error));
	},

	setOnline(on) {
		if (this.online === on) return;
		this.online = on;
		Zotero.ItemTreeManager.refreshColumns?.();
	},

	openSettings() {
		Zotero.Utilities.Internal.openPreferences(this.prefPaneID);
	},

	/** Papers cited as [@citekey] in a note's text, for its reference list. */
	async references(text) {
		const keys = new Set();
		for (const group of text.matchAll(/(?<!\[)\[[^\[\]\n]*@[^\]\n]*\]/g)) {
			for (const key of group[0].matchAll(/@([\w:.#$%&+?<>~/-]+)/g)) keys.add(key[1].replace(/[.,;:]+$/, ""));
		}
		return Promise.all([...keys].map(async (citekey) => {
			const item = await this.itemByCitekey(citekey);
			return item ? { citekey, key: item.key, label: this.shortLabel(item), title: item.getField("title") } : { citekey };
		}));
	},

	/** Search over the index when it runs; otherwise Zotero's own search of the library. */
	async searchAll(query, limit, source = "") {
		if (this.online || !this.checkedOnce) {
			try {
				const params = new URLSearchParams({ q: query, limit: String(limit) });
				if (source) params.set("source", source);
				const hits = await this.api(`/search?${params}`);
				this.setOnline(true);
				return hits;
			} catch (error) {
				if (!this.isOffline(error)) throw error;
				this.setOnline(false);
			}
		}
		const search = new Zotero.Search();
		search.libraryID = Zotero.Libraries.userLibraryID;
		search.addCondition("quicksearch-titleCreatorYearNote", "contains", query);
		const ids = (await search.search()).slice(0, 400);
		const items = Zotero.Items.get(ids).map((item) => (item.isRegularItem() ? item : item.parentItem)).filter((item) => item?.isRegularItem());
		const keyword = [...new Map(items.map((item) => [item.key, item])).keys()];
		let keys = keyword;
		if (this.localIndex.ready) {
			// meaning first; papers that also contain the words move up a little
			const exact = new Set(keyword);
			const ranked = (await this.localIndex.search(query, limit * 2)).map((hit) => ({ ...hit, score: hit.score + (exact.has(hit.key) ? 0.03 : 0) }));
			ranked.sort((a, b) => b.score - a.score);
			keys = [...new Set([...ranked.map((hit) => hit.key), ...keyword])];
		}
		return keys.slice(0, limit).map((key) => Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key)).filter(Boolean).map((item) => ({
			path: "zotero/" + item.key, title: item.getField("title"),
			zotero: { authors: item.getCreators().map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")), year: item.getField("year"), venue: item.getField("publicationTitle") },
		}));
	},

	async api(path) {
		const response = await Zotero.HTTP.request("GET", this.server + path, {
			responseType: "json", timeout: 15000, successCodes: false,
		});
		if (response.status >= 400 || !response.response) {
			throw new Error(response.response?.error ?? `HTTP ${response.status}`);
		}
		return response.response;
	},

	unreachable(error) {
		return this.isOffline(error)
			? "Second Brain isn't running, so this needs it. Notes, highlights and citations still work without it."
			: `Couldn't reach Second Brain: ${error?.message ?? error}`;
	},

	// ------------------------------------------------------------------ opening results

	/** Zotero items are selected in the library; notes, PDFs and images open in Obsidian. */
	open(path) {
		if (path.startsWith("zotero/")) {
			const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, path.slice(7));
			if (item) Zotero.getActiveZoteroPane()?.selectItem(item.id);
			return;
		}
		this.openURL(`obsidian://open?vault=${encodeURIComponent(this.vault)}&file=${encodeURIComponent(path.replace(/\.md$/, ""))}`);
	},

	/** Follow a link from a note without Zotero's "open this link?" prompt: zotero:// links are handled here,
	 *  obsidian:// and web links go to macOS directly (Zotero's own launcher asks every time). */
	openURL(href) {
		const zotero = /^zotero:\/\/(select|open-pdf)\/library\/items\/([A-Z0-9]{8})(?:\?(.*))?$/.exec(href);
		if (zotero) {
			const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, zotero[2]);
			if (!item) return;
			if (zotero[1] === "select") return Zotero.getActiveZoteroPane()?.selectItem(item.id);
			const params = new URLSearchParams(zotero[3] ?? "");
			const location = params.get("annotation") ? { annotationID: params.get("annotation") }
				: params.get("page") ? { pageIndex: Number(params.get("page")) - 1 } : undefined;
			return Zotero.Reader.open(item.id, location);
		}
		if (!/^(obsidian|https?|mailto):/i.test(href)) return;
		if (Zotero.isMac) Zotero.Utilities.Internal.exec("/usr/bin/open", [href]);
		else Zotero.launchURL(href);
	},

	kind(path) {
		if (path.startsWith("zotero/")) return "Zotero";
		if (/\.pdf$/i.test(path)) return "PDF";
		if (!path.endsWith(".md")) return "Image";
		return "Note";
	},

	// ------------------------------------------------------------------ item pane section

	registerSection() {
		this.paneID = Zotero.ItemPaneManager.registerSection({
			paneID: "second-brain",
			pluginID: this.id,
			header: { l10nID: "second-brain-pane-header", icon: this.rootURI + "content/icon.svg" },
			sidenav: { l10nID: "second-brain-pane-sidenav", icon: this.rootURI + "content/icon20.svg" },
			bodyXHTML: '<html:div class="sb-body" xmlns:html="http://www.w3.org/1999/xhtml"></html:div>',
			onItemChange: ({ item, setEnabled }) => {
				setEnabled(!!item?.isRegularItem());
				return true;
			},
			onRender: ({ body }) => {
				const box = body.querySelector(".sb-body");
				box.replaceChildren();
				box.append(this.el(body.ownerDocument, "div", "sb-muted", "Looking in your notes…"));
			},
			onAsyncRender: async ({ body, item, setSectionSummary }) => {
				await this.renderSection(body, item, setSectionSummary);
			},
			sectionButtons: [{
				type: "search",
				icon: "chrome://zotero/skin/16/universal/magnifier.svg",
				l10nID: "second-brain-section-search",
				onClick: ({ item }) => this.openSearch(item?.getField("title") ?? ""),
			}],
		});
	},

	async renderSection(body, item, setSectionSummary) {
		const doc = body.ownerDocument;
		const box = body.querySelector(".sb-body");
		this.style(doc);
		this.applyFocus(doc);
		if (item.isFeedItem) {
			box.replaceChildren(this.el(doc, "div", "sb-muted", "Feed articles aren't indexed. Add this one to My Library to see related notes."));
			setSectionSummary?.("");
			return;
		}
		const path = "zotero/" + item.key;
		box.replaceChildren(this.noteEditor(doc, item));
		let related, note;
		try {
			[related, note] = await Promise.all([
				this.api(`/related?path=${encodeURIComponent(path)}&limit=10`).catch((error) => {
					if (error?.message?.includes("no Zotero item")) return null;
					throw error;
				}),
				this.api(`/paper-note?key=${item.key}`),
			]);
			this.setOnline(true);
		} catch (error) {
			if (!this.isOffline(error)) Zotero.logError(error);
			this.setOnline(false);
			this.relatedInZotero(box, item);
			this.similarLocally(box, item);
			setSectionSummary?.("");
			return;
		}
		if (!related) {
			box.append(this.el(doc, "div", "sb-muted", "This paper isn't in the index yet. New papers are added within a few minutes."));
			return;
		}
		const refs = related.refs ?? {};
		const notePath = note?.path;
		const citing = (related.linked_from ?? []).filter((p) => p !== notePath)
			.map((p) => refs[p] ?? { path: p, title: p.split("/").pop().replace(/\.md$/, "") });
		const junk = (s) => !s.title || /^(no title|untitled)$/i.test(s.title.trim());
		const notes = (related.similar ?? []).filter((s) => !s.path.startsWith("zotero/") && s.path !== notePath && !junk(s));
		const papers = (related.similar ?? []).filter((s) => s.path.startsWith("zotero/") && !junk(s));
		setSectionSummary?.(note?.path ? "Has a note" : citing.length ? `Cited in ${citing.length}` : "");
		const cite = item.getField("citationKey") || "citekey";
		const more = this.el(doc, "div", "sb-related");
		box.append(more);
		this.list(more, "Cited in your notes", citing, `No other notes cite this paper. Cite it anywhere as [@${cite}].`);
		this.list(more, "Related notes", notes, "Nothing close in your notes.");
		this.list(more, "Similar papers in your library", papers, "No similar papers found.");
	},

	/** Without the index: the paper's related items as Zotero knows them. */
	relatedInZotero(box, item) {
		const doc = box.ownerDocument;
		const more = this.el(doc, "div", "sb-related");
		box.append(more);
		const rows = item.relatedItems.map((key) => Zotero.Items.getByLibraryAndKey(item.libraryID, key))
			.filter((other) => other?.isRegularItem())
			.map((other) => ({ path: "zotero/" + other.key, title: other.getField("title"),
				zotero: { authors: other.getCreators().map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")), year: other.getField("year"), venue: other.getField("publicationTitle") } }));
		this.list(more, "Related in Zotero", rows, "No related items.");
	},

	/** Without the index server: similar papers from the search model running in Zotero, if it's downloaded. */
	similarLocally(box, item) {
		const doc = box.ownerDocument;
		const more = box.querySelector(".sb-related") ?? box.appendChild(this.el(doc, "div", "sb-related"));
		const index = this.localIndex;
		if (!index.ready) {
			const hint = this.el(doc, "div", "sb-muted", index.state === "absent"
				? "For similar papers without Obsidian, download the search model in Second Brain settings (⚙)."
				: "The search model is still reading your library; similar papers show here when it's done.");
			more.append(hint);
			return;
		}
		const rows = index.similar(item.key, 8).map(({ key, score }) => {
			const other = Zotero.Items.getByLibraryAndKey(item.libraryID, key);
			return other && { path: "zotero/" + key, title: other.getField("title"), score, calibration: index.calibration,
				zotero: { authors: other.getCreators().map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")), year: other.getField("year"), venue: other.getField("publicationTitle") } };
		}).filter(Boolean);
		this.list(more, "Similar papers in your library", rows, "No similar papers found.");
	},

	/** "My notes" of the paper's Obsidian note, editable right here. */
	noteEditor(doc, item) {
		const card = this.el(doc, "div", "sb-note-card");
		const host = this.el(doc, "div");
		card.append(host);
		for (const old of this.editors) if (!old.tab && !old.root.isConnected) this.closeEditor(old);
		this.editors.add(new this.Editor(doc, host, item));
		return card;
	},

	/** Focus: hide every other item pane section and the related lists, so the note gets the whole pane. */
	setFocus(on) {
		this.focusMode = on;
		Zotero.Prefs.set("extensions.secondbrain.focus", on, true);
		for (const win of Zotero.getMainWindows()) this.applyFocus(win.document);
		for (const editor of this.editors) editor.showFocus();
	},

	applyFocus(doc) {
		for (const details of doc.querySelectorAll("item-details")) {
			details.classList.toggle("sb-focus", this.focusMode);
			if (this.focusMode) details.querySelector(".zotero-view-item")?.scrollTo(0, 0);
		}
		this.widen(doc, this.focusMode);
	},

	/** Focus gives the note more width: the collections pane folds away, and the item pane (library) and the
	 *  pane beside an open PDF take about half the window. The layout from before is kept in a pref so
	 *  "Show all" puts it back, even after a restart. */
	widen(doc, on) {
		const win = doc.defaultView;
		const splitter = doc.getElementById("zotero-collections-splitter");
		const panes = ["zotero-item-pane", "zotero-context-pane"].map((id) => doc.getElementById(id)).filter(Boolean);
		if (!splitter || !panes.length || !win.ZoteroPane) return;
		const saved = Zotero.Prefs.get("extensions.secondbrain.focusLayout", true);
		const setWidth = (pane, width) => {
			if (width) pane.setAttribute("width", width);
			else pane.removeAttribute("width");
			pane.style.width = width ? `${width}px` : "";
		};
		if (on) {
			if (!saved) {
				Zotero.Prefs.set("extensions.secondbrain.focusLayout", JSON.stringify({
					collapsed: splitter.getAttribute("state") === "collapsed",
					widths: Object.fromEntries(panes.map((pane) => [pane.id, pane.getAttribute("width") || ""])),
				}), true);
			}
			splitter.setAttribute("state", "collapsed");
			const width = Math.round(Math.min(win.innerWidth - 37 - 380, Math.max(560, win.innerWidth * 0.5)));
			for (const pane of panes) setWidth(pane, width);
		} else if (saved) {
			const layout = JSON.parse(saved);
			if (!layout.collapsed) splitter.setAttribute("state", "open");
			const widths = layout.widths ?? { "zotero-item-pane": layout.width ?? "" };
			for (const pane of panes) if (pane.id in widths) setWidth(pane, widths[pane.id]);
			Zotero.Prefs.clear("extensions.secondbrain.focusLayout", true);
		}
		win.ZoteroPane.updateLayoutConstraints?.();
	},

	closeEditor(editor) {
		editor.flush().finally(() => editor.destroy());
		this.editors.delete(editor);
	},

	/** Something changed in Zotero (a highlight, a comment, a note): show it in the open notes now, and copy it
	 *  into the Obsidian file a moment later, once the burst of changes has settled. */
	zoteroChanged(event, ids = []) {
		this.added ??= new Set();
		this.touched ??= new Set();
		if (event === "add") for (const id of ids) this.added.add(id);
		// deleted items can no longer be traced to their paper
		if (event === "delete") this.touchedAll = true;
		else for (const id of ids) this.touched.add(this.paperKeyOf(id));
		if (event !== "refresh") this.localIndex?.updateSoon();
		clearTimeout(this.zoteroTimer);
		this.zoteroTimer = setTimeout(() => {
			const added = [...this.added];
			const touched = new Set(this.touched);
			const all = this.touchedAll;
			this.added.clear();
			this.touched.clear();
			this.touchedAll = false;
			for (const editor of this.editors) {
				if (!all && !touched.has(editor.key)) continue;
				if (editor.root.isConnected && editor.renderFromZotero() && editor.path) this.refreshNoteSoon(editor.key);
			}
			if (this.autoQuote) this.quoteNewHighlights(added);
		}, 250);
	},

	/** The paper an item belongs to: an annotation's attachment's parent, a child note's parent, or the item itself. */
	paperKeyOf(id) {
		let item = Zotero.Items.get(id);
		while (item?.parentItem) item = item.parentItem;
		return item?.key;
	},

	drafts() {
		try {
			return JSON.parse(Zotero.Prefs.get("extensions.secondbrain.drafts", true) || "{}");
		} catch {
			return {};
		}
	},

	saveDrafts(drafts) {
		Zotero.Prefs.set("extensions.secondbrain.drafts", JSON.stringify(drafts), true);
	},

	/** A highlight was just made on a paper whose note is open: add it to the note as a linked quote. */
	quoteNewHighlights(ids) {
		for (const id of ids) {
			const annotation = Zotero.Items.get(id);
			if (!annotation?.isAnnotation?.() || annotation.annotationType === "ink") continue;
			// only highlights made just now, not ones arriving from another device through sync
			if (Date.now() - Zotero.Date.sqlToDate(annotation.dateAdded, true).getTime() > 60000) continue;
			const attachment = annotation.parentItem;
			const paper = attachment?.parentItem;
			if (!paper) continue;
			// one editor per paper does it (a tab is preferred over the side pane)
			const open = [...this.editors].filter((e) => e.key === paper.key && e.root.isConnected);
			const editor = open.find((e) => e.tab) ?? open[0];
			editor?.quote(attachment, annotation);
		}
	},

	/** Highlight comments and Zotero notes edited in the paper's Obsidian note: write them into Zotero. */
	async applyObsidianEdits() {
		if (this.applyingEdits) return;
		this.applyingEdits = true;
		try {
			let edits;
			try {
				edits = await this.api("/zotero/edits");
				this.setOnline(true);
			} catch (error) {
				if (this.isOffline(error)) this.setOnline(false);
				return;
			}
			if (!edits.length) return;
			const done = [];
			const library = Zotero.Libraries.userLibraryID;
			for (const edit of edits) {
				const item = Zotero.Items.getByLibraryAndKey(library, edit.key);
				try {
					if (edit.kind === "comment" && item?.isAnnotation()) {
						if ((item.annotationComment || "") !== edit.value) {
							item.annotationComment = edit.value;
							await item.saveTx();
						}
					} else if (edit.kind === "note" && item?.isNote()) {
						item.setNote(`<div data-schema-version="9">${this.cleanNoteHTML(edit.html)}</div>`);
						await item.saveTx();
					}
					done.push(edit.id); // also when the item is gone: nothing left to apply it to
				} catch (error) {
					Zotero.logError(error);
				}
			}
			if (done.length) await this.post("/zotero/edits/done", { ids: done });
		} catch (error) {
			/* server not running; try again next time */
		} finally {
			this.applyingEdits = false;
		}
	},

	setAutoQuote(on) {
		this.autoQuote = on;
		Zotero.Prefs.set("extensions.secondbrain.autoQuote", on, true);
		for (const editor of this.editors) editor.showAutoQuote?.();
	},

	shortLabel(item) {
		return [item.getField("firstCreator"), item.getField("year")].filter(Boolean).join(" ");
	},

	/** "Hou et al. 2024" for a citekey, looked up once in the library; onReady redraws when it arrives. */
	citeLabel(key, onReady) {
		this.citeCache ??= new Map();
		if (this.citeCache.has(key)) return this.citeCache.get(key);
		this.citeCache.set(key, null);
		this.itemByCitekey(key).then((item) => {
			if (!item) return;
			this.citeCache.set(key, { label: this.shortLabel(item) || key, title: item.getField("title"), id: item.id });
			onReady?.();
		});
		return null;
	},

	async itemByCitekey(key) {
		const library = Zotero.Libraries.userLibraryID;
		if (/^[A-Z0-9]{8}$/.test(key)) {
			const byKey = Zotero.Items.getByLibraryAndKey(library, key);
			if (byKey?.isRegularItem()) return byKey;
		}
		const search = new Zotero.Search();
		search.libraryID = library;
		search.addCondition("citationKey", "is", key);
		const ids = await search.search().catch(() => []);
		return ids.length ? Zotero.Items.get(ids[0]) : null;
	},

	async selectByCitekey(key) {
		const item = await this.itemByCitekey(key);
		if (item) Zotero.getActiveZoteroPane()?.selectItem(item.id);
	},

	refreshNoteSoon(key) {
		this.refreshTimers ??= new Map();
		clearTimeout(this.refreshTimers.get(key));
		this.refreshTimers.set(key, setTimeout(() => {
			this.refreshTimers.delete(key);
			if (this.store().kind !== "obsidian") return;
			this.post("/paper-note/refresh", { key }).catch((error) => { if (!this.isOffline(error)) Zotero.logError(error); });
		}, 2500));
	},

	/** Another editor saved this paper's note: let the others pick it up now rather than at the next poll. */
	notesChanged(key) {
		for (const editor of this.editors) if (editor.key === key && !editor.dirty) editor.checkForChanges();
	},

	/** The paper's note in its own Zotero tab: editor on the left, preview on the right. */
	openNoteTab(item) {
		const win = Zotero.getMainWindow();
		const tabs = win.Zotero_Tabs;
		const existing = this.noteTabs.get(item.key);
		if (existing && tabs._getTab(existing)?.tab) return tabs.select(existing);
		const title = item.getField("title") || "Paper note";
		let editor;
		const { id, container } = tabs.add({
			type: "second-brain-note", title: `Note · ${title}`, data: { itemID: item.id }, select: true,
			onClose: () => { if (editor) this.closeEditor(editor); this.noteTabs.delete(item.key); },
		});
		this.noteTabs.set(item.key, id);
		this.style(win.document);
		const scroller = this.el(win.document, "div", "sb-note-scroll");
		const page = this.el(win.document, "div", "sb-note-page");
		scroller.append(page);
		const head = this.el(win.document, "div", "sb-note-head");
		head.append(this.el(win.document, "div", "sb-note-kicker", "Paper note · saved to Obsidian"),
			this.el(win.document, "h1", "sb-note-title", title));
		const meta = [item.getField("firstCreator"), item.getField("year"), item.getField("publicationTitle")].filter(Boolean).join(" · ");
		if (meta) head.append(this.el(win.document, "div", "sb-meta", meta));
		const host = this.el(win.document, "div", "sb-note-editor");
		page.append(head, host);
		container.append(scroller);
		editor = new this.Editor(win.document, host, item, { tab: true });
		this.editors.add(editor);
		editor.ready.then(() => editor.cm?.focus());
	},

	button(doc, label, onClick, primary = false) {
		const button = this.el(doc, "button", primary ? "sb-button is-primary" : "sb-button", label);
		button.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
		return button;
	},

	list(box, label, rows, empty) {
		const doc = box.ownerDocument;
		const head = this.el(doc, "div", "sb-label", label);
		if (rows.length) head.append(this.el(doc, "span", "sb-count", String(rows.length)));
		box.append(head);
		if (!rows.length) {
			box.append(this.el(doc, "div", "sb-muted", empty));
			return;
		}
		for (const row of rows) {
			const isPaper = row.path.startsWith("zotero/");
			const line = this.el(doc, "div", "sb-row");
			line.setAttribute("title", isPaper ? "Show this paper in your library" : `Open in Obsidian: ${row.path}`);
			const text = this.el(doc, "div", "sb-row-text");
			text.append(this.el(doc, "div", "sb-title", row.title));
			text.append(this.el(doc, "div", "sb-meta", this.meta(row)));
			line.append(text);
			if (typeof row.score === "number") line.append(this.closeness(doc, row.score, row.calibration));
			line.append(this.el(doc, "span", "sb-go", isPaper ? "→" : "↗"));
			line.addEventListener("click", () => this.open(row.path));
			box.append(line);
		}
	},

	/** How close a similar paper or note is. Cosine scores from the embedding model bunch up, so they're graded
	 *  against this library: an unrelated pair of papers scores about 0.73, 99% of pairs stay under 0.86, and a
	 *  paper's single closest match is usually around 0.90 (measured on 3,529 papers, 2026-09-22). */
	closeness(doc, score, calibration = null) {
		// the model in Zotero reads title + abstract only, so its scores are graded against its own library-wide spread:
		// the same share of random paper pairs sits below each step as with the server's fixed thresholds
		const steps = calibration ? [calibration.p9999, calibration.p999, calibration.p99, calibration.p90] : [0.92, 0.88, 0.85, 0.8];
		const [, level, label] = [[steps[0], 5, "Very close"], [steps[1], 4, "Close"], [steps[2], 3, "Related"], [steps[3], 2, "Loose"], [-1, 1, "Distant"]]
			.find(([min]) => score >= min);
		const box = this.el(doc, "span", `sb-close is-${level}`);
		const dots = this.el(doc, "span", "sb-close-dots");
		for (let n = 1; n <= 5; n++) dots.append(this.el(doc, "span", n <= level ? "is-on" : ""));
		box.append(dots, this.el(doc, "span", "sb-close-label", label));
		box.setAttribute("title", calibration
			? `${label}: similarity ${score.toFixed(2)}. Two unrelated papers in your library score about ${calibration.p50.toFixed(2)}; ${calibration.p99.toFixed(2)} is closer than 99% of pairs.`
			: `${label}: similarity ${score.toFixed(2)}. Two unrelated papers score about 0.73; 0.86 is closer than 99% of pairs.`);
		return box;
	},

	/** Second line of a row: authors and year for papers, where it lives for notes and files. */
	meta(row) {
		if (row.path.startsWith("zotero/")) {
			const z = row.zotero ?? {};
			const authors = z.authors ?? [];
			const who = authors.length > 2 ? `${authors[0].split(" ").pop()} et al.` : authors.map((a) => a.split(" ").pop()).join(" & ");
			return [who, z.year, z.venue].filter(Boolean).join(" · ") || "Paper";
		}
		const folder = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : "Vault root";
		const kind = this.kind(row.path);
		return kind === "Note" ? folder : `${kind} · ${folder}`;
	},

	async post(path, body) {
		const response = await Zotero.HTTP.request("POST", this.server + path, {
			body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
			responseType: "json", timeout: 30000, successCodes: false,
		});
		if (response.status >= 400 || !response.response) {
			const error = new Error(response.response?.error ?? `HTTP ${response.status}`);
			error.status = response.status;
			error.body = response.response;
			throw error;
		}
		return response.response;
	},

	// ------------------------------------------------------------------ menus

	registerMenus() {
		const related = Zotero.MenuManager.registerMenu({
			menuID: "second-brain-item-related",
			pluginID: this.id,
			target: "main/library/item",
			menus: [{
				menuType: "menuitem",
				l10nID: "second-brain-menu-related",
				icon: this.rootURI + "content/icon.svg",
				onShowing: (event, context) => {
					const ok = context.items?.length === 1 && context.items[0].isRegularItem();
					context.setVisible?.(ok);
				},
				onCommand: (event, context) => {
					const item = context.items?.[0];
					if (item) this.openSearch(item.getField("title"));
				},
			}],
		});
		const findPDF = Zotero.MenuManager.registerMenu({
			menuID: "second-brain-item-find-pdf",
			pluginID: this.id,
			target: "main/library/item",
			menus: [{
				menuType: "menuitem",
				l10nID: "second-brain-menu-find-pdf",
				onShowing: (event, context) => context.setVisible?.(!!context.items?.some((item) => item.isRegularItem())),
				onCommand: (event, context) => this.findPDFsFor((context.items ?? []).filter((item) => item.isRegularItem()))
					.catch((error) => Zotero.logError(error)),
			}],
		});
		const search = Zotero.MenuManager.registerMenu({
			menuID: "second-brain-tools-search",
			pluginID: this.id,
			target: "main/menubar/tools",
			menus: [{
				menuType: "menuitem",
				l10nID: "second-brain-menu-search",
				icon: this.rootURI + "content/icon.svg",
				onCommand: () => this.openSearch(""),
			}],
		});
		const fix = Zotero.MenuManager.registerMenu({
			menuID: "second-brain-tools-fix",
			pluginID: this.id,
			target: "main/menubar/tools",
			menus: [{
				menuType: "menuitem",
				l10nID: "second-brain-menu-fix",
				onCommand: () => this.fixMissingPDFs().catch((error) => Zotero.logError(error)),
			}],
		});
		this.menuIDs = [related, findPDF, search, fix].filter(Boolean);
	},

	openSearch(query) {
		const win = Zotero.getMainWindow();
		const existing = Services.wm.getMostRecentWindow("second-brain:search");
		if (existing) {
			existing.SecondBrainSearch?.setQuery(query);
			existing.focus();
			return;
		}
		win.openDialog("chrome://second-brain/content/search.xhtml", "second-brain-search",
			"chrome,resizable,centerscreen,width=680,height=760", { query, SecondBrain: this });
	},

	// ------------------------------------------------------------------ index status column

	/** "Second Brain" column in the item list: whether each paper is in the index and with what. */
	registerColumn() {
		this.columnKey = Zotero.ItemTreeManager.registerColumn({
			dataKey: "second-brain-index",
			label: "Second Brain",
			pluginID: this.id,
			width: "110",
			dataProvider: (item) => this.indexLabel(item),
		});
	},

	indexLabel(item) {
		if (!item.isRegularItem() || item.libraryID !== Zotero.Libraries.userLibraryID) return "";
		if (!this.online) return "";
		const s = this.indexState[item.key];
		if (!s) return "Not indexed";
		const what = s.full_text ? "Full text" : "Details only";
		return s.state === "meaning" ? what : `${what} (keywords)`;
	},

	async refreshIndexState() {
		try {
			this.indexState = (await this.api("/zotero/status")).items ?? {};
			this.online = true;
			Zotero.ItemTreeManager.refreshColumns?.();
		} catch (error) {
			if (this.isOffline(error)) this.setOnline(false);
		} finally {
			this.checkedOnce = true;
		}
	},

	// ------------------------------------------------------------------ toolbar search

	/** A search field next to Zotero's own, over notes, PDFs, images and papers; results drop down under it. */
	addToolbarSearch(window) {
		const doc = window.document;
		const anchor = doc.getElementById("zotero-tb-search");
		if (!anchor || doc.getElementById("second-brain-tb-search")) return;
		this.style(doc);
		const input = this.el(doc, "input", "sb-tb-input");
		input.id = "second-brain-tb-search";
		input.type = "search";
		input.placeholder = "Search Second Brain…";
		input.title = "Search your notes, PDFs and papers by meaning";
		anchor.after(input);

		const panel = doc.createXULElement("panel");
		panel.id = "second-brain-tb-results";
		panel.setAttribute("noautofocus", "true");
		panel.setAttribute("consumeoutsideclicks", "false");
		const list = this.el(doc, "div", "sb-tb-list");
		panel.append(list);
		(doc.getElementById("mainPopupSet") ?? doc.documentElement).append(panel);

		let timer = null, seq = 0, hits = [], active = 0;
		const show = () => {
			if (panel.state !== "open" && panel.state !== "showing") panel.openPopup(input, "after_start", 0, 3, false, false);
		};
		const select = (i) => {
			active = Math.max(0, Math.min(hits.length - 1, i));
			list.querySelectorAll(".sb-row").forEach((row, n) => row.classList.toggle("is-active", n === active));
			list.querySelectorAll(".sb-row")[active]?.scrollIntoView({ block: "nearest" });
		};
		const openHit = (hit) => { panel.hidePopup(); this.open(hit.path); };
		const run = async () => {
			const query = input.value.trim();
			const mine = ++seq;
			if (!query) { panel.hidePopup(); return; }
			list.replaceChildren(this.el(doc, "div", "sb-muted", "Searching…"));
			show();
			try {
				const result = await this.searchAll(query, 15);
				if (mine !== seq) return;
				hits = result;
			} catch (error) {
				if (mine === seq) list.replaceChildren(this.el(doc, "div", "sb-muted", this.unreachable(error)));
				return;
			}
			list.replaceChildren();
			if (!hits.length) list.append(this.el(doc, "div", "sb-muted", "No matches."));
			hits.forEach((hit, n) => {
				const row = this.el(doc, "div", "sb-row sb-tb-row");
				const text = this.el(doc, "div", "sb-row-text");
				text.append(this.el(doc, "div", "sb-title", hit.title), this.el(doc, "div", "sb-meta", this.meta(hit)));
				const snippet = hit.passages?.[0]?.snippet;
				if (snippet) text.append(this.el(doc, "div", "sb-snippet", snippet.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ")));
				row.append(this.el(doc, "span", "sb-badge", this.kind(hit.path)), text);
				row.addEventListener("mousedown", (event) => { event.preventDefault(); openHit(hit); });
				row.addEventListener("mousemove", () => { if (active !== n) select(n); });
				list.append(row);
			});
			list.append(this.el(doc, "div", "sb-muted sb-tb-foot", this.online ? "↑↓ move · Enter open · papers open here, notes in Obsidian"
				: this.localIndex.ready ? "↑↓ move · Enter open · searching your library by meaning, on this computer"
				: "↑↓ move · Enter open · searching titles, authors and notes (download the search model in settings to search by meaning)"));
			select(0);
		};
		input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 180); });
		input.addEventListener("focus", () => { if (input.value.trim() && hits.length) show(); });
		input.addEventListener("blur", () => setTimeout(() => panel.hidePopup(), 150));
		input.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown") { event.preventDefault(); show(); select(active + 1); }
			else if (event.key === "ArrowUp") { event.preventDefault(); select(active - 1); }
			else if (event.key === "Enter" && hits[active]) { event.preventDefault(); openHit(hits[active]); }
			else if (event.key === "Escape") { panel.hidePopup(); }
		});
	},

	// ------------------------------------------------------------------ fixing missing PDFs

	/** Relink PDFs found on the drives, then download the rest with Zotero's own Find Full Text. */
	async fixMissingPDFs() {
		const win = Zotero.getMainWindow();
		const prompts = Services.prompt;
		if (this.fixing) {
			if (prompts.confirm(win, "Second Brain", "Finding PDFs is still running. Stop it?")) this.fixing.stop = true;
			return;
		}
		const job = (this.fixing = { stop: false });
		try {
			await this.runFix(win, prompts, job);
		} finally {
			this.fixing = null;
		}
	},

	/** Without Second Brain there's no drive search, but papers with no PDF can still be found online. */
	async planWithoutServer() {
		const items = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).filter((item) => item.isRegularItem());
		let ok = 0;
		const missing = [];
		for (const item of items) (await this.hasWorkingPDF(item)) ? ok++ : missing.push(item.key);
		return { counts: { ok, pdf_attachments: items.length, ok_after_base: 0 }, relink: [], find_online: missing, local: true };
	},

	async runFix(win, prompts, job) {
		const progress = new Zotero.ProgressWindow({ closeOnClick: false });
		progress.changeHeadline("Second Brain: checking PDF attachments");
		const line = new progress.ItemProgress(this.rootURI + "content/icon.svg", "Looking for missing files on your drives…");
		progress.show();
		let plan;
		try {
			for (let first = true; ; first = false) {
				const reply = await this.api(`/zotero/files${first ? "?refresh=1" : ""}`);
				if (reply.ready) { plan = reply.plan; break; }
				if (reply.error) throw new Error(reply.error);
				if (reply.total) {
					line.setText(`Checking attachments… ${reply.done} of ${reply.total}`);
					line.setProgress(Math.round((reply.done / reply.total) * 100));
				}
				await Zotero.Promise.delay(1500);
			}
		} catch (error) {
			if (!this.isOffline(error)) {
				line.setError();
				line.setText(this.unreachable(error));
				progress.startCloseTimer(8000);
				return;
			}
			line.setText("Finding papers without a PDF…");
			plan = await this.planWithoutServer();
		}
		progress.close();

		const c = plan.counts;
		const baseChange = plan.base && Zotero.Prefs.get("baseAttachmentPath") !== plan.base;
		const text = [
			plan.local ? `${c.ok} of ${c.pdf_attachments} papers have a PDF that opens. (Start Second Brain to also search your drives for lost files.)`
				: `${c.ok} of ${c.pdf_attachments} PDF attachments open today.`,
			baseChange ? `• ${c.ok_after_base} more open once linked files are read from ${plan.base}.` : "",
			plan.local ? "" : `• ${plan.relink.length} were found elsewhere on your drives (checked against each paper's title or DOI) and will be relinked.`,
			`• ${plan.find_online.length} papers still have no PDF; Zotero will look for open-access copies online, then Unpaywall (with your email), arXiv, OpenAlex, Semantic Scholar and Europe PMC (this runs in the background and can take a while).`,
			"",
			"Nothing is deleted. Continue?",
		].filter((t) => t !== "").join("\n");
		if (!prompts.confirm(win, "Fix missing PDFs", text)) return;

		if (baseChange) Zotero.Prefs.set("baseAttachmentPath", plan.base);
		const relinked = await this.relink(plan.relink, job);
		await this.findOnline(plan.find_online, job);
		if (relinked.length) Zotero.FullText.indexItems(relinked).catch(() => {});
	},

	async relink(entries, job) {
		const progress = new Zotero.ProgressWindow({ closeOnClick: false });
		progress.changeHeadline("Second Brain: relinking PDFs");
		const line = new progress.ItemProgress(this.rootURI + "content/icon.svg", "");
		progress.show();
		const done = [];
		let failed = 0;
		for (const [n, entry] of entries.entries()) {
			if (job.stop) break;
			line.setText(`Relinking ${n + 1} of ${entries.length}`);
			line.setProgress(Math.round(((n + 1) / entries.length) * 100));
			const attachment = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, entry.attachment);
			try {
				if (attachment && !(await attachment.fileExists())) {
					await attachment.relinkAttachmentFile(entry.path);
					done.push(attachment.id);
				}
			} catch (error) {
				failed++;
				Zotero.logError(error);
			}
		}
		line.setText(`Relinked ${done.length} PDFs${failed ? `, ${failed} failed` : ""}${job.stop ? " (stopped)" : ""}`);
		progress.startCloseTimer(6000);
		return done;
	},

	/** Papers with no PDF at all go to Zotero's Find Full Text queue. Papers whose only PDFs are broken are
	 *  skipped by that queue, so those are fetched one by one with the same resolvers; when a copy arrives,
	 *  broken attachments without highlights move to the Trash (restorable). */
	async findOnline(keys, job) {
		const items = keys.map((key) => Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key)).filter(Boolean);
		const fresh = items.filter((item) => Zotero.Attachments.canFindFileForItem(item));
		// Zotero's resolvers (DOI, URL, Unpaywall open access) first; it shows its own progress
		const zoteroPass = fresh.length ? Zotero.Attachments.addAvailableFiles(fresh).catch((e) => Zotero.logError(e)) : null;
		const broken = items.filter((item) => !fresh.includes(item) &&
			(item.getField("DOI") || item.getField("url") || item.getExtraField?.("DOI")));
		if (!broken.length) {
			await zoteroPass;
			return this.findOnArxiv(items, job);
		}
		const progress = new Zotero.ProgressWindow({ closeOnClick: false });
		progress.changeHeadline("Second Brain: downloading PDFs for broken links");
		const line = new progress.ItemProgress(this.rootURI + "content/icon.svg", "");
		progress.show();
		let found = 0;
		for (const [n, item] of broken.entries()) {
			if (job.stop) break;
			line.setText(`${n + 1} of ${broken.length} · ${found} found`);
			line.setProgress(Math.round(((n + 1) / broken.length) * 100));
			try {
				const added = await Zotero.Attachments.addFileFromURLs(item, Zotero.Attachments.getFileResolvers(item));
				if (!added) continue;
				found++;
			} catch (error) {
				Zotero.logError(error);
			}
		}
		line.setText(`Downloaded ${found} of ${broken.length} PDFs${job.stop ? " (stopped)" : ""}`);
		progress.startCloseTimer(10000);
		await zoteroPass;
		await this.findOnArxiv(items, job);
	},

	// ------------------------------------------------------------------ arXiv

	async hasWorkingPDF(item) {
		for (const id of item.getAttachments()) {
			const attachment = Zotero.Items.get(id);
			if (attachment?.isPDFAttachment?.() && !attachment.deleted && await attachment.fileExists()) return true;
		}
		return false;
	},

	/** The arXiv id a paper already names: its URL, a 10.48550/arXiv DOI, or "arXiv:" in Extra. */
	arxivID(item) {
		const fields = [item.getField("url"), item.getField("DOI"), item.getField("extra"), item.getField("archiveID"),
			item.getField("publicationTitle")].join(" ");
		const m = /arxiv\.org\/(?:abs|pdf)\/([\w.\/-]+?)(?:v\d+)?(?:\.pdf)?(?:[\s?#]|$)/i.exec(fields)
			|| /10\.48550\/arxiv\.([\d.]+)/i.exec(fields)
			|| /arxiv:\s*([\d]{4}\.[\d]{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})/i.exec(fields);
		return m ? m[1] : null;
	},

	normalizeTitle(title) {
		return (title || "").toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, " ").trim();
	},

	/** Search arXiv by title; accept only a near-identical title (so a wrong paper is never attached). */
	async searchArxiv(item) {
		const title = this.normalizeTitle(item.getField("title"));
		if (title.split(" ").length < 3) return null;
		const query = `ti:"${title.split(" ").slice(0, 14).join(" ")}"`;
		const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=5`;
		const response = await Zotero.HTTP.request("GET", url, { responseType: "text", timeout: 30000, successCodes: false });
		if (response.status !== 200) return null;
		const xml = new (Zotero.getMainWindow().DOMParser)().parseFromString(response.response, "application/xml");
		const want = new Set(title.split(" "));
		for (const entry of xml.getElementsByTagName("entry")) {
			const found = this.normalizeTitle(entry.getElementsByTagName("title")[0]?.textContent);
			const words = new Set(found.split(" "));
			const shared = [...want].filter((w) => words.has(w)).length;
			const similarity = shared / Math.max(want.size, words.size);
			if (found === title || similarity >= 0.9) {
				const id = entry.getElementsByTagName("id")[0]?.textContent ?? "";
				const m = /arxiv\.org\/abs\/(.+?)(?:v\d+)?$/.exec(id.trim());
				if (m) return m[1];
			}
		}
		return null;
	},

	// ------------------------------------------------------------------ open-access sources

	async json(url) {
		const response = await Zotero.HTTP.request("GET", url, { responseType: "json", timeout: 30000, successCodes: false });
		return response.status === 200 ? response.response : null;
	},

	/** A free PDF for the paper from OpenAlex (which aggregates repositories), or null. */
	async openAlex(item) {
		const doi = (item.getField("DOI") || item.getExtraField?.("DOI") || "").replace(/^https?:\/\/doi\.org\//i, "");
		const url = doi ? `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`
			: `https://api.openalex.org/works?filter=title.search:${encodeURIComponent(this.normalizeTitle(item.getField("title")))}&per_page=1`;
		const data = await this.json(url + this.openAlexAuth(url.includes("?") ? "&" : "?"));
		const work = data?.results ? data.results[0] : data;
		if (!work) return null;
		if (!doi && this.titlesDiffer(item, work.display_name)) return null;
		const locations = [work.best_oa_location, work.primary_location, ...(work.locations ?? [])];
		return locations.find((l) => l?.pdf_url)?.pdf_url ?? null;
	},

	/** Your email (settings) puts OpenAlex requests in its faster "polite pool"; an API key lifts the daily cap. */
	openAlexAuth(join) {
		const params = new URLSearchParams();
		const email = Zotero.Prefs.get("extensions.secondbrain.email", true);
		const key = Zotero.Prefs.get("extensions.secondbrain.openalexKey", true);
		if (email) params.set("mailto", email);
		if (key) params.set("api_key", key);
		return params.size ? join + params : "";
	},

	/** Unpaywall takes its own API key, or an email address when there's no key. */
	unpaywallAuth() {
		const params = new URLSearchParams();
		const key = Zotero.Prefs.get("extensions.secondbrain.unpaywallKey", true);
		const email = Zotero.Prefs.get("extensions.secondbrain.email", true);
		if (key) params.set("api_key", key);
		if (email) params.set("email", email);
		return params.size ? String(params) : "";
	},

	/** Unpaywall's best open-access PDF for a DOI. Unpaywall needs an email with each request, so it's used only
	 *  once one is set in the settings. */
	async unpaywall(item) {
		const doi = (item.getField("DOI") || item.getExtraField?.("DOI") || "").replace(/^https?:\/\/doi\.org\//i, "");
		const auth = this.unpaywallAuth();
		if (!auth || !doi) return null;
		const data = await this.json(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?${auth}`);
		const locations = [data?.best_oa_location, ...(data?.oa_locations ?? [])];
		return locations.find((l) => l?.url_for_pdf)?.url_for_pdf ?? null;
	},

	/** Semantic Scholar's open-access copy, or null. */
	async semanticScholar(item) {
		const doi = (item.getField("DOI") || "").replace(/^https?:\/\/doi\.org\//i, "");
		const url = doi
			? `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=title,openAccessPdf`
			: `https://api.semanticscholar.org/graph/v1/paper/search?limit=1&fields=title,openAccessPdf&query=${encodeURIComponent(item.getField("title"))}`;
		const data = await this.json(url);
		const paper = data?.data ? data.data[0] : data;
		if (!paper || (!doi && this.titlesDiffer(item, paper.title))) return null;
		return paper.openAccessPdf?.url ?? null;
	},

	/** Europe PMC (life sciences), or null. */
	async europePMC(item) {
		const doi = (item.getField("DOI") || "").replace(/^https?:\/\/doi\.org\//i, "");
		if (!doi) return null;
		const data = await this.json(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:%22${encodeURIComponent(doi)}%22&format=json&resultType=core`);
		const hit = data?.resultList?.result?.[0];
		return hit?.pmcid && hit?.isOpenAccess === "Y" ? `https://europepmc.org/articles/${hit.pmcid}?pdf=render` : null;
	},

	titlesDiffer(item, other) {
		const want = new Set(this.normalizeTitle(item.getField("title")).split(" "));
		const found = new Set(this.normalizeTitle(other).split(" "));
		if (!want.size || !found.size) return true;
		const shared = [...want].filter((w) => found.has(w)).length;
		return shared / Math.max(want.size, found.size) < 0.85;
	},

	/** Save a PDF onto the paper, and undo it if what arrived isn't really a PDF. */
	async attachPDF(item, url, title) {
		const attachment = await Zotero.Attachments.importFromURL({
			libraryID: item.libraryID, parentItemID: item.id, url, title, contentType: "application/pdf",
		});
		const path = attachment && await attachment.getFilePathAsync();
		const head = path && (await IOUtils.read(path, { maxBytes: 5 }));
		if (head && new TextDecoder().decode(head) === "%PDF-") return true;
		if (attachment) await attachment.eraseTx(); // a login page or an error page, not the paper
		return false;
	},

	/** Papers still without a PDF after Zotero's own search: try the free sources, one paper at a time. */
	async findOnArxiv(items, job) {
		const missing = [];
		for (const item of items) if (!(await this.hasWorkingPDF(item))) missing.push(item);
		if (!missing.length) return;
		const progress = new Zotero.ProgressWindow({ closeOnClick: false });
		progress.changeHeadline("Second Brain: looking for free copies");
		const line = new progress.ItemProgress(this.rootURI + "content/icon.svg", "");
		progress.show();
		const found = { Unpaywall: 0, arXiv: 0, OpenAlex: 0, "Semantic Scholar": 0, "Europe PMC": 0 };
		for (const [n, item] of missing.entries()) {
			if (job.stop) break;
			const total = Object.values(found).reduce((a, b) => a + b, 0);
			line.setText(`${n + 1} of ${missing.length} · ${total} found`);
			line.setProgress(Math.round(((n + 1) / missing.length) * 100));
			const sources = [
				["Unpaywall", () => this.unpaywall(item)],
				["arXiv", async () => {
					let id = this.arxivID(item);
					if (!id) {
						id = await this.searchArxiv(item);
						await Zotero.Promise.delay(3000); // arXiv asks for one search every 3 seconds
					}
					return id ? `https://arxiv.org/pdf/${id}` : null;
				}],
				["OpenAlex", () => this.openAlex(item)],
				["Semantic Scholar", () => this.semanticScholar(item)],
				["Europe PMC", () => this.europePMC(item)],
			];
			for (const [name, find] of sources) {
				if (job.stop) break;
				try {
					const url = await find();
					await Zotero.Promise.delay(1000); // gentle on the free APIs
					if (!url) continue;
					if (await this.attachPDF(item, url, `${name} Full Text PDF`)) {
						found[name]++;
						break;
					}
				} catch (error) {
					Zotero.logError(error);
				}
			}
		}
		const summary = Object.entries(found).filter(([, n]) => n).map(([name, n]) => `${name} ${n}`).join(", ");
		line.setText(`Found ${Object.values(found).reduce((a, b) => a + b, 0)} of ${missing.length}${summary ? ` (${summary})` : ""}${job.stop ? " · stopped" : ""}`);
		progress.startCloseTimer(15000);
	},

	/** Right-click: find PDFs for the selected papers (Zotero's resolvers, then arXiv). */
	async findPDFsFor(items) {
		if (this.fixing) return;
		const job = (this.fixing = { stop: false });
		try {
			await this.findOnline(items.map((item) => item.key), job);
		} finally {
			this.fixing = null;
		}
	},

	// ------------------------------------------------------------------ helpers

	/** Obsidian text becomes Zotero note HTML: keep formatting tags and web/zotero links, drop everything else. */
	cleanNoteHTML(html) {
		const keep = new Set(["P", "BR", "HR", "STRONG", "B", "EM", "I", "U", "S", "DEL", "MARK", "SUB", "SUP", "CODE", "PRE",
			"BLOCKQUOTE", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "A", "SPAN", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);
		const drop = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "SVG", "MATH", "FORM", "LINK", "META", "BASE"]);
		const doc = new (Zotero.getMainWindow().DOMParser)().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, "text/html");
		const clean = (node) => {
			for (const child of [...node.children]) {
				const tag = child.tagName.toUpperCase();
				if (drop.has(tag)) { child.remove(); continue; }
				clean(child);
				if (!keep.has(tag)) { child.replaceWith(...child.childNodes); continue; }
				for (const { name } of [...child.attributes]) {
					if (!(tag === "A" && name === "href" && /^(https?|zotero):/i.test(child.getAttribute("href").trim()))) child.removeAttribute(name);
				}
			}
		};
		clean(doc.body);
		return doc.body.innerHTML;
	},

	el(doc, tag, cls, text) {
		const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
		if (cls) node.className = cls;
		if (text !== undefined) node.textContent = text;
		return node;
	},

	style(doc) {
		if (doc.getElementById("second-brain-style")) return;
		const style = this.el(doc, "style");
		style.id = "second-brain-style";
		style.textContent = `
			/* contain: inline-size keeps long titles from widening the pane; they get an ellipsis instead */
			.sb-body { display: flex; flex-direction: column; gap: 2px; padding-bottom: 4px; width: 100%; contain: inline-size; }
			.sb-body > *, .sb-row, .sb-card, .sb-card-head { min-width: 0; }
			.sb-card-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.sb-card-head .sb-button { flex: none; }
			.sb-label { font-weight: 600; font-size: 11px; color: var(--fill-secondary); text-transform: uppercase; letter-spacing: .04em; margin: 8px 0 2px; }
			.sb-muted { color: var(--fill-secondary); font-size: 12px; padding: 2px 0; }
			.sb-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; cursor: pointer; }
			.sb-row:hover { background: var(--fill-quinary); }
			.sb-row-text { flex: 1; min-width: 0; }
			.sb-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.sb-meta { font-size: 11px; color: var(--fill-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.sb-go { color: var(--fill-tertiary); font-size: 12px; opacity: 0; }
			.sb-row:hover .sb-go { opacity: 1; }
			.sb-count { margin-inline-start: 6px; font-weight: 500; color: var(--fill-tertiary); }
			.sb-badge { font-size: 10px; padding: 0 5px; border-radius: 4px; background: var(--fill-quinary); color: var(--fill-secondary); }
			.sb-card { display: flex; flex-direction: column; gap: 6px; padding: 10px; margin: 2px 0 6px;
				border-radius: 8px; border: 1px solid var(--fill-quinary); background: var(--material-sidepane, transparent); cursor: default; }
			.sb-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
			.sb-card-title { font-weight: 600; }
			.sb-card-text { font-size: 12px; line-height: 1.45; cursor: pointer;
				display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
			.sb-hint { font-size: 11px; color: var(--fill-secondary); }
			.sb-button { font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 5px; cursor: pointer;
				border: 1px solid var(--fill-quinary); background: var(--material-button, var(--fill-quinary)); color: inherit; }
			.sb-button:hover { background: var(--fill-quarternary, var(--fill-quinary)); }
			.sb-button.is-primary { align-self: flex-start; background: var(--accent-blue); border-color: transparent; color: #fff; font-weight: 500; padding: 5px 12px; }
			.sb-button:disabled { opacity: .6; cursor: default; }
			.sb-ed { display: flex; flex-direction: column; gap: 8px; min-width: 0;
				--sb-link: var(--accent-blue); --sb-muted: var(--fill-tertiary); --sb-quote: var(--fill-secondary);
				--sb-code-bg: var(--fill-quinary); }
			.sb-ed [hidden] { display: none !important; }
			.sb-ed-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
			.sb-ed-tools { display: flex; flex-wrap: wrap; gap: 2px; padding: 3px; border-radius: 9px; background: var(--fill-quinary); }
			.sb-tool { min-width: 32px; height: 30px; padding: 0 7px; border: none; border-radius: 6px; background: transparent;
				color: var(--fill-secondary); font: 15px -apple-system, system-ui, sans-serif; cursor: pointer; }
			.sb-tool:hover { background: var(--material-background); color: inherit; }
			.sb-tool.is-bold { font-weight: 700; } .sb-tool.is-italic { font-style: italic; font-family: Georgia, serif; }
			.sb-tool.is-heading { font-weight: 700; } .sb-tool.is-cite { color: var(--accent-blue); font-weight: 600; }
			.sb-ed-status { font-size: 12px; color: var(--fill-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
			.sb-ed-status.is-error { color: var(--accent-red, #d33); }
			.sb-ed-spacer { flex: 1; }
			.sb-ed-bar .sb-button { flex: none; padding: 4px 10px; font-size: 12.5px; border-color: transparent; background: transparent; color: var(--fill-secondary); }
			.sb-ed-bar .sb-button:hover { background: var(--fill-quinary); color: inherit; }
			.sb-ed-bar .sb-button.is-icon { font-size: 17px; padding: 2px 8px; }
			.sb-ed-toggle.is-on { color: var(--accent-green, #3a9d4a) !important; }

			/* the note: CodeMirror in its own frame (note-frame.html/.css) */
			.sb-ed-surface { min-width: 0; padding: 4px 16px 0; }
			.sb-ed-frame { display: block; width: 100%; height: 440px; border: 0; background: transparent; }

			/* the writing space: a sheet of its own, so it reads as the place to write */
			.sb-ed-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
			.sb-ed-heading { display: flex; flex-direction: column; min-width: 0; flex: 1; }
			.sb-ed-heading b { font-size: 15px; font-weight: 650; }
			.sb-ed-heading span { font-size: 11.5px; color: var(--fill-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.sb-ed-head .sb-button { flex: none; padding: 5px 12px; font-size: 12.5px; }
			.sb-ed-head .sb-button.is-on { background: var(--fill-quinary); color: inherit; }
			.sb-ed-head .sb-button.is-icon { font-size: 15px; padding: 3px 8px; border-color: transparent; background: transparent; }
			.sb-ed-sheet { display: flex; flex-direction: column; min-width: 0; border-radius: 8px; overflow: hidden;
				border: 1px solid var(--fill-quinary); background: var(--sb-sheet-bg, var(--material-background)); }
			.sb-ed-sheet:focus-within { border-color: var(--sb-accent, var(--color-accent)); }
			.sb-ed-sheet > .sb-ed-bar { padding: 6px 8px; border-bottom: 1px solid var(--fill-quinary); }
			.sb-ed-sheet > .sb-cite, .sb-ed-sheet > .sb-ed-conflict { margin: 8px 8px 0; }
			.sb-ed.is-tab .sb-ed-sheet { border-radius: 12px; }

			/* focus: only the note is left in the item pane */
			item-details.sb-focus .zotero-view-item > [data-pane]:not([data-pane=${doc.defaultView.CSS.escape(this.paneID)}]) { display: none !important; }
			item-details.sb-focus .sb-related { display: none; }

			/* closeness of a similar paper or note */
			.sb-close { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
			.sb-close-dots { display: flex; gap: 2px; }
			.sb-close-dots > span { width: 6px; height: 6px; border-radius: 50%; background: var(--fill-quinary); }
			.sb-close.is-5 .is-on, .sb-close.is-4 .is-on { background: var(--accent-green, #3a9d4a); }
			.sb-close.is-3 .is-on { background: var(--accent-blue); }
			.sb-close.is-2 .is-on, .sb-close.is-1 .is-on { background: var(--fill-tertiary); }
			.sb-close-label { font-size: 10px; color: var(--fill-secondary); white-space: nowrap; }
			.sb-hl-image img { max-width: 100%; border-radius: 4px; display: block; }
			.sb-hl.is-quoted .sb-hl-quote { opacity: 1; color: var(--accent-green, #3a9d4a); }

			/* rendered Markdown, close to Obsidian's reading view */
			.sb-md { font-size: 13.5px; line-height: 1.6; overflow-wrap: anywhere; min-width: 0; }
			.sb-md > :first-child { margin-top: 0; }
			.sb-md > :last-child { margin-bottom: 0; }
			.sb-md p { margin: 0 0 .6em; }
			.sb-md h1, .sb-md h2, .sb-md h3, .sb-md h4 { margin: .9em 0 .35em; line-height: 1.3; font-weight: 600; }
			.sb-md h1 { font-size: 1.3em; } .sb-md h2 { font-size: 1.15em; } .sb-md h3, .sb-md h4 { font-size: 1em; }
			.sb-md ul, .sb-md ol { margin: 0 0 .6em; padding-inline-start: 1.4em; }
			.sb-md li { margin: .15em 0; }
			.sb-md blockquote { margin: 0 0 .6em; padding-left: 10px; border-left: 3px solid var(--fill-quinary); color: var(--fill-secondary); }
			.sb-md code { font: 12px ui-monospace, Menlo, monospace; padding: 1px 4px; border-radius: 4px; background: var(--fill-quinary); }
			.sb-md pre { padding: 8px 10px; border-radius: 6px; background: var(--fill-quinary); overflow-x: auto; }
			.sb-md pre code { padding: 0; background: none; }
			.sb-md table { border-collapse: collapse; margin: 0 0 .6em; }
			.sb-md th, .sb-md td { border: 1px solid var(--fill-quinary); padding: 3px 7px; }
			.sb-md a, .sb-md .cite { color: var(--accent-blue); cursor: pointer; text-decoration: none; }
			.sb-md a:hover, .sb-md .cite:hover { text-decoration: underline; }
			.sb-md .cite.missing { color: var(--accent-red, #d33); cursor: default; text-decoration: none; }
			.sb-md .wikilink { color: var(--accent-purple, #8a63d2); }
			.sb-md-empty { color: var(--fill-tertiary); font-style: italic; }
			.sb-md-raw { white-space: pre-wrap; font: inherit; margin: 0; }

			/* citation search and "[@" suggestions share one row design */
			.sb-cite { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 8px;
				border: 1px solid var(--fill-quinary); background: var(--material-background); box-shadow: 0 4px 14px rgba(0,0,0,.18); }
			.sb-cite-input { font: inherit; font-size: 13px; padding: 5px 8px; border-radius: 5px; border: 1px solid var(--fill-quinary);
				background: transparent; color: inherit; }
			.sb-cite-input:focus { outline: 2px solid var(--color-accent); outline-offset: -1px; }
			.sb-cite-list { display: flex; flex-direction: column; max-height: 240px; overflow-y: auto; }
			.sb-pick { display: flex; align-items: center; gap: 8px; padding: 5px 7px; border-radius: 5px; cursor: pointer; min-width: 0; }
			.sb-pick.is-active { background: var(--fill-quinary); }
			.sb-pick-main { flex: 1; min-width: 0; }
			.sb-pick-title { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.sb-pick-meta { font-size: 11px; color: var(--fill-secondary); }
			.sb-pick-key { flex: none; font: 10px ui-monospace, Menlo, monospace; color: var(--fill-tertiary); }
			.sb-pick-hint { font-size: 11px; color: var(--fill-tertiary); padding: 4px 7px; }

			.sb-ed-conflict { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px; border-radius: 6px;
				font-size: 12px; background: color-mix(in srgb, var(--accent-orange, orange) 18%, transparent); }
			.sb-note-card { padding: 2px 0 4px; }
			.sb-doc-section:empty { display: none; }
			.sb-doc-section { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid var(--fill-quinary); }
			.sb-doc-head { display: flex; align-items: baseline; font-size: 11px; font-weight: 600; text-transform: uppercase;
				letter-spacing: .04em; color: var(--fill-secondary); }
			.sb-hl { position: relative; padding: 6px 10px 5px 12px; border-radius: 6px; cursor: pointer;
				background: color-mix(in srgb, var(--hl) 13%, transparent); box-shadow: inset 3px 0 0 var(--hl); }
			.sb-hl:hover { background: color-mix(in srgb, var(--hl) 22%, transparent); }
			.sb-hl-text { font-size: 12.5px; line-height: 1.5; }
			.sb-hl-text.is-image { font-style: italic; color: var(--fill-secondary); }
			.sb-hl-comment { margin-top: 4px; font-size: 12px; color: var(--fill-secondary); }
			.sb-hl-comment::before { content: "💬 "; }
			.sb-hl-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 3px; font-size: 10.5px; color: var(--fill-tertiary); }
			.sb-hl-quote { font: inherit; border: none; background: none; color: var(--accent-blue); cursor: pointer; padding: 0; opacity: 0; }
			.sb-hl:hover .sb-hl-quote { opacity: 1; }
			.sb-znote { padding: 6px 10px; border-radius: 6px; background: color-mix(in srgb, var(--fill-quinary) 60%, transparent); font-size: 12.5px; }
			.sb-ref { display: flex; gap: 8px; align-items: baseline; padding: 3px 4px; border-radius: 5px; cursor: pointer; min-width: 0; }
			.sb-ref:hover { background: var(--fill-quinary); }
			.sb-ref-label { flex: none; font-size: 12px; color: var(--accent-blue); }
			.sb-ref-title { font-size: 12px; color: var(--fill-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.sb-ref.is-missing .sb-ref-label { color: var(--accent-red, #d33); }
			.sb-ref.is-missing { cursor: default; }

			/* the note tab: one centred column, like a document */
			tab-content:has(> .sb-note-scroll) { display: flex; }
			.sb-note-scroll { flex: 1; overflow-y: auto; height: 100%; }
			.sb-note-page { max-width: 760px; margin: 0 auto; padding: 32px 36px 80px; display: flex; flex-direction: column; gap: 16px; }
			.sb-note-kicker { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--fill-secondary); }
			.sb-note-title { margin: 4px 0 2px; font-size: 24px; font-weight: 650; line-height: 1.25; }
			.sb-ed.is-tab { gap: 12px; }
			.sb-ed.is-tab .sb-hl-text { font-size: 14px; }
			.sb-tb-input { width: 220px; margin-inline: 6px 2px; padding: 3px 8px; border-radius: 5px;
				border: 1px solid var(--fill-quinary); background: var(--material-background); color: inherit; font: inherit; }
			.sb-tb-input:focus { outline: 2px solid var(--color-accent); outline-offset: -1px; }
			#second-brain-tb-results { --panel-padding: 4px; }
			.sb-tb-list { width: 460px; max-height: 480px; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
			.sb-tb-row { align-items: flex-start; }
			.sb-tb-row .sb-badge { margin-top: 2px; }
			.sb-tb-row.is-active { background: var(--fill-quinary); }
			.sb-snippet { grid-column: 1 / -1; font-size: 11px; color: var(--fill-secondary); overflow: hidden;
				display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; margin-top: 2px; }
			.sb-tb-foot { padding: 4px 6px 2px; font-size: 11px; }
		`;
		doc.documentElement.append(style);
	},
};
