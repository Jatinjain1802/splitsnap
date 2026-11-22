# SplitSnap

Splitwise-style expense splitter with bill photo OCR. Node.js + Express + SQLite, plain static frontend (no build step).

## Features
- Accounts: email + password signup/login (scrypt hashes, server-side sessions, HttpOnly cookies). Group data is only visible to members.
- Add friends by registered email, or as named guests
- Edit expenses (amount, payer, split, date, category), rename groups, CSV export, group totals
- Multiple currencies: each expense has a currency code and every currency is balanced and settled separately. There is no conversion and no exchange rate, so nothing is invented
- Recurring expenses: weekly or monthly (rent, subscriptions). The first one is saved at once, due ones appear automatically when anyone opens the group, and the creator or group owner can stop a rule
- In-app reminders: the bell shows when someone adds or edits an expense, records a payment, or joins a group. In-app only: no email, SMS or push is sent
- Keep the bill photo with an expense. Photos are stored on the server's disk (`DATA_DIR`, default `./data`), only group members can open them, and they are deleted with the expense
- Guest claim: the group owner makes a one-time link (7 days) for a named guest. Whoever opens it, logs in and confirms becomes that guest and keeps its history. The link is a secret, so send it only to that person
- Groups with friends, add friends any time
- Expenses split equally, by exact amounts, percentages, shares, or item by item
- Bill photo OCR (Tesseract, runs locally, free): extracts items, tax and total, you edit, assign items to friends, save
- Tax and fees are shared in proportion to what each person ordered
- Balances, suggested payments (greedy matching, few transfers but not guaranteed minimal), settle-up, delete expenses
- Money stored as integer paise, so splits always add up exactly

## Run
```
npm install
npm start        # http://localhost:3000
npm test
```
Password reset and email verification only work when a mailer is configured. By default there is none, and those routes answer 501. For local development set `MAIL_MODE=console`: links are printed to the server console and nothing is delivered, so this is NOT real verification. To go live, implement a provider in `lib/mailer.js` and set `APP_URL` to your public https address.

Env: `PORT`, `DATA_DIR`, `APP_URL`, `MAIL_MODE`, `DB_FILE` (default `splitsnap.db`), `COOKIE_SECURE=1` when served over HTTPS.
The first OCR call downloads English language data (needs internet once).

## API
`PUT /api/groups/:gid/expenses/:eid`, `POST|GET /api/groups/:gid/expenses/:eid/receipt`, `GET /api/groups/:id/export.csv`, `POST /api/groups/:id/recurring`, `DELETE /api/groups/:gid/recurring/:rid`, `GET /api/notifications`, `POST /api/notifications/read`, `POST /api/groups/:id/members/:mid/invite`, `POST /api/claim`, `POST /api/password-reset/request|confirm`, `POST /api/verify`, `POST /api/signup`, `/api/login`, `/api/logout`, `GET /api/me`, `GET/POST /api/groups`, `GET/DELETE /api/groups/:id`, `POST /api/groups/:id/members`,
`POST /api/groups/:id/expenses`, `DELETE /api/groups/:gid/expenses/:id`,
`POST /api/groups/:id/settlements`, `POST /api/ocr` (multipart field `bill`), `GET /healthz`.

## Scale notes
SQLite in WAL mode with indexes, validated inputs, 8 MB upload cap, per-IP rate limit on OCR, temp files removed after each scan. For many users, swap SQLite for Postgres and run OCR in a worker queue.

## Limits
No real email delivery is built in (no invite, reset or verification emails until you plug in a mailer). Reminders are in-app only: no push, SMS or email notifications. Currencies are never converted; each currency is its own balance. No cross-group debt simplification, and guests cannot be merged into an existing member. Set `COOKIE_SECURE=1` behind HTTPS. SQLite on one server is fine for small to medium use, it is not horizontally scalable. OCR works best on flat, well-lit photos; always check the extracted amounts.
