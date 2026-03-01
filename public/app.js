const TESCO_URL = "https://www.tesco.com/groceries/en-GB/search?query=";

let recipes = [];
let currentRecipe = null;
let activeProfile = null;

// ===== Recipe Cache =====
function getCachedRecipes() {
  try { return JSON.parse(localStorage.getItem("cachedRecipes")) || []; }
  catch { return []; }
}

function cacheRecipe(recipe, profileKey) {
  const cached = getCachedRecipes();
  cached.push({
    recipe,
    profileKey: profileKey || null,
    date: new Date().toISOString().split("T")[0],
  });
  // Keep last 20
  if (cached.length > 20) cached.splice(0, cached.length - 20);
  localStorage.setItem("cachedRecipes", JSON.stringify(cached));
}

function getSiblingNames(profileKey) {
  const profiles = getProfiles();
  return Object.entries(profiles)
    .filter(([k]) => k !== profileKey)
    .map(([, p]) => p.name)
    .join(" and ");
}

// ===== Default Profiles =====
const DEFAULT_PROFILES = {
  jerry: {
    name: "Jerry",
    emoji: "\u{1F336}\u{FE0F}",
    colour: "#FF6B35",
    basePrefs: "Adventurous eater, likes spicy food. Has enjoyed spicy chicken kebabs, curries, Thai food, Mexican food, and bold flavours.",
    history: [],
  },
  paddy: {
    name: "Paddy",
    emoji: "\u{1F354}",
    colour: "#4ECDC4",
    basePrefs: "Cautious eater, prefers familiar comfort food. Likes burgers, pasta, pizza, chicken nuggets, and simple flavours.",
    history: [],
  },
  rufus: {
    name: "Rufus",
    emoji: "\u{1F969}",
    colour: "#FF6B6B",
    basePrefs: "Loves meaty dishes, especially steak. Enjoys hearty meals with bold flavours, BBQ, and anything with a good chunk of protein.",
    history: [],
  },
};

// ===== Profile Storage =====
function getProfiles() {
  try {
    const stored = JSON.parse(localStorage.getItem("profiles"));
    if (stored && stored.jerry) return stored;
  } catch {}
  // Seed defaults
  localStorage.setItem("profiles", JSON.stringify(DEFAULT_PROFILES));
  return JSON.parse(JSON.stringify(DEFAULT_PROFILES));
}

function saveProfiles(profiles) {
  localStorage.setItem("profiles", JSON.stringify(profiles));
}

function getProfile(key) {
  return getProfiles()[key];
}

function recordChoice(profileKey, recipeName) {
  const profiles = getProfiles();
  profiles[profileKey].history.push({
    name: recipeName,
    date: new Date().toISOString().split("T")[0],
  });
  // Keep last 30
  if (profiles[profileKey].history.length > 30) {
    profiles[profileKey].history = profiles[profileKey].history.slice(-30);
  }
  saveProfiles(profiles);
}

// ===== Store Cupboard =====
function getCupboard() {
  try { return JSON.parse(localStorage.getItem("storeCupboard")) || []; }
  catch { return []; }
}

function saveCupboard(items) {
  localStorage.setItem("storeCupboard", JSON.stringify(items));
}

function addToCupboard(name) {
  const items = getCupboard();
  const key = name.toLowerCase().trim();
  if (!items.includes(key)) { items.push(key); saveCupboard(items); }
}

function removeFromCupboard(name) {
  saveCupboard(getCupboard().filter(i => i !== name.toLowerCase().trim()));
}

function isInCupboard(name) {
  return getCupboard().includes(name.toLowerCase().trim());
}

// ===== Weekly Order =====
function getWeeklyOrder() {
  try { return JSON.parse(localStorage.getItem("weeklyOrder")) || []; }
  catch { return []; }
}

function saveWeeklyOrder(order) {
  localStorage.setItem("weeklyOrder", JSON.stringify(order));
}

function addToWeeklyOrder(recipe, profileKey) {
  const order = getWeeklyOrder();
  order.push({
    recipe,
    profileKey: profileKey || null,
    date: new Date().toISOString().split("T")[0],
  });
  saveWeeklyOrder(order);
  renderWeeklyOrder();
}

function removeFromWeeklyOrder(index) {
  const order = getWeeklyOrder();
  order.splice(index, 1);
  saveWeeklyOrder(order);
  renderWeeklyOrder();
}

function renderWeeklyOrder() {
  const order = getWeeklyOrder();
  const list = document.getElementById("weekly-order-list");
  const noOrders = document.getElementById("no-orders");
  const actions = document.getElementById("weekly-order-actions");

  if (order.length === 0) {
    list.innerHTML = "";
    noOrders.classList.remove("hidden");
    actions.classList.add("hidden");
    return;
  }

  noOrders.classList.add("hidden");
  actions.classList.remove("hidden");

  list.innerHTML = order.map((entry, i) => {
    const r = entry.recipe;
    const profile = entry.profileKey ? getProfile(entry.profileKey) : null;
    const badge = profile ? `<span class="saved-profile-badge" style="background:${profile.colour}">${profile.emoji} ${profile.name}</span>` : "";
    const emoji = recipeEmoji(r);
    return `
      <div class="weekly-order-item" data-index="${i}">
        <div class="weekly-order-info">
          <span class="weekly-order-emoji">${emoji}</span>
          <div>
            <strong>${r.name}</strong>
            <span class="weekly-order-meta">${badge} ${entry.date}</span>
          </div>
        </div>
        <div class="weekly-order-actions-row">
          <button class="weekly-view-btn" data-index="${i}">View</button>
          <button class="weekly-remove-btn" data-index="${i}">&times;</button>
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".weekly-view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const entry = getWeeklyOrder()[parseInt(btn.dataset.index)];
      currentRecipe = entry.recipe;
      if (entry.profileKey) activeProfile = entry.profileKey;
      showRecipe(entry.recipe);
      document.getElementById("ingredient-section").classList.remove("hidden");
      document.getElementById("method-section").classList.remove("hidden");
      document.getElementById("ingredient-section").scrollIntoView({ behavior: "smooth" });
    });
  });

  list.querySelectorAll(".weekly-remove-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      removeFromWeeklyOrder(parseInt(btn.dataset.index));
    });
  });
}

// ===== Tesco Search Term Builder =====
function buildTescoSearchTerm(ing) {
  const unit = (ing.unit || "").toLowerCase().trim();
  const name = ing.name.toLowerCase().trim();
  const qty = ing.quantity;
  const compactUnits = { g: "g", kg: "kg", ml: "ml", l: "l" };

  if (/^\d+g\s/.test(name)) return name;

  const skipQtyPatterns = [
    /wine/, /beer/, /ale/, /lager/, /cider/,
    /stock cube/, /yeast/, /mustard/, /sauce\b/,
    /oil$/, /vinegar/, /honey/, /sugar/,
    /flour/, /butter/, /cream cheese/, /milk/,
  ];
  const skipQty = skipQtyPatterns.some(p => p.test(name));

  const driedGoods = ["spaghetti", "penne pasta", "fusilli", "tagliatelle", "linguine", "egg noodles", "rice noodles"];
  const isDried = driedGoods.some(g => name.includes(g));

  let prefix = "";
  if (!skipQty && unit in compactUnits) {
    prefix = qty + compactUnits[unit] + " ";
  }

  let suffix = "";
  if (isDried && !/dried|fresh/.test(name)) {
    suffix = " dried";
  }

  return (prefix + name + suffix).trim();
}

// ===== Category Emojis =====
const CATEGORY_EMOJI = {
  meat: "🥩", dairy: "🧀", vegetable: "🥬", fruit: "🍋",
  spice: "🌶️", pantry: "🫙", other: "🛒",
};

function formatTime(mins) {
  if (!mins) return null;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function timingBadge(recipe) {
  const prep = recipe.prepTime;
  const cook = recipe.cookTime;
  if (!prep && !cook) return "";
  const total = (prep || 0) + (cook || 0);
  return `<span class="timing-badge">⏱️ ${formatTime(total)}</span>`;
}

function timingDetail(recipe) {
  const prep = recipe.prepTime;
  const cook = recipe.cookTime;
  if (!prep && !cook) return "";
  const parts = [];
  if (prep) parts.push(`Prep: ${formatTime(prep)}`);
  if (cook) parts.push(`Cook: ${formatTime(cook)}`);
  const total = (prep || 0) + (cook || 0);
  parts.push(`Total: ${formatTime(total)}`);
  return `<div class="timing-detail">⏱️ ${parts.join(" · ")}</div>`;
}

function recipeEmoji(recipe) {
  // Pick an emoji based on the main protein/theme
  const names = recipe.ingredients.map(i => i.name.toLowerCase()).join(" ");
  if (/chicken/.test(names)) return "🍗";
  if (/beef|steak/.test(names)) return "🥩";
  if (/lamb/.test(names)) return "🐑";
  if (/pork|sausage/.test(names)) return "🐷";
  if (/salmon|fish|prawn|haddock/.test(names)) return "🐟";
  if (/pasta|spaghetti|penne/.test(names)) return "🍝";
  if (/rice/.test(names)) return "🍚";
  if (/pizza/.test(names)) return "🍕";
  if (/burger/.test(names)) return "🍔";
  if (/curry/.test(names)) return "🍛";
  return "🍽️";
}

// ===== Navigation =====
function showSection(id) {
  ["profile-section", "suggestions-section", "recipe-browser", "generate-section", "ingredient-section", "method-section", "saved-section", "profile-editor"].forEach(s => {
    document.getElementById(s).classList.add("hidden");
  });
  document.getElementById(id).classList.remove("hidden");
}

function showHome() {
  activeProfile = null;
  showSection("profile-section");
  document.getElementById("ingredient-section").classList.add("hidden");
  document.getElementById("method-section").classList.add("hidden");
  document.getElementById("generate-section").classList.add("hidden");
}

// ===== Profile Picker =====
function renderProfiles() {
  const profiles = getProfiles();
  const grid = document.getElementById("profile-grid");
  grid.innerHTML = Object.entries(profiles).map(([key, p]) => `
    <button class="profile-btn" data-key="${key}" style="background: ${p.colour}">
      <span class="profile-emoji">${p.emoji}</span>
      ${p.name}
    </button>
  `).join("");

  grid.querySelectorAll(".profile-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activeProfile = btn.dataset.key;
      openSuggestions(activeProfile);
    });
  });
}

// ===== Suggestions =====
async function openSuggestions(profileKey, mood) {
  const profile = getProfile(profileKey);
  document.getElementById("suggestions-title").textContent = `What do you fancy, ${profile.name}?`;
  showSection("suggestions-section");

  const grid = document.getElementById("suggestions-grid");
  grid.innerHTML = "";
  document.getElementById("suggestions-loading").classList.remove("hidden");
  document.getElementById("suggestions-loading").querySelector("span").textContent = "Thinking up some ideas...";

  try {
    const res = await fetch("/api/suggest-recipes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        basePrefs: profile.basePrefs,
        history: profile.history,
        mood: mood || "",
      }),
    });
    if (!res.ok) throw new Error("API error");
    const suggestions = await res.json();
    renderSuggestions(suggestions, profile);
  } catch (err) {
    grid.innerHTML = '<p style="color:#c00;text-align:center">Failed to generate suggestions. Is ANTHROPIC_API_KEY set?</p>';
  } finally {
    document.getElementById("suggestions-loading").classList.add("hidden");
  }
}

function renderSuggestions(suggestions, profile) {
  const grid = document.getElementById("suggestions-grid");
  grid.innerHTML = suggestions.map((s, i) => `
    <div class="suggestion-card" data-index="${i}" style="--accent: ${profile.colour}">
      <span class="card-emoji">${s.emoji || "\u{1F372}"}</span>
      <h3>${s.name}</h3>
      <p>${s.description}</p>
      ${timingBadge(s)}
    </div>
  `).join("");

  // Set the coloured left border
  grid.querySelectorAll(".suggestion-card").forEach(card => {
    card.style.setProperty("border-left", `5px solid ${profile.colour}`);
    card.addEventListener("click", () => {
      const idx = parseInt(card.dataset.index);
      chooseSuggestion(suggestions[idx]);
    });
  });
}

async function chooseSuggestion(suggestion) {
  // Record the choice
  if (activeProfile) {
    recordChoice(activeProfile, suggestion.name);
  }

  // Generate the full recipe
  document.getElementById("suggestions-loading").classList.remove("hidden");
  document.getElementById("suggestions-loading").querySelector("span").textContent = `Generating ${suggestion.name}...`;

  try {
    const profile = activeProfile ? getProfile(activeProfile) : null;
    const body = {
      description: suggestion.name + " - " + suggestion.description,
    };
    if (profile) {
      body.profileName = profile.name;
      body.profileEmoji = profile.emoji;
      body.siblings = getSiblingNames(activeProfile);
      body.tone = profile.tone || "";
    }

    const res = await fetch("/api/generate-recipe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("API error");
    const recipe = await res.json();

    currentRecipe = recipe;
    recipes.push(recipe);
    cacheRecipe(recipe, activeProfile);
    showRecipe(recipe);

    // Show ingredient and method sections, hide suggestions loading
    document.getElementById("suggestions-loading").classList.add("hidden");
    document.getElementById("ingredient-section").classList.remove("hidden");
    document.getElementById("method-section").classList.remove("hidden");
    document.getElementById("ingredient-section").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    document.getElementById("suggestions-loading").classList.add("hidden");
    alert("Failed to generate recipe");
  }
}

// ===== "Show me more" =====
document.getElementById("show-more-btn").addEventListener("click", () => {
  if (!activeProfile) return;
  const mood = document.getElementById("mood-input").value.trim();
  openSuggestions(activeProfile, mood);
});

document.getElementById("mood-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("show-more-btn").click();
});

// ===== Back buttons =====
document.getElementById("back-to-profiles").addEventListener("click", showHome);
document.getElementById("back-from-browse").addEventListener("click", showHome);

// ===== Browse all recipes =====
document.getElementById("browse-all-btn").addEventListener("click", () => {
  showSection("recipe-browser");
  document.getElementById("generate-section").classList.remove("hidden");
  renderRecipes();
});

// ===== Recipe Grid (curated) =====
function renderRecipes() {
  const grid = document.getElementById("recipe-grid");
  grid.innerHTML = recipes.map((r, i) => `
    <div class="recipe-card" data-index="${i}">
      <button class="delete-recipe" data-index="${i}" title="Remove recipe">&times;</button>
      <h3>${r.name}</h3>
      <p>${r.description}</p>
      <div class="servings">${timingBadge(r)} Serves ${r.servings}</div>
    </div>
  `).join("");

  grid.querySelectorAll(".recipe-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.classList.contains("delete-recipe")) return;
      selectRecipe(parseInt(card.dataset.index));
    });
  });

  grid.querySelectorAll(".delete-recipe").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      if (currentRecipe === recipes[idx]) {
        currentRecipe = null;
        document.getElementById("ingredient-section").classList.add("hidden");
        document.getElementById("method-section").classList.add("hidden");
      }
      recipes.splice(idx, 1);
      renderRecipes();
    });
  });
}

function selectRecipe(index) {
  currentRecipe = recipes[index];
  showRecipe(currentRecipe);
  document.querySelectorAll(".recipe-card").forEach((c, i) => {
    c.classList.toggle("selected", i === index);
  });
}

function showRecipe(recipe) {
  document.getElementById("recipe-emoji").textContent = recipeEmoji(recipe);
  document.getElementById("selected-recipe-name").textContent = recipe.name;
  document.getElementById("selected-servings").textContent = recipe.servings;

  const timingEl = document.getElementById("selected-timing");
  if (timingEl) timingEl.innerHTML = timingDetail(recipe);

  const list = document.getElementById("ingredient-list");
  list.innerHTML = recipe.ingredients.map((ing, i) => {
    const checked = !isInCupboard(ing.name);
    const qtyStr = ing.quantity + (ing.unit ? " " + ing.unit : "");
    const searchStr = buildTescoSearchTerm(ing);
    const searchTerm = encodeURIComponent(searchStr);
    return `
      <div class="ingredient-row ${checked ? "" : "unchecked"}" data-index="${i}">
        <input type="checkbox" ${checked ? "checked" : ""} data-name="${ing.name}">
        <div class="ingredient-info">
          <span class="ingredient-name">${ing.name}</span>
          <span class="ingredient-qty">${qtyStr}</span>
        </div>
        <span class="category-tag">${CATEGORY_EMOJI[ing.category] || "🛒"} ${ing.category}</span>
        <button class="tesco-btn" data-term="${searchTerm}">Search Tesco</button>
      </div>
    `;
  }).join("");

  list.querySelectorAll("input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", () => {
      const name = cb.dataset.name;
      const row = cb.closest(".ingredient-row");
      if (cb.checked) {
        removeFromCupboard(name);
        row.classList.remove("unchecked");
      } else {
        addToCupboard(name);
        row.classList.add("unchecked");
      }
      renderCupboard();
    });
  });

  list.querySelectorAll(".tesco-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      window.open(TESCO_URL + btn.dataset.term, "_blank");
    });
  });

  document.getElementById("ingredient-section").classList.remove("hidden");
  document.getElementById("method-section").classList.remove("hidden");

  const methodList = document.getElementById("method-list");
  methodList.innerHTML = recipe.method.map(s => `<li>${s}</li>`).join("");

  document.getElementById("ingredient-section").scrollIntoView({ behavior: "smooth" });
}

// ===== Tweak Recipe =====
document.getElementById("tweak-btn").addEventListener("click", async () => {
  const input = document.getElementById("tweak-input");
  const tweak = input.value.trim();
  if (!tweak || !currentRecipe) return;

  const btn = document.getElementById("tweak-btn");
  const status = document.getElementById("tweak-status");
  btn.disabled = true;
  status.classList.remove("hidden");
  status.textContent = "Updating recipe...";

  try {
    const res = await fetch("/api/tweak-recipe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipe: currentRecipe, tweak }),
    });
    if (!res.ok) throw new Error("API error");
    const updated = await res.json();

    currentRecipe = updated;
    cacheRecipe(updated, activeProfile);
    showRecipe(updated);
    status.textContent = "Recipe updated!";
    input.value = "";
  } catch (err) {
    status.textContent = "Failed to update recipe.";
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("tweak-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("tweak-btn").click();
});

// ===== Tesco Extension =====
function getCheckedSearchTerms() {
  const checked = document.querySelectorAll("#ingredient-list input[type=checkbox]:checked");
  return [...checked].map(cb => {
    const row = cb.closest(".ingredient-row");
    const btn = row.querySelector(".tesco-btn");
    return decodeURIComponent(btn.dataset.term);
  });
}

document.getElementById("add-to-tesco-btn").addEventListener("click", () => {
  const items = getCheckedSearchTerms();
  if (items.length === 0) return;

  const hasExtension = document.documentElement.hasAttribute("data-tesco-extension");
  if (!hasExtension) {
    document.getElementById("no-extension-msg").classList.remove("hidden");
    return;
  }

  document.getElementById("tesco-progress").classList.remove("hidden");
  document.getElementById("tesco-progress").textContent = "Starting...";
  const recipeName = currentRecipe ? currentRecipe.name : "";
  const allIngredients = currentRecipe ? currentRecipe.ingredients.map(i => i.name).join(", ") : "";
  document.dispatchEvent(new CustomEvent("tesco-add-to-basket", {
    detail: { items, recipeName, allIngredients }
  }));
});

document.addEventListener("tesco-progress", (e) => {
  const el = document.getElementById("tesco-progress");
  el.classList.remove("hidden");
  el.textContent = e.detail.text;
});

// ===== Generate Recipe (from browse view) =====
document.getElementById("generate-btn").addEventListener("click", async () => {
  const input = document.getElementById("recipe-prompt");
  const desc = input.value.trim();
  if (!desc) return;

  const btn = document.getElementById("generate-btn");
  const status = document.getElementById("generate-status");
  btn.disabled = true;
  status.classList.remove("hidden");
  status.textContent = "Generating recipe...";

  try {
    const res = await fetch("/api/generate-recipe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: desc }),
    });
    if (!res.ok) throw new Error("API error");
    const recipe = await res.json();

    recipes.push(recipe);
    renderRecipes();
    selectRecipe(recipes.length - 1);
    status.textContent = `Generated: ${recipe.name}`;
    input.value = "";
  } catch (err) {
    status.textContent = "Failed to generate recipe. Is ANTHROPIC_API_KEY set?";
  } finally {
    btn.disabled = false;
  }
});

// ===== Cupboard UI =====
function renderCupboard() {
  const items = getCupboard();
  const container = document.getElementById("cupboard-items");
  if (items.length === 0) {
    container.innerHTML = '<span style="color:#999;font-size:0.85rem">No items yet</span>';
    return;
  }
  container.innerHTML = items.map(name => `
    <span class="cupboard-tag">
      ${name}
      <button data-name="${name}">&times;</button>
    </span>
  `).join("");

  container.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      removeFromCupboard(btn.dataset.name);
      renderCupboard();
      if (currentRecipe) showRecipe(currentRecipe);
    });
  });
}

document.getElementById("clear-cupboard").addEventListener("click", () => {
  saveCupboard([]);
  renderCupboard();
  if (currentRecipe) showRecipe(currentRecipe);
});

// ===== Saved Recipes =====
document.getElementById("saved-recipes-btn").addEventListener("click", () => {
  showSection("saved-section");
  renderSavedRecipes();
});

document.getElementById("back-from-saved").addEventListener("click", showHome);

function renderSavedRecipes() {
  const cached = getCachedRecipes();
  const grid = document.getElementById("saved-grid");
  const noSaved = document.getElementById("no-saved");

  if (cached.length === 0) {
    grid.innerHTML = "";
    noSaved.classList.remove("hidden");
    return;
  }

  noSaved.classList.add("hidden");
  grid.innerHTML = cached.map((entry, i) => {
    const r = entry.recipe;
    const profile = entry.profileKey ? getProfile(entry.profileKey) : null;
    const profileBadge = profile ? `<span class="saved-profile-badge" style="background:${profile.colour}">${profile.emoji} ${profile.name}</span>` : "";
    const emoji = recipeEmoji(r);
    return `
      <div class="recipe-card saved-card" data-index="${i}">
        <h3>${emoji} ${r.name}</h3>
        <p>${r.description}</p>
        <div class="saved-meta">
          ${timingBadge(r)}
          ${profileBadge}
          <span class="saved-date">${entry.date}</span>
        </div>
      </div>
    `;
  }).reverse().join("");

  grid.querySelectorAll(".saved-card").forEach(card => {
    card.addEventListener("click", () => {
      const idx = parseInt(card.dataset.index);
      const entry = cached[idx];
      currentRecipe = entry.recipe;
      if (entry.profileKey) activeProfile = entry.profileKey;
      showRecipe(entry.recipe);
      document.getElementById("ingredient-section").classList.remove("hidden");
      document.getElementById("method-section").classList.remove("hidden");
      document.getElementById("ingredient-section").scrollIntoView({ behavior: "smooth" });
    });
  });
}

// ===== Print Recipe =====
document.getElementById("print-recipe-btn").addEventListener("click", () => {
  if (!currentRecipe) return;
  const r = currentRecipe;
  const emoji = recipeEmoji(r);
  const profile = activeProfile ? getProfile(activeProfile) : null;
  const profileLine = profile ? `<p class="print-profile">${profile.emoji} Chosen by ${profile.name}</p>` : "";

  const ingredients = r.ingredients.map(ing => {
    const qty = ing.quantity + (ing.unit ? " " + ing.unit : "");
    const catEmoji = CATEGORY_EMOJI[ing.category] || "";
    return `<li>${catEmoji} <strong>${ing.name}</strong> — ${qty}</li>`;
  }).join("");

  const method = r.method.map((s, i) => `<li>${s}</li>`).join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${r.name}</title>
<style>
  body { font-family: Georgia, serif; max-width: 700px; margin: 40px auto; padding: 20px; color: #333; }
  h1 { font-size: 2rem; margin-bottom: 4px; }
  .desc { color: #666; font-style: italic; margin-bottom: 20px; }
  .print-profile { font-size: 1.1rem; margin-bottom: 16px; }
  h2 { font-size: 1.3rem; margin-top: 24px; border-bottom: 2px solid #eee; padding-bottom: 6px; }
  ul, ol { padding-left: 24px; }
  li { margin-bottom: 8px; line-height: 1.5; }
  .servings { color: #888; font-size: 0.9rem; }
  @media print { body { margin: 0; } }
</style>
</head><body>
  <h1>${emoji} ${r.name}</h1>
  <p class="desc">${r.description}</p>
  ${profileLine}
  <p class="servings">Serves ${r.servings}${r.prepTime || r.cookTime ? ` · ⏱️ ${r.prepTime ? 'Prep: ' + formatTime(r.prepTime) : ''}${r.prepTime && r.cookTime ? ' · ' : ''}${r.cookTime ? 'Cook: ' + formatTime(r.cookTime) : ''}${' · Total: ' + formatTime((r.prepTime || 0) + (r.cookTime || 0))}` : ''}</p>
  <h2>🛒 Ingredients</h2>
  <ul>${ingredients}</ul>
  <h2>👨‍🍳 Method</h2>
  <ol>${method}</ol>
</body></html>`;

  const win = window.open("", "_blank");
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
});

// ===== Profile Editor =====
document.getElementById("edit-profiles-btn").addEventListener("click", () => {
  showSection("profile-editor");
  renderProfileEditor();
});

document.getElementById("back-from-editor").addEventListener("click", showHome);

function renderProfileEditor() {
  const profiles = getProfiles();
  const container = document.getElementById("profile-forms");
  container.innerHTML = Object.entries(profiles).map(([key, p]) => `
    <div class="profile-edit-card" style="border-left: 5px solid ${p.colour}">
      <div class="profile-edit-header">
        <span class="profile-edit-emoji">${p.emoji}</span>
        <strong>${p.name}</strong>
      </div>
      <label>Food preferences</label>
      <textarea class="profile-prefs-input" data-key="${key}" rows="3">${p.basePrefs}</textarea>
      <label>Recipe narration style</label>
      <textarea class="profile-tone-input" data-key="${key}" rows="2" placeholder="e.g. 'Fun and excitable, like a TV chef' or 'Chill and mature, no silly stuff'">${p.tone || ""}</textarea>
      <div class="profile-history-info">
        ${p.history.length} recipes in history
        ${p.history.length > 0 ? `<button class="clear-history-btn secondary-btn" data-key="${key}">Clear history</button>` : ""}
      </div>
    </div>
  `).join("");

  container.querySelectorAll(".clear-history-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const profiles = getProfiles();
      profiles[btn.dataset.key].history = [];
      saveProfiles(profiles);
      renderProfileEditor();
    });
  });
}

document.getElementById("save-profiles-btn").addEventListener("click", () => {
  const profiles = getProfiles();

  document.querySelectorAll(".profile-prefs-input").forEach(input => {
    profiles[input.dataset.key].basePrefs = input.value.trim();
  });

  document.querySelectorAll(".profile-tone-input").forEach(input => {
    profiles[input.dataset.key].tone = input.value.trim();
  });

  saveProfiles(profiles);
  renderProfiles();

  const status = document.getElementById("profile-save-status");
  status.classList.remove("hidden");
  status.textContent = "Profiles saved!";
  setTimeout(() => status.classList.add("hidden"), 2000);
});

// ===== Weekly Order Buttons =====
document.getElementById("add-to-weekly-btn").addEventListener("click", () => {
  if (!currentRecipe) return;
  addToWeeklyOrder(currentRecipe, activeProfile);
  const btn = document.getElementById("add-to-weekly-btn");
  btn.textContent = "Added!";
  btn.disabled = true;
  setTimeout(() => { btn.textContent = "+ This week's order"; btn.disabled = false; }, 1500);
});

document.getElementById("clear-weekly-order").addEventListener("click", () => {
  saveWeeklyOrder([]);
  renderWeeklyOrder();
});

document.getElementById("view-weekly-shopping-btn").addEventListener("click", () => {
  const order = getWeeklyOrder();
  if (order.length === 0) return;

  // Combine all ingredients across all ordered recipes
  const combined = {};
  order.forEach(entry => {
    entry.recipe.ingredients.forEach(ing => {
      const key = ing.name.toLowerCase().trim();
      if (combined[key]) {
        // Try to add quantities
        const existingQty = parseFloat(combined[key].quantity);
        const newQty = parseFloat(ing.quantity);
        if (!isNaN(existingQty) && !isNaN(newQty) && combined[key].unit === ing.unit) {
          combined[key].quantity = String(existingQty + newQty);
        }
      } else {
        combined[key] = { ...ing };
      }
    });
  });

  // Build a synthetic recipe for display
  const combinedRecipe = {
    name: "This Week's Shopping List",
    description: order.map(e => e.recipe.name).join(" + "),
    servings: order.reduce((sum, e) => sum + (e.recipe.servings || 4), 0),
    ingredients: Object.values(combined),
    method: ["This is a combined shopping list from " + order.length + " recipe(s): " + order.map(e => e.recipe.name).join(", ")],
  };

  currentRecipe = combinedRecipe;
  showRecipe(combinedRecipe);
  document.getElementById("ingredient-section").classList.remove("hidden");
  document.getElementById("method-section").classList.remove("hidden");
  document.getElementById("ingredient-section").scrollIntoView({ behavior: "smooth" });
});

// ===== Init =====
fetch("/recipes.json")
  .then(r => r.json())
  .then(data => { recipes = data; });

renderProfiles();
renderCupboard();
renderWeeklyOrder();
