import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import dotenv from "dotenv";
import pg from "pg";
dotenv.config();
const { Pool } = pg;
const app = express();
app.use(cors({ origin: process.env.ADMIN_ORIGIN || true }));
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
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
async function answerCustomer(message) {
  const products = await allProducts(true);
  if (process.env.OPENAI_API_KEY) {
    const catalog = products.map(p => ({name:p.name,price:Number(p.price),offer:p.offer||"",sizes:p.sizes||"",stock:p.stock,description:p.description||""}));
    try {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method:"POST", headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,"content-type":"application/json"},
        body:JSON.stringify({model:process.env.OPENAI_MODEL||"gpt-4.1-mini",input:[
          {role:"system",content:[{type:"input_text",text:"You are the friendly sales assistant for Fashion Mart. Sell only women's clothing. Reply naturally in the customer's language, especially Bangla. Use only this product catalog for prices, sizes, offers and stock; never invent product details. If a product/detail is not listed, say you will check with the owner. Never promise a special discount; tell them you can ask the owner and create a pending approval request. Help gather name, phone, delivery address and product/size for an order, but do not claim an order is confirmed until saved by admin. Keep replies concise. Catalog: "+JSON.stringify(catalog)}]},
          {role:"user",content:[{type:"input_text",text:message}]}
        ]})
      });
      const data = await r.json();
      if (r.ok) {
        const out = data.output?.flatMap(x=>x.content||[]).find(x=>x.type==="output_text")?.text;
        if (out) return out;
      } else console.error("OpenAI error:", JSON.stringify(data).slice(0,500));
    } catch(e) { console.error("AI request error",e.message); }
  }
  if (!products.length) return "আসসালামু আলাইকুম! 💗 Fashion Mart-এ স্বাগতম। নতুন পোশাকের ক্যাটালগ এখনো যোগ করা হয়নি। আপনি কী ধরনের পোশাক খুঁজছেন?";
  return "ধন্যবাদ 💗 আপনার পছন্দের পোশাকটির নাম বা ছবি/বর্ণনা দিন। সঠিক দাম ও স্টক দেখে জানাচ্ছি। বিশেষ ছাড়ের জন্য মালিকের অনুমতি নিতে হবে।";
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
      const psid=event.sender?.id, text=event.message?.text;
      if(!psid || !text || event.message?.is_echo) continue;
      if(/discount|ছাড়|কম দাম|দরদাম|দাম কম/i.test(text)) {
        if(pool) await query("INSERT INTO discounts(psid,customer_message) VALUES($1,$2)",[psid,text]);
        else memory.discounts.push({id:Date.now(),psid,customer_message:text,status:"pending"});
        await sendMessenger(psid,"বিশেষ ছাড়ের অনুরোধটি মালিকের কাছে পাঠানোর জন্য নোট করেছি। অনুমতি পেলেই জানাব। 💗");
      } else await sendMessenger(psid,await answerCustomer(text));
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
