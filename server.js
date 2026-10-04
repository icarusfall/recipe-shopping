const express = require("express");
const Anthropic = require("@anthropic-ai/sdk").default;

const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.get("/recipes.json", (req, res) => {
  res.sendFile(path.join(__dirname, "recipes.json"));
});

const client = new Anthropic();

const MODEL = "claude-opus-5-5";

// JSON schemas for structured outputs — the API guarantees the response text
// parses and matches these, so no fence-stripping or bracket-hunting needed.
const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    prepTime: { type: "integer" },
    cookTime: { type: "integer" },
    servings: { type: "integer" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "string" },
          unit: { type: "string" },
          category: {
            type: "string",
            enum: ["meat", "dairy", "vegetable", "fruit", "spice", "pantry", "other"],
          },
        },
        required: ["name", "quantity", "unit", "category"],
        additionalProperties: false,
      },
    },
    method: { type: "array", items: { type: "string" } },
  },
  required: ["name", "description", "prepTime", "cookTime", "servings", "ingredients", "method"],
  additionalProperties: false,
};

const SUGGESTIONS_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          emoji: { type: "string" },
          prepTime: { type: "integer" },
          cookTime: { type: "integer" },
        },
        required: ["name", "description", "emoji", "prepTime", "cookTime"],
        additionalProperties: false,
      },
    },
  },
  required: ["suggestions"],
  additionalProperties: false,
};

const PICK_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string" },
    index: { type: "integer" },
  },
  required: ["reason", "index"],
  additionalProperties: false,
};

// One place for every Claude call: Opus 5.5 with a schema-constrained JSON
// response. `fallbacks: "default"` re-runs the request on Anthropic's
// recommended model if a safety classifier declines it (rare for recipes, but
// cheap insurance against a false positive breaking the app).
async function askClaude({ prompt, schema, effort = "medium", maxTokens = 16000 }) {
  const message = await client.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });

  if (message.stop_reason === "refusal") {
    throw new Error(`Request declined (${message.stop_details?.category ?? "unknown"})`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Response truncated at max_tokens");
  }
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text in response");
  return JSON.parse(textBlock.text);
}

app.post("/api/generate-recipe", async (req, res) => {
  const { description, profileName, profileEmoji, siblings, tone } = req.body;
  if (!description) return res.status(400).json({ error: "description required" });

  let personalisationText = "";
  if (profileName) {
    const toneInstruction = tone
      ? `Narration style: ${tone}.`
      : `Write in a fun, personalised narrative voice. Give them a fun title (like "${profileName} the Magnificent Meat Eater" or "${profileName} the Fearless Flavour Explorer").`;

    personalisationText = `\nThis recipe is being made for ${profileName} ${profileEmoji || ""}. Address the method steps to ${profileName}. ${toneInstruction} ${siblings ? `Occasionally reference their siblings ${siblings} in a cheeky way (e.g. "keep this secret from..." or "they'll be jealous when they smell this").` : ""} Keep the actual cooking instructions accurate and clear despite the personalised narration.`;
  }

  try {
    const recipe = await askClaude({
      schema: RECIPE_SCHEMA,
      prompt: `Generate a recipe based on this description: "${description}"
${personalisationText}

prepTime and cookTime are in minutes. Be realistic — include time for chopping, marinating, resting etc in prepTime.
Ingredient names are used directly as supermarket search terms (Tesco and Waitrose), so name them the way a shop would (e.g. "chopped tomatoes", "red onion", "beef mince") and put the amount in quantity/unit rather than the name. Include realistic quantities. Keep it family-friendly and practical.
Every recipe must include at least one vegetable. If the requested dish has none (e.g. "burger and chips"), add a simple vegetable side — include its ingredients (category "vegetable") and method steps for preparing it.`,
    });
    res.json(recipe);
  } catch (err) {
    console.error("Claude API error:", err.message);
    res.status(500).json({ error: "Failed to generate recipe" });
  }
});

app.post("/api/pick-product", async (req, res) => {
  const { ingredient, products, recipeName, allIngredients, storeName } = req.body;
  if (!ingredient || !products) return res.status(400).json({ error: "ingredient and products required" });

  const shop = storeName || "supermarket";
  // Products arrive as {name, details} from the extension, where details is the
  // tile's size/price/offer text. Older callers sent plain strings.
  const productLines = products
    .map((p, i) => (typeof p === "string" ? `${i}: ${p}` : `${i}: ${p.name}${p.details ? ` — ${p.details}` : ""}`))
    .join("\n");

  try {
    const recipeContext = recipeName
      ? `I'm making "${recipeName}". Full ingredient list: ${allIngredients}.\n\n`
      : "";

    const pick = await askClaude({
      schema: PICK_SCHEMA,
      effort: "medium",
      maxTokens: 4000,
      prompt: `${recipeContext}I need to buy: "${ingredient}"

${shop} search results, in the order shown on the page (sponsored listings already removed):
${productLines}

Pick the product a sensible home cook would put in their basket for this recipe.
- It must actually be the ingredient asked for, in the form the recipe uses: fresh onions, not onion rings, gravy granules or dried onion; plain chopped tomatoes, not a pasta sauce. Search results often include loosely related products — ignore them.
- Prefer the supermarket's own-brand or a mainstream brand over niche or premium specialty lines, unless the recipe calls for something specific.
- Choose a pack size that sensibly covers the quantity in the recipe without being wildly oversized. Loose items priced "each" (e.g. a single onion) are fine when the recipe needs only one or two.
- Ignore ready meals, meal kits and frozen/dried substitutes unless that's what was asked for.
- If none of the results is a reasonable match, return index -1 rather than settling for something wrong.

Give a short reason (one sentence), then the index.`,
    });

    const index = Number.isInteger(pick.index) && pick.index >= -1 && pick.index < products.length ? pick.index : 0;
    res.json({ index, reason: pick.reason });
  } catch (err) {
    console.error("Claude pick-product error:", err.message);
    res.json({ index: 0, reason: "Picker unavailable — used the top result" });
  }
});

app.post("/api/suggest-recipes", async (req, res) => {
  const { basePrefs, history, mood } = req.body;
  if (!basePrefs) return res.status(400).json({ error: "basePrefs required" });

  const recentHistory = (history || []).slice(-10);
  const historyText = recentHistory.length > 0
    ? `\nRecently chosen recipes (most recent last):\n${recentHistory.map(h => `- ${h.name}`).join("\n")}`
    : "\nNo recipe history yet.";

  const moodText = mood
    ? `\nThey're currently in the mood for: "${mood}". Weight suggestions towards this but still include variety.`
    : "";

  try {
    const result = await askClaude({
      schema: SUGGESTIONS_SCHEMA,
      prompt: `You're suggesting dinner recipes for a child/teenager. Here's their profile:

${basePrefs}
${historyText}
${moodText}

Generate exactly 10 recipe suggestions. Rules:
- Tailor to their preferences but ensure variety
- Every suggestion must include at least one vegetable — either as a main component or a built-in vegetable side — and the description should mention it
- At least 3 suggestions should feature vegetables prominently as the star of the dish
- At least 2 should gently push beyond their comfort zone while still being appealing to them
- Don't repeat any recipes from their recent history
- All recipes should be family-friendly and practical to cook at home
- Make the descriptions a fun, appetising one-liner for a young person, with a fitting emoji

prepTime and cookTime are in minutes. Be realistic.`,
    });
    res.json(result.suggestions);
  } catch (err) {
    console.error("Claude suggest error:", err.message);
    res.status(500).json({ error: "Failed to generate suggestions" });
  }
});

app.post("/api/tweak-recipe", async (req, res) => {
  const { recipe, tweak } = req.body;
  if (!recipe || !tweak) return res.status(400).json({ error: "recipe and tweak required" });

  try {
    const updated = await askClaude({
      schema: RECIPE_SCHEMA,
      prompt: `Here is an existing recipe as JSON:
${JSON.stringify(recipe)}

The user wants this change: "${tweak}"

Apply the change to the recipe. Update the ingredients list and method steps as needed, and preserve any fun personalised narration style in the method steps.

prepTime and cookTime are in minutes. Be realistic.
Ingredient names are used directly as supermarket search terms, so name them the way a shop would and keep amounts in quantity/unit. Keep it practical.
The final recipe must still contain at least one vegetable. If the change would remove the only vegetable, keep a suitable one or add a simple vegetable side.`,
    });
    res.json(updated);
  } catch (err) {
    console.error("Claude tweak error:", err.message);
    res.status(500).json({ error: "Failed to tweak recipe" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
