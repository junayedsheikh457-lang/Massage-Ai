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
const memory = { products: [], orders: [], discounts: [] };
async function query(sql, params=[]) {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool.query(sql, params);
}
async function initDb() {
  if (!pool) return;
  await query(`CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    price NUMERIC(12,2) NOT NULL DEFAULT 0, offer TEXT DEFAULT '', image_url TEXT DEFAULT '',
    sizes TEXT DEFAULT '', stock INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW())`);
  // Ensure every column used by the current API exists, even on legacy tables.
  await query("ALTER TABLE products ADD COLUMN IF NOT EXISTS name TEXT");
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
async function sendMessenger(psid, text) {
  if (!process.env.PAGE_ACCESS_TOKEN) { console.warn("PAGE_ACCESS_TOKEN missing; cannot send Messenger reply"); return; }
  const resp = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(process.env.PAGE_ACCESS_TOKEN)}`, {
    method:"POST", headers:{"content-type":"application/json"},
    body:JSON.stringify({recipient:{id:psid},message:{text:String(text).slice(0,1900)}})
  });
  if (!resp.ok) console.error("Messenger send failed:", await resp.text());
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
      if(text && /discount|ছাড়|কম দাম|দরদাম|দাম কম/i.test(text)) {
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
  const {name,description="",price,offer="",image_url="",sizes="",stock=0,active=true}=req.body||{};
  if(!name || !Number.isFinite(Number(price)) || Number(price)<0) return res.status(400).json({error:"Valid product name and price required"});
  try {
    let p;
    if(pool){const r=await query("INSERT INTO products(name,description,price,offer,image_url,sizes,stock,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[name,description,price,offer,image_url,sizes,stock,active]);p=r.rows[0];}
    else {p={id:Date.now(),name,description,price:Number(price),offer,image_url,sizes,stock:Number(stock),active:!!active};memory.products.unshift(p);}
    res.status(201).json(p);
  }catch(e){res.status(500).json({error:e.message});}
});
app.patch("/api/products/:id",adminAuth,async(req,res)=>{
  try {
    const keys=["name","description","price","offer","image_url","sizes","stock","active"];
    const body=req.body||{}, fields=keys.filter(k=>body[k]!==undefined);
    if(!fields.length) return res.status(400).json({error:"No fields supplied"});
    let p;
    if(pool){const sets=fields.map((k,i)=>`${k}=$${i+1}`).join(",");const vals=fields.map(k=>body[k]);vals.push(req.params.id);const r=await query(`UPDATE products SET ${sets} WHERE id=$${vals.length} RETURNING *`,vals);p=r.rows[0];}
    else {p=memory.products.find(x=>String(x.id)===req.params.id);if(p)Object.assign(p,body);}
    if(!p)return res.sendStatus(404);res.json(p);
  }catch(e){res.status(500).json({error:e.message});}
});
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
