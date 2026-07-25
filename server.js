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
  'complete-set': 5000, // $50.00 — fallback estimate, used only if live Shippo quotes are unavailable
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

// ─── Local delivery ZIP codes ────────────────────────────────────────────────
// Free hand-delivery is only offered within this area (Spokane / Spokane
// Valley and surrounding communities, including nearby North Idaho towns).
const LOCAL_ZIP_CODES = new Set([
  '99201','99202','99203','99204','99205','99206','99207','99208','99212','99213',
  '99214','99215','99216','99217','99218','99223','99224','99001','99003','99004',
  '99005','99006','99009','99011','99012','99013','99016','99019','99021','99022',
  '99023','99025','99026','99027','99030','99031','99036','99037','99039','99101',
  '99109','99110','99114','99122','99139','99156','99163','99180','99347','83814',
  '83815','83854','83877','83858','83835','83805','83811','83843','83850','83861',
  '83869','83804',
]);

function isLocalZip(zip) {
  return LOCAL_ZIP_CODES.has(String(zip || '').trim());
}

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

// Local hand-delivery orders never reach this — they skip Stripe's shipping
// section entirely (see /create-checkout-session). This only builds the
// "Standard Shipping" option, at the quoted (or fallback flat) rate.
function buildShippingOptions(product, quotedAmount) {
  const standardAmount = quotedAmount ?? STANDARD_SHIPPING[product] ?? 0;
  return [{
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: { amount: standardAmount, currency: 'usd' },
      display_name: 'Standard Shipping',
      delivery_estimate: {
        minimum: { unit: 'business_day', value: 3 },
        maximum: { unit: 'business_day', value: 10 },
      },
    },
  }];
}

// Validates a full address against Shippo's address validation API (the same
// service that computes rates and prints labels, so "valid" here means
// genuinely deliverable, not just well-formatted). Fails open (treats the
// address as valid) if Shippo can't be reached, so a Shippo outage doesn't
// block every checkout — this is a data-quality/anti-mismatch check, not the
// sole line of defense.
async function validateAddressWithShippo(address) {
  try {
    const resp = await fetch('https://api.goshippo.com/addresses/', {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${process.env.SHIPPO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...address, validate: true }),
    });
    const data = await resp.json();
    const results = data.validation_results;

    if (results && results.is_valid === false) {
      const messages = (results.messages || []).map(m => m.text).filter(Boolean);
      return { valid: false, messages };
    }

    // Shippo can mark an address "valid" even after silently correcting it.
    // What matters is WHAT it corrected: a change to city, state, or ZIP
    // means what was typed points to a genuinely different place — that's
    // the real "wrong address" risk, so we reject it. A missing street type
    // ("Ave", "St"), abbreviation, or capitalization fix doesn't change
    // where the package goes, so those are accepted silently — using
    // Shippo's cleaned version as the address of record from here on.
    const messages = (results && results.messages) || [];
    const corrections = messages.filter(m => m.type === 'address_correction');
    const locationMismatchCodes = new Set([
      'administrative_area_change',    // state
      'locality_change',               // city
      'postal_code_change',            // zip
      'subadministrative_area_change', // county
      'dependent_locality_change',     // neighborhood/district
    ]);
    const locationMismatches = corrections.filter(m => locationMismatchCodes.has(m.code));
    if (locationMismatches.length > 0) {
      const texts = locationMismatches.map(m => m.text).filter(Boolean);
      return {
        valid: false,
        messages: texts.length ? texts : ["That address doesn't match a real location. Please double check it."],
      };
    }

    // Missing info needed to actually ship to this address — also invalid.
    if (data.is_complete === false) {
      return {
        valid: false,
        messages: ['That address is missing details needed to ship to it. Please double check it.'],
      };
    }

    return {
      valid: true,
      cleaned: {
        name: data.name || address.name,
        street1: data.street1 || address.street1,
        city: data.city || address.city,
        state: data.state || address.state,
        zip: data.zip || address.zip,
        country: data.country || address.country || 'US',
      },
    };
  } catch (err) {
    console.error('Shippo address validation failed (failing open):', err.message);
    return { valid: true };
  }
}

// ─── Get a live shipping quote (Shippo) ──────────────────────────────────────
// Called from shipping-quote.html before checkout. Returns a quoteId — the
// actual dollar amount (and validated address) is never trusted from the
// client afterward, only this server-generated id is passed along to
// /create-checkout-session.
app.post('/shipping-rate', express.json(), async (req, res) => {
  try {
    const { product, name, street1, city, state, zip } = req.body || {};
    const pkg = PACKAGE_INFO[product];

    if (!pkg) {
      return res.status(400).json({ error: `No package info for product: "${product}".` });
    }
    if (!name || !street1 || !city || !state) {
      return res.status(400).json({ error: 'Please enter your full name and complete shipping address.' });
    }
    if (!/^\d{5}(-\d{4})?$/.test(String(zip || '').trim())) {
      return res.status(400).json({ error: 'Please enter a valid 5-digit ZIP code.' });
    }

    const addressTo = {
      name: name.trim(),
      street1: street1.trim(),
      city: city.trim(),
      state: state.trim(),
      zip: zip.trim(),
      country: 'US',
    };

    const haveShippoConfig = process.env.SHIPPO_API_KEY && SHIPPO_FROM_ADDRESS.street1 && SHIPPO_FROM_ADDRESS.zip;
    let cleanedAddress = addressTo;

    if (haveShippoConfig) {
      const validation = await validateAddressWithShippo(addressTo);
      if (validation.valid === false) {
        return res.status(400).json({
          error: "We couldn't verify that address as deliverable. Please double check it.",
          details: validation.messages,
        });
      }
      if (validation.cleaned) cleanedAddress = validation.cleaned;

      try {
        const resp = await fetch('https://api.goshippo.com/shipments/', {
          method: 'POST',
          headers: {
            'Authorization': `ShippoToken ${process.env.SHIPPO_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            address_from: SHIPPO_FROM_ADDRESS,
            address_to: cleanedAddress,
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
            address: cleanedAddress,
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
    // Still store the address so checkout can use it in place of Stripe's
    // address collection — just without live validation behind it. Uses the
    // Shippo-cleaned address if validation ran but the rate lookup itself
    // failed, otherwise the raw customer input.
    const fallbackAmount = STANDARD_SHIPPING[product] ?? 0;
    const quoteId = saveQuote(product, fallbackAmount, { live: false, address: cleanedAddress });
    res.json({ quoteId, amount: fallbackAmount, live: false });
  } catch (err) {
    console.error('Shipping rate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Verify a local delivery address (Shippo) ────────────────────────────────
// Same idea as /shipping-rate but for free local hand-delivery: no rate is
// computed, but the address still goes through the same strict Shippo
// validation (reject on anything Shippo has to correct) before it's locked
// to a quoteId that /create-checkout-session will trust.
app.post('/verify-local-address', express.json(), async (req, res) => {
  try {
    const { product, name, street1, city, state, zip } = req.body || {};

    if (!PRICE_MAP[product]) {
      return res.status(400).json({ error: `Unknown product: "${product}".` });
    }
    if (!name || !street1 || !city || !state) {
      return res.status(400).json({ error: 'Please enter your full name and complete address.' });
    }
    if (!isLocalZip(zip)) {
      return res.status(400).json({ error: "That ZIP code isn't in our free local delivery area." });
    }

    const addressTo = {
      name: name.trim(),
      street1: street1.trim(),
      city: city.trim(),
      state: state.trim(),
      zip: String(zip).trim(),
      country: 'US',
    };

    let cleanedAddress = addressTo;
    if (process.env.SHIPPO_API_KEY) {
      const validation = await validateAddressWithShippo(addressTo);
      if (validation.valid === false) {
        return res.status(400).json({
          error: "We couldn't verify that address as deliverable. Please double check it.",
          details: validation.messages,
        });
      }
      if (validation.cleaned) cleanedAddress = validation.cleaned;
    }

    const quoteId = saveQuote(product, 0, { live: !!process.env.SHIPPO_API_KEY, address: cleanedAddress });
    res.json({ quoteId });
  } catch (err) {
    console.error('Local address verification error:', err.message);
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

    const deliveryMethod = req.body.deliveryMethod === 'local' ? 'local' : 'standard';

    const sessionConfig = {
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.DOMAIN}/success.html`,
      cancel_url: `${process.env.DOMAIN}/beerhole.html`,
    };

    if (deliveryMethod === 'local') {
      // Local hand-delivery: the address must have already been verified via
      // /verify-local-address (same strict Shippo checks as standard
      // shipping — reject on anything Shippo has to correct, not just a
      // ZIP-list check). We never trust raw address fields sent directly to
      // this endpoint, only a quoteId pointing at a server-stored, verified
      // address — and we do NOT ask Stripe to collect a shipping address at
      // all, so there's nothing for the customer to change afterward.
      const quote = req.body.quoteId ? getValidQuote(req.body.quoteId, product) : null;
      if (!quote || !quote.meta || !quote.meta.address) {
        return res.status(400).json({
          error: 'A verified local address is required for free local delivery. Please verify your address first.',
        });
      }
      const addr = quote.meta.address;
      sessionConfig.metadata = {
        deliveryMethod: 'local',
        shipToName: addr.name,
        localAddress: `${addr.street1}, ${addr.city}, ${addr.state} ${addr.zip}`,
      };
    } else {
      // Standard shipping. If we have a valid quote on file, it was created
      // from a specific, already-collected (and where possible, Shippo-
      // validated) address — we use that exact address and skip Stripe's own
      // address screen, so there's no second address field where a customer
      // could swap in a different, differently-priced destination after the
      // fact. If they skipped the quote step entirely, fall back to letting
      // Stripe collect the address with the flat estimated rate (there's no
      // per-address quote to mismatch against in that case).
      let quote = null;
      if (req.body.quoteId) {
        quote = getValidQuote(req.body.quoteId, product);
      }

      if (quote && quote.meta && quote.meta.address) {
        const addr = quote.meta.address;
        sessionConfig.line_items.push({
          price_data: {
            currency: 'usd',
            product_data: { name: `Shipping to ${addr.city}, ${addr.state} ${addr.zip}` },
            unit_amount: quote.amount,
          },
          quantity: 1,
        });
        sessionConfig.metadata = {
          deliveryMethod: 'standard',
          shipToName: addr.name,
          shipToAddress: `${addr.street1}, ${addr.city}, ${addr.state} ${addr.zip}`,
          shippingLive: String(!!(quote.meta && quote.meta.live)),
        };
      } else {
        sessionConfig.shipping_address_collection = { allowed_countries: ['US'] };
        sessionConfig.shipping_options = buildShippingOptions(product, undefined);
      }
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

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
