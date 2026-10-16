# Supabase + email setup (Phase 1)

## 1. Run the frontend locally on Windows

```powershell
cd .\chronova-storefront
Copy-Item .env.example .env.local
npm install
npm run dev
```

Keep `.env.local` private. `npm run build` verifies the production bundle.

## 2. Set up the shared database

1. Create a Supabase project.
2. Open **SQL Editor** and run `supabase/schema.sql`.
3. Confirm the owner-approved product list, photos, prices, stock, shipping and payment rules before importing any catalogue rows. The current Vite catalogue is only demo content transcribed from the supplied old HTML.
4. In **Project Settings → API**, copy the project URL and publishable/anon key into `.env.local` as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
5. Never put a database password, `service_role` key, Supabase secret key, Resend key, or Brevo key in a `VITE_` variable. All `VITE_` variables are bundled into public browser code.

The SQL intentionally has no public read policy for customer orders. Customers create orders and track them through the Edge Function; do not add a broad public policy to `orders`, `order_items`, or `order_status_history`.

## 3. Deploy the order function

Install the Supabase CLI, then from this directory:

```powershell
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy order-notifications
```

Set secrets in the function environment (use real, verified sender credentials):

```powershell
supabase secrets set STORE_EMAIL="owner@example.com" MAIL_FROM="Chronova BD <orders@your-verified-domain.com>" RESEND_API_KEY="your-resend-secret" BREVO_API_KEY="your-brevo-secret"
```

The function tries Resend first, then Brevo if Resend fails. EmailJS is a last-resort browser fallback only after the function confirms the order is saved and reports customer-email failure. Configure EmailJS public IDs in `.env.local`; configure the EmailJS templates with the same variable names referenced in `src/lib/services.js`, restrict allowed origins, and enable sensible rate limits.

**Before accepting live orders:** verify both email deliveries, sender-domain authentication, provider quotas, spam controls, delivery-zone pricing, actual business contact, and order persistence. Add CAPTCHA/rate limiting to the public order endpoint. Provider APIs can fail or time out; the saved order remains the source of truth.

## 4. Tracking and Django handoff

The customer tracking page calls the function with order reference **and** checkout email, then reads the status history. When the Django owner app is added, it should update both `orders.status` / `orders.updated_at` and append an `order_status_history` row. The Django app should use a protected database connection and should send status emails after the update is committed. The owner machine being offline does not stop website submissions once Supabase is configured; it does mean the owner cannot process those orders locally until back online.

This is a starter integration, not a production deployment. Apply rate limits/CAPTCHA, set real legal copy, review data retention, and test concurrent stock/order cases before launch.
