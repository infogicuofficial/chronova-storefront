# Chronova BD storefront — Phase 1

Customer-facing React + Vite storefront. The catalogue data is explicitly demo data taken from the supplied legacy HTML; verify it against the owner's real catalogue before launch. The hero is a generated editorial placeholder and is **not** a photo of a Chronova product.

## Run on Windows PowerShell

```powershell
cd chronova-storefront
Copy-Item .env.example .env.local
npm install
npm run dev
```

Open the local URL printed by Vite. For a production build: `npm run build`.

## Integrations / launch gates

- Supabase is optional until credentials/schema are supplied. Without it, orders are demo-only in this browser's local storage and are not shared between customers/devices.
- EmailJS may be used from the browser with its public key and locked-down templates, but configure allowed origins and rate limits. It is not a substitute for storing an order.
- Resend and Brevo private API keys must **never** be placed in `.env.local` variables prefixed `VITE_` or shipped to the browser. The included Supabase Edge Function tries Resend, then Brevo; EmailJS is a browser-side final fallback only after the function confirms order persistence. Configure and test provider secrets before production.
- The old owner portal supplied by the business uses browser `localStorage`; that is device-local and is not a shared order database. This phase does not port that owner portal or implement Django.
- Real-time tracking needs the Supabase schema, RLS policies, and a secure order lookup token. Until configured, tracking is clearly labelled as demo/local.
- Product names/prices from the old HTML are sample values. Product photos and commercial details must be supplied/approved by the owner.

This phase does not include Django or the private owner dashboard.
