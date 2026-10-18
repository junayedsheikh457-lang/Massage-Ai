# Massage-Ai — Fashion Mart Messenger Sales Assistant

Separate Node.js app for a Facebook Page Messenger webhook and a simple product/order admin panel.

## Features
- Product catalog editable from `/admin.html`
- Messenger webhook verification and signed webhook requests
- AI product answers grounded in the active catalog (OpenAI key optional)
- Discount requests saved for owner approval; the bot does not promise an unapproved discount
- PostgreSQL persistence for products and discount requests
- Order list/status API (orders must be created through a configured order workflow; do not treat chat text alone as a confirmed order)

## Required Render environment variables
- `DATABASE_URL` — Render PostgreSQL **internal** connection string
- `ADMIN_PASSWORD` — strong unique password for the admin panel API
- `META_VERIFY_TOKEN` — random verification token entered in Meta webhook setup
- `META_APP_SECRET` — Meta app secret used to verify webhook signatures
- `PAGE_ACCESS_TOKEN` — Facebook Page access token
- `OPENAI_API_KEY` — optional, for AI answers
- `OPENAI_MODEL` — optional, defaults to `gpt-4.1-mini`

## Run
```sh
npm install
npm start
``

Health check: `/health`; admin: `/admin.html`; webhook: `/webhook`.

## Important setup
1. Deploy this repository as a **new** Render web service, separate from the old Fashion Mart website.
2. Attach a separate PostgreSQL database and set `DATABASE_URL`.
3. Set a strong `ADMIN_PASSWORD` and the Meta/OpenAI credentials as Render environment variables. Never commit secrets to GitHub.
4. In Meta for Developers, configure the Facebook Page Messenger webhook URL as `https://YOUR-RENDER-URL/webhook`, subscribe to `messages` and `messaging_postbacks`, and use the same `META_VERIFY_TOKEN`.
5. The Page owner must grant the required Meta app/Page permissions and complete any required app review. Moderator access alone may not be sufficient.
6. Test with a Page admin/tester before public launch.

This is a starter implementation, not yet a complete order-checkout flow. Keep customer data private and restrict the admin panel to a strong password.
