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

const BINANCE_PAY_ID = process.env.BINANCE_PAY_ID;
const USDT_ADDRESS = process.env.USDT_ADDRESS;
const BTC_ADDRESS = process.env.BTC_ADDRESS;
const DATABASE_PATH = process.env.DATABASE_PATH || "./bot.db";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing in .env file");
  process.exit(1);
}

// Create Telegram bot instance and enable session memory for multi-step flows
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

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

// Main customer menu buttons
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("👤 My Profile", "my_profile")],
    [Markup.button.callback("💰 Add Fund", "add_fund")],
    [Markup.button.callback("🛒 Buy Product", "buy_product")],
    [Markup.button.callback("📦 My Orders", "my_orders")],
    [Markup.button.callback("🆘 Support", "support")]
  ]);
}

// Customer navigation/back helpers.
// Callback pages edit the same bot message so old menu messages do not pile up.
function backToMainKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back to Main Menu", "back_main")]]);
}

function productBackKeyboard(productId = null) {
  const rows = [];
  if (productId) rows.push([Markup.button.callback("⬅️ Back to Product", `view_product_${productId}`)]);
  rows.push([Markup.button.callback("⬅️ Back to Products", "buy_product")]);
  rows.push([Markup.button.callback("🏠 Main Menu", "back_main")]);
  return Markup.inlineKeyboard(rows);
}

async function editOrReply(ctx, text, keyboard = null) {
  try {
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      return await ctx.editMessageText(text, keyboard || {});
    }
  } catch (error) {
    if (!String(error.message).includes("message is not modified")) {
      console.error("edit message failed:", error.message);
    }
  }

  return ctx.reply(text, keyboard || {});
}

async function showMainMenu(ctx) {
  const user = createOrGetUser(ctx);
  return editOrReply(
    ctx,
    `Welcome, ${user.first_name || "User"}!\n\n` +
      `Your profile is ready.\n` +
      `Balance: ${Number(user.balance).toFixed(2)} USD`,
    mainMenu()
  );
}

async function showProductList(ctx) {
  const products = db
    .prepare("SELECT * FROM products WHERE status = 'active' ORDER BY id ASC")
    .all();

  if (products.length === 0) {
    return editOrReply(ctx, "❌ No products available right now.", backToMainKeyboard());
  }

  const buttons = products.map((product) => [
    Markup.button.callback(
      `${product.name} - ${Number(product.price).toFixed(2)} USD | Stock: ${getStockCount(product.id)}`,
      `view_product_${product.id}`
    )
  ]);

  buttons.push([Markup.button.callback("⬅️ Back to Main Menu", "back_main")]);
  return editOrReply(ctx, "🛒 Select a product:", Markup.inlineKeyboard(buttons));
}

async function showProductDetails(ctx, productId) {
  const product = db
    .prepare("SELECT * FROM products WHERE id = ? AND status = 'active'")
    .get(productId);

  if (!product) {
    return editOrReply(ctx, "❌ Product not found.", productBackKeyboard());
  }

  const stockCount = getStockCount(productId);

  if (isAreaCodeProduct(product.name)) {
    const buttons = AREA_CODES.map((areaCode) => [
      Markup.button.callback(
        `${areaCode} | Stock: ${getAreaStockCount(productId, areaCode)}`,
        `area_${product.id}_${areaCode}`
      )
    ]);

    buttons.push([Markup.button.callback("⬅️ Back to Products", "buy_product")]);
    buttons.push([Markup.button.callback("🏠 Main Menu", "back_main")]);

    return editOrReply(
      ctx,
      `📦 Product Details\n\n` +
        `Name: ${product.name}\n` +
        `Price: ${Number(product.price).toFixed(2)} USD each\n` +
        `Total Available Stock: ${stockCount}\n\n` +
        `Please select area code:`,
      Markup.inlineKeyboard(buttons)
    );
  }

  return editOrReply(
    ctx,
    `📦 Product Details\n\n` +
      `Name: ${product.name}\n` +
      `Price: ${Number(product.price).toFixed(2)} USD each\n` +
      `Available Stock: ${stockCount}\n\n` +
      `Click Buy Now, then send quantity.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Buy Now", `ask_qty_${product.id}`)],
      [Markup.button.callback("⬅️ Back to Products", "buy_product")],
      [Markup.button.callback("🏠 Main Menu", "back_main")]
    ])
  );
}

// Admin command guide shown by /admin
function adminHelpText() {
  return (
    `🛠 Admin Commands\n\n` +
    `Add Product:\n` +
    `/addproduct Product Name | Price\n\n` +
    `Example:\n` +
    `/addproduct New Gmail | 0.50\n\n` +
    `Add Stock Normal Product:\n` +
    `/addstock ProductID | Stock Data\n\n` +
    `Example:\n` +
    `/addstock 1 | email:password\n\n` +
    `Add Stock Area Code Product:\n` +
    `/addstock ProductID | AreaCode | Stock Data\n\n` +
    `Example:\n` +
    `/addstock 1 | 818 | number1:details\nnumber2:details\n\n` +
    `Area Codes: 818, 650, 415, 646, 347, Random\n\n` +
    `Other Commands:\n` +
    `/admin\n` +
    `/products_admin\n` +
    `/editproduct PRODUCT_ID | New Name | New Price\n` +
    `/offproduct PRODUCT_ID\n` +
    `/onproduct PRODUCT_ID\n` +
    `/deleteproduct PRODUCT_ID\n` +
    `/stocks PRODUCT_ID\n` +
    `/deletestock STOCK_ID\n` +
    `/clearstocks PRODUCT_ID\n` +
    `/orders_admin\n` +
    `/order ORDER_ID\n` +
    `/refund ORDER_ID\n` +
    `/block USER_ID\n` +
    `/unblock USER_ID\n` +
    `/broadcast Your message here\n` +
    `/user USER_ID\n` +
    `/addbalance USER_ID AMOUNT\n` +
    `/cutbalance USER_ID AMOUNT`
  );
}

// /start creates user profile and shows the main menu
bot.start(async (ctx) => {
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

bot.action("back_main", async (ctx) => {
  if (blockGuard(ctx)) return;
  await ctx.answerCbQuery();
  await showMainMenu(ctx);
});

bot.action("back_products", async (ctx) => {
  if (blockGuard(ctx)) return;
  await ctx.answerCbQuery();
  await showProductList(ctx);
});

bot.action("my_profile", async (ctx) => {
  if (blockGuard(ctx)) return;
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
  createOrGetUser(ctx);

  await ctx.answerCbQuery();
  await editOrReply(
    ctx,
    "💰 Add Fund\n\nPlease send amount using this format:\n\n/addfund 10",
    backToMainKeyboard()
  );
});

// Customer starts manual add-fund request using /addfund AMOUNT
bot.command("addfund", (ctx) => {
  if (blockGuard(ctx)) return;
  createOrGetUser(ctx);

  const amount = Number(ctx.message.text.split(" ")[1]);

  if (!amount || amount <= 0) {
    return ctx.reply("❌ Invalid amount.\nExample: /addfund 10");
  }

  ctx.session = ctx.session || {};
  ctx.session.addFundAmount = amount;

  ctx.reply(
    `Amount: ${amount} USD\n\nSelect payment method:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("1️⃣ Binance Pay ID", `pay_binance_${amount}`)],
      [Markup.button.callback("2️⃣ USDT Address", `pay_usdt_${amount}`)],
      [Markup.button.callback("3️⃣ BTC Address", `pay_btc_${amount}`)],
      [Markup.button.callback("⬅️ Back to Main Menu", "back_main")]
    ])
  );
});

bot.action(/^pay_(binance|usdt|btc)_(.+)$/, async (ctx) => {
  if (blockGuard(ctx)) return;
  const method = ctx.match[1];
  const amount = Number(ctx.match[2]);

  let paymentText = "";

  if (method === "binance") {
    paymentText = `Binance Pay ID: ${BINANCE_PAY_ID}`;
  } else if (method === "usdt") {
    paymentText = `USDT Address: ${USDT_ADDRESS}`;
  } else if (method === "btc") {
    paymentText = `BTC Address: ${BTC_ADDRESS}`;
  }

  await ctx.answerCbQuery();
  await editOrReply(
    ctx,
    `✅ Payment Method Selected\n\n` +
      `Amount: ${amount} USD\n` +
      `${paymentText}\n\n` +
      `After payment, submit your TXID using this format:\n\n` +
      `/txid YOUR_TRANSACTION_ID`,
    backToMainKeyboard()
  );

  ctx.session = ctx.session || {};
  ctx.session.pendingAmount = amount;
  ctx.session.pendingMethod = method;
});

bot.command("txid", (ctx) => {
  if (blockGuard(ctx)) return;
  const txid = ctx.message.text.split(" ").slice(1).join(" ").trim();

  if (!txid) {
    return ctx.reply("❌ Please send TXID.\nExample: /txid ABC123XYZ");
  }

  ctx.session = ctx.session || {};
  ctx.session.pendingTxid = txid;

  ctx.reply("📸 Now send your payment screenshot as a photo.");
});

// After TXID, customer sends payment screenshot; request goes to admin for approval
bot.on("photo", (ctx) => {
  if (blockGuard(ctx)) return;
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
        `Status: Pending`
    );

    for (const adminId of ADMIN_IDS) {
      bot.telegram.sendPhoto(adminId, screenshotFileId, {
        caption:
          `💰 New Fund Request\n\n` +
          `Request ID: ${requestId}\n` +
          `User: @${ctx.from.username || "N/A"}\n` +
          `User ID: ${ctx.from.id}\n` +
          `Amount: ${amount} USD\n` +
          `Method: ${method}\n` +
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
      `Current Balance: ${newBalance.toFixed(2)} USD`
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

// Admin adds a new product with price
bot.command("addproduct", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const text = ctx.message.text.replace("/addproduct", "").trim();
  const parts = text.split("|").map((p) => p.trim());

  if (parts.length < 2) {
    return ctx.reply(
      `❌ Wrong format.\n\nUse:\n/addproduct Product Name | Price\n\nExample:\n/addproduct New Gmail | 0.50`
    );
  }

  const name = parts[0];
  const price = Number(parts[1]);

  if (!name || !price || price <= 0) {
    return ctx.reply("❌ Invalid product name or price.");
  }

  const result = db
    .prepare("INSERT INTO products (name, price) VALUES (?, ?)")
    .run(name, price);

  ctx.reply(
    `✅ Product Added\n\n` +
      `Product ID: ${result.lastInsertRowid}\n` +
      `Name: ${name}\n` +
      `Price: ${price} USD`
  );
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

  const needsAreaCode = isAreaCodeProduct(product.name);
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

// Admin edits product name and price
bot.command("editproduct", (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const text = ctx.message.text.replace("/editproduct", "").trim();
  const parts = text.split("|").map((p) => p.trim());

  if (parts.length < 3) {
    return ctx.reply(
      `❌ Wrong format.\n\nUse:\n/editproduct PRODUCT_ID | New Name | New Price\n\nExample:\n/editproduct 10 | New Gmail | 0.50`
    );
  }

  const productId = Number(parts[0]);
  const name = parts[1];
  const price = Number(parts[2]);

  if (!productId || !name || !price || price <= 0) {
    return ctx.reply("❌ Invalid product ID, name, or price.");
  }

  const product = db
    .prepare("SELECT * FROM products WHERE id = ?")
    .get(productId);

  if (!product) {
    return ctx.reply("❌ Product not found.");
  }

  db.prepare("UPDATE products SET name = ?, price = ? WHERE id = ?").run(
    name,
    price,
    productId
  );

  ctx.reply(
    `✅ Product Updated\n\n` +
      `Product ID: ${productId}\n` +
      `Old Name: ${product.name}\n` +
      `New Name: ${name}\n` +
      `Old Price: ${Number(product.price).toFixed(2)} USD\n` +
      `New Price: ${price.toFixed(2)} USD`
  );
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
      ctx.reply(chunk);
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
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ You are not admin.");
  }

  const products = db.prepare("SELECT * FROM products ORDER BY id DESC").all();

  if (products.length === 0) {
    return ctx.reply("No products found.");
  }

  let message = "📦 Product List\n\n";

  for (const product of products) {
    message +=
      `ID: ${product.id}\n` +
      `Name: ${product.name}\n` +
      `Price: ${product.price} USD\n` +
      `Stock: ${getStockCount(product.id)}\n` +
      `Status: ${product.status}\n\n`;
  }

  ctx.reply(message);
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

// =====================
// User Product Purchase
// =====================

// Customer opens product list
bot.action("buy_product", async (ctx) => {
  if (blockGuard(ctx)) return;
  createOrGetUser(ctx);

  await ctx.answerCbQuery();
  await showProductList(ctx);
});

bot.action(/^view_product_(\d+)$/, async (ctx) => {
  if (blockGuard(ctx)) return;
  createOrGetUser(ctx);

  await ctx.answerCbQuery();
  await showProductDetails(ctx, Number(ctx.match[1]));
});

bot.action(/^area_(\d+)_(.+)$/, async (ctx) => {
  if (blockGuard(ctx)) return;
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

  if (stockCount <= 0) {
    return editOrReply(
      ctx,
      `❌ Out of Stock\n\n` +
        `Product: ${product.name}\n` +
        `Area Code: ${areaCode}`,
      productBackKeyboard(productId)
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
      `Available Stock: ${stockCount}\n\n` +
      `Please send quantity using this format:\n\n` +
      `/qty 5`,
    productBackKeyboard(productId)
  );
});

bot.action(/^ask_qty_(\d+)$/, async (ctx) => {
  if (blockGuard(ctx)) return;
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

  if (stockCount <= 0) {
    return editOrReply(
      ctx,
      "❌ Out of Stock\n\nThis product is currently unavailable.",
      productBackKeyboard(productId)
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
      `Available Stock: ${stockCount}\n\n` +
      `Please send quantity using this format:\n\n` +
      `/qty 5`,
    productBackKeyboard(productId)
  );
});

// Customer confirms quantity; bot checks balance/stock and delivers multiple stock lines
bot.command("qty", (ctx) => {
  if (blockGuard(ctx)) return;
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

  const needsAreaCode = isAreaCodeProduct(product.name);

  if (needsAreaCode && !areaCode) {
    return ctx.reply("❌ Please select area code first.");
  }

  const stockCount = needsAreaCode
    ? getAreaStockCount(productId, areaCode)
    : getStockCount(productId);

  if (stockCount < quantity) {
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

    const result = purchaseTransaction();

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
      ctx.reply(deliveryMessage);
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
  await ctx.answerCbQuery();
  await editOrReply(ctx, "🆘 Support: Contact admin.", backToMainKeyboard());
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