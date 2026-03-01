// Content script running on localhost:3000
// Bridges the web app and the background service worker

// Mark that the extension is installed
document.documentElement.setAttribute("data-tesco-extension", "true");

// Listen for the app's custom event
document.addEventListener("tesco-add-to-basket", (e) => {
  const { items, recipeName, allIngredients } = e.detail;
  if (!items || items.length === 0) return;

  chrome.runtime.sendMessage({ type: "START_ADDING", items, recipeName, allIngredients });
});

// Receive progress updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PROGRESS") {
    document.dispatchEvent(
      new CustomEvent("tesco-progress", { detail: { text: msg.text } })
    );
  }
});
