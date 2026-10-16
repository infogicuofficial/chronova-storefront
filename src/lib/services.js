import { createClient } from '@supabase/supabase-js';
import emailjs from '@emailjs/browser';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

const emailjsReady = Boolean(import.meta.env.VITE_EMAILJS_SERVICE_ID && import.meta.env.VITE_EMAILJS_PUBLIC_KEY && import.meta.env.VITE_EMAILJS_TEMPLATE_CUSTOMER && import.meta.env.VITE_EMAILJS_TEMPLATE_STORE);
const localOrdersKey = 'chronova.demo.orders.v1';

function emailParams(payload, orderNumber, total) {
  return {
    order_number: orderNumber,
    customer_name: payload.customer.name,
    customer_email: payload.customer.email,
    to_email: payload.customer.email,
    customer_phone: payload.customer.phone,
    address: payload.customer.address,
    items: payload.items.map(x => `${x.quantity} × ${x.name} — BDT ${Number(x.price * x.quantity).toLocaleString('en-BD')}`).join(' | '),
    total: `BDT ${Number(total).toLocaleString('en-BD')}`,
    payment_method: payload.paymentMethod,
    notes: payload.customer.notes || '—',
  };
}

export async function placeOrder(payload) {
  if (supabase) {
    const fn = import.meta.env.VITE_ORDER_EMAIL_FUNCTION || 'order-notifications';
    const { data, error } = await supabase.functions.invoke(fn, { body: { action: 'create-order', order: payload } });
    if (error) throw new Error(`Order could not be submitted: ${error.message}`);
    if (!data?.ok || !data?.orderNumber) throw new Error(data?.message || 'Order could not be confirmed. Please try again.');

    // Private Resend/Brevo API keys stay in the Supabase Edge Function. EmailJS is only the
    // public-key, last-resort fallback after the function confirms that the order was saved.
    let customerMailOk = data.customerEmailStatus !== 'failed';
    let storeMailOk = !['failed', 'not-configured'].includes(data.storeEmailStatus);
    if (emailjsReady) {
      const common = emailParams(payload, data.orderNumber, data.total);
      const attempts = [];
      const kinds = [];
      if (!customerMailOk) {
        attempts.push(emailjs.send(import.meta.env.VITE_EMAILJS_SERVICE_ID, import.meta.env.VITE_EMAILJS_TEMPLATE_CUSTOMER, common, import.meta.env.VITE_EMAILJS_PUBLIC_KEY));
        kinds.push('customer');
      }
      if (!storeMailOk && import.meta.env.VITE_STORE_EMAIL) {
        attempts.push(emailjs.send(import.meta.env.VITE_EMAILJS_SERVICE_ID, import.meta.env.VITE_EMAILJS_TEMPLATE_STORE, { ...common, to_email: import.meta.env.VITE_STORE_EMAIL, store_email: import.meta.env.VITE_STORE_EMAIL, reply_to: payload.customer.email }, import.meta.env.VITE_EMAILJS_PUBLIC_KEY));
        kinds.push('store');
      }
      const results = await Promise.allSettled(attempts);
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && kinds[index] === 'customer') customerMailOk = true;
        if (result.status === 'fulfilled' && kinds[index] === 'store') storeMailOk = true;
      });
    }
    const notification = customerMailOk && storeMailOk ? 'sent' : customerMailOk ? 'partial' : 'failed';
    return { orderNumber: data.orderNumber, mode: 'live', notification, subtotal: data.subtotal, shippingFee: data.shippingFee, total: data.total };
  }

  // Development-only fallback: records are saved in this browser and are not shared across users/devices.
  const orderNumber = `CB-${new Date().toISOString().slice(2, 10).replaceAll('-', '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const record = { ...payload, orderNumber, status: 'Order received', createdAt: new Date().toISOString(), mode: 'demo' };
  const current = JSON.parse(localStorage.getItem(localOrdersKey) || '[]');
  localStorage.setItem(localOrdersKey, JSON.stringify([record, ...current].slice(0, 100)));

  let notification = 'not-configured';
  if (emailjsReady) {
    const common = emailParams(payload, orderNumber, payload.total);
    const results = await Promise.allSettled([
      emailjs.send(import.meta.env.VITE_EMAILJS_SERVICE_ID, import.meta.env.VITE_EMAILJS_TEMPLATE_CUSTOMER, common, import.meta.env.VITE_EMAILJS_PUBLIC_KEY),
      emailjs.send(import.meta.env.VITE_EMAILJS_SERVICE_ID, import.meta.env.VITE_EMAILJS_TEMPLATE_STORE, { ...common, to_email: import.meta.env.VITE_STORE_EMAIL || '', store_email: import.meta.env.VITE_STORE_EMAIL || '', reply_to: payload.customer.email }, import.meta.env.VITE_EMAILJS_PUBLIC_KEY),
    ]);
    notification = results.every(r => r.status === 'fulfilled') ? 'sent' : 'partial';
  }
  return { orderNumber, mode: 'demo', notification };
}

export async function lookupOrder(orderNumber, email) {
  if (supabase) {
    const fn = import.meta.env.VITE_ORDER_EMAIL_FUNCTION || 'order-notifications';
    const { data, error } = await supabase.functions.invoke(fn, { body: { action: 'track-order', orderNumber, email } });
    if (error) throw new Error('We could not check this order. Please try again.');
    if (!data?.order) return null;
    return data.order;
  }
  const all = JSON.parse(localStorage.getItem(localOrdersKey) || '[]');
  return all.find(o => o.orderNumber?.toLowerCase() === orderNumber.trim().toLowerCase() && o.customer?.email?.toLowerCase() === email.trim().toLowerCase()) || null;
}
