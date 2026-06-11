SMMID SERVICES BOT

Before running:
1. Open .env
2. Replace only this line with your BotFather token:
   BOT_TOKEN=CLIENT_BOT_TOKEN_HERE

Already added:
- ADMIN_IDS=5378667713
- SUPPORT_ADMIN_LINK=https://t.me/buygv_tn
- CHANNEL_LINK=https://t.me/smmidservices
- WEBSITE_LINK=https://www.smmidservices.com
- Last provided payment methods and QR images

Run:
npm install
node index.js

If PowerShell blocks npm:
npm.cmd install
node index.js

Important:
Run commands from the folder where package.json and index.js are located.
node_modules is not included.


Google Sheet Stock System:
1. Open GOOGLE_SHEET_STOCK_APPS_SCRIPT.txt
2. Copy all code
3. Paste into Google Sheet Apps Script
4. Deploy as Web App: Execute as Me, Who has access Anyone
5. Put Web App URL in .env:
   GOOGLE_SHEET_WEBHOOK_URL=YOUR_URL_HERE
6. Keep SHEET_STOCK_ENABLED=1
7. Create Stock tab with columns:
   Stock ID | Product Name | Area Code | Stock Data | Status | Sold To | Username | Order ID | Sold At
8. Add stock rows with Status=Available.
