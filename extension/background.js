const APP_ORIGIN = "http://localhost:3000";

// Per-store config. Everything in here is passed into injected page scripts,
// so it must stay JSON-serialisable (no functions).
//   tileSelector   - one element per product (optional; otherwise we walk up
//                    from each Add button to the smallest container holding it)
//   addSelector    - the "add to basket/trolley" button inside a tile
//   nameAttr       - attribute on the tile holding the clean product name
//   sponsoredSelector - tiles matching this are paid placements
const STORES = {
  tesco: {
    name: "Tesco",
    search: "https://www.tesco.com/groceries/en-GB/search?query=",
    tileSelector: null,
    addSelector: 'button[data-auto="btnAddToBasket"], button[type="submit"]',
    addTexts: ["add", "add to basket"],
    nameSelector: 'a[href*="/products/"]',
    nameAttr: null,
    sponsoredSelector: '[data-auto*="sponsored" i], [class*="sponsored" i]',
  },
  waitrose: {
    name: "Waitrose",
    search: "https://www.waitrose.com/ecom/shop/search?searchTerm=",
    tileSelector: 'article[data-testid="product-pod"]',
    addSelector: 'button[data-testid="addButton"]',
    addTexts: ["add", "add to trolley"],
    nameSelector: '[data-testid="product-pod-name"], a[href*="/ecom/products/"]',
    nameAttr: "data-product-name",
    sponsoredSelector: '[data-product-pod-type="sponsored"]',
  },
};

const MAX_PRODUCTS = 12;

let appTabId = null;
let storeTabId = null;
let running = false;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "START_ADDING") {
    if (running) {
      sendProgress("Already adding items — please wait for the current run to finish.", sender.tab.id);
      return;
    }
    appTabId = sender.tab.id;
    const store = STORES[msg.store] || STORES.tesco;
    runOrder(store, msg.items, msg.recipeName || "", msg.allIngredients || "");
  }
});

function sendProgress(text, tabId = appTabId) {
  if (tabId) chrome.tabs.sendMessage(tabId, { type: "PROGRESS", text });
}

async function runOrder(store, items, recipeName, allIngredients) {
  running = true;
  sendProgress(`Starting ${store.name} order...`);
  const skipped = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const pos = `${i + 1}/${items.length}`;
      try {
        const added = await addItem(store, item, pos, recipeName, allIngredients);
        if (!added) skipped.push(item);
      } catch (err) {
        console.error(`Failed on ${item}:`, err);
        sendProgress(`Problem with ${item} (${pos}) - skipping`);
        skipped.push(item);
      }
      await sleep(800);
    }
    sendProgress(
      skipped.length
        ? `Done! Skipped ${skipped.length}: ${skipped.join(", ")} — add these by hand.`
        : `Done! All items added to your ${store.name} basket.`
    );
    if (storeTabId) chrome.tabs.update(storeTabId, { active: true });
  } finally {
    running = false;
  }
}

async function addItem(store, item, pos, recipeName, allIngredients) {
  sendProgress(`Searching ${pos}: ${item}`);
  await openSearch(store.search + encodeURIComponent(item));

  // Phase 1: scrape non-sponsored product tiles (waits for results to render)
  const [{ result: products }] = await chrome.scripting.executeScript({
    target: { tabId: storeTabId },
    func: scrapeProducts,
    args: [store, MAX_PRODUCTS],
  });

  if (!products || products.length === 0) {
    sendProgress(`No products found for: ${item} (${pos}) - skipping`);
    return false;
  }

  // Phase 2: ask Claude which product best fits the recipe
  let pick = { index: 0, reason: "" };
  if (products.length > 1) {
    sendProgress(`Picking best match ${pos}: ${item}...`);
    try {
      const res = await fetch(`${APP_ORIGIN}/api/pick-product`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ingredient: item,
          products: products.map(({ name, details }) => ({ name, details })),
          recipeName,
          allIngredients,
          storeName: store.name,
        }),
      });
      pick = await res.json();
    } catch (err) {
      console.error("Failed to call pick-product API:", err);
    }
  }

  if (pick.index === -1) {
    sendProgress(`No good match for ${item} (${pos}) - skipping. ${pick.reason || ""}`);
    return false;
  }
  const chosen = products[pick.index] || products[0];
  sendProgress(`Adding ${pos}: ${chosen.name}${pick.reason ? ` — ${pick.reason}` : ""}`);

  // Phase 3: click the Add button we tagged on that exact tile
  const [{ result: clicked }] = await chrome.scripting.executeScript({
    target: { tabId: storeTabId },
    func: clickTaggedButton,
    args: [chosen.pickId],
  });

  if (!clicked) {
    sendProgress(`Could not add: ${item} (${pos}) - skipping`);
    return false;
  }
  await sleep(1500); // let the basket update before navigating away
  sendProgress(`Added: ${chosen.name} (${pos})`);
  return true;
}

async function openSearch(url) {
  if (storeTabId) {
    try {
      await chrome.tabs.get(storeTabId);
    } catch {
      storeTabId = null; // user closed the tab
    }
  }
  const loaded = storeTabId ? waitForPageLoad(storeTabId) : null;
  if (!storeTabId) {
    const tab = await chrome.tabs.create({ url, active: false });
    storeTabId = tab.id;
    await waitForPageLoad(storeTabId);
  } else {
    await chrome.tabs.update(storeTabId, { url });
    await loaded;
  }
}

function waitForPageLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") done();
    }
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Injected into the store page. Finds product tiles in page order, drops
// sponsored and unavailable ones, and tags each kept tile's Add button with
// data-recipe-pick so phase 3 clicks exactly the product Claude chose.
async function scrapeProducts(cfg, maxProducts) {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  function isAddButton(btn) {
    if (!btn.matches(cfg.addSelector)) return false;
    if (btn.getAttribute("data-auto") === "btnAddToBasket" || btn.getAttribute("data-testid") === "addButton") return true;
    const text = clean(btn.textContent).toLowerCase();
    const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (/favourite|list|wishlist/.test(aria)) return false;
    return cfg.addTexts.includes(text) || /^add\b/.test(aria);
  }

  function findTiles() {
    if (cfg.tileSelector) return [...document.querySelectorAll(cfg.tileSelector)];
    // Walk up from each Add button to the largest ancestor that still holds
    // only that one Add button — that's the product tile.
    const buttons = [...document.querySelectorAll("button")].filter(isAddButton);
    return buttons.map((btn) => {
      let tile = btn;
      while (tile.parentElement && tile.parentElement !== document.body) {
        const addsInParent = [...tile.parentElement.querySelectorAll("button")].filter(isAddButton).length;
        if (addsInParent > 1) break;
        tile = tile.parentElement;
      }
      return tile;
    });
  }

  function isSponsored(tile) {
    if (cfg.sponsoredSelector && (tile.matches(cfg.sponsoredSelector) || tile.querySelector(cfg.sponsoredSelector))) return true;
    // Visible "Sponsored" / "Ad" badge anywhere inside this tile only
    for (const el of tile.querySelectorAll("span, div, p, small, strong")) {
      if (el.children.length === 0 && /^(sponsored|sponsored product|promoted|ad)$/i.test(clean(el.textContent))) return true;
    }
    return false;
  }

  // Results render client-side; poll until tiles with Add buttons appear.
  let tiles = [];
  for (let waited = 0; waited < 12000; waited += 500) {
    tiles = findTiles().filter((t) => [...t.querySelectorAll("button")].some(isAddButton));
    if (tiles.length > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 500)); // let the rest of the grid settle
  tiles = findTiles().filter((t) => [...t.querySelectorAll("button")].some(isAddButton));

  document.querySelectorAll("[data-recipe-pick]").forEach((el) => el.removeAttribute("data-recipe-pick"));

  const products = [];
  for (const tile of tiles) {
    if (products.length >= maxProducts) break;
    if (isSponsored(tile)) continue;
    const button = [...tile.querySelectorAll("button")].find(isAddButton);
    if (!button || button.disabled) continue;

    let name = cfg.nameAttr ? tile.getAttribute(cfg.nameAttr) : "";
    if (!name) {
      const link = [...tile.querySelectorAll(cfg.nameSelector)].find((a) => clean(a.textContent));
      name = link ? clean(link.textContent) : "";
    }
    if (!name) continue;

    // Size, price, offers etc. — the tile's visible text minus UI noise
    const details = clean(tile.innerText)
      .replace(/view product details for/gi, "")
      .replace(name, "")
      .replace(/\b(add|quantity controls|more like this|favourite)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);

    const pickId = String(products.length);
    button.setAttribute("data-recipe-pick", pickId);
    products.push({ pickId, name, details });
  }
  return products;
}

// Injected into the store page - phase 3
function clickTaggedButton(pickId) {
  const button = document.querySelector(`button[data-recipe-pick="${pickId}"]`);
  if (!button) return false;
  button.scrollIntoView({ block: "center" });
  button.click();
  return true;
}
