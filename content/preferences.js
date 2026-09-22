/* global Zotero, Components */
// Second Brain's settings pane (Zotero Settings → Second Brain).

var SecondBrainPrefs = {
	COLORS: [
		["background", "Writing background"],
		["text", "Text"],
		["accent", "Links, cursor and focus ring"],
		["highlight", "Highlighted text (==…==)"],
	],

	pref(name) { return Zotero.Prefs.get(`extensions.secondbrain.${name}`, true); },
	set(name, value) {
		if (value === "" || value === undefined) Zotero.Prefs.clear(`extensions.secondbrain.${name}`, true);
		else Zotero.Prefs.set(`extensions.secondbrain.${name}`, value, true);
	},

	init(root) {
		const doc = root.ownerDocument;
		const $ = (id) => doc.getElementById(id);
		const html = (tag, props = {}) => Object.assign(doc.createElementNS("http://www.w3.org/1999/xhtml", tag), props);

		const notesIn = $("sb-notes-in");
		notesIn.value = this.pref("notesIn") || "auto";
		notesIn.addEventListener("command", () => this.set("notesIn", notesIn.value === "auto" ? "" : notesIn.value));

		const folder = $("sb-notes-folder");
		const defaultFolder = PathUtils.join(Zotero.DataDirectory.dir, "second-brain", "notes");
		const showFolder = () => { folder.value = this.pref("notesFolder") || defaultFolder; };
		showFolder();
		$("sb-notes-choose").addEventListener("command", async () => {
			const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
			const picker = new FilePicker();
			picker.init(doc.defaultView, "Folder for paper notes", picker.modeGetFolder);
			if (await picker.show() !== picker.returnOK) return;
			this.set("notesFolder", picker.file);
			showFolder();
		});
		$("sb-notes-reveal").addEventListener("command", async () => {
			await IOUtils.makeDirectory(folder.value, { createAncestors: true });
			Zotero.File.reveal(folder.value);
		});

		const grid = $("sb-colors");
		grid.replaceChildren();
		for (const [name, label] of this.COLORS) {
			const key = `color.${name}`;
			const input = html("input", { type: "color", value: this.pref(key) || this.zoteroColor(doc, name) });
			const reset = html("button", { textContent: "Use Zotero's" });
			const mark = () => { reset.disabled = !this.pref(key); input.classList.toggle("is-default", !this.pref(key)); };
			input.addEventListener("input", () => { this.set(key, input.value); mark(); });
			reset.addEventListener("click", () => { this.set(key, ""); input.value = this.zoteroColor(doc, name); mark(); });
			mark();
			grid.append(html("label", { textContent: label }), input, reset);
		}

		for (const [id, name] of [["sb-email", "email"], ["sb-openalex-key", "openalexKey"], ["sb-vault", "vault"]]) {
			const input = $(id);
			input.value = this.pref(name) || "";
			input.addEventListener("change", () => this.set(name, input.value.trim()));
		}

		const index = Zotero.SecondBrain?.localIndex;
		const state = $("sb-model-state");
		const download = $("sb-model-download");
		const remove = $("sb-model-remove");
		const show = (name, detail) => {
			const busy = ["downloading", "loading", "indexing"].includes(name);
			state.textContent = {
				absent: "Not downloaded",
				downloading: `Downloading… ${detail}`,
				loading: "Starting…",
				indexing: `Reading your library… ${detail}`,
				ready: `Ready · ${detail}`,
				error: `Didn't work: ${detail}`,
			}[name] ?? name;
			download.hidden = !["absent", "error"].includes(name);
			download.label = name === "error" ? "Try again" : "Download";
			remove.hidden = name === "absent" || busy;
		};
		if (index) {
			show(index.state, index.detail);
			index.listeners.add(show);
			doc.defaultView.addEventListener("unload", () => index.listeners.delete(show));
			download.addEventListener("command", () => index.download());
			remove.addEventListener("command", () => index.remove());
		} else {
			state.textContent = "Second Brain isn't loaded";
			download.hidden = remove.hidden = true;
		}

		const server = $("sb-server");
		server.value = this.pref("server") || "http://127.0.0.1:27182";
		server.addEventListener("change", () => {
			const value = server.value.trim().replace(/\/+$/, "");
			this.set("server", value === "http://127.0.0.1:27182" ? "" : value);
			this.check(doc);
		});
		this.check(doc);
	},

	/** A color input can't be empty, so it starts at the color Zotero is using right now. */
	zoteroColor(doc, name) {
		const style = doc.defaultView.getComputedStyle(doc.documentElement);
		const raw = {
			background: style.getPropertyValue("--material-background"),
			text: style.color,
			accent: style.getPropertyValue("--color-accent") || style.getPropertyValue("--accent-blue"),
			highlight: "#ffd400",
		}[name].trim();
		const probe = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
		probe.style.color = raw;
		doc.documentElement.append(probe);
		const rgb = doc.defaultView.getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number) ?? [128, 128, 128];
		probe.remove();
		return "#" + rgb.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
	},

	async check(doc) {
		const state = doc.getElementById("sb-server-state");
		const base = (this.pref("server") || "http://127.0.0.1:27182").replace(/\/+$/, "");
		state.textContent = "Checking…";
		try {
			const response = await Zotero.HTTP.request("GET", `${base}/ping`, { timeout: 3000, successCodes: false });
			state.textContent = response.status === 200 ? "Connected ✓"
				: response.status ? `Not available (HTTP ${response.status})` : "Not running · notes are kept in the folder above";
		} catch (error) {
			state.textContent = "Not running · notes are kept in the folder above";
		}
	},
};

// Zotero may load this script before or after it inserts the pane, so set up whenever both are there.
(function setUp(tries = 0) {
	const root = document.getElementById("second-brain-prefs");
	if (root && !root.dataset.ready) {
		root.dataset.ready = "1";
		SecondBrainPrefs.init(root);
	} else if (!root && tries < 100) {
		setTimeout(() => setUp(tries + 1), 100);
	}
})();
