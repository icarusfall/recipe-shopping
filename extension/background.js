const APP_ORIGIN = "http://localhost:3000";

// Per-store config. titleSelectors and addButtonTexts are passed into the
// injected page scripts, so they must stay JSON-serialisable (no functions).
const STORES = {
  tesco: {
    name: "Tesco",
    search: "https://www.tesco.com/groceries/en-GB/search?query=",
    titleSelectors: [
      'a[data-auto="product-tile--title"]',
      'h3 a',
      '[class*="product-tile"] a[href*="/products/"]',
      '[class*="ProductTile"] a',
      'a[href*="/products/"]',
    ],
    addButtonTexts: ["add", "add to basket"],
  },
  waitrose: {
    name: "Waitrose",
    search: "https://www.waitrose.com/ecom/shop/search?searchTerm=",
    titleSelectors: [
      'a[href*="/ecom/products/"]',
      '[class*="podHeader"] a',
      '[class*="productPod"] a[href*="/products/"]',
      'h2 a',
      'h3 a',
    ],
    addButtonTexts: ["add to trolley", "add"],
  },
};

let appTabId = null;
let storeTabId = null;
let store = STORES.tesco;
let items = [];
let currentIndex = 0;
let recipeName = "";
let allIngredients = "";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_ADDING") {
    appTabId = sender.tab.id;
    store = STORES[msg.store] || STORES.tesco;
    items = msg.items;
    recipeName = msg.recipeName || "";
    allIngredients = msg.allIngredients || "";
    currentIndex = 0;
    sendProgress(`Starting ${store.name} order...`);
    startAdding();
  }

  if (msg.type === "SCRAPE_RESULT") {
    handleScrapeResult(msg.products, msg.item);
  }

  if (msg.type === "ADD_RESULT") {
    handleAddResult(msg.success, msg.item);
  }
});

function sendProgress(text) {
  if (appTabId) {
    chrome.tabs.sendMessage(appTabId, { type: "PROGRESS", text });
  }
}

async function startAdding() {
  if (currentIndex >= items.length) {
    sendProgress(`Done! All items processed for ${store.name}.`);
    if (storeTabId) {
      chrome.tabs.update(storeTabId, { active: true });
    }
    return;
  }

  const item = items[currentIndex];
  const query = encodeURIComponent(item);
  const url = store.search + query;

  sendProgress(`Searching ${currentIndex + 1}/${items.length}: ${item}`);

  if (!storeTabId) {
    const tab = await chrome.tabs.create({ url, active: false });
    storeTabId = tab.id;
    chrome.tabs.onRemoved.addListener(function onRemoved(tabId) {
      if (tabId === storeTabId) {
        storeTabId = null;
        chrome.tabs.onRemoved.removeListener(onRemoved);
      }
    });
  } else {
    await chrome.tabs.update(storeTabId, { url });
  }

  // Phase 1: Wait for page load, then scrape product names
  waitForPageLoad(storeTabId, () => {
    chrome.scripting.executeScript({
      target: { tabId: storeTabId },
      func: scrapeProductNames,
      args: [item, store.titleSelectors],
    });
  });
}

function waitForPageLoad(tabId, callback) {
  function listener(updatedTabId, changeInfo) {
    if (updatedTabId === tabId && changeInfo.status === "complete") {
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(callback, 2000);
    }
  }
  chrome.tabs.onUpdated.addListener(listener);
}

// Injected into the store page - Phase 1: scrape product names
function scrapeProductNames(itemName, titleSelectors) {
  function isSponsored(el) {
    let node = el;
    for (let i = 0; i < 10 && node; i++) {
      const cls = node.className || "";
      const attrs = node.outerHTML ? node.outerHTML.substring(0, 500) : "";
      if (/sponsored|promoted|ad\b/i.test(cls) || /sponsored|promoted/i.test(attrs)) return true;
      const labels = node.querySelectorAll ? node.querySelectorAll("span, div, p") : [];
      for (const lbl of labels) {
        if (/^sponsored$/i.test(lbl.textContent.trim())) return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  // Find product tiles using the store's title selectors
  const products = [];
  const seen = new Set();

  for (const sel of titleSelectors) {
    document.querySelectorAll(sel).forEach(el => {
      const name = el.textContent.trim();
      if (name && !seen.has(name) && !isSponsored(el)) {
        seen.add(name);
        products.push(name);
      }
    });
    if (products.length >= 8) break;
  }

  // Fallback: grab any heading-ish text near add buttons
  if (products.length === 0) {
    document.querySelectorAll("button").forEach(btn => {
      const text = btn.textContent.trim().toLowerCase();
      if (text === "add" || text === "add to basket" || text === "add to trolley") {
        // Walk up to find the product container and its title
        let node = btn.parentElement;
        for (let i = 0; i < 8 && node; i++) {
          const heading = node.querySelector("h2, h3, a[href*='/products/']");
          if (heading) {
            const name = heading.textContent.trim();
            if (name && !seen.has(name) && !isSponsored(btn)) {
              seen.add(name);
              products.push(name);
            }
            break;
          }
          node = node.parentElement;
        }
      }
    });
  }

  chrome.runtime.sendMessage({
    type: "SCRAPE_RESULT",
    products: products.slice(0, 8),
    item: itemName,
  });
}

// Phase 2: Ask Claude to pick the best product, then click it
async function handleScrapeResult(products, item) {
  if (!products || products.length === 0) {
    sendProgress(`No products found for: ${item} (${currentIndex + 1}/${items.length}) - skipping`);
    currentIndex++;
    setTimeout(() => startAdding(), 500);
    return;
  }

  // If only one non-sponsored product, just pick it
  let bestIndex = 0;

  if (products.length > 1) {
    sendProgress(`Picking best match ${currentIndex + 1}/${items.length}: ${item}...`);
    try {
      const res = await fetch(`${APP_ORIGIN}/api/pick-product`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ingredient: item, products, recipeName, allIngredients }),
      });
      const data = await res.json();
      bestIndex = data.index;
      if (bestIndex < 0 || bestIndex >= products.length) bestIndex = 0;
    } catch (err) {
      console.error("Failed to call pick-product API:", err);
      bestIndex = 0;
    }
  }

  sendProgress(`Adding ${currentIndex + 1}/${items.length}: ${products[bestIndex]}`);

  // Phase 3: Inject script to click the correct product's Add button
  chrome.scripting.executeScript({
    target: { tabId: storeTabId },
    func: addProductByIndex,
    args: [bestIndex, item, store.addButtonTexts],
  });
}

// Injected into the store page - Phase 3: click Add on the chosen product
function addProductByIndex(targetIndex, itemName, addButtonTexts) {
  function isSponsored(el) {
    let node = el;
    for (let i = 0; i < 10 && node; i++) {
      const cls = node.className || "";
      const attrs = node.outerHTML ? node.outerHTML.substring(0, 500) : "";
      if (/sponsored|promoted|ad\b/i.test(cls) || /sponsored|promoted/i.test(attrs)) return true;
      const labels = node.querySelectorAll ? node.querySelectorAll("span, div, p") : [];
      for (const lbl of labels) {
        if (/^sponsored$/i.test(lbl.textContent.trim())) return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  // Find product containers with Add buttons, skipping sponsored
  const addButtons = [];
  const allButtons = document.querySelectorAll("button");

  for (const btn of allButtons) {
    const text = btn.textContent.trim().toLowerCase();
    const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
    const isAdd = addButtonTexts.includes(text) ||
                  ariaLabel.includes("add") ||
                  btn.getAttribute("data-auto") === "btnAddToBasket";

    if (isAdd && !isSponsored(btn)) {
      addButtons.push(btn);
    }
  }

  const button = addButtons[targetIndex] || addButtons[0];

  if (button) {
    button.click();
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "ADD_RESULT", success: true, item: itemName });
    }, 1500);
  } else {
    chrome.runtime.sendMessage({ type: "ADD_RESULT", success: false, item: itemName });
  }
}

function handleAddResult(success, item) {
  if (success) {
    sendProgress(`Added: ${item} (${currentIndex + 1}/${items.length})`);
  } else {
    sendProgress(`Could not add: ${item} (${currentIndex + 1}/${items.length}) - skipping`);
  }

  currentIndex++;
  setTimeout(() => startAdding(), 1000);
}
