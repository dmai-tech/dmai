import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config({ override: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ 沒有 ANTHROPIC_API_KEY，複製 .env.example 成 .env 並填入 API key。");
  process.exit(1);
}

const client = new Anthropic();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const TEMPLATE_HINTS = {
  教學型: "用『我學到…』或『原來…』破題，把一個小知識拆成 1-2 個重點，結尾留一個可以延伸思考的問題。",
  故事型: "用一個具體場景或小故事開場（時間、人、地點），引發共鳴後帶出觀點。",
  爭議型: "提出一個普遍想法，然後用『但其實…』或『我反而覺得…』翻轉，給出有憑有據的新觀點，不要惡意挑釁。",
  條列型: "第一行寫一句鉤子總結，接著用 3-5 條短句列重點，每條 15 字內，結尾收斂。",
  抱怨碎念型: "像真人碎念、略帶幽默與自嘲，不要假掰，可以講實話但避免攻擊他人。",
  共鳴型: "提出一個大家都經歷過但很少有人公開講的微小生活觀察、疑問或小糗事。**1-3 句、20-80 字**，要短到 3 秒就讀完。口語、不說教、不解釋、不結論——讓人看了覺得『對欸我也是』、忍不住想留言回答。可以用問句（「為什麼…」「到底有沒有人…」），也可以用自嘲陳述（「我到現在還是不會分…」）。禁止 emoji 開頭、禁止說教、禁止講大道理。",
};

const LENGTH_PROFILES = {
  短: { min: 80, max: 130 },
  中: { min: 140, max: 200 },
  長: { min: 210, max: 280 },
  自由: { min: 100, max: 280 },
};

// 共鳴型 has its own length constraint — override whatever the user picked.
function effectiveLengthProfile(template, lengthRange) {
  if (template === "共鳴型") return { min: 20, max: 80 };
  return LENGTH_PROFILES[lengthRange] ?? LENGTH_PROFILES["自由"];
}

const MODEL = "claude-sonnet-4-6";
const RECENT_WINDOW = 10;

// ---- Trends (via Firecrawl) ----
let trendsCache = { at: 0, data: null };
const TRENDS_TTL = 60 * 60 * 1000; // 1 hour

app.get("/api/trends", async (_req, res) => {
  try {
    if (trendsCache.data && Date.now() - trendsCache.at < TRENDS_TTL) {
      return res.json({ cached: true, ...trendsCache.data });
    }

    if (!process.env.FIRECRAWL_API_KEY) {
      return res.status(500).json({ error: "熱搜功能需要 FIRECRAWL_API_KEY" });
    }

    const fcRes = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://trends.google.com/trending?geo=TW&hl=zh-TW",
        formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 3000,
      }),
    });

    if (!fcRes.ok) {
      throw new Error(`Firecrawl HTTP ${fcRes.status}`);
    }

    const fcData = await fcRes.json();
    const markdown = fcData?.data?.markdown ?? "";
    const items = parseTrendsMarkdown(markdown);

    const payload = { updatedAt: new Date().toISOString(), items };
    trendsCache = { at: Date.now(), data: payload };
    res.json({ cached: false, ...payload });
  } catch (err) {
    console.error("trends error:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---- Generate 3 drafts ----
app.post("/api/generate", async (req, res) => {
  try {
    const {
      template = "教學型",
      topic = "",
      overrideVoice = "",
      lengthRange = "自由",
      profile = {},
      recentHistory = [],
    } = req.body ?? {};

    if (!topic.trim()) {
      return res.status(400).json({ error: "請輸入主題" });
    }

    const templateHint = TEMPLATE_HINTS[template] ?? TEMPLATE_HINTS["教學型"];
    const lenProfile = effectiveLengthProfile(template, lengthRange);

    const profileBlock = buildProfileBlock(profile, overrideVoice);
    const freshnessBlock = buildFreshnessBlock(recentHistory);

    const systemPrompt = `你是一位熟悉 Threads（脆）貼文生態的繁體中文文案助手。

你的任務：根據使用者的「個人檔案」、「模板類型」、「主題」，產生 3 則可直接貼上 Threads 的貼文。

硬性規則：
1. 使用繁體中文（台灣用語），避免大陸化詞彙（視頻→影片、信息→資訊、軟件→軟體、質量→品質）。
2. 每則貼文**嚴格控制在 ${lenProfile.min} 到 ${lenProfile.max} 字之間**（中文字計數，不含標點）。超出或過短都不行。
3. 參考個人檔案的語調、個性、斷行節奏；但**口頭禪是偶爾點綴，不是每則都用**。
4. **3 則貼文的開頭必須使用 3 種不同的切入方式**——例如：
   一則用故事/場景破題，一則用反直覺觀察/爭議點破題，一則用數字/具體事例破題。
   嚴禁 3 則都用同一個發語詞（例如都用「欸」「我最近」「原來」）開頭。
5. 不要生硬地套模板名字，讀起來要像真人在發文。
6. 不要在開頭加「#主題」或標題，直接進入內文。
7. 每則貼文都要有一個「鉤子」（第一句話要讓人想繼續看）。
8. 如果個人檔案列出「避免風格」，嚴格避開。
9. 輸出格式嚴格使用下面的結構，不要加任何前言或後記。

輸出格式（務必照此，不要加 Markdown）：
===POST1===
（第一則貼文內容）
===POST2===
（第二則貼文內容）
===POST3===
（第三則貼文內容）
===END===`;

    const userPrompt = `${profileBlock}${freshnessBlock}

【模板類型】${template}
【模板指引】${templateHint}

【這次要寫的主題】
${topic.trim()}

請產出 3 則不同切角的脆貼文。`;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock ? textBlock.text : "";
    const posts = parsePosts(raw);

    if (posts.length === 0) {
      return res.status(500).json({ error: "AI 回應解析失敗，請再試一次", raw });
    }

    res.json({ posts, usage: response.usage });
  } catch (err) {
    console.error("generate error:", err);
    const message = err instanceof Anthropic.APIError ? `${err.status}: ${err.message}` : String(err);
    res.status(500).json({ error: message });
  }
});

// ---- Random resonance post (抽抽樂) ----
const RESONANCE_DOMAINS = [
  "食物/飲食習慣",
  "睡眠/起床",
  "工作/上班",
  "人際關係",
  "購物/買東西",
  "身體小毛病",
  "手機/科技使用",
  "天氣/季節",
  "交通/通勤",
  "洗澡/盥洗",
  "家事/整理",
  "金錢/花費",
  "運動/懶惰",
  "咖啡/飲料",
  "寵物/動物",
  "朋友/家人",
  "童年記憶",
  "時間感",
  "流行/追劇",
  "社群媒體",
];

app.post("/api/random-resonance", async (req, res) => {
  try {
    const { profile = {}, recentHistory = [] } = req.body ?? {};

    const profileBlock = buildProfileBlock(profile, "");
    const freshnessBlock = buildFreshnessBlock(recentHistory);
    const domain = RESONANCE_DOMAINS[Math.floor(Math.random() * RESONANCE_DOMAINS.length)];
    const seed = Math.random().toString(36).slice(2, 10);

    const systemPrompt = `你是脆（Threads）上擅長寫「共鳴型爆款貼文」的繁體中文文案助手。

你的任務：**隨機抽取**一個大家都經歷過但很少有人公開講的微小生活觀察、疑問或小糗事，寫成 1 則超短貼文。

硬性規則：
1. 使用繁體中文（台灣用語），避免大陸化詞彙。
2. **嚴格 20-80 字、1-3 句**（中文字計數）。3 秒內要讀完。
3. 句型優先選這幾種：
   - 問句型：「為什麼…」「到底有沒有人…」「是不是只有我覺得…」
   - 自嘲型：「我到現在還是不會…」「我承認我…」「我從來沒想過…」
   - 對比型：「以前覺得…現在才發現…」
4. **禁止**：emoji、說教、結論、引用數據、長篇、文青化、硬梆梆的詞（如「賦能」「乾貨」）。
5. 要寫「讓人忍不住想留言說『我也是』」的感覺，不是「我要教你什麼」。
6. 參考使用者個人檔案的語氣節奏，但不要每次都用「欸」或同樣口頭禪開頭。
7. 輸出格式嚴格照下面，不要前言後記：
===POST1===
（貼文內容）
===END===`;

    const userPrompt = `${profileBlock}${freshnessBlock}

【隨機主題領域】${domain}
【random seed】${seed}

請從「${domain}」這個領域，抽一則大家都經歷過但很少公開講的小觀察、小糗事或小疑問，寫成一則共鳴型貼文。`;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock ? textBlock.text : "";
    const posts = parsePosts(raw);

    if (posts.length === 0) {
      return res.status(500).json({ error: "抽失敗，請再試一次", raw });
    }

    res.json({ post: posts[0], domain, usage: response.usage });
  } catch (err) {
    console.error("random-resonance error:", err);
    const message = err instanceof Anthropic.APIError ? `${err.status}: ${err.message}` : String(err);
    res.status(500).json({ error: message });
  }
});

// ---- Regenerate a single draft ----
app.post("/api/regenerate-draft", async (req, res) => {
  try {
    const {
      topic = "",
      template = "教學型",
      overrideVoice = "",
      lengthRange = "自由",
      otherDrafts = [],
      profile = {},
      recentHistory = [],
    } = req.body ?? {};

    if (!topic.trim()) {
      return res.status(400).json({ error: "請輸入主題" });
    }

    const templateHint = TEMPLATE_HINTS[template] ?? TEMPLATE_HINTS["教學型"];
    const lenProfile = effectiveLengthProfile(template, lengthRange);

    const profileBlock = buildProfileBlock(profile, overrideVoice);
    const freshnessBlock = buildFreshnessBlock(recentHistory);
    const otherBlock = otherDrafts.length
      ? `\n\n【保留中的貼文（請產一則切角、開頭、風格跟這些都不同的新版本）】\n` +
        otherDrafts
          .filter((d) => typeof d === "string" && d.trim())
          .map((d, i) => `--- 保留 ${i + 1} ---\n${d.trim()}`)
          .join("\n\n")
      : "";

    const systemPrompt = `你是一位熟悉 Threads（脆）貼文生態的繁體中文文案助手。

你的任務：針對同一個主題，產生 1 則切入角度與「已保留的貼文」完全不同的新版本。

硬性規則：
1. 使用繁體中文（台灣用語），避免大陸化詞彙（視頻→影片、信息→資訊、軟件→軟體）。
2. 貼文**嚴格控制在 ${lenProfile.min} 到 ${lenProfile.max} 字之間**（中文字計數）。
3. 參考個人檔案語調，但**口頭禪偶爾用就好，不要每次都用同一個發語詞**。
4. **開頭必須和所有保留的貼文不同**——不同發語詞、不同切入角度（可選：故事場景 / 反直覺觀察 / 具體數字 / 問句 / 爭議點）。
5. 不要套模板名、不要加 # 或標題。
6. 第一句要有鉤子。
7. 如果個人檔案列出避免風格，嚴格避開。
8. 輸出格式嚴格照下面，不要加前言後記：
===POST1===
（新貼文內容）
===END===`;

    const userPrompt = `${profileBlock}${freshnessBlock}${otherBlock}

【模板類型】${template}
【模板指引】${templateHint}

【主題】${topic.trim()}

請產 1 則切角不同的新版本。`;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock ? textBlock.text : "";
    const posts = parsePosts(raw);

    if (posts.length === 0) {
      return res.status(500).json({ error: "AI 回應解析失敗，請再試一次", raw });
    }

    res.json({ post: posts[0], usage: response.usage });
  } catch (err) {
    console.error("regenerate-draft error:", err);
    const message = err instanceof Anthropic.APIError ? `${err.status}: ${err.message}` : String(err);
    res.status(500).json({ error: message });
  }
});

// ---- Helpers ----
function buildFreshnessBlock(history) {
  if (!Array.isArray(history) || !history.length) return "";
  const recent = history.slice(-RECENT_WINDOW);
  const lines = recent.map((h, i) => {
    const firstLine = (h.drafts?.[0] ?? "").split("\n")[0].slice(0, 50);
    return `${i + 1}. 主題「${h.topic}」 · 切角：${firstLine}`;
  });
  return `\n\n【最近已寫過的題目（請避免角度重複，寫出新切入點）】\n${lines.join("\n")}`;
}

function buildProfileBlock(profile, overrideVoice) {
  const parts = [];

  if (profile.name) parts.push(`【稱呼】${profile.name}`);
  if (profile.personality) parts.push(`【個性】${profile.personality}`);
  if (profile.voiceHabits) parts.push(`【講話習慣】${profile.voiceHabits}`);
  if (profile.interests) parts.push(`【興趣領域】${profile.interests}`);
  if (profile.avoid) parts.push(`【避免風格／詞彙】${profile.avoid}`);

  const voiceSamples = (overrideVoice || "").trim() || (profile.sampleposts || "").trim();
  if (voiceSamples) {
    parts.push(`【代表貼文 — 完全模仿這個語氣】\n${voiceSamples}`);
  }

  if (parts.length === 0) {
    return "【個人檔案】（未設定，請用自然口語化、帶點個性的繁中語調）";
  }

  return "【個人檔案】\n" + parts.join("\n");
}

function parseTrendsMarkdown(md) {
  const rowRe = /\|\s*\|\s*([^<|\n][^<|\n]*?)<br>([\d,]+萬?\+?)\s*次搜尋/g;
  const items = [];
  const seen = new Set();
  let m;
  while ((m = rowRe.exec(md)) !== null) {
    const keyword = m[1].trim().replace(/\s+/g, "");
    const traffic = m[2].trim();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    items.push({ keyword, traffic });
    if (items.length >= 20) break;
  }
  return items;
}

function parsePosts(text) {
  return text
    .split(/===POST\d+===/)
    .slice(1)
    .map((section) => section.split("===END===")[0].trim())
    .filter(Boolean);
}

// Export app for serverless (Vercel); only listen when run directly.
const thisFilePath = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === thisFilePath;
if (isMain) {
  app.listen(PORT, () => {
    console.log(`✅ 脆文案生成器跑在 http://localhost:${PORT}`);
  });
}

export default app;
