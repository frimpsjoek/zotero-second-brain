/* Second Brain for Zotero: notes on each paper, similar papers and search by meaning, and free-PDF finding.
   Works on its own; when the optional Second Brain server runs (127.0.0.1:27182 by default) notes sync with an
   Obsidian vault and search covers the vault too. */

var SecondBrain;
var chromeHandle;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
	Services.scriptloader.loadSubScript(rootURI + "content/second-brain.js");
	Services.scriptloader.loadSubScript(rootURI + "content/editor.js");
	Services.scriptloader.loadSubScript(rootURI + "content/store.js");
	Services.scriptloader.loadSubScript(rootURI + "content/local-index.js");
	// chrome://second-brain/content/... for the search window
	const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
	const manifestURI = Services.io.newURI(rootURI + "manifest.json");
	chromeHandle = aomStartup.registerChrome(manifestURI, [["content", "second-brain", rootURI + "content/"]]);
	SecondBrain.init({ id, version, rootURI });
	for (const win of Zotero.getMainWindows()) SecondBrain.addToWindow(win);
}

function onMainWindowLoad({ window }) {
	SecondBrain?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	SecondBrain?.removeFromWindow(window);
}

function shutdown() {
	SecondBrain?.shutdown();
	SecondBrain = undefined;
	chromeHandle?.destruct();
	chromeHandle = null;
}
