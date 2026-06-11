// Load environment variables from .env file
require("dotenv").config();
const http = require("http");
const { Telegraf, Markup, session } = require("telegraf");
const Database = require("better-sqlite3");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const path = require("path");
const fs = require("fs");

const BINANCE_PAY_ID = process.env.BINANCE_PAY_ID || "";
const USDT_TRC20_ADDRESS = process.env.USDT_TRC20_ADDRESS || process.env.USDT_ADDRESS || "";
const BTC_ADDRESS = process.env.BTC_ADDRESS || "";
const ETH_ADDRESS = process.env.ETH_ADDRESS || "";
const BNB_ADDRESS = process.env.BNB_ADDRESS || "";
const LTC_ADDRESS = process.env.LTC_ADDRESS || "";
const SOL_ADDRESS = process.env.SOL_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const XMR_ADDRESS = process.env.XMR_ADDRESS || "";
const DATABASE_PATH = process.env.DATABASE_PATH || "./bot.db";
const GOOGLE_SHEET_WEBHOOK_URL = process.env.GOOGLE_SHEET_WEBHOOK_URL || "";
const SHEET_STOCK_ENABLED = String(process.env.SHEET_STOCK_ENABLED || "1").toLowerCase() === "1" || String(process.env.SHEET_STOCK_ENABLED || "").toLowerCase() === "true";
const SUPPORT_ADMIN_LINK = process.env.SUPPORT_ADMIN_LINK || "https://t.me/buygv_tn";
const CHANNEL_LINK = process.env.CHANNEL_LINK || "https://t.me/smmidservices";
const WEBSITE_LINK = process.env.WEBSITE_LINK || "https://www.smmidservices.com";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing in .env file");
  process.exit(1);
}

// Create Telegram bot instance and enable session memory for multi-step flows
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());


// =====================
// Clean Chat UI Helpers
// =====================
// Keeps only the latest customer interface message visible.
// Reply-keyboard clicks create a user message; we try to delete that too,
// so the chat stays clean and only the updated screen remains.
const lastUiMessageByChat = new Map();

async function safeDeleteMessage(ctx, messageId) {
  if (!ctx.chat || !messageId) return;
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
  } catch (error) {
    // Ignore delete errors: message may be too old, already deleted, or not deletable.
  }
}

function rememberUiMessage(ctx, message) {
  if (!ctx.chat || !message || !message.message_id) return;
  lastUiMessageByChat.set(String(ctx.chat.id), message.message_id);
}

async function cleanupPreviousUi(ctx) {
  if (!ctx.chat) return;
  const chatId = String(ctx.chat.id);
  const lastMessageId = lastUiMessageByChat.get(chatId);
  const currentCallbackMessageId = ctx.callbackQuery?.message?.message_id;

  // If the user pressed an inline Back/Main button and we need to send a new
  // reply-keyboard message, delete the old inline screen first.
  if (currentCallbackMessageId) {
    await safeDeleteMessage(ctx, currentCallbackMessageId);
  }

  if (lastMessageId && lastMessageId !== currentCallbackMessageId) {
    await safeDeleteMessage(ctx, lastMessageId);
  }

  // Delete the user's reply-keyboard click text, e.g. "🛒 Buy Product".
  if (ctx.message?.message_id) {
    await safeDeleteMessage(ctx, ctx.message.message_id);
  }
}


async function cleanReply(ctx, text, keyboard = null) {
  await cleanupPreviousUi(ctx);
  const sent = await ctx.reply(text, keyboard || {});
  rememberUiMessage(ctx, sent);
  return sent;
}

async function cleanReplyWithPhoto(ctx, photoPath, caption, keyboard = null) {
  if (!fs.existsSync(photoPath)) {
    console.error("QR image missing:", photoPath);
    return cleanReply(
      ctx,
      "❌ QR/Barcode image missing. Please check assets/payments folder.",
      backToMainKeyboard()
    );
  }

  const sent = await ctx.replyWithPhoto(
    { source: fs.createReadStream(photoPath) },
    {
      caption,
      ...(keyboard || {})
    }
  );

  // Delete old UI only after the QR image is successfully sent.
  const chatId = String(ctx.chat.id);
  const lastMessageId = lastUiMessageByChat.get(chatId);
  const currentCallbackMessageId = ctx.callbackQuery?.message?.message_id;

  if (currentCallbackMessageId) {
    await safeDeleteMessage(ctx, currentCallbackMessageId);
  }

  if (lastMessageId && lastMessageId !== currentCallbackMessageId) {
    await safeDeleteMessage(ctx, lastMessageId);
  }

  if (ctx.message?.message_id) {
    await safeDeleteMessage(ctx, ctx.message.message_id);
  }

  rememberUiMessage(ctx, sent);
  return sent;
}

// Open SQLite database file
const db = new Database(DATABASE_PATH);

// Create required database tables if they do not exist
// users: customer profiles and balance
// fund_requests: manual add-fund requests with TXID and screenshot
// products: product catalog
// stocks: available/sold stock data
// orders: completed/refunded orders
// balance_logs: every balance change history
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  balance REAL DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fund_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL,
  txid TEXT NOT NULL UNIQUE,
  screenshot_file_id TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  stock_data TEXT NOT NULL,
  status TEXT DEFAULT 'available',
  sold_to TEXT,
  sold_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  price REAL NOT NULL,
  stock_data TEXT NOT NULL,
  status TEXT DEFAULT 'completed',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS balance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  old_balance REAL NOT NULL,
  new_balance REAL NOT NULL,
  reason TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// Migration: add area_code column to stocks table for area-code based products
try {
  db.prepare("ALTER TABLE stocks ADD COLUMN area_code TEXT").run();
} catch (error) {
  // Ignore duplicate column error when column already exists
}


// Migration: add terms_accepted column to users table for Terms & Conditions gate
try {
  db.prepare("ALTER TABLE users ADD COLUMN terms_accepted INTEGER DEFAULT 0").run();
} catch (error) {
  // Ignore duplicate column error when column already exists
}


// Migration: add service/category system columns to products table
try {
  db.prepare("ALTER TABLE products ADD COLUMN service_id INTEGER").run();
} catch (error) {
  // Ignore duplicate column error when column already exists
}

try {
  db.prepare("ALTER TABLE products ADD COLUMN product_type TEXT DEFAULT 'normal'").run();
} catch (error) {
  // Ignore duplicate column error when column already exists
}

// Make old area-code products compatible with the new product_type system
try {
  db.prepare(
    "UPDATE products SET product_type = 'area' WHERE product_type IS NULL OR product_type = ''"
  ).run();
} catch (error) {}

// =====================
// Google Sheet Tracking
// =====================

// Send data to Google Apps Script webhook without breaking bot if sheet is down
async function sendToGoogleSheet(payload) {
  if (!GOOGLE_SHEET_WEBHOOK_URL) return;

  try {
    await fetch(GOOGLE_SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error("Google Sheet tracking failed:", error.message);
  }
}

// Track user visit in Google Sheet
async function trackUserVisit(ctx) {
  const user = createOrGetUser(ctx);

  await sendToGoogleSheet({
    type: "user_visit",
    user_id: String(ctx.from.id),
    username: ctx.from.username ? `@${ctx.from.username}` : "No Username",
    name: ctx.from.first_name || user.first_name || "No Name"
  });
}

// Track successful order in Google Sheet
async function trackOrder(ctx, orderData) {
  await sendToGoogleSheet({
    type: "order",
    order_id: orderData.orderId,
    user_id: String(ctx.from.id),
    username: ctx.from.username ? `@${ctx.from.username}` : "No Username",
    name: ctx.from.first_name || "No Name",
    product: orderData.productName || "",
    quantity: orderData.quantity || "",
    area_code: orderData.areaCode || "",
    price: Number(orderData.totalPrice || 0).toFixed(2),
    payment_status: "Paid",
    delivery_status: "Delivered"
  });
}

// Track Terms & Conditions action in Google Sheet
async function trackTerms(ctx, action) {
  await sendToGoogleSheet({
    type: "terms",
    user_id: String(ctx.from.id),
    username: ctx.from.username ? `@${ctx.from.username}` : "No Username",
    name: ctx.from.first_name || "No Name",
    action
  });
}


// Check whether stock delivery should come from Google Sheet Stock tab
function isSheetStockEnabled() {
  return SHEET_STOCK_ENABLED && Boolean(GOOGLE_SHEET_WEBHOOK_URL);
}

// Display stock count in product menu.
// When sheet stock is enabled, actual stock is controlled by the Google Sheet Stock tab.
function getDisplayStockText(productId, areaCode = null) {
  if (isSheetStockEnabled()) return "Sheet";
  return areaCode ? getAreaStockCount(productId, areaCode) : getStockCount(productId);
}

// Take stock from Google Sheet Stock tab and mark that row as Sold.
// Apps Script must support type: "take_stock_bulk".
async function takeStockFromSheet(ctx, productName, areaCode, orderId, quantity) {
  if (!GOOGLE_SHEET_WEBHOOK_URL) {
    return { success: false, message: "Google Sheet URL missing" };
  }

  try {
    const response = await fetch(GOOGLE_SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "take_stock_bulk",
        product_name: productName,
        area_code: areaCode || "Random",
        order_id: String(orderId),
        quantity: Number(quantity || 1),
        user_id: String(ctx.from.id),
        username: ctx.from.username ? `@${ctx.from.username}` : "No Username",
        name: ctx.from.first_name || "No Name"
      })
    });

    return await response.json();
  } catch (error) {
    console.error("Take stock from sheet failed:", error.message);
    return { success: false, message: error.message };
  }
}



// Check whether the Telegram user is an admin
function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from.id));
}

// Create a user profile on first start, or return existing profile
function createOrGetUser(ctx) {
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username || "";
  const firstName = ctx.from.first_name || "";

  const existing = db
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(telegramId);

  if (existing) {
    db.prepare(
      "UPDATE users SET username = ?, first_name = ? WHERE telegram_id = ?"
    ).run(username, firstName, telegramId);

    return db
      .prepare("SELECT * FROM users WHERE telegram_id = ?")
      .get(telegramId);
  }

  db.prepare(
    "INSERT INTO users (telegram_id, username, first_name) VALUES (?, ?, ?)"
  ).run(telegramId, username, firstName);

  return db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId);
}


// Check if a customer account is blocked
function isUserBlocked(ctx) {
  const user = createOrGetUser(ctx);
  return user.status === "blocked";
}

// Stop blocked customers from using customer-side features
function blockGuard(ctx) {
  if (isUserBlocked(ctx)) {
    ctx.reply("🚫 Your account is blocked. Please contact support.");
    return true;
  }
  return false;
}


// Products that require area code selection before purchase
const AREA_CODE_PRODUCTS = [
  "new google voice",
  "old google voice",
  "credit google voice",
  "new text now",
  "web text now",
  "new text free",
  "web text free",
  "talkatone",
  "text pluse",
  "text plus",
  "textplus",
  "text pluse premium",
  "text plus premium",
  "textplus premium"
];

// Area codes shown to customers for selected products
const AREA_CODES = ["818", "650", "415", "646", "347", "Random"];

function normalizeProductName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\+/g, "plus")
    .replace(/\s+/g, " ")
    .trim();
}

function isAreaCodeProduct(productName) {
  const normalized = normalizeProductName(productName);
  return AREA_CODE_PRODUCTS.some((item) => normalized === item);
}

function getAreaStockCount(productId, areaCode) {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM stocks WHERE product_id = ? AND status = 'available' AND area_code = ?"
    )
    .get(productId, areaCode);

  return row.count || 0;
}

// Count all available stock for a product, including old stock rows without area_code
// Count available unsold stock for a product
function getStockCount(productId) {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM stocks WHERE product_id = ? AND status = 'available'"
    )
    .get(productId);

  return row.count || 0;
}

// =====================
// Dynamic Service + Product Type Helpers
// =====================

function normalizeProductType(type) {
  const value = String(type || "normal").toLowerCase().trim();
  return value === "area" ? "area" : "normal";
}

function isAreaProduct(product) {
  if (!product) return false;

  if (product.product_type) {
    return normalizeProductType(product.product_type) === "area";
  }

  return isAreaCodeProduct(product.name);
}

function getServiceName(serviceId) {
  if (!serviceId) return "Unassigned";

  const service = db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId);
  return service ? service.name : "Unknown Service";
}

function getServiceProductCount(serviceId) {
  if (serviceId === "other") {
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM products WHERE status = 'active' AND service_id IS NULL")
      .get();
    return row.count || 0;
  }

  const row = db
    .prepare("SELECT COUNT(*) AS count FROM products WHERE status = 'active' AND service_id = ?")
    .get(serviceId);
  return row.count || 0;
}

function serviceBackKeyboard(serviceId = null) {
  const rows = [];

  if (serviceId !== null && serviceId !== undefined) {
    rows.push([Markup.button.callback("⬅️ Back to Service Products", `service_${serviceId}`)]);
  }

  rows.push([Markup.button.callback("⬅️ Back to Services", "buy_product")]);
  rows.push([Markup.button.callback("🏠 Main Menu", "back_main")]);
  return Markup.inlineKeyboard(rows);
}


// Terms & Conditions text shown before customer can use the bot
function termsText() {
  return (
    `📜 Terms & Conditions\n\n` +
    `Please read and accept our terms before using this bot.\n\n` +
    `1. All products are digital goods and will be delivered automatically from available stock.\n` +
    `2. Please check product name, price, stock, and area code before purchase.\n` +
    `3. Balance will be deducted automatically after a successful order.\n` +
    `4. Fake payment screenshot, fake TXID, or abuse may result in account block.\n` +
    `5. Refund/replacement is only possible for valid delivery or product issues after admin review.\n` +
    `6. Do not misuse any product or service purchased from this bot.\n` +
    `7. Admin decision is final for refund, replacement, or account actions.\n\n` +
    `Do you agree with these Terms & Conditions?`
  );
}

function termsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ I Agree", "terms_agree")],
    [Markup.button.callback("❌ I Don’t Agree", "terms_decline")]
  ]);
}

function hasAcceptedTerms(ctx) {
  const user = createOrGetUser(ctx);
  return Number(user.terms_accepted || 0) === 1;
}

function termsGuard(ctx) {
  if (!hasAcceptedTerms(ctx)) {
    ctx.reply(termsText(), termsKeyboard());
    return true;
  }

  return false;
}

// Main customer menu buttons shown under the typing box (Reply Keyboard)
function mainMenu() {
  return Markup.keyboard([
    ["👤 My Profile", "💰 Add Fund"],
    ["🛒 Buy Product", "📦 My Orders"],
    ["🆘 Support"]
  ]).resize();
}


const PAYMENT_METHODS = {
  usdt_trc20: {
    label: "USDT TRC20",
    address: USDT_TRC20_ADDRESS,
    imagePath: path.join(__dirname, "assets", "payments", "usdt_trc20.jpg")
  },
  btc: {
    label: "BTC",
    address: BTC_ADDRESS,
    imagePath: path.join(__dirname, "assets", "payments", "btc.jpg")
  },
  eth: {
    label: "ETH",
    address: ETH_ADDRESS,
    imagePath: path.join(__dirname, "assets", "payments", "eth.jpg")
  },
  bnb: {
    label: "BNB",
    address: BNB_ADDRESS,
    imagePath: path.join(__dirname, "assets", "payments", "bnb.jpg")
  },
  ltc: {
    label: "LTC",
    address: LTC_ADDRESS,
    imagePath: path.join(__dirname, "assets", "payments", "ltc.jpg")
  },
  sol: {
    label: "SOL",
    address: SOL_ADDRESS,
    imagePath: path.join(__dirname, "assets", "payments", "sol.jpg")
  },
  usdc: {
    label: "USDC",
    address: USDC_ADDRESS,
    imagePath: path.join(__dirname, "assets", "payments", "usdc.jpg")
  },
  binance_id: {
    label: "Binance ID",
    address: BINANCE_PAY_ID,
    imagePath: path.join(__dirname, "assets", "payments", "binance_id.jpg")
  }
};

function getPaymentMethodConfig(methodKey) {
  return PAYMENT_METHODS[methodKey] || null;
}

function getPaymentMethodLabel(methodKey) {
  return getPaymentMethodConfig(methodKey)?.label || methodKey;
}

function paymentMethodsKeyboard(amount) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("USDT TRC20", "paymethod_usdt_trc20"),
      Markup.button.callback("Binance ID", "paymethod_binance_id")
    ],
    [
      Markup.button.callback("BTC", "paymethod_btc"),
      Markup.button.callback("ETH", "paymethod_eth")
    ],
    [
      Markup.button.callback("BNB", "paymethod_bnb"),
      Markup.button.callback("LTC", "paymethod_ltc")
    ],
    [
      Markup.button.callback("SOL", "paymethod_sol"),
      Markup.button.callback("USDC", "paymethod_usdc")
    ],
    [Markup.button.callback("⬅️ Back to Main Menu", "back_main")]
  ]);
}

function paymentDetailKeyboard(methodKey) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Payment Done", `payment_done_${methodKey}`)],
    [Markup.button.callback("⬅️ Back to Payment Methods", "show_payment_methods")],
    [Markup.button.callback("🏠 Main Menu", "back_main")]
  ]);
}

async function showPaymentMethodDetails(ctx, methodKey, amount) {
  const payment = getPaymentMethodConfig(methodKey);

  if (!payment) {
    return cleanReply(ctx, "❌ Payment method not found.", backToMainKeyboard());
  }

  ctx.session = ctx.session || {};
  ctx.session.pendingAmount = amount;
  ctx.session.pendingMethod = methodKey;

  const caption =
    `💳 Payment Method: ${payment.label}

` +
    `Amount: ${Number(amount).toFixed(2)} USD

` +
    `📌 ${payment.label === "Binance ID" ? "Binance Pay ID" : "Payment Address"}:
` +
    `${payment.address}

` +
    `📷 QR/Barcode and ID/Address are shown together.

` +
    `⚠️ Important:
` +
    `• Send payment only to the selected method/network.
` +
    `• Wrong network payment will not be accepted.

` +
    `After payment, click ✅ Payment Done and send your TXID/Hash.
` +
    `Then send payment screenshot as a photo.`;

  try {
    console.log("Payment method clicked:", methodKey, "Amount:", amount, "Image:", payment.imagePath);
    return await cleanReplyWithPhoto(ctx, payment.imagePath, caption, paymentDetailKeyboard(methodKey));
  } catch (error) {
    console.error("Payment QR send failed:", error);
    return cleanReply(
      ctx,
      `❌ QR/Barcode send failed for ${payment.label}.

` +
        `Address/ID:
${payment.address}

` +
        `Please check assets/payments/${methodKey}.jpg`,
      paymentDetailKeyboard(methodKey)
    );
  }
}

// Customer navigation/back helpers.
// Callback pages edit the same bot message so old menu messages do not pile up.
function backToMainKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back to Main Menu", "back_main")]]);
}

function productBackKeyboard(productId = null, serviceId = null) {
  const rows = [];
  if (productId) rows.push([Markup.button.callback("⬅️ Back to Product", `view_product_${productId}`)]);
  if (serviceId !== null && serviceId !== undefined) {
    rows.push([Markup.button.callback("⬅️ Back to Service Products", `service_${serviceId}`)]);
  }
  rows.push([Markup.button.callback("⬅️ Back to Services", "buy_product")]);
  rows.push([Markup.button.callback("🏠 Main Menu", "back_main")]);
  return Markup.inlineKeyboard(rows);
}

async function editOrReply(ctx, text, keyboard = null) {
  try {
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      const edited = await ctx.editMessageText(text, keyboard || {});
      rememberUiMessage(ctx, ctx.callbackQuery.message);
      return edited;
    }
  } catch (error) {
    if (String(error.message).includes("message is not modified")) {
      rememberUiMessage(ctx, ctx.callbackQuery.message);
      return null;
    }
    console.error("edit message failed:", error.message);
  }

  return cleanReply(ctx, text, keyboard);
}

async function showMainMenu(ctx) {
  const user = createOrGetUser(ctx);
  return cleanReply(
    ctx,
    `Welcome, ${user.first_name || "User"}!

` +
      `Your profile is ready.
` +
      `Balance: ${Number(user.balance).toFixed(2)} USD`,
    mainMenu()
  );
}

async function showServiceList(ctx) {
  const services = db
    .prepare(
      `SELECT s.*, COUNT(p.id) AS product_count
       FROM services s
       LEFT JOIN products p ON p.service_id = s.id AND p.status = 'active'
       WHERE s.status = 'active'
       GROUP BY s.id
       ORDER BY s.id ASC`
    )
    .all();

  const buttons = [];

  for (const service of services) {
    if (service.product_count > 0) {
      buttons.push([
        Markup.button.callback(
          `📁 ${service.name} | ${service.product_count} Products`,
          `service_${service.id}`
        )
      ]);
    }
  }

  const otherCount = getServiceProductCount("other");
  if (otherCount > 0) {
    buttons.push([
      Markup.button.callback(`📦 Other Products | ${otherCount} Products`, "service_other")
    ]);
  }

  if (buttons.length === 0) {
    return editOrReply(ctx, "❌ No products available right now.", backToMainKeyboard());
  }

  buttons.push([Markup.button.callback("⬅️ Back to Main Menu", "back_main")]);
  return editOrReply(ctx, "🛒 Select a service:", Markup.inlineKeyboard(buttons));
}

async function showProductList(ctx) {
  return showServiceList(ctx);
}

async function showProductsByService(ctx, serviceId) {
  let products = [];
  let serviceTitle = "Other Products";

  if (serviceId === "other") {
    products = db
      .prepare("SELECT * FROM products WHERE status = 'active' AND service_id IS NULL ORDER BY id ASC")
      .all();
  } else {
    const service = db.prepare("SELECT * FROM services WHERE id = ? AND status = 'active'").get(serviceId);
    if (!service) {
      return editOrReply(ctx, "❌ Service not found.", serviceBackKeyboard());
    }

    serviceTitle = service.name;
    products = db
      .prepare("SELECT * FROM products WHERE status = 'active' AND service_id = ? ORDER BY id ASC")
      .all(serviceId);
  }

  if (products.length === 0) {
    return editOrReply(ctx, `❌ No active products found in ${serviceTitle}.`, serviceBackKeyboard());
  }

  const buttons = products.map((product) => [
    Markup.button.callback(
      `${isAreaProduct(product) ? "📍" : "📦"} ${product.name} - ${Number(product.price).toFixed(2)} USD | Stock: ${getStockCount(product.id)}`,
      `view_product_${product.id}`
    )
  ]);

  buttons.push([Markup.button.callback("⬅️ Back to Services", "buy_product")]);
  buttons.push([Markup.button.callback("🏠 Main Menu", "back_main")]);

  return editOrReply(ctx, `📁 ${serviceTitle}\n\nSelect a product:`, Markup.inlineKeyboard(buttons));
}

async function showProductDetails(ctx, productId) {
  const product = db.prepare("SELECT * FROM products WHERE id = ? AND status = 'active'").get(productId);

  if (!product) {
    return editOrReply(ctx, "❌ Product not found.", productBackKeyboard());
  }

  const stockCount = getStockCount(productId);
  const serviceId = product.service_id || "other";

  if (isAreaProduct(product)) {
    const buttons = AREA_CODES.map((areaCode) => [
      Markup.button.callback(
        `${areaCode} | Stock: ${getDisplayStockText(productId, areaCode)}`,
        `area_${product.id}_${areaCode}`
      )
    ]);

    buttons.push([Markup.button.callback("⬅️ Back to Service Products", `service_${serviceId}`)]);
    buttons.push([Markup.button.callback("⬅️ Back to Services", "buy_product")]);
    buttons.push([Markup.button.callback("🏠 Main Menu", "back_main")]);

    return editOrReply(
      ctx,
      `📦 Product Details\n\n` +
        `Service: ${getServiceName(product.service_id)}\n` +
        `Name: ${product.name}\n` +
        `Type: Area Code Required\n` +
        `Price: ${Number(product.price).toFixed(2)} USD each\n` +
        `Total Available Stock: ${getDisplayStockText(productId)}\n\n` +
        `Please select area code:`,
      Markup.inlineKeyboard(buttons)
    );
  }

  return editOrReply(
    ctx,
    `📦 Product Details\n\n` +
      `Service: ${getServiceName(product.service_id)}\n` +
      `Name: ${product.name}\n` +
      `Type: Normal\n` +
      `Price: ${Number(product.price).toFixed(2)} USD each\n` +
      `Available Stock: ${getDisplayStockText(productId)}\n\n` +
      `Click Buy Now, then send quantity.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Buy Now", `ask_qty_${product.id}`)],
      [Markup.button.callback("⬅️ Back to Service Products", `service_${serviceId}`)],
      [Markup.button.callback("⬅️ Back to Services", "buy_product")],
      [Markup.button.callback("🏠 Main Menu", "back_main")]
    ])
  );
}

// Admin command guide shown by /admin// Admin command guide shown by /admin
function adminHelpText() {
  return (
    `🛠 Admin Commands\n\n` +
    `Service Management:\n` +
    `/addservice Service Name\n` +
    `/services_admin\n` +
    `/editservice SERVICE_ID | New Name\n` +
    `/offservice SERVICE_ID\n` +
    `/onservice SERVICE_ID\n\n` +
    `Product Management:\n` +
    `/addproduct SERVICE_ID | Product Name | Price | normal/area\n` +
    `Example:\n` +
    `/addproduct 1 | New Google Voice | 3 | area\n` +
    `/addproduct 2 | New Gmail | 0.50 | normal\n\n` +
    `Product Commands:\n` +
    `/products_admin\n` +
    `/editproduct PRODUCT_ID | New Name | New Price | normal/area\n` +
    `/moveproduct PRODUCT_ID | SERVICE_ID\n` +
    `/offproduct PRODUCT_ID\n` +
    `/onproduct PRODUCT_ID\n` +
    `/deleteproduct PRODUCT_ID\n\n` +
    `Stock Normal Product:\n` +
    `/addstock ProductID | Stock Data\n\n` +
    `Stock Area Product:\n` +
    `/addstock ProductID | AreaCode | Stock Data\n\n` +
    `Stock Commands:\n` +
    `/stocks PRODUCT_ID\n` +
    `/stocks PRODUCT_ID 818\n` +
    `/deletestock STOCK_ID\n` +
    `/clearstocks PRODUCT_ID\n\n` +
    `Other Commands:\n` +
    `/admin\n` +
    `/orders_admin\n` +
    `/order ORDER_ID\n` +
    `/refund ORDER_ID\n` +
    `/block USER_ID\n` +
    `/unblock USER_ID\n` +
    `/broadcast Your message here\n` +
    `/user USER_ID\n` +
    `/addbalance USER_ID AMOUNT\n` +
    `/cutbalance USER_ID AMOUNT\n` +
    `/resetterms USER_ID`
  );
}

// /start creates user profile and shows Terms first, then main menu after agreement
bot.start(async (ctx) => {
  const user = createOrGetUser(ctx);
  await trackUserVisit(ctx);

  if (Number(user.terms_accepted || 0) !== 1) {
    return ctx.reply(termsText(), termsKeyboard());
  }

  await showMainMenu(ctx);
});

bot.command("menu", async (ctx) => {
  await showMainMenu(ctx);
});

bot.command("admin", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  ctx.reply(adminHelpText());
});


// Reply Keyboard handlers - same menu text, but buttons stay under the typing box
bot.hears("👤 My Profile", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  const user = createOrGetUser(ctx);

  await cleanReply(
    ctx,
    `👤 My Profile

` +
      `User ID: ${user.telegram_id}
` +
      `Username: @${user.username || "N/A"}
` +
      `Balance: ${Number(user.balance).toFixed(2)} USD
` +
      `Status: ${user.status}`,
    backToMainKeyboard()
  );
});

bot.hears("💰 Add Fund", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  createOrGetUser(ctx);

  ctx.session = ctx.session || {};
  ctx.session.waitingAddFundAmount = true;

  await cleanReply(
    ctx,
    "💰 Add Fund\\n\\nPlease send the amount you want to add.\\n\\nExample: 10",
    backToMainKeyboard()
  );
});

bot.hears("🛒 Buy Product", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  createOrGetUser(ctx);

  await showProductList(ctx);
});

bot.hears("📦 My Orders", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  createOrGetUser(ctx);

  const orders = db
    .prepare(
      "SELECT * FROM orders WHERE telegram_id = ? ORDER BY id DESC LIMIT 10"
    )
    .all(String(ctx.from.id));

  if (orders.length === 0) {
    return cleanReply(ctx, "📦 You have no orders yet.", backToMainKeyboard());
  }

  let message = "📦 My Orders\n\n";

  for (const order of orders) {
    message +=
      `Order ID: ${order.id}\n` +
      `Product: ${order.product_name}\n` +
      `Price: ${Number(order.price).toFixed(2)} USD\n` +
      `Status: ${order.status}\n` +
      `Date: ${order.created_at}\n\n`;
  }

  await cleanReply(ctx, message, backToMainKeyboard());
});

bot.hears("🆘 Support", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;

  await cleanReply(
    ctx,
    `🆘 Support Center

` +
      `Need help? Please contact admin or visit our channel/website.`,
    Markup.inlineKeyboard([
      [Markup.button.url("👤 Contact Admin", SUPPORT_ADMIN_LINK)],
      [Markup.button.url("📢 Join Channel", CHANNEL_LINK)],
      [Markup.button.url("🌐 Website", WEBSITE_LINK)],
      [Markup.button.callback("⬅️ Back to Main Menu", "back_main")]
    ])
  );
});

bot.action("terms_agree", async (ctx) => {
  createOrGetUser(ctx);

  db.prepare("UPDATE users SET terms_accepted = 1 WHERE telegram_id = ?").run(
    String(ctx.from.id)
  );

  await ctx.answerCbQuery("Accepted");
  await trackTerms(ctx, "Agreed");

  await editOrReply(
    ctx,
    `✅ Terms Accepted\n\nWelcome! You can now use the bot.`
  );
  await showMainMenu(ctx);
});

bot.action("terms_decline", async (ctx) => {
  createOrGetUser(ctx);

  await ctx.answerCbQuery("Declined");
  await trackTerms(ctx, "Declined");

  await editOrReply(
    ctx,
    `❌ You did not accept our Terms & Conditions.\n\n` +
      `You cannot use this bot unless you accept the terms.\n\n` +
      `Please press /start again if you want to continue.`
  );
});

bot.action("back_main", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  await ctx.answerCbQuery();
  await showMainMenu(ctx);
});

bot.action("back_products", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  await ctx.answerCbQuery();
  await showProductList(ctx);
});

bot.action("my_profile", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  const user = createOrGetUser(ctx);

  await ctx.answerCbQuery();
  await editOrReply(
    ctx,
    `👤 My Profile\n\n` +
      `User ID: ${user.telegram_id}\n` +
      `Username: @${user.username || "N/A"}\n` +
      `Balance: ${Number(user.balance).toFixed(2)} USD\n` +
      `Status: ${user.status}`,
    backToMainKeyboard()
  );
});

bot.action("add_fund", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  createOrGetUser(ctx);

  ctx.session = ctx.session || {};
  ctx.session.waitingAddFundAmount = true;

  await ctx.answerCbQuery();
  await cleanReply(
    ctx,
    "💰 Add Fund\\n\\nPlease send the amount you want to add.\\n\\nExample: 10",
    backToMainKeyboard()
  );
});


async function showAddFundPaymentMethods(ctx, amount) {
  ctx.session = ctx.session || {};
  ctx.session.addFundAmount = amount;
  ctx.session.pendingAmount = amount;
  ctx.session.pendingMethod = null;
  ctx.session.pendingTxid = null;
  ctx.session.waitingAddFundAmount = false;

  return cleanReply(
    ctx,
    `💰 Add Fund

Amount: ${amount.toFixed(2)} USD

Select payment method:`,
    paymentMethodsKeyboard(amount)
  );
}

bot.on("text", async (ctx, next) => {
  if (!ctx.session?.waitingAddFundAmount) {
    return next();
  }

  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;

  const amount = Number(String(ctx.message.text || "").trim());

  if (!amount || amount <= 0) {
    return cleanReply(
      ctx,
      "❌ Invalid amount.\n\nPlease send only a number.\nExample: 10",
      backToMainKeyboard()
    );
  }

  return showAddFundPaymentMethods(ctx, amount);
});

// Customer starts manual add-fund request using /addfund AMOUNT
bot.command("addfund", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  createOrGetUser(ctx);

  const amount = Number(ctx.message.text.split(" ")[1]);

  if (!amount || amount <= 0) {
    return ctx.reply("❌ Invalid amount.\\nExample: /addfund 10");
  }

  return showAddFundPaymentMethods(ctx, amount);
});


bot.action(/^paymethod_(usdt_trc20|binance_id|btc|eth|bnb|ltc|sol|usdc)$/, async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;

  const methodKey = ctx.match[1];
  const amount = Number(ctx.session?.pendingAmount || ctx.session?.addFundAmount || 0);

  await ctx.answerCbQuery("Loading QR...");

  if (!amount || amount <= 0) {
    return cleanReply(
      ctx,
      "💰 Add Fund\n\nAmount not found. Please send amount again.\n\nExample: 10",
      backToMainKeyboard()
    );
  }

  return showPaymentMethodDetails(ctx, methodKey, amount);
});

bot.action("show_payment_methods", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;

  const amount = Number(ctx.session?.pendingAmount || ctx.session?.addFundAmount || 0);
  await ctx.answerCbQuery();

  if (!amount || amount <= 0) {
    return cleanReply(
      ctx,
      "💰 Add Fund\n\nPlease send amount using this format:\n\n/addfund 10",
      backToMainKeyboard()
    );
  }

  return cleanReply(
    ctx,
    `💰 Add Fund

Amount: ${amount.toFixed(2)} USD

Select payment method:`,
    paymentMethodsKeyboard(amount)
  );
});

bot.action(/^payment_done_(usdt_trc20|binance_id|btc|eth|bnb|ltc|sol|usdc)$/, async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;

  const methodKey = ctx.match[1];
  ctx.session = ctx.session || {};
  ctx.session.pendingMethod = methodKey;

  await ctx.answerCbQuery("Send TXID / Hash");
  return cleanReply(
    ctx,
    `✅ ${getPaymentMethodLabel(methodKey)} selected.

Please send your TXID / Hash using this format:

/txid YOUR_TRANSACTION_ID`,
    backToMainKeyboard()
  );
});

bot.command("txid", (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  const txid = ctx.message.text.split(" ").slice(1).join(" ").trim();

  if (!txid) {
    return ctx.reply("❌ Please send TXID.\nExample: /txid ABC123XYZ");
  }

  ctx.session = ctx.session || {};
  ctx.session.pendingTxid = txid;

  ctx.reply("📸 Now send your payment screenshot as a photo.", mainMenu());
});

// After TXID, customer sends payment screenshot; request goes to admin for approval
bot.on("photo", (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  createOrGetUser(ctx);

  ctx.session = ctx.session || {};

  const amount = ctx.session.pendingAmount;
  const method = ctx.session.pendingMethod;
  const txid = ctx.session.pendingTxid;

  if (!amount || !method || !txid) {
    return ctx.reply("❌ Please start Add Fund first.\nUse: /addfund 10");
  }

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const screenshotFileId = photo.file_id;

  try {
    const result = db
      .prepare(
        `INSERT INTO fund_requests 
        (telegram_id, amount, method, txid, screenshot_file_id) 
        VALUES (?, ?, ?, ?, ?)`
      )
      .run(String(ctx.from.id), amount, method, txid, screenshotFileId);

    const requestId = result.lastInsertRowid;

    ctx.reply(
      `✅ Fund request submitted.\n\n` +
        `Request ID: ${requestId}\n` +
        `Amount: ${amount} USD\n` +
        `Status: Pending`,
      mainMenu()
    );

    for (const adminId of ADMIN_IDS) {
      bot.telegram.sendPhoto(adminId, screenshotFileId, {
        caption:
          `💰 New Fund Request\n\n` +
          `Request ID: ${requestId}\n` +
          `User: @${ctx.from.username || "N/A"}\n` +
          `User ID: ${ctx.from.id}\n` +
          `Amount: ${amount} USD\n` +
          `Method: ${getPaymentMethodLabel(method)}\n` +
          `TXID: ${txid}\n\n` +
          `Status: Pending`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `approve_${requestId}` },
              { text: "❌ Reject", callback_data: `reject_${requestId}` }
            ]
          ]
        }
      });
    }

    ctx.session.pendingAmount = null;
    ctx.session.pendingMethod = null;
    ctx.session.pendingTxid = null;
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return ctx.reply("❌ This TXID has already been used.");
    }

    console.error(error);
    return ctx.reply("❌ Something went wrong. Please try again.");
  }
});

// Admin approves fund request and balance is added safely
bot.action(/^approve_(\d+)$/, (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Unauthorized");
  }

  const requestId = ctx.match[1];

  const request = db
    .prepare("SELECT * FROM fund_requests WHERE id = ?")
    .get(requestId);

  if (!request) {
    return ctx.answerCbQuery("Request not found");
  }

  if (request.status !== "pending") {
    return ctx.answerCbQuery("Already processed");
  }

  const user = db
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(request.telegram_id);

  if (!user) {
    return ctx.answerCbQuery("User not found");
  }

  const oldBalance = Number(user.balance);
  const newBalance = oldBalance + Number(request.amount);

  const approveTransaction = db.transaction(() => {
    db.prepare("UPDATE users SET balance = ? WHERE telegram_id = ?").run(
      newBalance,
      request.telegram_id
    );

    db.prepare(
      "UPDATE fund_requests SET status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(requestId);

    db.prepare(
      `INSERT INTO balance_logs 
      (telegram_id, type, amount, old_balance, new_balance, reason)
      VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      request.telegram_id,
      "add",
      request.amount,
      oldBalance,
      newBalance,
      `Fund request approved #${requestId}`
    );
  });

  approveTransaction();

  ctx.answerCbQuery("Approved");
  ctx.reply(`✅ Fund request #${requestId} approved.`);

  bot.telegram.sendMessage(
    request.telegram_id,
    `✅ Fund Added Successfully\n\n` +
      `Amount: ${request.amount} USD\n` +
      `Current Balance: ${newBalance.toFixed(2)} USD`,
    mainMenu()
  );
});

// Admin rejects fund request; balance is not changed
bot.action(/^reject_(\d+)$/, (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Unauthorized");
  }

  const requestId = ctx.match[1];

  const request = db
    .prepare("SELECT * FROM fund_requests WHERE id = ?")
    .get(requestId);

  if (!request) {
    return ctx.answerCbQuery("Request not found");
  }

  if (request.status !== "pending") {
    return ctx.answerCbQuery("Already processed");
  }

  db.prepare("UPDATE fund_requests SET status = 'rejected' WHERE id = ?").run(
    requestId
  );

  ctx.answerCbQuery("Rejected");
  ctx.reply(`❌ Fund request #${requestId} rejected.`);

  bot.telegram.sendMessage(
    request.telegram_id,
    `❌ Your fund request has been rejected.\nPlease contact support.`
  );
});

// =====================
// Product Admin System
// =====================


// =====================
// Service Admin System
// =====================

bot.command("addservice", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
  const name = ctx.message.text.replace("/addservice", "").trim();
  if (!name) return ctx.reply("Use: /addservice Service Name\n\nExample: /addservice Google Voice");
  const result = db.prepare("INSERT INTO services (name) VALUES (?)").run(name);
  ctx.reply(`✅ Service Added\n\nService ID: ${result.lastInsertRowid}\nName: ${name}`);
});

bot.command("services_admin", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
  const services = db.prepare("SELECT * FROM services ORDER BY id ASC").all();
  if (services.length === 0) return ctx.reply("No services found.\n\nUse: /addservice Google Voice");
  let message = "📁 Service List\n\n";
  for (const service of services) {
    message += `ID: ${service.id}\nName: ${service.name}\nProducts: ${getServiceProductCount(service.id)}\nStatus: ${service.status}\n\n`;
  }
  ctx.reply(message);
});

bot.command("editservice", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
  const parts = ctx.message.text.replace("/editservice", "").trim().split("|").map((p) => p.trim());
  if (parts.length < 2) return ctx.reply("Use: /editservice SERVICE_ID | New Name");
  const serviceId = Number(parts[0]);
  const name = parts[1];
  if (!serviceId || !name) return ctx.reply("❌ Invalid service ID or name.");
  const service = db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId);
  if (!service) return ctx.reply("❌ Service not found.");
  db.prepare("UPDATE services SET name = ? WHERE id = ?").run(name, serviceId);
  ctx.reply(`✅ Service Updated\n\nService ID: ${serviceId}\nOld Name: ${service.name}\nNew Name: ${name}`);
});

bot.command("offservice", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
  const serviceId = Number(ctx.message.text.split(" ")[1]);
  if (!serviceId) return ctx.reply("Use: /offservice SERVICE_ID");
  const service = db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId);
  if (!service) return ctx.reply("❌ Service not found.");
  db.prepare("UPDATE services SET status = 'inactive' WHERE id = ?").run(serviceId);
  ctx.reply(`✅ Service OFF\n\nService ID: ${serviceId}\nName: ${service.name}`);
});

bot.command("onservice", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
  const serviceId = Number(ctx.message.text.split(" ")[1]);
  if (!serviceId) return ctx.reply("Use: /onservice SERVICE_ID");
  const service = db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId);
  if (!service) return ctx.reply("❌ Service not found.");
  db.prepare("UPDATE services SET status = 'active' WHERE id = ?").run(serviceId);
  ctx.reply(`✅ Service ON\n\nService ID: ${serviceId}\nName: ${service.name}`);
});

// Admin adds a new product with service/category and type
// New format: /addproduct SERVICE_ID | Product Name | Price | normal/area
// Old format still works: /addproduct Product Name | Price
bot.command("addproduct", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const text = ctx.message.text.replace("/addproduct", "").trim();
  const parts = text.split("|").map((p) => p.trim());

  if (parts.length < 2) {
    return ctx.reply(
      `❌ Wrong format.\n\n` +
        `Use:\n/addproduct SERVICE_ID | Product Name | Price | normal/area\n\n` +
        `Example:\n/addproduct 1 | New Google Voice | 3 | area\n` +
        `/addproduct 2 | New Gmail | 0.50 | normal`
    );
  }

  let serviceId = null;
  let name = "";
  let price = 0;
  let productType = "normal";

  if (parts.length >= 4 && Number(parts[0])) {
    serviceId = Number(parts[0]);
    name = parts[1];
    price = Number(parts[2]);
    productType = normalizeProductType(parts[3]);
    const service = db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId);
    if (!service) return ctx.reply("❌ Service not found. Use /services_admin to see Service ID.");
  } else {
    name = parts[0];
    price = Number(parts[1]);
    productType = isAreaCodeProduct(name) ? "area" : "normal";
  }

  if (!name || !price || price <= 0) return ctx.reply("❌ Invalid product name or price.");

  const result = db.prepare("INSERT INTO products (service_id, name, price, product_type) VALUES (?, ?, ?, ?)").run(serviceId, name, price, productType);
  ctx.reply(`✅ Product Added\n\nProduct ID: ${result.lastInsertRowid}\nService: ${getServiceName(serviceId)}\nName: ${name}\nType: ${productType}\nPrice: ${price} USD`);
});

// Admin adds one or many stock lines to a product
// Normal product format: /addstock ProductID | Stock Data
// Area-code product format: /addstock ProductID | AreaCode | Stock Data
bot.command("addstock", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const text = ctx.message.text.replace("/addstock", "").trim();
  const parts = text.split("|").map((p) => p.trim());

  if (parts.length < 2) {
    return ctx.reply(
      `❌ Wrong format.\n\n` +
        `Normal Product:\n/addstock ProductID | Stock Data\n\n` +
        `Area Code Product:\n/addstock ProductID | AreaCode | Stock Data\n\n` +
        `Example:\n/addstock 10 | 818 | number1:details\nnumber2:details`
    );
  }

  const productId = Number(parts[0]);

  if (!productId) {
    return ctx.reply("❌ Invalid product ID.");
  }

  const product = db
    .prepare("SELECT * FROM products WHERE id = ?")
    .get(productId);

  if (!product) {
    return ctx.reply("❌ Product not found.");
  }

  const needsAreaCode = isAreaProduct(product);
  let areaCode = null;
  let stockText = "";

  if (needsAreaCode) {
    if (parts.length < 3) {
      return ctx.reply(
        `❌ This product needs area code stock.\n\n` +
          `Use:\n/addstock ${productId} | 818 | stock1\nstock2\n\n` +
          `Allowed area codes: ${AREA_CODES.join(", ")}`
      );
    }

    areaCode = parts[1];

    const validArea = AREA_CODES.some(
      (code) => code.toLowerCase() === areaCode.toLowerCase()
    );

    if (!validArea) {
      return ctx.reply(
        `❌ Invalid area code.\n\nAllowed area codes:\n${AREA_CODES.join(", ")}`
      );
    }

    const matchedArea = AREA_CODES.find(
      (code) => code.toLowerCase() === areaCode.toLowerCase()
    );
    areaCode = matchedArea;

    stockText = parts.slice(2).join("|").trim();
  } else {
    stockText = parts.slice(1).join("|").trim();
  }

  if (!stockText) {
    return ctx.reply("❌ Stock data is empty.");
  }

  const stockLines = stockText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (stockLines.length === 0) {
    return ctx.reply("❌ No valid stock lines found.");
  }

  const insertStock = db.prepare(
    "INSERT INTO stocks (product_id, stock_data, area_code) VALUES (?, ?, ?)"
  );

  const addStockTransaction = db.transaction((lines) => {
    for (const line of lines) {
      insertStock.run(productId, line, areaCode);
    }
  });

  addStockTransaction(stockLines);

  ctx.reply(
    `✅ Stock Added\n\n` +
      `Product: ${product.name}\n` +
      `${needsAreaCode ? `Area Code: ${areaCode}\n` : ""}` +
      `Added Stock: ${stockLines.length}\n` +
      `Available Stock: ${getStockCount(productId)}`
  );
});

// Admin edits product name, price, and optional product type
bot.command("editproduct", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
  const parts = ctx.message.text.replace("/editproduct", "").trim().split("|").map((p) => p.trim());
  if (parts.length < 3) return ctx.reply(`❌ Wrong format.\n\nUse:\n/editproduct PRODUCT_ID | New Name | New Price | normal/area`);
  const productId = Number(parts[0]);
  const name = parts[1];
  const price = Number(parts[2]);
  const productType = parts[3] ? normalizeProductType(parts[3]) : null;
  if (!productId || !name || !price || price <= 0) return ctx.reply("❌ Invalid product ID, name, or price.");
  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(productId);
  if (!product) return ctx.reply("❌ Product not found.");
  if (productType) {
    db.prepare("UPDATE products SET name = ?, price = ?, product_type = ? WHERE id = ?").run(name, price, productType, productId);
  } else {
    db.prepare("UPDATE products SET name = ?, price = ? WHERE id = ?").run(name, price, productId);
  }
  ctx.reply(`✅ Product Updated\n\nProduct ID: ${productId}\nService: ${getServiceName(product.service_id)}\nOld Name: ${product.name}\nNew Name: ${name}\nOld Price: ${Number(product.price).toFixed(2)} USD\nNew Price: ${price.toFixed(2)} USD\nType: ${productType || product.product_type || "normal"}`);
});

bot.command("moveproduct", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
  const parts = ctx.message.text.replace("/moveproduct", "").trim().split("|").map((p) => p.trim());
  if (parts.length < 2) return ctx.reply("Use: /moveproduct PRODUCT_ID | SERVICE_ID");
  const productId = Number(parts[0]);
  const serviceId = Number(parts[1]);
  if (!productId || !serviceId) return ctx.reply("❌ Invalid product ID or service ID.");
  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(productId);
  const service = db.prepare("SELECT * FROM services WHERE id = ?").get(serviceId);
  if (!product) return ctx.reply("❌ Product not found.");
  if (!service) return ctx.reply("❌ Service not found.");
  db.prepare("UPDATE products SET service_id = ? WHERE id = ?").run(serviceId, productId);
  ctx.reply(`✅ Product Moved\n\nProduct ID: ${productId}\nProduct: ${product.name}\nNew Service: ${service.name}`);
});

// Admin hides a product from customer purchase list
bot.command("offproduct", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const productId = Number(ctx.message.text.split(" ")[1]);

  if (!productId) {
    return ctx.reply("Use: /offproduct PRODUCT_ID\n\nExample: /offproduct 10");
  }

  const product = db
    .prepare("SELECT * FROM products WHERE id = ?")
    .get(productId);

  if (!product) {
    return ctx.reply("❌ Product not found.");
  }

  db.prepare("UPDATE products SET status = 'inactive' WHERE id = ?").run(
    productId
  );

  ctx.reply(
    `✅ Product Turned OFF\n\n` +
      `Product ID: ${productId}\n` +
      `Name: ${product.name}\n\n` +
      `Users will not see this product in Buy Product.`
  );
});

// Admin makes a hidden product visible again
bot.command("onproduct", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const productId = Number(ctx.message.text.split(" ")[1]);

  if (!productId) {
    return ctx.reply("Use: /onproduct PRODUCT_ID\n\nExample: /onproduct 10");
  }

  const product = db
    .prepare("SELECT * FROM products WHERE id = ?")
    .get(productId);

  if (!product) {
    return ctx.reply("❌ Product not found.");
  }

  db.prepare("UPDATE products SET status = 'active' WHERE id = ?").run(
    productId
  );

  ctx.reply(
    `✅ Product Turned ON\n\n` +
      `Product ID: ${productId}\n` +
      `Name: ${product.name}\n\n` +
      `Users can now see this product in Buy Product.`
  );
});

// Admin deletes product if no orders exist, otherwise hides it to protect order history
bot.command("deleteproduct", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const productId = Number(ctx.message.text.split(" ")[1]);

  if (!productId) {
    return ctx.reply("Use: /deleteproduct PRODUCT_ID\n\nExample: /deleteproduct 10");
  }

  const product = db
    .prepare("SELECT * FROM products WHERE id = ?")
    .get(productId);

  if (!product) {
    return ctx.reply("❌ Product not found.");
  }

  const orderCountRow = db
    .prepare("SELECT COUNT(*) AS count FROM orders WHERE product_id = ?")
    .get(productId);

  const orderCount = orderCountRow.count || 0;

  if (orderCount > 0) {
    db.prepare("UPDATE products SET status = 'deleted' WHERE id = ?").run(
      productId
    );

    ctx.reply(
      `✅ Product Marked as Deleted\n\n` +
        `Product ID: ${productId}\n` +
        `Name: ${product.name}\n\n` +
        `This product has order history, so it was hidden instead of permanently deleted.`
    );
  } else {
    const deleteTransaction = db.transaction(() => {
      db.prepare("DELETE FROM stocks WHERE product_id = ? AND status = 'available'").run(
        productId
      );
      db.prepare("DELETE FROM products WHERE id = ?").run(productId);
    });

    deleteTransaction();

    ctx.reply(
      `✅ Product Deleted Permanently\n\n` +
        `Product ID: ${productId}\n` +
        `Name: ${product.name}\n\n` +
        `Available stock for this product was also deleted.`
    );
  }
});

// Admin views available stock list with stock IDs
// Use: /stocks PRODUCT_ID
// Area-code product filter: /stocks PRODUCT_ID AREA_CODE
bot.command("stocks", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const args = ctx.message.text.split(" ");
  const productId = Number(args[1]);
  const areaFilter = args[2] ? args[2].trim() : null;

  if (!productId) {
    return ctx.reply("Use: /stocks PRODUCT_ID\n\nExample: /stocks 10\nArea filter: /stocks 10 818");
  }

  const product = db
    .prepare("SELECT * FROM products WHERE id = ?")
    .get(productId);

  if (!product) {
    return ctx.reply("❌ Product not found.");
  }

  let stocks = [];
  let totalAvailable = 0;

  if (areaFilter) {
    stocks = db
      .prepare(
        "SELECT * FROM stocks WHERE product_id = ? AND status = 'available' AND area_code = ? ORDER BY id ASC LIMIT 50"
      )
      .all(productId, areaFilter);

    totalAvailable = getAreaStockCount(productId, areaFilter);
  } else {
    stocks = db
      .prepare(
        "SELECT * FROM stocks WHERE product_id = ? AND status = 'available' ORDER BY id ASC LIMIT 50"
      )
      .all(productId);

    totalAvailable = getStockCount(productId);
  }

  if (stocks.length === 0) {
    return ctx.reply(
      `📦 Stock List\n\n` +
        `Product: ${product.name}\n` +
        `${areaFilter ? `Area Code: ${areaFilter}\n` : ""}` +
        `Available Stock: 0`
    );
  }

  let message =
    `📦 Stock List\n\n` +
    `Product: ${product.name}\n` +
    `${areaFilter ? `Area Code: ${areaFilter}\n` : ""}` +
    `Total Available Stock: ${totalAvailable}\n` +
    `Showing First: ${stocks.length}\n\n`;

  for (const stock of stocks) {
    message +=
      `Stock ID: ${stock.id}\n` +
      `${stock.area_code ? `Area: ${stock.area_code}\n` : ""}` +
      `${stock.stock_data}\n\n`;
  }

  if (message.length > 3900) {
    const chunks = message.match(/[\s\S]{1,3500}/g) || [];
    for (const chunk of chunks) {
      ctx.reply(chunk, mainMenu());
    }
  } else {
    ctx.reply(message);
  }
});

// Admin deletes one available/unsold stock by stock ID
bot.command("deletestock", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const stockId = Number(ctx.message.text.split(" ")[1]);

  if (!stockId) {
    return ctx.reply("Use: /deletestock STOCK_ID\n\nExample: /deletestock 25");
  }

  const stock = db
    .prepare("SELECT * FROM stocks WHERE id = ?")
    .get(stockId);

  if (!stock) {
    return ctx.reply("❌ Stock not found.");
  }

  if (stock.status !== "available") {
    return ctx.reply("❌ This stock is already sold. Sold stock cannot be deleted.");
  }

  db.prepare("DELETE FROM stocks WHERE id = ? AND status = 'available'").run(
    stockId
  );

  ctx.reply(
    `✅ Stock Deleted\n\n` +
      `Stock ID: ${stockId}\n` +
      `Product ID: ${stock.product_id}`
  );
});

// Admin clears all available/unsold stock for a product
bot.command("clearstocks", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const productId = Number(ctx.message.text.split(" ")[1]);

  if (!productId) {
    return ctx.reply("Use: /clearstocks PRODUCT_ID\n\nExample: /clearstocks 10");
  }

  const product = db
    .prepare("SELECT * FROM products WHERE id = ?")
    .get(productId);

  if (!product) {
    return ctx.reply("❌ Product not found.");
  }

  const availableCount = getStockCount(productId);

  if (availableCount === 0) {
    return ctx.reply(
      `📦 No available stock to clear.\n\nProduct: ${product.name}`
    );
  }

  db.prepare(
    "DELETE FROM stocks WHERE product_id = ? AND status = 'available'"
  ).run(productId);

  ctx.reply(
    `✅ Available Stocks Cleared\n\n` +
      `Product: ${product.name}\n` +
      `Deleted Stock: ${availableCount}\n\n` +
      `Note: Sold stock/order history was not deleted.`
  );
});

bot.command("products_admin", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
  const products = db.prepare("SELECT * FROM products ORDER BY id DESC").all();
  if (products.length === 0) return ctx.reply("No products found.");
  let message = "📦 Product List\n\n";
  for (const product of products) {
    message += `ID: ${product.id}\nService: ${getServiceName(product.service_id)}\nName: ${product.name}\nType: ${normalizeProductType(product.product_type)}\nPrice: ${product.price} USD\nStock: ${getStockCount(product.id)}\nStatus: ${product.status}\n\n`;
  }
  if (message.length > 3900) {
    const chunks = message.match(/[\s\S]{1,3500}/g) || [];
    for (const chunk of chunks) ctx.reply(chunk);
  } else {
    ctx.reply(message);
  }
});


// =====================
// User Block + Broadcast System
// =====================

// Admin blocks a user; blocked users cannot add fund, buy, or use customer menu
bot.command("block", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const userId = ctx.message.text.split(" ")[1];

  if (!userId) {
    return ctx.reply("Use: /block USER_ID\n\nExample: /block 123456789");
  }

  const user = db
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(userId);

  if (!user) {
    return ctx.reply("❌ User not found.");
  }

  db.prepare("UPDATE users SET status = 'blocked' WHERE telegram_id = ?").run(
    userId
  );

  ctx.reply(
    `✅ User Blocked\n\n` +
      `User ID: ${userId}\n` +
      `Username: @${user.username || "N/A"}`
  );

  bot.telegram
    .sendMessage(userId, "🚫 Your account has been blocked. Please contact support.")
    .catch(() => {});
});

// Admin unblocks a user
bot.command("unblock", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const userId = ctx.message.text.split(" ")[1];

  if (!userId) {
    return ctx.reply("Use: /unblock USER_ID\n\nExample: /unblock 123456789");
  }

  const user = db
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(userId);

  if (!user) {
    return ctx.reply("❌ User not found.");
  }

  db.prepare("UPDATE users SET status = 'active' WHERE telegram_id = ?").run(
    userId
  );

  ctx.reply(
    `✅ User Unblocked\n\n` +
      `User ID: ${userId}\n` +
      `Username: @${user.username || "N/A"}`
  );

  bot.telegram
    .sendMessage(userId, "✅ Your account has been unblocked. You can use the bot again.")
    .catch(() => {});
});

// Admin broadcasts a message to all active users
bot.command("broadcast", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const message = ctx.message.text.replace("/broadcast", "").trim();

  if (!message) {
    return ctx.reply(
      "Use: /broadcast Your message here\n\nExample:\n/broadcast New stock available now!"
    );
  }

  const users = db
    .prepare("SELECT telegram_id FROM users WHERE status = 'active'")
    .all();

  if (users.length === 0) {
    return ctx.reply("❌ No active users found.");
  }

  let sent = 0;
  let failed = 0;

  await ctx.reply(`📢 Broadcast started...\nTotal active users: ${users.length}`);

  for (const user of users) {
    try {
      await bot.telegram.sendMessage(
        user.telegram_id,
        `📢 Announcement\n\n${message}`
      );
      sent++;
    } catch (error) {
      failed++;
    }
  }

  ctx.reply(
    `✅ Broadcast Finished\n\n` +
      `Sent: ${sent}\n` +
      `Failed: ${failed}\n` +
      `Total: ${users.length}`
  );
});

// Admin command: view one user profile and balance
bot.command("user", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const userId = ctx.message.text.split(" ")[1];

  if (!userId) {
    return ctx.reply("Use: /user USER_ID");
  }

  const user = db
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(userId);

  if (!user) {
    return ctx.reply("❌ User not found.");
  }

  ctx.reply(
    `👤 User Info\n\n` +
      `User ID: ${user.telegram_id}\n` +
      `Username: @${user.username || "N/A"}\n` +
      `Name: ${user.first_name || "N/A"}\n` +
      `Balance: ${Number(user.balance).toFixed(2)} USD\n` +
      `Status: ${user.status}`
  );
});

bot.command("addbalance", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const parts = ctx.message.text.split(" ");
  const userId = parts[1];
  const amount = Number(parts[2]);

  if (!userId || !amount || amount <= 0) {
    return ctx.reply("Use: /addbalance USER_ID AMOUNT");
  }

  const user = db
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(userId);

  if (!user) {
    return ctx.reply("❌ User not found.");
  }

  const oldBalance = Number(user.balance);
  const newBalance = oldBalance + amount;

  db.prepare("UPDATE users SET balance = ? WHERE telegram_id = ?").run(
    newBalance,
    userId
  );

  db.prepare(
    `INSERT INTO balance_logs 
    (telegram_id, type, amount, old_balance, new_balance, reason)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, "add", amount, oldBalance, newBalance, "Admin manual add");

  ctx.reply(
    `✅ Balance Added\n\n` +
      `User ID: ${userId}\n` +
      `Old Balance: ${oldBalance.toFixed(2)} USD\n` +
      `New Balance: ${newBalance.toFixed(2)} USD`
  );

  bot.telegram.sendMessage(
    userId,
    `✅ Balance Added by Admin\n\n` +
      `Amount: ${amount} USD\n` +
      `Current Balance: ${newBalance.toFixed(2)} USD`
  );
});

bot.command("cutbalance", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const parts = ctx.message.text.split(" ");
  const userId = parts[1];
  const amount = Number(parts[2]);

  if (!userId || !amount || amount <= 0) {
    return ctx.reply("Use: /cutbalance USER_ID AMOUNT");
  }

  const user = db
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(userId);

  if (!user) {
    return ctx.reply("❌ User not found.");
  }

  const oldBalance = Number(user.balance);

  if (oldBalance < amount) {
    return ctx.reply("❌ User does not have enough balance.");
  }

  const newBalance = oldBalance - amount;

  db.prepare("UPDATE users SET balance = ? WHERE telegram_id = ?").run(
    newBalance,
    userId
  );

  db.prepare(
    `INSERT INTO balance_logs 
    (telegram_id, type, amount, old_balance, new_balance, reason)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, "cut", amount, oldBalance, newBalance, "Admin manual cut");

  ctx.reply(
    `✅ Balance Cut\n\n` +
      `User ID: ${userId}\n` +
      `Old Balance: ${oldBalance.toFixed(2)} USD\n` +
      `New Balance: ${newBalance.toFixed(2)} USD`
  );

  bot.telegram.sendMessage(
    userId,
    `⚠️ Balance Deducted by Admin\n\n` +
      `Amount: ${amount} USD\n` +
      `Current Balance: ${newBalance.toFixed(2)} USD`
  );
});

// Admin can reset a user's Terms agreement for testing/support
bot.command("resetterms", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const userId = ctx.message.text.split(" ")[1];

  if (!userId) {
    return ctx.reply("Use: /resetterms USER_ID");
  }

  db.prepare("UPDATE users SET terms_accepted = 0 WHERE telegram_id = ?").run(
    userId
  );

  ctx.reply(`✅ Terms reset for user: ${userId}`);
});

// =====================
// User Product Purchase
// =====================

// Customer opens product list
bot.action("buy_product", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  createOrGetUser(ctx);

  await ctx.answerCbQuery();
  await showProductList(ctx);
});


bot.action(/^service_(.+)$/, async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  createOrGetUser(ctx);
  const serviceIdRaw = ctx.match[1];
  const serviceId = serviceIdRaw === "other" ? "other" : Number(serviceIdRaw);
  await ctx.answerCbQuery();
  await showProductsByService(ctx, serviceId);
});

bot.action(/^view_product_(\d+)$/, async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  createOrGetUser(ctx);

  await ctx.answerCbQuery();
  await showProductDetails(ctx, Number(ctx.match[1]));
});

bot.action(/^area_(\d+)_(.+)$/, async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  createOrGetUser(ctx);

  const productId = Number(ctx.match[1]);
  const areaCode = ctx.match[2];

  const product = db
    .prepare("SELECT * FROM products WHERE id = ? AND status = 'active'")
    .get(productId);

  await ctx.answerCbQuery();

  if (!product) {
    return editOrReply(ctx, "❌ Product not found.", productBackKeyboard());
  }

  const stockCount = getAreaStockCount(productId, areaCode);

  if (!isSheetStockEnabled() && stockCount <= 0) {
    return editOrReply(
      ctx,
      `❌ Out of Stock\n\n` +
        `Product: ${product.name}\n` +
        `Area Code: ${areaCode}`,
      productBackKeyboard(productId, product.service_id || "other")
    );
  }

  ctx.session = ctx.session || {};
  ctx.session.pendingBuyProductId = productId;
  ctx.session.pendingAreaCode = areaCode;

  await editOrReply(
    ctx,
    `🛒 Quantity Required\n\n` +
      `Product: ${product.name}\n` +
      `Area Code: ${areaCode}\n` +
      `Price: ${Number(product.price).toFixed(2)} USD each\n` +
      `Available Stock: ${getDisplayStockText(productId)}\n\n` +
      `Please send quantity using this format:\n\n` +
      `/qty 5`,
    productBackKeyboard(productId, product.service_id || "other")
  );
});

bot.action(/^ask_qty_(\d+)$/, async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  createOrGetUser(ctx);

  const productId = Number(ctx.match[1]);

  const product = db
    .prepare("SELECT * FROM products WHERE id = ? AND status = 'active'")
    .get(productId);

  await ctx.answerCbQuery();

  if (!product) {
    return editOrReply(ctx, "❌ Product not found.", productBackKeyboard());
  }

  const stockCount = getStockCount(productId);

  if (!isSheetStockEnabled() && stockCount <= 0) {
    return editOrReply(
      ctx,
      "❌ Out of Stock\n\nThis product is currently unavailable.",
      productBackKeyboard(productId, product.service_id || "other")
    );
  }

  ctx.session = ctx.session || {};
  ctx.session.pendingBuyProductId = productId;
  ctx.session.pendingAreaCode = null;

  await editOrReply(
    ctx,
    `🛒 Quantity Required\n\n` +
      `Product: ${product.name}\n` +
      `Price: ${Number(product.price).toFixed(2)} USD each\n` +
      `Available Stock: ${getDisplayStockText(productId)}\n\n` +
      `Please send quantity using this format:\n\n` +
      `/qty 5`,
    productBackKeyboard(productId, product.service_id || "other")
  );
});

// Customer confirms quantity; bot checks balance/stock and delivers multiple stock lines
bot.command("qty", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  const user = createOrGetUser(ctx);

  ctx.session = ctx.session || {};

  const productId = ctx.session.pendingBuyProductId;
  const areaCode = ctx.session.pendingAreaCode || null;
  const quantity = Number(ctx.message.text.split(" ")[1]);

  if (!productId) {
    return ctx.reply("❌ Please select a product first.\nGo to 🛒 Buy Product.");
  }

  if (!quantity || quantity <= 0 || !Number.isInteger(quantity)) {
    return ctx.reply("❌ Invalid quantity.\nExample: /qty 5");
  }

  const product = db
    .prepare("SELECT * FROM products WHERE id = ? AND status = 'active'")
    .get(productId);

  if (!product) {
    ctx.session.pendingBuyProductId = null;
    ctx.session.pendingAreaCode = null;
    return ctx.reply("❌ Product not found.");
  }

  const needsAreaCode = isAreaProduct(product);

  if (needsAreaCode && !areaCode) {
    return ctx.reply("❌ Please select area code first.");
  }

  const stockCount = needsAreaCode
    ? getAreaStockCount(productId, areaCode)
    : getStockCount(productId);

  if (!isSheetStockEnabled() && stockCount < quantity) {
    return ctx.reply(
      `❌ Not enough stock.\n\n` +
        `Product: ${product.name}\n` +
        `${areaCode ? `Area Code: ${areaCode}\n` : ""}` +
        `Requested: ${quantity}\n` +
        `Available: ${stockCount}`
    );
  }

  const currentBalance = Number(user.balance);
  const unitPrice = Number(product.price);
  const totalPrice = unitPrice * quantity;

  if (currentBalance < totalPrice) {
    return ctx.reply(
      `❌ Insufficient Balance\n\n` +
        `Product: ${product.name}\n` +
        `${areaCode ? `Area Code: ${areaCode}\n` : ""}` +
        `Price: ${unitPrice.toFixed(2)} USD each\n` +
        `Quantity: ${quantity}\n` +
        `Total Price: ${totalPrice.toFixed(2)} USD\n` +
        `Your Balance: ${currentBalance.toFixed(2)} USD\n\n` +
        `Please add fund first.`
    );
  }

  try {
    const purchaseTransaction = db.transaction(() => {
      const freshUser = db
        .prepare("SELECT * FROM users WHERE telegram_id = ?")
        .get(String(ctx.from.id));

      const freshBalance = Number(freshUser.balance);

      if (freshBalance < totalPrice) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      let stocks = [];

      if (needsAreaCode) {
        stocks = db
          .prepare(
            "SELECT * FROM stocks WHERE product_id = ? AND status = 'available' AND area_code = ? ORDER BY id ASC LIMIT ?"
          )
          .all(productId, areaCode, quantity);
      } else {
        stocks = db
          .prepare(
            "SELECT * FROM stocks WHERE product_id = ? AND status = 'available' ORDER BY id ASC LIMIT ?"
          )
          .all(productId, quantity);
      }

      if (stocks.length < quantity) {
        throw new Error("OUT_OF_STOCK");
      }

      const newBalance = freshBalance - totalPrice;
      const deliveryText = stocks.map((stock) => stock.stock_data).join("\n");

      db.prepare("UPDATE users SET balance = ? WHERE telegram_id = ?").run(
        newBalance,
        String(ctx.from.id)
      );

      const updateStock = db.prepare(
        "UPDATE stocks SET status = 'sold', sold_to = ?, sold_at = CURRENT_TIMESTAMP WHERE id = ?"
      );

      for (const stock of stocks) {
        updateStock.run(String(ctx.from.id), stock.id);
      }

      const orderProductName = areaCode
        ? `${product.name} - Area ${areaCode}`
        : product.name;

      const orderResult = db
        .prepare(
          `INSERT INTO orders 
          (telegram_id, product_id, product_name, price, stock_data)
          VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          String(ctx.from.id),
          product.id,
          orderProductName,
          totalPrice,
          deliveryText
        );

      db.prepare(
        `INSERT INTO balance_logs 
        (telegram_id, type, amount, old_balance, new_balance, reason)
        VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        String(ctx.from.id),
        "cut",
        totalPrice,
        freshBalance,
        newBalance,
        `Order #${orderResult.lastInsertRowid} purchase quantity ${quantity}`
      );

      return {
        orderId: orderResult.lastInsertRowid,
        deliveryText,
        newBalance
      };
    });


    const purchaseFromSheetStock = async () => {
      const orderProductName = areaCode
        ? `${product.name} - Area ${areaCode}`
        : product.name;

      const pendingOrder = db
        .prepare(
          `INSERT INTO orders 
          (telegram_id, product_id, product_name, price, stock_data, status)
          VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          String(ctx.from.id),
          product.id,
          orderProductName,
          totalPrice,
          "Pending Sheet Stock",
          "pending"
        );

      const orderId = pendingOrder.lastInsertRowid;

      const sheetStock = await takeStockFromSheet(
        ctx,
        product.name,
        areaCode || "Random",
        orderId,
        quantity
      );

      if (!sheetStock.success) {
        db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
        throw new Error("OUT_OF_STOCK");
      }

      let deliveryItems = [];

      if (Array.isArray(sheetStock.stocks)) {
        deliveryItems = sheetStock.stocks
          .map((item) => (typeof item === "string" ? item : item.stock_data))
          .filter(Boolean);
      } else if (sheetStock.stock_data) {
        deliveryItems = [sheetStock.stock_data];
      }

      if (deliveryItems.length < quantity) {
        db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
        throw new Error("OUT_OF_STOCK");
      }

      const deliveryText = deliveryItems.join("\n");

      const finalizeSheetOrder = db.transaction(() => {
        const freshUser = db
          .prepare("SELECT * FROM users WHERE telegram_id = ?")
          .get(String(ctx.from.id));

        const freshBalance = Number(freshUser.balance);

        if (freshBalance < totalPrice) {
          throw new Error("INSUFFICIENT_BALANCE");
        }

        const newBalance = freshBalance - totalPrice;

        db.prepare("UPDATE users SET balance = ? WHERE telegram_id = ?").run(
          newBalance,
          String(ctx.from.id)
        );

        db.prepare("UPDATE orders SET stock_data = ?, status = 'completed' WHERE id = ?").run(
          deliveryText,
          orderId
        );

        db.prepare(
          `INSERT INTO balance_logs 
          (telegram_id, type, amount, old_balance, new_balance, reason)
          VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          String(ctx.from.id),
          "cut",
          totalPrice,
          freshBalance,
          newBalance,
          `Order #${orderId} purchase quantity ${quantity} from Google Sheet`
        );

        return {
          orderId,
          deliveryText,
          newBalance
        };
      });

      return finalizeSheetOrder();
    };

    const result = isSheetStockEnabled()
      ? await purchaseFromSheetStock()
      : purchaseTransaction();

    await trackOrder(ctx, {
      orderId: result.orderId,
      productName: product.name,
      quantity,
      areaCode,
      totalPrice
    });

    ctx.session.pendingBuyProductId = null;
    ctx.session.pendingAreaCode = null;

    const deliveryMessage =
      `✅ Order Successful\n\n` +
      `Order ID: ${result.orderId}\n` +
      `Product: ${product.name}\n` +
      `${areaCode ? `Area Code: ${areaCode}\n` : ""}` +
      `Quantity: ${quantity}\n` +
      `Unit Price: ${unitPrice.toFixed(2)} USD\n` +
      `Total Price: ${totalPrice.toFixed(2)} USD\n` +
      `Remaining Balance: ${result.newBalance.toFixed(2)} USD\n\n` +
      `Your Products:\n${result.deliveryText}`;

    if (deliveryMessage.length > 3900) {
      ctx.reply(
        `✅ Order Successful\n\n` +
          `Order ID: ${result.orderId}\n` +
          `Product: ${product.name}\n` +
          `${areaCode ? `Area Code: ${areaCode}\n` : ""}` +
          `Quantity: ${quantity}\n` +
          `Total Price: ${totalPrice.toFixed(2)} USD\n` +
          `Remaining Balance: ${result.newBalance.toFixed(2)} USD\n\n` +
          `Your Products are too long, sending separately...`
      );

      const chunks = result.deliveryText.match(/[\s\S]{1,3500}/g) || [];
      for (const chunk of chunks) {
        ctx.reply(chunk);
      }
    } else {
      ctx.reply(deliveryMessage, mainMenu());
    }

    for (const adminId of ADMIN_IDS) {
      bot.telegram.sendMessage(
        adminId,
        `🛒 New Order\n\n` +
          `Order ID: ${result.orderId}\n` +
          `User: @${ctx.from.username || "N/A"}\n` +
          `User ID: ${ctx.from.id}\n` +
          `Product: ${product.name}\n` +
          `${areaCode ? `Area Code: ${areaCode}\n` : ""}` +
          `Quantity: ${quantity}\n` +
          `Total Price: ${totalPrice.toFixed(2)} USD`
      );
    }
  } catch (error) {
    if (error.message === "INSUFFICIENT_BALANCE") {
      return ctx.reply("❌ Insufficient balance.");
    }

    if (error.message === "OUT_OF_STOCK") {
      return ctx.reply("❌ Out of stock.");
    }

    console.error(error);
    return ctx.reply("❌ Purchase failed. Please try again.");
  }
});

// =====================
// Admin Order + Refund System
// =====================

// Admin views recent orders
bot.command("orders_admin", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const orders = db
    .prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 20")
    .all();

  if (orders.length === 0) {
    return ctx.reply("📦 No orders found.");
  }

  let message = "📦 Recent Orders\n\n";

  for (const order of orders) {
    message +=
      `Order ID: ${order.id}\n` +
      `User ID: ${order.telegram_id}\n` +
      `Product: ${order.product_name}\n` +
      `Price: ${Number(order.price).toFixed(2)} USD\n` +
      `Status: ${order.status}\n` +
      `Date: ${order.created_at}\n\n`;
  }

  if (message.length > 3900) {
    const chunks = message.match(/[\s\S]{1,3500}/g) || [];
    for (const chunk of chunks) {
      ctx.reply(chunk);
    }
  } else {
    ctx.reply(message);
  }
});

// Admin views full details of one order
bot.command("order", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const orderId = Number(ctx.message.text.split(" ")[1]);

  if (!orderId) {
    return ctx.reply("Use: /order ORDER_ID\n\nExample: /order 5");
  }

  const order = db
    .prepare("SELECT * FROM orders WHERE id = ?")
    .get(orderId);

  if (!order) {
    return ctx.reply("❌ Order not found.");
  }

  const message =
    `📦 Order Details\n\n` +
    `Order ID: ${order.id}\n` +
    `User ID: ${order.telegram_id}\n` +
    `Product ID: ${order.product_id}\n` +
    `Product: ${order.product_name}\n` +
    `Price: ${Number(order.price).toFixed(2)} USD\n` +
    `Status: ${order.status}\n` +
    `Date: ${order.created_at}\n\n` +
    `Delivered Stock:\n${order.stock_data}`;

  if (message.length > 3900) {
    const chunks = message.match(/[\s\S]{1,3500}/g) || [];
    for (const chunk of chunks) {
      ctx.reply(chunk);
    }
  } else {
    ctx.reply(message);
  }
});

// Admin refunds an order amount to customer balance; stock is not restored
bot.command("refund", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const orderId = Number(ctx.message.text.split(" ")[1]);

  if (!orderId) {
    return ctx.reply("Use: /refund ORDER_ID\n\nExample: /refund 5");
  }

  const order = db
    .prepare("SELECT * FROM orders WHERE id = ?")
    .get(orderId);

  if (!order) {
    return ctx.reply("❌ Order not found.");
  }

  if (order.status === "refunded") {
    return ctx.reply("❌ This order is already refunded.");
  }

  const user = db
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(order.telegram_id);

  if (!user) {
    return ctx.reply("❌ User not found.");
  }

  const refundAmount = Number(order.price);
  const oldBalance = Number(user.balance);
  const newBalance = oldBalance + refundAmount;

  const refundTransaction = db.transaction(() => {
    db.prepare("UPDATE users SET balance = ? WHERE telegram_id = ?").run(
      newBalance,
      order.telegram_id
    );

    db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(
      orderId
    );

    db.prepare(
      `INSERT INTO balance_logs 
      (telegram_id, type, amount, old_balance, new_balance, reason)
      VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      order.telegram_id,
      "refund",
      refundAmount,
      oldBalance,
      newBalance,
      `Refund for order #${orderId}`
    );
  });

  refundTransaction();

  ctx.reply(
    `✅ Refund Successful\n\n` +
      `Order ID: ${orderId}\n` +
      `User ID: ${order.telegram_id}\n` +
      `Refund Amount: ${refundAmount.toFixed(2)} USD\n` +
      `New Balance: ${newBalance.toFixed(2)} USD`
  );

  bot.telegram.sendMessage(
    order.telegram_id,
    `✅ Refund Received\n\n` +
      `Order ID: ${orderId}\n` +
      `Refund Amount: ${refundAmount.toFixed(2)} USD\n` +
      `Current Balance: ${newBalance.toFixed(2)} USD`
  );
});

bot.action("my_orders", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;
  createOrGetUser(ctx);

  const orders = db
    .prepare(
      "SELECT * FROM orders WHERE telegram_id = ? ORDER BY id DESC LIMIT 10"
    )
    .all(String(ctx.from.id));

  await ctx.answerCbQuery();

  if (orders.length === 0) {
    return editOrReply(ctx, "📦 You have no orders yet.", backToMainKeyboard());
  }

  let message = "📦 My Orders\n\n";

  for (const order of orders) {
    message +=
      `Order ID: ${order.id}\n` +
      `Product: ${order.product_name}\n` +
      `Price: ${Number(order.price).toFixed(2)} USD\n` +
      `Status: ${order.status}\n` +
      `Date: ${order.created_at}\n\n`;
  }

  await editOrReply(ctx, message, backToMainKeyboard());
});

bot.action("support", async (ctx) => {
  if (blockGuard(ctx)) return;
  if (termsGuard(ctx)) return;

  await ctx.answerCbQuery();

  await editOrReply(
    ctx,
    `🆘 Support Center\n\n` +
      `Need help? Please contact admin or visit our channel/website.`,
    Markup.inlineKeyboard([
      [Markup.button.url("👤 Contact Admin", SUPPORT_ADMIN_LINK)],
      [Markup.button.url("📢 Join Channel", CHANNEL_LINK)],
      [Markup.button.url("🌐 Website", WEBSITE_LINK)],
      [Markup.button.callback("⬅️ Back to Main Menu", "back_main")]
    ])
  );
});


// Render/UptimeRobot health server
const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("SmmidServices Bot Running");
  })
  .listen(PORT, () => {
    console.log(`Health server running on port ${PORT}`);
  });

// Start bot polling
bot.launch();

console.log("SmmidServices bot is running...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));