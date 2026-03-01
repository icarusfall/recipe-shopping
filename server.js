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

function stripMarkdown(text) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

app.post("/api/generate-recipe", async (req, res) => {
  const { description, profileName, profileEmoji, siblings, tone } = req.body;
  if (!description) return res.status(400).json({ error: "description required" });

  let personalisationText = "";
  if (profileName) {
    const toneInstruction = tone
      ? `Narration style: ${tone}.`
      : `Write in a fun, personalised narrative voice. Give them a fun title (like "${profileName} the Magnificent Meat Eater" or "${profileName} the Fearless Flavour Explorer").`;

    personalisationText = `\nIMPORTANT: This recipe is being made for ${profileName} ${profileEmoji || ""}. Address the method steps to ${profileName}. ${toneInstruction} ${siblings ? `Occasionally reference their siblings ${siblings} in a cheeky way (e.g. "keep this secret from..." or "they'll be jealous when they smell this").` : ""} Keep the actual cooking instructions accurate and clear despite the personalised narration.`;
  }

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: `Generate a recipe based on this description: "${description}"
${personalisationText}
Return ONLY valid JSON matching this exact structure (no markdown, no explanation):
{
  "name": "Recipe Name",
  "description": "Short description",
  "prepTime": 15,
  "cookTime": 30,
  "servings": 4,
  "ingredients": [
    { "name": "ingredient name", "quantity": "500", "unit": "g", "category": "meat|dairy|vegetable|fruit|spice|pantry|other" }
  ],
  "method": ["Step 1...", "Step 2..."]
}

prepTime and cookTime are in minutes. Be realistic — include time for chopping, marinating, resting etc in prepTime.
Use Tesco-friendly ingredient names (e.g. "400g tin chopped tomatoes" not "chopped tomatoes 400g"). Include realistic quantities. Keep it family-friendly and practical.`,
        },
      ],
    });

    const text = stripMarkdown(message.content[0].text);
    const recipe = JSON.parse(text);
    res.json(recipe);
  } catch (err) {
    console.error("Claude API error:", err.message);
    res.status(500).json({ error: "Failed to generate recipe" });
  }
});

app.post("/api/pick-product", async (req, res) => {
  const { ingredient, products, recipeName, allIngredients } = req.body;
  if (!ingredient || !products) return res.status(400).json({ error: "ingredient and products required" });

  try {
    const recipeContext = recipeName
      ? `I'm making "${recipeName}" which uses: ${allIngredients}.\n\n`
      : "";

    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [
        {
          role: "user",
          content: `${recipeContext}I need to buy: "${ingredient}"

Here are the Tesco search results (index: product name):
${products.map((p, i) => `${i}: ${p}`).join("\n")}

Which product index (0-${products.length - 1}) is the best match? Rules:
- Strongly prefer fresh, whole, unprocessed ingredients (e.g. fresh onions not freeze-dried onion)
- Prefer Tesco own-brand basics over niche/specialty brands
- Avoid ready meals, prepared dishes, freeze-dried substitutes, and unrelated products
- Pick the most natural form a home cook would use

Reply with ONLY the index number, nothing else.`,
        },
      ],
    });

    const text = message.content[0].text.trim();
    const index = parseInt(text);
    res.json({ index: isNaN(index) ? 0 : index });
  } catch (err) {
    console.error("Claude pick-product error:", err.message);
    res.json({ index: 0 }); // fallback to first item
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
    const message = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `You're suggesting dinner recipes for a child/teenager. Here's their profile:

${basePrefs}
${historyText}
${moodText}

Generate exactly 10 recipe suggestions. Rules:
- Tailor to their preferences but ensure variety
- At least 3 suggestions should feature vegetables prominently
- At least 2 should gently push beyond their comfort zone while still being appealing to them
- Don't repeat any recipes from their recent history
- All recipes should be family-friendly and practical to cook at home
- Make the descriptions fun and appetising for a young person

Return ONLY valid JSON — an array of 10 objects, no markdown:
[{ "name": "Recipe Name", "description": "One fun line about the dish", "emoji": "🍗", "prepTime": 15, "cookTime": 30 }]

prepTime and cookTime are in minutes. Be realistic.`,
        },
      ],
    });

    const text = stripMarkdown(message.content[0].text);
    const suggestions = JSON.parse(text);
    res.json(suggestions);
  } catch (err) {
    console.error("Claude suggest error:", err.message);
    res.status(500).json({ error: "Failed to generate suggestions" });
  }
});

app.post("/api/tweak-recipe", async (req, res) => {
  const { recipe, tweak } = req.body;
  if (!recipe || !tweak) return res.status(400).json({ error: "recipe and tweak required" });

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `Here is an existing recipe as JSON:
${JSON.stringify(recipe)}

The user wants this change: "${tweak}"

Apply the change to the recipe. Update the ingredients list and method steps as needed. Keep the same JSON structure. Preserve any fun personalised narration style in the method steps.

Return ONLY valid JSON (no markdown, no explanation):
{
  "name": "Recipe Name",
  "description": "Short description",
  "prepTime": 15,
  "cookTime": 30,
  "servings": 4,
  "ingredients": [
    { "name": "ingredient name", "quantity": "500", "unit": "g", "category": "meat|dairy|vegetable|fruit|spice|pantry|other" }
  ],
  "method": ["Step 1...", "Step 2..."]
}

prepTime and cookTime are in minutes. Be realistic.
Use Tesco-friendly ingredient names. Keep it practical.`,
        },
      ],
    });

    const text = stripMarkdown(message.content[0].text);
    const updated = JSON.parse(text);
    res.json(updated);
  } catch (err) {
    console.error("Claude tweak error:", err.message);
    res.status(500).json({ error: "Failed to tweak recipe" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
