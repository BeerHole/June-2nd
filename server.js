require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const path = require('path');

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const app = express();

// ─── Webhook route (must use raw body — registered BEFORE express.json) ───────
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('✅ Payment complete! Session ID:', session.id);
    // TODO: fulfill the order (send confirmation email, update inventory, etc.)
  }

  res.json({ received: true });
});

// ─── JSON + form parsing for all other routes ────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Serve static site files ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ─── Root route → beerhole.html ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'beerhole.html'));
});

// ─── Product → Stripe Price ID map ───────────────────────────────────────────
// Each product on the site has its own Stripe price, set in .env.
const PRICE_MAP = {
  'complete-set': process.env.STRIPE_PRICE_COMPLETE_SET,
  'extra-bags': process.env.STRIPE_PRICE_EXTRA_BAGS,
  'merch': process.env.STRIPE_PRICE_MERCH,
};

// ─── Standard shipping rate per product (in cents) ───────────────────────────
// Fallback flat rate, used when no live Shippo quote is available (no API key
// configured yet, quote expired, or the Shippo call failed).
const STANDARD_SHIPPING = {
  'complete-set': 3500, // $35.00 — rough estimate, will be replaced by live quotes
  'extra-bags': 699,    // $6.99
  'merch': 599,         // $5.99
};

// ─── Package dimensions/weight per product, for live Shippo rate quotes ─────
// Dims in inches, weight in lbs. A small buffer is added on top of the raw
// product weight/size to account for packaging materials.
const PACKAGE_INFO = {
  'complete-set': { length: 48, width: 31.25, height: 8.5, weight: 52 },
  'extra-bags': { length: 6, width: 6, height: 2, weight: 2.5 },
};

// ─── Shippo origin address ───────────────────────────────────────────────────
// TODO: fill these in .env once finalized (Spokane / Spokane Valley, WA area
// per the site's local-delivery copy). Live quotes are skipped until both
// SHIPPO_API_KEY and this address are set.
const SHIPPO_FROM_ADDRESS = {
  name: process.env.SHIPPO_FROM_NAME || 'BeerHole',
  street1: process.env.SHIPPO_FROM_STREET1 || '',
  city: process.env.SHIPPO_FROM_CITY || 'Spokane',
  state: process.env.SHIPPO_FROM_STATE || 'WA',
  zip: process.env.SHIPPO_FROM_ZIP || '',
  country: process.env.SHIPPO_FROM_COUNTRY || 'US',
};

// ─── In-memory shipping quote store ──────────────────────────────────────────
// Quotes are short-lived and only used to carry a trusted, server-computed
// shipping amount from /shipping-rate into /create-checkout-session — the
// client only ever sends back a quoteId, never the amount itself.
const shippingQuotes = new Map();
const QUOTE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function saveQuote(product, amount, meta) {
  const id = require('crypto').randomUUID();
  shippingQuotes.set(id, { product, amount, meta, createdAt: Date.now() });
  return id;
}

function getValidQuote(id, product) {
  const quote = shippingQuotes.get(id);
  if (!quote) return null;
  if (Date.now() - quote.createdAt > QUOTE_TTL_MS) {
    shippingQuotes.delete(id);
    return null;
  }
  if (quote.product !== product) return null;
  return quote;
}

// Every product offers the same two choices at checkout: pick it up free if
// you're local (Spokane / Spokane Valley area — hand-delivered), or pay the
// standard shipping rate for that product. If a valid live quote is passed
// in, it's used in place of the flat placeholder rate.
function buildShippingOptions(product, quotedAmount) {
  const standardAmount = quotedAmount ?? STANDARD_SHIPPING[product] ?? 0;

  return [
    {
      shipping_rate_data: {
        type: 'fixed_amount',
        fixed_amount: { amount: 0, currency: 'usd' },
        display_name: 'Free Local Delivery (Spokane / Spokane Valley area)',
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 1 },
          maximum: { unit: 'business_day', value: 5 },
        },
      },
    },
    {
      shipping_rate_data: {
        type: 'fixed_amount',
        fixed_amount: { amount: standardAmount, currency: 'usd' },
        display_name: 'Standard Shipping',
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 3 },
          maximum: { unit: 'business_day', value: 10 },
        },
      },
    },
  ];
}

// ─── Get a live shipping quote (Shippo) ──────────────────────────────────────
// Called from shipping-quote.html before checkout. Returns a quoteId — the
// actual dollar amount is never trusted from the client afterward, only this
// server-generated id is passed along to /create-checkout-session.
app.post('/shipping-rate', express.json(), async (req, res) => {
  try {
    const { product, zip } = req.body || {};
    const pkg = PACKAGE_INFO[product];

    if (!pkg) {
      return res.status(400).json({ error: `No package info for product: "${product}".` });
    }
    if (!/^\d{5}(-\d{4})?$/.test(String(zip || '').trim())) {
      return res.status(400).json({ error: 'Please enter a valid 5-digit ZIP code.' });
    }

    const haveShippoConfig = process.env.SHIPPO_API_KEY && SHIPPO_FROM_ADDRESS.street1 && SHIPPO_FROM_ADDRESS.zip;

    if (haveShippoConfig) {
      try {
        const resp = await fetch('https://api.goshippo.com/shipments/', {
          method: 'POST',
          headers: {
            'Authorization': `ShippoToken ${process.env.SHIPPO_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            address_from: SHIPPO_FROM_ADDRESS,
            address_to: { zip: zip.trim(), country: 'US' },
            parcels: [{
              length: String(pkg.length),
              width: String(pkg.width),
              height: String(pkg.height),
              distance_unit: 'in',
              weight: String(pkg.weight),
              mass_unit: 'lb',
            }],
            async: false,
          }),
        });

        const data = await resp.json();
        const rates = (data.rates || []).filter(r => r.amount);

        if (rates.length > 0) {
          const cheapest = rates.reduce((a, b) => parseFloat(a.amount) < parseFloat(b.amount) ? a : b);
          const amountCents = Math.round(parseFloat(cheapest.amount) * 100);
          const quoteId = saveQuote(product, amountCents, {
            carrier: cheapest.provider,
            service: cheapest.servicelevel?.name,
            estimatedDays: cheapest.estimated_days,
            live: true,
          });
          return res.json({
            quoteId,
            amount: amountCents,
            live: true,
            carrier: cheapest.provider,
            service: cheapest.servicelevel?.name,
            estimatedDays: cheapest.estimated_days,
          });
        }
        console.warn('Shippo returned no usable rates, falling back to flat estimate.', data.messages || '');
      } catch (shippoErr) {
        console.error('Shippo rate lookup failed, falling back to flat estimate:', shippoErr.message);
      }
    }

    // Fallback: no Shippo key/origin configured yet, or the live call failed.
    const fallbackAmount = STANDARD_SHIPPING[product] ?? 0;
    const quoteId = saveQuote(product, fallbackAmount, { live: false });
    res.json({ quoteId, amount: fallbackAmount, live: false });
  } catch (err) {
    console.error('Shipping rate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Checkout Session ──────────────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
  try {
    const product = req.body.product;
    const priceId = PRICE_MAP[product];

    if (!priceId) {
      return res.status(400).json({
        error: `Unknown or unconfigured product: "${product}". Check STRIPE_PRICE_* in your .env.`,
      });
    }

    // If the customer got a shipping quote first, use that trusted,
    // server-stored amount instead of the flat placeholder rate.
    let quotedAmount;
    if (req.body.quoteId) {
      const quote = getValidQuote(req.body.quoteId, product);
      if (quote) quotedAmount = quote.amount;
    }

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'payment',
      shipping_address_collection: {
        allowed_countries: ['US'],
      },
      shipping_options: buildShippingOptions(product, quotedAmount),
      success_url: `${process.env.DOMAIN}/success.html`,
      cancel_url: `${process.env.DOMAIN}/beerhole.html`,
    });

    res.redirect(303, session.url);
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🍻 BeerHole server running at http://localhost:${PORT}`);
});
