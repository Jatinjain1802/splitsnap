# SplitSnap

Splitwise-style expense splitter with bill photo OCR. Node.js + Express + SQLite, plain static frontend (no build step).

## Features
- Accounts: email + password signup/login (scrypt hashes, server-side sessions, HttpOnly cookies). Group data is only visible to members.
- Add friends by registered email, or as named guests
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
Env: `PORT`, `DB_FILE` (default `splitsnap.db`), `COOKIE_SECURE=1` when served over HTTPS.
The first OCR call downloads English language data (needs internet once).

## API
`POST /api/signup`, `/api/login`, `/api/logout`, `GET /api/me`, `GET/POST /api/groups`, `GET/DELETE /api/groups/:id`, `POST /api/groups/:id/members`,
`POST /api/groups/:id/expenses`, `DELETE /api/groups/:gid/expenses/:id`,
`POST /api/groups/:id/settlements`, `POST /api/ocr` (multipart field `bill`), `GET /healthz`.

## Scale notes
SQLite in WAL mode with indexes, validated inputs, 8 MB upload cap, per-IP rate limit on OCR, temp files removed after each scan. For many users, swap SQLite for Postgres and run OCR in a worker queue.

## Limits
Guests added by name cannot log in as that guest yet, and there is no password reset, email verification or invite email. Set `COOKIE_SECURE=1` behind HTTPS. SQLite on one server is fine for small to medium use, it is not horizontally scalable. OCR works best on flat, well-lit photos; always check the extracted amounts.
