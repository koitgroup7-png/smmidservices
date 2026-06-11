const Database = require("better-sqlite3");

const db = new Database("./bot.db");

const OLD_ID = 14;
const NEW_ID = 1;

const oldProduct = db.prepare("SELECT * FROM products WHERE id = ?").get(OLD_ID);
const newProduct = db.prepare("SELECT * FROM products WHERE id = ?").get(NEW_ID);

if (!oldProduct) {
  console.log(`❌ Product ID ${OLD_ID} not found.`);
  process.exit(1);
}

if (newProduct) {
  console.log(`❌ Product ID ${NEW_ID} already exists.`);
  console.log("আগে ID 1 product delete/hide না, permanently delete করতে হবে অথবা database fresh করতে হবে।");
  process.exit(1);
}

const tx = db.transaction(() => {
  db.prepare("UPDATE products SET id = ? WHERE id = ?").run(NEW_ID, OLD_ID);

  // যদি এই product এর stock থাকে, stock গুলোর product_id update হবে
  db.prepare("UPDATE stocks SET product_id = ? WHERE product_id = ?").run(NEW_ID, OLD_ID);

  // যদি order history থাকে, relation ঠিক রাখতে update হবে
  db.prepare("UPDATE orders SET product_id = ? WHERE product_id = ?").run(NEW_ID, OLD_ID);

  // next product ID যেন ঠিকভাবে চলে
  db.prepare("UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM products) WHERE name = 'products'").run();
});

tx();

console.log(`✅ Product ID changed from ${OLD_ID} to ${NEW_ID}`);
db.close();