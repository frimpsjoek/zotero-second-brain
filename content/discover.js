/* global Zotero, SecondBrain */
// Papers that aren't in the library yet: search OpenAlex by meaning (keywords, then Semantic Scholar, as
// fallbacks), or list what's around a paper (similar papers, the papers that cite it, its references), mark the
// ones already in the library, and add the others with Zotero's own DOI/arXiv lookup.

SecondBrain.Discover = class {
	static FIELDS = "id,doi,ids,display_name,publication_year,authorships,primary_location,cited_by_count,best_oa_location,type,abstract_inverted_index,related_works,referenced_works";

	constructor(sb) {
		this.sb = sb;
	}

	// ------------------------------------------------------------------ searching

	/** OpenAlex's meaning-based search (a question or a topic in your own words works), then its keyword search,
	 *  then Semantic Scholar's. */
	async search(query, limit = 25) {
		try {
			return this.mark(await this.semantic(query, limit));
		} catch (error) {
			Zotero.logError(error);
		}
		try {
			const data = await this.openAlex(`/works?search=${encodeURIComponent(query)}&per_page=${limit}&select=${SecondBrain.Discover.FIELDS}`);
			return this.mark(data.results.map((work) => this.fromOpenAlex(work)));
		} catch (error) {
			Zotero.logError(error);
			const data = await this.sb.json(`https://api.semanticscholar.org/graph/v1/paper/search?limit=${limit}&query=${encodeURIComponent(query)}&fields=title,year,authors,venue,externalIds,citationCount,openAccessPdf,abstract`);
			return this.mark((data?.data ?? []).map((paper) => this.fromSemanticScholar(paper)));
		}
	}

	async semantic(text, limit) {
		const data = await this.openAlex(`/works?search.semantic=${encodeURIComponent(text.slice(0, 1200))}&per_page=${limit}&select=${SecondBrain.Discover.FIELDS}`);
		if (!data.results?.length) throw new Error("no semantic results");
		return data.results.map((work) => this.fromOpenAlex(work));
	}

	/** Papers like this one (OpenAlex's meaning-based search on its title and abstract), the papers citing it,
	 *  and its references. OpenAlex's own "related works" list proved too loose to show. */
	async related(item) {
		const work = await this.findWork(item);
		if (!work) return null;
		const ids = (list, n) => (list ?? []).slice(0, n).map((url) => url.split("/").pop());
		const about = `${item.getField("title")}. ${item.getField("abstractNote") || (work.abstract_inverted_index ? this.unInvert(work.abstract_inverted_index) : "")}`;
		const [related, references, citing] = await Promise.all([
			this.semantic(about, 21).then((list) => list.filter((r) => r.id !== work.id).slice(0, 20)).catch(() => []),
			this.works(ids(work.referenced_works, 50)),
			this.openAlex(`/works?filter=cites:${work.id.split("/").pop()}&sort=cited_by_count:desc&per_page=20&select=${SecondBrain.Discover.FIELDS}`)
				.then((data) => data.results.map((w) => this.fromOpenAlex(w))),
		]);
		references.sort((a, b) => b.cites - a.cites);
		return {
			work: this.fromOpenAlex(work),
			groups: [
				["Similar papers", await this.mark(related)],
				["Cites this paper", await this.mark(citing)],
				["In its references", await this.mark(references)],
			],
		};
	}

	async findWork(item) {
		const doi = this.doiOf(item);
		if (doi) {
			try {
				return await this.openAlex(`/works/doi:${encodeURIComponent(doi)}?select=${SecondBrain.Discover.FIELDS}`);
			} catch (error) { /* not in OpenAlex by DOI; try the title */ }
		}
		const title = this.sb.normalizeTitle(item.getField("title"));
		const data = await this.openAlex(`/works?filter=title.search:${encodeURIComponent(title)}&per_page=1&select=${SecondBrain.Discover.FIELDS}`);
		const work = data.results[0];
		return work && !this.sb.titlesDiffer(item, work.display_name) ? work : null;
	}

	async works(ids) {
		if (!ids.length) return [];
		const data = await this.openAlex(`/works?filter=openalex:${ids.join("|")}&per_page=${ids.length}&select=${SecondBrain.Discover.FIELDS}`);
		return data.results.map((work) => this.fromOpenAlex(work));
	}

	async openAlex(path) {
		const url = `https://api.openalex.org${path}`;
		const response = await Zotero.HTTP.request("GET", url + this.sb.openAlexAuth(url.includes("?") ? "&" : "?"), {
			responseType: "json", timeout: 20000, successCodes: false,
		});
		if (response.status !== 200 || !response.response) {
			throw new Error(response.response?.message || response.response?.error || `OpenAlex: HTTP ${response.status}`);
		}
		return response.response;
	}

	// ------------------------------------------------------------------ one shape for both services

	fromOpenAlex(work) {
		const abstract = work.abstract_inverted_index ? this.unInvert(work.abstract_inverted_index) : "";
		const arxiv = /arxiv\.org\/abs\/([^\s?#v]+)/i.exec(work.primary_location?.landing_page_url ?? "")?.[1]
			?? (work.ids?.arxiv ? String(work.ids.arxiv).split("/").pop() : null);
		return {
			id: work.id,
			doi: (work.doi ?? "").replace(/^https?:\/\/doi\.org\//i, "") || null,
			arxiv,
			title: work.display_name ?? "",
			authors: (work.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean),
			year: work.publication_year ?? "",
			venue: work.primary_location?.source?.display_name ?? "",
			cites: work.cited_by_count ?? 0,
			pdf: work.best_oa_location?.pdf_url ?? null,
			type: work.type ?? "article",
			abstract,
		};
	}

	fromSemanticScholar(paper) {
		return {
			id: paper.paperId,
			doi: paper.externalIds?.DOI ?? null,
			arxiv: paper.externalIds?.ArXiv ?? null,
			title: paper.title ?? "",
			authors: (paper.authors ?? []).map((a) => a.name),
			year: paper.year ?? "",
			venue: paper.venue ?? "",
			cites: paper.citationCount ?? 0,
			pdf: paper.openAccessPdf?.url ?? null,
			type: "article",
			abstract: paper.abstract ?? "",
		};
	}

	unInvert(index) {
		const words = [];
		for (const [word, positions] of Object.entries(index)) for (const at of positions) words[at] = word;
		return words.filter(Boolean).join(" ");
	}

	// ------------------------------------------------------------------ what's already in the library

	doiOf(item) {
		return (item.getField("DOI") || item.getExtraField?.("DOI") || "").replace(/^https?:\/\/doi\.org\//i, "").toLowerCase() || null;
	}

	/** DOIs and normalized titles of the library, read once and kept up to date as papers are added here. */
	async libraryIndex() {
		if (this.known) return this.known;
		const known = { dois: new Map(), titles: new Map() };
		const items = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).filter((item) => item.isRegularItem() && !item.deleted);
		await Zotero.Items.loadDataTypes(items, ["itemData"]);
		for (const item of items) this.remember(known, item);
		this.known = known;
		return known;
	}

	remember(known, item) {
		const doi = this.doiOf(item);
		if (doi) known.dois.set(doi, item.key);
		known.titles.set(this.sb.normalizeTitle(item.getField("title")), item.key);
	}

	async mark(results) {
		const known = await this.libraryIndex();
		for (const r of results) {
			r.key = (r.doi && known.dois.get(r.doi.toLowerCase())) || known.titles.get(this.sb.normalizeTitle(r.title)) || null;
		}
		return results;
	}

	// ------------------------------------------------------------------ adding

	/** Save a paper to the library (and the selected collection), filled in by Zotero's DOI or arXiv lookup when
	 *  possible, then attach a free PDF if one is known. Returns the new item. */
	async add(result) {
		const pane = Zotero.getActiveZoteroPane();
		const libraryID = Zotero.Libraries.userLibraryID;
		const collection = pane?.getSelectedCollection?.();
		const collections = collection && collection.libraryID === libraryID ? [collection.id] : [];
		let item = null;
		for (const identifier of [result.doi && { DOI: result.doi }, result.arxiv && { arXiv: result.arxiv }].filter(Boolean)) {
			try {
				const translate = new Zotero.Translate.Search();
				translate.setIdentifier(identifier);
				const translators = await translate.getTranslators();
				if (!translators.length) continue;
				translate.setTranslator(translators);
				[item] = await translate.translate({ libraryID, collections, saveAttachments: false });
				if (item) break;
			} catch (error) {
				Zotero.logError(error);
			}
		}
		if (!item) item = await this.create(result, collections);
		if (result.pdf && !(await this.sb.hasWorkingPDF(item))) {
			await this.sb.attachPDF(item, result.pdf, "Open Access PDF").catch((error) => Zotero.logError(error));
		}
		if (this.known) this.remember(this.known, item);
		return item;
	}

	/** Without a DOI or arXiv ID Zotero can look up, build the item from what the search returned. */
	async create(result, collections) {
		const item = new Zotero.Item(result.type === "book" ? "book" : "journalArticle");
		item.libraryID = Zotero.Libraries.userLibraryID;
		item.setField("title", result.title);
		if (result.year) item.setField("date", String(result.year));
		if (result.venue && item.itemType === "journalArticle") item.setField("publicationTitle", result.venue);
		if (result.doi && item.itemType === "journalArticle") item.setField("DOI", result.doi);
		if (result.abstract) item.setField("abstractNote", result.abstract);
		item.setCreators(result.authors.slice(0, 50).map((name) => {
			const parts = name.trim().split(/\s+/);
			return { creatorType: "author", lastName: parts.pop(), firstName: parts.join(" ") };
		}));
		item.setCollections(collections);
		await item.saveTx();
		return item;
	}
};
