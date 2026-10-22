import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import dotenv from "dotenv";
import pg from "pg";
dotenv.config();
const { Pool } = pg;
const app = express();
app.use(cors({ origin: process.env.ADMIN_ORIGIN || true }));
app.use(express.json({ limit: "6mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static("public"));
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
}) : null;
const memory = { products: [], orders: [], discounts: [], drafts: [] };
async function query(sql, params=[]) {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool.query(sql, params);
}
async function initDb() {
  if (!pool) return;
  await query(`CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT DEFAULT 'other', description TEXT DEFAULT '',
    price NUMERIC(12,2) NOT NULL DEFAULT 0, offer TEXT DEFAULT '', image_url TEXT DEFAULT '',
    sizes TEXT DEFAULT '', stock INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW())`);
  // Ensure every column used by the current API exists, even on legacy tables.
  await query("ALTER TABLE products ADD COLUMN IF NOT EXISTS name TEXT");
  await query("ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'other'");
  await query("ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''");
  await query("ALTER TABLE products ADD COLUMN IF NOT EXISTS price NUMERIC(12,2) NOT NULL DEFAULT 0");
  await query("ALTER TABLE products ADD COLUMN IF NOT EXISTS offer TEXT DEFAULT ''");
  await query("ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT ''");
  await query("ALTER TABLE products ADD COLUMN IF NOT EXISTS sizes TEXT DEFAULT ''");
  await query("ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INTEGER NOT NULL DEFAULT 0");
  await query("ALTER TABLE products ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE");
  await query("ALTER TABLE products ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()");
  // Upgrade older products tables created by earlier versions of this app.
  const productCols = await query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'products'");
  const colSet = new Set(productCols.rows.map(r => r.column_name));
  for (const [oldName, newName] of [["product_name","name"],["title","name"],["product_description","description"],["image","image_url"],["size","sizes"],["quantity","stock"],["is_active","active"]]) {
    if (!colSet.has(newName) && colSet.has(oldName)) {
      await query(`ALTER TABLE products RENAME COLUMN "${oldName}" TO "${newName}"`);
      colSet.delete(oldName); colSet.add(newName);
    }
  }
  if (!colSet.has("name")) { await query("ALTER TABLE products ADD COLUMN name TEXT"); colSet.add("name"); }
  if (!colSet.has("category")) await query("ALTER TABLE products ADD COLUMN category TEXT DEFAULT 'other'");
  if (!colSet.has("description")) await query("ALTER TABLE products ADD COLUMN description TEXT DEFAULT ''");
  if (!colSet.has("price")) await query("ALTER TABLE products ADD COLUMN price NUMERIC(12,2) NOT NULL DEFAULT 0");
  if (!colSet.has("offer")) await query("ALTER TABLE products ADD COLUMN offer TEXT DEFAULT ''");
  if (!colSet.has("image_url")) await query("ALTER TABLE products ADD COLUMN image_url TEXT DEFAULT ''");
  if (!colSet.has("sizes")) await query("ALTER TABLE products ADD COLUMN sizes TEXT DEFAULT ''");
  if (!colSet.has("stock")) await query("ALTER TABLE products ADD COLUMN stock INTEGER NOT NULL DEFAULT 0");
  if (!colSet.has("active")) await query("ALTER TABLE products ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE");
  if (!colSet.has("created_at")) await query("ALTER TABLE products ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW()");
  // Legacy databases may have an extra NOT NULL "data" column not used by this app.
  // Give it a safe default so current product inserts can work without deleting legacy data.
  const dataInfo = await query("SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'products' AND column_name = 'data'");
  if (dataInfo.rows.length && dataInfo.rows[0].is_nullable === "NO") {
    const dataType = dataInfo.rows[0].data_type;
    if (dataType === "json" || dataType === "jsonb") {
      await query("ALTER TABLE products ALTER COLUMN data SET DEFAULT '{}'::jsonb");
    } else if (["text", "character varying", "character"].includes(dataType)) {
      await query("ALTER TABLE products ALTER COLUMN data SET DEFAULT ''");
    } else {
      await query("ALTER TABLE products ALTER COLUMN data DROP NOT NULL");
    }
  }
  // Repair legacy numeric IDs that are NOT NULL but have no auto-generated default.
  // Use separate parameterized queries rather than a DO block (node-postgres extended protocol).
  const idInfo = await query("SELECT data_type, column_default, is_identity FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'products' AND column_name = 'id'");
  if (idInfo.rows.length && ["smallint", "integer", "bigint"].includes(idInfo.rows[0].data_type) && !idInfo.rows[0].column_default && idInfo.rows[0].is_identity === "NO") {
    await query("CREATE SEQUENCE IF NOT EXISTS products_id_fix_seq");
    const maxIdResult = await query("SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM products");
    const maxId = Number(maxIdResult.rows[0].max_id);
    await query("SELECT setval('products_id_fix_seq', $1, $2)", [Math.max(maxId, 1), maxId > 0]);
    await query("ALTER TABLE products ALTER COLUMN id SET DEFAULT nextval('products_id_fix_seq')");
    await query("ALTER SEQUENCE products_id_fix_seq OWNED BY products.id");
  }

  await query(`CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY, customer_name TEXT DEFAULT '', phone TEXT DEFAULT '',
    address TEXT DEFAULT '', items JSONB DEFAULT '[]', total NUMERIC(12,2) DEFAULT 0,
    status TEXT DEFAULT 'pending', source TEXT DEFAULT 'messenger', created_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS discounts (
    id BIGSERIAL PRIMARY KEY, psid TEXT, customer_message TEXT, status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS reply_drafts (id BIGSERIAL PRIMARY KEY, psid TEXT NOT NULL, customer_message TEXT DEFAULT '', reply_text TEXT DEFAULT '', product_ids JSONB NOT NULL DEFAULT '[]'::jsonb, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW())`);
}
const adminAuth = (req,res,next) => {
  const secret = process.env.ADMIN_PASSWORD;
  if (!secret) return res.status(503).json({error:"Set ADMIN_PASSWORD in Render environment variables first."});
  const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i,"");
  if (!provided || provided.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(provided),Buffer.from(secret))) {
    return res.status(401).json({error:"Unauthorized"});
  }
  next();
};
async function allProducts(activeOnly=false) {
  if (pool) {
    const r = await query("SELECT * FROM products " + (activeOnly ? "WHERE active=TRUE " : "") + "ORDER BY id DESC");
    return r.rows;
  }
  return memory.products.filter(p => !activeOnly || p.active);
}
async function saveReplyDraft(psid, customerMessage, replyText, products=[]) {
  const productIds = products.map(p => String(p.id));
  if (pool) {
    const r = await query("INSERT INTO reply_drafts(psid,customer_message,reply_text,product_ids,status) VALUES($1,$2,$3,$4::jsonb,'pending') RETURNING *", [String(psid),String(customerMessage||''),String(replyText||''),JSON.stringify(productIds)]);
    return r.rows[0];
  }
  const draft = {id:Date.now(),psid:String(psid),customer_message:String(customerMessage||''),reply_text:String(replyText||''),product_ids:productIds,status:'pending',created_at:new Date().toISOString()};
  memory.drafts.unshift(draft); return draft;
}
async function getReplyDrafts() { return pool ? (await query('SELECT * FROM reply_drafts ORDER BY id DESC LIMIT 200')).rows : memory.drafts; }

async function sendMessenger(psid, text) {
  if (!process.env.PAGE_ACCESS_TOKEN) { console.warn("PAGE_ACCESS_TOKEN missing; cannot send Messenger reply"); return false; }
  const resp = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(process.env.PAGE_ACCESS_TOKEN)}`, {
    method:"POST", headers:{"content-type":"application/json"},
    body:JSON.stringify({recipient:{id:psid},message:{text:String(text).slice(0,1900)}})
  });
  if (!resp.ok) { console.error("Messenger send failed:", await resp.text()); return false; }
  return true;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function sendMessengerImage(psid, imageUrl, productId=null) {
  if (String(imageUrl||"").startsWith("data:image/") && productId) {
    let base = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
    if (base.endsWith("/")) base = base.slice(0,-1);
    if (!base) { console.error("Set PUBLIC_BASE_URL to the public Render URL for gallery image sending"); return false; }
    imageUrl = base + "/product-images/" + encodeURIComponent(productId);
  }
  if (!process.env.PAGE_ACCESS_TOKEN) return false;
  let url;
  try {
    url = new URL(String(imageUrl || ""));
    if (url.protocol !== "https:") return false;
  } catch(e) { console.error("Invalid product image URL:",e.message); return false; }

  // Send catalog images sequentially with a short pause and retry temporary Meta throttling/errors.
  for (let attempt=0; attempt<3; attempt++) {
    try {
      const resp = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(process.env.PAGE_ACCESS_TOKEN)}`, {
        method:"POST", headers:{"content-type":"application/json"},
        body:JSON.stringify({recipient:{id:psid},message:{attachment:{type:"image",payload:{url:url.toString(),is_reusable:true}}}})
      });
      if (resp.ok) return true;
      const errorText = await resp.text();
      console.error("Messenger image send failed (attempt "+(attempt+1)+"):", errorText);
      if (attempt===2 || (resp.status<500 && resp.status!==429)) return false;
    } catch(e) {
      console.error("Messenger image request failed (attempt "+(attempt+1)+"):",e.message);
      if (attempt===2) return false;
    }
    await wait(900*(attempt+1));
  }
  return false;
}
app.get("/product-images/:id",async(req,res)=>{
  try {
    const products=await allProducts(false);
    const p=products.find(x=>String(x.id)===String(req.params.id));
    const match=String(p?.image_url||"").match(new RegExp("^data:(image/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$"));
    if(!match) return res.sendStatus(404);
    res.set("Content-Type",match[1]); res.set("Cache-Control","public, max-age=86400");
    res.send(Buffer.from(match[2],"base64"));
  } catch(e) { console.error("Product image route failed:",e.message); res.sendStatus(500); }
});
function normalizeDigits(value) {
  return String(value).replace(/[০-৯]/g, d => "০১২৩৪৫৬৭৮৯".indexOf(d));
}
function extractBudget(message) {
  const text = normalizeDigits(message).toLowerCase();
  if (!/(মধ্যে|মাঝে|modd?e|modde|moddhe|moddhey|within|under|budget|এর মধ্যে|টাকার মধ্যে)/i.test(text)) return null;
  const match = text.match(/(?:৳\s*)?(\d{2,7})(?:\s*(?:টাকা|টাকার|tk|taka|tkar|takar))?/i);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}
async function showProductsWithinBudget(psid, budget, category=null) {
  const products = (await allProducts(true))
    .filter(p => Number(p.price) > 0 && Number(p.price) <= budget && Number(p.stock ?? 0) > 0 && p.image_url && (!category || String(p.category||"").toLowerCase()===category))
    .sort((a,b) => Number(a.price)-Number(b.price));
  if (!products.length) {
    const available = (await allProducts(true)).filter(p => Number(p.price)>0 && Number(p.stock ?? 0)>0 && p.image_url && (!category || String(p.category||"").toLowerCase()===category));
    const lowest = available.sort((a,b)=>Number(a.price)-Number(b.price))[0];
    const msg = lowest
      ? `দুঃখিত 💗 এখন ${budget} টাকার মধ্যে স্টকে থাকা পোশাক পাইনি। সবচেয়ে কম দামের স্টকে থাকা পোশাক ${Number(lowest.price)} টাকা।`
      : "দুঃখিত 💗 এখন স্টকে থাকা পোশাক পাওয়া যাচ্ছে না। নতুন স্টক যোগ হলে জানাব।";
    await sendMessenger(psid,msg);
    return true;
  }
  const lines = products.map((p,i) => `${i+1}. ${Number(p.price)} টাকা${p.sizes ? " | সাইজ: "+p.sizes : ""}${p.offer ? " | "+p.offer : ""}`);
  await sendMessenger(psid,`অবশ্যই! 💗 ${budget} টাকার মধ্যে স্টকে থাকা ${products.length}টি পোশাক দেখুন:\\n\\n${lines.join("\\n")}\\n\\nপ্রতিটি ডিজাইনের ছবি পাঠানো হচ্ছে 💗`);
  for (const p of products) {
    const ok = await sendMessengerImage(psid,p.image_url,p.id);
    if (!ok) await sendMessenger(psid,`📸 ${p.name} — ${Number(p.price)} টাকা। এই ছবিটি পাঠানো যায়নি; পরের ছবিগুলো পাঠানোর চেষ্টা করছি।`);
    await wait(800);
  }
  return true;
}
function signatureOk(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return false;
  const received = req.headers["x-hub-signature-256"];
  if (!received || !req.rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256",secret).update(req.rawBody).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(received),Buffer.from(expected)); } catch { return false; }
}
async function answerCustomer(message, imageParts=[]) {
  const products = await allProducts(true);
  const catalog = products.map(p => ({
    name:p.name, price:Number(p.price), offer:p.offer||"", sizes:p.sizes||"",
    stock:p.stock, description:p.description||""
  }));
  const prompt = [
    "You are the friendly sales assistant for Fashion Mart.",
    "Reply naturally in the customer's language, especially Bangla. Keep replies concise and helpful.",
    "Sell only women's clothing. Use only the product catalog below for prices, sizes, offers and stock; never invent product details.",
    "If a customer sends a clothing image, describe what you can see and compare it with catalog items. Do not claim an exact match unless supported by the catalog.",
    "If the product or detail is not listed, politely say you will check with the owner.",
    "Never promise a special discount; say you can ask the owner.",
    "Help gather name, phone, delivery address and product/size for an order, but do not claim an order is confirmed until saved by admin.",
    "Product catalog: " + JSON.stringify(catalog)
  ].join("\\n");
  if (process.env.GEMINI_API_KEY) {
    try {
      const parts = [{text: prompt + "\\n\\nCustomer message: " + (message || (imageParts.length ? "এই ছবির পোশাকটি দেখে সাহায্য করুন।" : "হ্যালো"))}];
      for (const image of imageParts) parts.push({inline_data:{mime_type:image.mimeType,data:image.data}});
      // Retry with Google's currently recommended model if Render still has an older model configured.
      const configuredModel = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
      const modelsToTry = configuredModel === "gemini-3.5-flash-lite"
        ? [configuredModel]
        : [configuredModel, "gemini-3.5-flash-lite"];
      for (const model of modelsToTry) {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({
            contents:[{role:"user",parts}],
            generationConfig:{temperature:0.4,maxOutputTokens:300}
          })
        });
        const data = await r.json();
        if (r.ok) {
          const out = data.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("").trim();
          if (out) return out;
          console.error("Gemini returned no text:", JSON.stringify(data).slice(0,500));
          break;
        }
        console.error("Gemini API error (" + model + "):", JSON.stringify(data).slice(0,700));
        if (r.status !== 404) break;
      }
    } catch(e) { console.error("Gemini request error:",e.message); }
  } else {
    console.warn("GEMINI_API_KEY missing; AI replies are disabled. Add GEMINI_API_KEY in Render.");
  }
  if (!products.length) return "আসসালামু আলাইকুম! 💗 Fashion Mart-এ স্বাগতম। নতুন পোশাকের ক্যাটালগ এখনো যোগ করা হয়নি। আপনি কী ধরনের পোশাক খুঁজছেন?";
  if (imageParts.length) return "ছবিটি পেয়েছি 💗 তবে এখন AI সেবা পাওয়া যাচ্ছে না। পোশাকটির দাম ও স্টক নিশ্চিত করতে একটু পরে আবার চেষ্টা করুন।";
  return "ধন্যবাদ 💗 আপনার মেসেজটি পেয়েছি। এই মুহূর্তে AI সেবা পাওয়া যাচ্ছে না—দয়া করে একটু পরে আবার চেষ্টা করুন।";
}
async function getMessengerImages(attachments=[]) {
  const images = [];
  for (const attachment of attachments) {
    if (attachment?.type !== "image" || !attachment.payload?.url) continue;
    try {
      const url = new URL(attachment.payload.url);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || !(
        host === "facebook.com" || host.endsWith(".facebook.com") ||
        host === "fbcdn.net" || host.endsWith(".fbcdn.net") ||
        host === "fbsbx.com" || host.endsWith(".fbsbx.com")
      )) {
        console.warn("Skipping Messenger image with unexpected host");
        continue;
      }
      const response = await fetch(url, {signal:AbortSignal.timeout(8000)});
      if (!response.ok) { console.warn("Could not fetch Messenger image:", response.status); continue; }
      const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const allowedTypes = new Set(["image/jpeg","image/png","image/webp","image/gif"]);
      if (!allowedTypes.has(mimeType)) continue;
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > 4 * 1024 * 1024) { console.warn("Messenger image too large"); continue; }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > 4 * 1024 * 1024) continue;
      images.push({mimeType,data:buffer.toString("base64")});
    } catch(e) { console.warn("Messenger image fetch failed:",e.message); }
  }
  return images.slice(0,2);
}
async function findSimilarKurtis(customerImage) {
  if (!process.env.GEMINI_API_KEY) return null;
  const products = (await allProducts(false))
    .filter(p => p.image_url)
    .filter((p,i,arr) => arr.findIndex(x => x.image_url === p.image_url) === i)
    .slice(0,6);
  const candidates = [];
  for (const product of products) {
    try {
      const imageUrl = String(product.image_url || "");
      const inline = imageUrl.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
      if (inline) {
        candidates.push({product,mimeType:inline[1],data:inline[2]});
        continue;
      }
      const url = new URL(imageUrl);
      if (url.protocol !== "https:") continue;
      const response = await fetch(url, {signal:AbortSignal.timeout(4000)});
      if (!response.ok) continue;
      const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!["image/jpeg","image/png","image/webp","image/gif"].includes(mimeType)) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > 4*1024*1024) continue;
      candidates.push({product,mimeType,data:buffer.toString("base64")});
    } catch(e) { console.warn("Could not prepare catalog photo for matching:",e.message); }
  }
  if (!candidates.length) return null;
  const prompt = [
    "You are a visual fashion catalog matcher.",
    "The first image is the customer's reference clothing photo. The following images are catalog products, each introduced by a numbered label.",
    "Compare clothing type, colors, pattern, embroidery, neckline, sleeves and overall design. Ignore background and model identity.",
    "Return only strong visual matches. Do not match merely because the items are both clothing.",
    "Return valid JSON only: {\\"matches\\":[{\\"index\\":1,\\"confidence\\":0.85}]}",
    "Use 1-based candidate indices. Confidence is 0 to 1. Return at most 3 matches. If no close match, return {\\"matches\\":[]}. Only return confidence 0.68 or higher."
  ].join("\\n");
  const parts = [{text:prompt},{inline_data:{mime_type:customerImage.mimeType,data:customerImage.data}}];
  candidates.forEach((c,i) => {
    parts.push({text:"Catalog item "+(i+1)+", price "+Number(c.product.price)+" BDT"});
    parts.push({inline_data:{mime_type:c.mimeType,data:c.data}});
  });
  const configuredModel = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const models = configuredModel === "gemini-3.5-flash-lite" ? [configuredModel] : [configuredModel,"gemini-3.5-flash-lite"];
  for (const model of models) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({contents:[{role:"user",parts}],generationConfig:{temperature:0.1,maxOutputTokens:180,responseMimeType:"application/json"}}),
        signal:AbortSignal.timeout(12000)
      });
      const data = await response.json();
      if (!response.ok) {
        console.error("Gemini visual matching error ("+model+"):",JSON.stringify(data).slice(0,500));
        if (response.status === 404) continue;
        return null;
      }
      const raw = data.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("").trim() || "";
      const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,""));
      return (Array.isArray(parsed.matches) ? parsed.matches : [])
        .filter(m=>Number.isInteger(Number(m.index)) && Number(m.index)>=1 && Number(m.index)<=candidates.length && Number(m.confidence)>=0.68)
        .sort((a,b)=>Number(b.confidence)-Number(a.confidence))
        .slice(0,3)
        .map(m=>candidates[Number(m.index)-1].product);
    } catch(e) {
      console.error("Gemini visual matching request failed:",e.message);
      return null;
    }
  }
  return null;
}
app.get("/health",(req,res)=>res.json({ok:true,name:"Massage-Ai Messenger Sales Bot",database:!!pool}));
app.get("/webhook",(req,res)=>{
  const mode=req.query["hub.mode"], token=req.query["hub.verify_token"], challenge=req.query["hub.challenge"];
  if(mode==="subscribe" && process.env.META_VERIFY_TOKEN && token===process.env.META_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});
app.post("/webhook",async(req,res)=>{
  if(!signatureOk(req)) return res.sendStatus(403);
  res.sendStatus(200);
  try {
    if(req.body.object!=="page") return;
    for(const entry of req.body.entry||[]) for(const event of entry.messaging||[]) {
      const psid=event.sender?.id, message=event.message;
      if(!psid || !message || message.is_echo) continue;
      const text=String(message.text||"").trim();
      const attachments=Array.isArray(message.attachments)?message.attachments:[];
      const hasImage=attachments.some(a=>a?.type==="image" && a.payload?.url);
      if(!text && !hasImage) continue;
      const category = /2\s*pis|two\s*piece|two-piece|টু\s*পিস|দুই\s*পিস/i.test(text) ? "two-piece" : /kurti|কুর্তি/i.test(text) ? "kurti" : null;
      const budget = text ? extractBudget(text) : null;
      // Default manual mode: prepare drafts and avoid Messenger send attempts while Meta restrictions are active.
      if (String(process.env.MANUAL_MODE || "true").toLowerCase() !== "false") {
        let replyText = ""; let selectedProducts = [];
        if (budget !== null) {
          selectedProducts = (await allProducts(true)).filter(p => Number(p.price)>0 && Number(p.price)<=budget && Number(p.stock ?? 0)>0 && p.image_url && (!category || String(p.category||"").toLowerCase()===category)).sort((a,b)=>Number(a.price)-Number(b.price)).slice(0,10);
          replyText = selectedProducts.length ? "অবশ্যই আপু! 💗 "+budget+" টাকার মধ্যে "+selectedProducts.length+"টি পোশাক পেয়েছি। ছবিগুলোর সঙ্গে দাম ও সাইজ নিচে দেখুন.\n\n"+selectedProducts.map((p,i)=>(i+1)+". "+Number(p.price)+" টাকা"+(p.sizes ? " | সাইজ: "+p.sizes : "")+(p.offer ? " | "+p.offer : "")).join("\n") : "দুঃখিত আপু 💗 "+budget+" টাকার মধ্যে এখন স্টকে থাকা পোশাক পাইনি। একটু বেশি বাজেটের পোশাক দেখতে চাইলে জানান।";
        } else if (hasImage) {
          let customerImages = []; try { customerImages = await getMessengerImages(attachments); } catch(e) { console.warn("Draft image download failed:",e.message); }
          const similar = customerImages.length ? await findSimilarKurtis(customerImages[0]) : null;
          if (similar && similar.length) { selectedProducts=similar; replyText="হ্যাঁ আপু, আপনার ছবির সঙ্গে মিলে এমন ডিজাইন আমাদের ক্যাটালগে পেয়েছি। 💗\n\n"+similar.map((p,i)=>(i+1)+". "+Number(p.price)+" টাকা"+(p.sizes ? " | সাইজ: "+p.sizes : "")).join("\n"); }
          else { selectedProducts=(await allProducts(true)).filter(p=>p.image_url && Number(p.stock ?? 0)>0).slice(0,5); replyText=similar ? "দুঃখিত আপু, এই ডিজাইনটি আমাদের ক্যাটালগে মেলেনি। 💗 বিকল্প হিসেবে নিচের ডিজাইনগুলো দেখতে পারেন।" : "আপু, ছবিটি পেয়েছি 💗 এই মুহূর্তে নিশ্চিতভাবে মিলিয়ে দেখা যায়নি। বিকল্প হিসেবে আমাদের কিছু ডিজাইন দিলাম।"; }
        } else { replyText = await answerCustomer(text); }
        await saveReplyDraft(psid,text,replyText,selectedProducts);
        console.log("Prepared manual reply draft for customer",String(psid).slice(-4));
        continue;
      }
      if (budget !== null) {
        await showProductsWithinBudget(psid,budget,category);
      } else if (hasImage) {
        // Acknowledge immediately so the customer never waits silently for image downloads or AI matching.
        await sendMessenger(psid,"ছবিটি পেয়েছি আপু 💗 ক্যাটালগের সঙ্গে মিলিয়ে দেখছি, একটু অপেক্ষা করুন।");
        try {
          const customerImages = await getMessengerImages(attachments);
          if (!customerImages.length) {
            await sendMessenger(psid,"ছবিটি পেয়েছি আপু 💗 ছবিটি খুলতে সমস্যা হচ্ছে। আপনি চাইলে ক্যাটালগের অন্য ড্রেসগুলো দেখুন।");
            const alternatives = (await allProducts(true)).filter(p=>p.image_url).slice(0,3);
            for (const p of alternatives) { await sendMessengerImage(psid,p.image_url,p.id); await wait(800); }
          } else {
            const similar = await findSimilarKurtis(customerImages[0]);
            if (similar && similar.length) {
              await sendMessenger(psid,"হ্যাঁ আপু, এই ড্রেসটি আমাদের কাছে আছে। 💗");
              for (const p of similar) {
                await sendMessengerImage(psid,p.image_url,p.id);
                await sendMessenger(psid,Number(p.price)+" টাকা"+(p.sizes ? " | সাইজ: "+p.sizes : ""));
                await wait(800);
              }
            } else if (similar && similar.length === 0) {
              await sendMessenger(psid,"দুঃখিত আপু, এই ড্রেসটি আমাদের কালেকশনে নেই। 💗 আপনি চাইলে আমাদের ক্যাটালগের অন্য ছবিগুলো দেখে পছন্দ করতে পারেন।");
              const alternatives = (await allProducts(true)).filter(p=>p.image_url).slice(0,5);
              for (const p of alternatives) { await sendMessengerImage(psid,p.image_url,p.id); await wait(800); }
            } else {
              await sendMessenger(psid,"আপু, ছবিটি পেয়েছি 💗 কিন্তু এই মুহূর্তে ক্যাটালগের সঙ্গে মিলিয়ে দেখতে সমস্যা হচ্ছে। নিচে আমাদের কিছু ড্রেসের ছবি দিলাম।");
              const alternatives = (await allProducts(true)).filter(p=>p.image_url).slice(0,5);
              for (const p of alternatives) { await sendMessengerImage(psid,p.image_url,p.id); await wait(800); }
            }
          }
        } catch (imageError) {
          console.error("Customer photo handling failed:",imageError);
          await sendMessenger(psid,"আপু, ছবিটি পেয়েছি 💗 কিন্তু মিলিয়ে দেখতে সমস্যা হয়েছে। আমাদের ক্যাটালগের অন্য ড্রেসগুলো দেখে নিতে পারেন।");
          try {
            const alternatives = (await allProducts(true)).filter(p=>p.image_url).slice(0,3);
            for (const p of alternatives) { await sendMessengerImage(psid,p.image_url,p.id); await wait(800); }
          } catch (fallbackError) { console.error("Could not send alternative catalog photos:",fallbackError.message); }
        }
      } else if(text && category && /(দেখাও|দেখান|ছবি|pic|photo|show|দাও|দেন|কিনতে|kurti|কুর্তি|2\\s*pis|two\\s*piece)/i.test(text)) {
        const matches=(await allProducts(true)).filter(p=>String(p.category||"").toLowerCase()===category && Number(p.stock??0)>0 && p.image_url);
        if(!matches.length) await sendMessenger(psid, category==="kurti" ? "দুঃখিত 💗 এখন কুর্তি স্টকে নেই।" : "দুঃখিত 💗 এখন টু-পিস স্টকে নেই।");
        else {
          await sendMessenger(psid, (category==="kurti" ? "কুর্তি" : "টু-পিস")+" কালেকশন থেকে "+matches.length+"টি ডিজাইন দেখুন 💗\\n"+matches.map((p,i)=>(i+1)+". "+Number(p.price)+" টাকা"+(p.sizes ? " | সাইজ: "+p.sizes : "")).join("\\n"));
          for(const p of matches) { const ok=await sendMessengerImage(psid,p.image_url,p.id); if(!ok) await sendMessenger(psid,"একটি ছবি পাঠানো যায়নি; বাকি ছবিগুলো পাঠানোর চেষ্টা করছি।"); await wait(800); }
        }
      } else if(text && /discount|ছাড়|কম দাম|দরদাম|দাম কম/i.test(text)) {
        if(pool) await query("INSERT INTO discounts(psid,customer_message) VALUES($1,$2)",[psid,text]);
        else memory.discounts.push({id:Date.now(),psid,customer_message:text,status:"pending"});
        await sendMessenger(psid,"বিশেষ ছাড়ের অনুরোধটি মালিকের কাছে পাঠানোর জন্য নোট করেছি। অনুমতি পেলেই জানাব। 💗");
      } else {
        const images=hasImage ? await getMessengerImages(attachments) : [];
        await sendMessenger(psid,await answerCustomer(text,images));
      }
    }
  } catch(e) { console.error("Webhook processing error:",e); }
});
app.get("/api/products",adminAuth,async(req,res)=>{try{res.json(await allProducts(false));}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/products",adminAuth,async(req,res)=>{
  const {name,category="other",description="",price,offer="",image_url="",sizes="",stock=0,active=true}=req.body||{};
  if(!Number.isFinite(Number(price)) || Number(price)<0) return res.status(400).json({error:"Valid product price required"});
  const productName=String(name||"").trim() || ("ডিজাইন-"+Date.now());
  try {
    // Skip exact duplicate catalog photos so accidental repeated uploads do not multiply products.
    if (image_url) {
      if (pool) {
        const existing = await query("SELECT id FROM products WHERE category=$1 AND image_url=$2 LIMIT 1",[category,image_url]);
        if (existing.rows.length) return res.json({duplicate:true,id:existing.rows[0].id});
      } else {
        const existing = memory.products.find(x=>x.category===category && x.image_url===image_url);
        if (existing) return res.json({duplicate:true,id:existing.id});
      }
    }
    let p;
    if(pool){const r=await query("INSERT INTO products(name,category,description,price,offer,image_url,sizes,stock,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",[productName,category,description,price,offer,image_url,sizes,stock,active]);p=r.rows[0];}
    else {p={id:Date.now(),name:productName,category,description,price:Number(price),offer,image_url,sizes,stock:Number(stock),active:!!active};memory.products.unshift(p);}
    res.status(201).json(p);
  }catch(e){res.status(500).json({error:e.message});}
});
app.delete("/api/products/bulk",adminAuth,async(req,res)=>{
  const raw=req.body?.ids;
  if(!Array.isArray(raw) || !raw.length || raw.length>500) return res.status(400).json({error:"Select between 1 and 500 products"});
  const ids=[...new Set(raw.map(x=>String(x)).filter(x=>/^\d+$/.test(x)))];
  if(!ids.length) return res.status(400).json({error:"No valid product IDs selected"});
  try {
    let deleted=0;
    if(pool) {
      const result=await query("DELETE FROM products WHERE id = ANY($1::bigint[]) RETURNING id",[ids]);
      deleted=result.rowCount;
    } else {
      const before=memory.products.length;
      memory.products=memory.products.filter(p=>!ids.includes(String(p.id)));
      deleted=before-memory.products.length;
    }
    res.json({ok:true,deleted});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete("/api/products/:id",adminAuth,async(req,res)=>{
  try {
    if(pool) {
      const result=await query("DELETE FROM products WHERE id=$1 RETURNING id",[req.params.id]);
      if(!result.rows.length) return res.sendStatus(404);
    } else {
      const index=memory.products.findIndex(p=>String(p.id)===String(req.params.id));
      if(index<0) return res.sendStatus(404);
      memory.products.splice(index,1);
    }
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.patch("/api/products/:id",adminAuth,async(req,res)=>{
  try {
    const keys=["name","category","description","price","offer","image_url","sizes","stock","active"];
    const body=req.body||{}, fields=keys.filter(k=>body[k]!==undefined);
    if(!fields.length) return res.status(400).json({error:"No fields supplied"});
    let p;
    if(pool){const sets=fields.map((k,i)=>`${k}=$${i+1}`).join(",");const vals=fields.map(k=>body[k]);vals.push(req.params.id);const r=await query(`UPDATE products SET ${sets} WHERE id=$${vals.length} RETURNING *`,vals);p=r.rows[0];}
    else {p=memory.products.find(x=>String(x.id)===req.params.id);if(p)Object.assign(p,body);}
    if(!p)return res.sendStatus(404);res.json(p);
  }catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/drafts",adminAuth,async(req,res)=>{try{const drafts=await getReplyDrafts();const products=await allProducts(false);res.json(drafts.map(d=>({...d,products:(Array.isArray(d.product_ids)?d.product_ids:[]).map(id=>products.find(p=>String(p.id)===String(id))).filter(Boolean)})));}catch(e){res.status(500).json({error:e.message});}});
app.patch("/api/drafts/:id",adminAuth,async(req,res)=>{const status=String(req.body?.status||"");if(!["done","dismissed","pending"].includes(status))return res.status(400).json({error:"Invalid status"});try{if(pool){const r=await query("UPDATE reply_drafts SET status=$1 WHERE id=$2 RETURNING *",[status,req.params.id]);if(!r.rows[0])return res.sendStatus(404);res.json(r.rows[0]);}else{const d=memory.drafts.find(x=>String(x.id)===req.params.id);if(!d)return res.sendStatus(404);d.status=status;res.json(d);}}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/orders",adminAuth,async(req,res)=>{try{res.json(pool?(await query("SELECT * FROM orders ORDER BY id DESC LIMIT 200")).rows:memory.orders);}catch(e){res.status(500).json({error:e.message});}});
app.patch("/api/orders/:id",adminAuth,async(req,res)=>{
  const status=String(req.body?.status||"");
  if(!["pending","confirmed","processing","shipped","delivered","cancelled"].includes(status))return res.status(400).json({error:"Invalid status"});
  try{if(pool){const r=await query("UPDATE orders SET status=$1 WHERE id=$2 RETURNING *",[status,req.params.id]);if(!r.rows[0])return res.sendStatus(404);res.json(r.rows[0]);}else{const o=memory.orders.find(x=>String(x.id)===req.params.id);if(!o)return res.sendStatus(404);o.status=status;res.json(o);}}catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/discounts",adminAuth,async(req,res)=>{try{res.json(pool?(await query("SELECT * FROM discounts ORDER BY id DESC LIMIT 200")).rows:memory.discounts);}catch(e){res.status(500).json({error:e.message});}});
app.patch("/api/discounts/:id",adminAuth,async(req,res)=>{
 const status=req.body?.status;if(!["approved","rejected"].includes(status))return res.status(400).json({error:"Use approved or rejected"});
 try{if(pool){const r=await query("UPDATE discounts SET status=$1 WHERE id=$2 RETURNING *",[status,req.params.id]);if(!r.rows[0])return res.sendStatus(404);res.json(r.rows[0]);}else{const d=memory.discounts.find(x=>String(x.id)===req.params.id);if(!d)return res.sendStatus(404);d.status=status;res.json(d);}}catch(e){res.status(500).json({error:e.message});}
});
const port=process.env.PORT||3000;
initDb().then(()=>app.listen(port,"0.0.0.0",()=>console.log("Massage-Ai listening on",port))).catch(e=>{console.error("Database initialization failed:",e);process.exit(1);});
