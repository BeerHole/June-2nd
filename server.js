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

  // Acknowledge Stripe immediately — label purchase involves a live Shippo
  // call that can take a few seconds, and Stripe expects a fast response or
  // it'll consider the webhook failed and retry (which we handle safely,
  // but there's no reason to make Stripe wait).
  res.json({ received: true });

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('✅ Payment complete! Session ID:', session.id);
    fulfillOrder(session).catch(err => {
      console.error(`Order fulfillment error for session ${session.id}:`, err.message);
    });
  }
});

// ─── Order fulfillment: auto-purchase a Shippo label on payment ─────────────
// Runs after checkout.session.completed. Local delivery needs no label
// (hand-delivered). Standard shipping gets a label bought automatically,
// using the exact rate the customer was quoted where possible.
//
// Idempotency note: whether a label was already purchased is tracked in the
// Checkout Session's own metadata on Stripe (not in our server's memory),
// specifically so a duplicate webhook delivery — or our server restarting
// between the original event and a retry — can't cause a second label to be
// bought for the same order.
async function fulfillOrder(session) {
  const meta = session.metadata || {};

  if (meta.deliveryMethod === 'local') {
    const preorderNote = meta.preorder === 'true' ? ' (PREORDER — no stock yet, hold delivery until available)' : '';
    console.log(`📦 LOCAL DELIVERY — order ${session.id}: hand-deliver to ${meta.shipToName}, ${meta.localAddress}${preorderNote}`);
    return;
  }

  if (meta.deliveryMethod !== 'standard') {
    console.warn(`Order ${session.id} has no recognized deliveryMethod ("${meta.deliveryMethod}") — skipping auto label purchase.`);
    return;
  }

  if (meta.preorder === 'true') {
    console.log(`🕓 PREORDER — order ${session.id} (${meta.product}): payment complete, but no label purchased yet since this is a preorder with no stock. Ship to: ${meta.shipToName}, ${meta.shipStreet1}, ${meta.shipCity}, ${meta.shipState} ${meta.shipZip}. Buy the label manually in Shippo once stock is available.`);
    return;
  }

  // Re-fetch the session from Stripe itself (durable) rather than trusting
  // only the webhook payload, so we can check whether a label was already
  // bought for this order before ever attempting a purchase.
  let freshSession;
  try {
    freshSession = await stripe.checkout.sessions.retrieve(session.id);
  } catch (err) {
    console.error(`⚠️ Order ${session.id}: couldn't re-check session status (${err.message}) — skipping to avoid a possible duplicate purchase. Please check manually.`);
    return;
  }

  if (freshSession.metadata && freshSession.metadata.labelPurchased === 'true') {
    console.log(`Order ${session.id} already has a label purchased — skipping duplicate webhook.`);
    return;
  }

  const pkg = PACKAGE_INFO[meta.product];
  if (!pkg) {
    console.error(`⚠️ Order ${session.id}: no package info for product "${meta.product}" — label NOT purchased automatically. Please buy it manually in Shippo.`);
    const failMeta = { ...meta, labelPurchased: 'false', labelError: `No package dimensions configured for product "${meta.product}" — buy the label manually in Shippo.` };
    try {
      await stripe.checkout.sessions.update(session.id, { metadata: failMeta });
    } catch (err) {
      console.error(`Order ${session.id}: also failed to record the missing-package-info failure in Stripe metadata (${err.message}).`);
    }
    await syncPaymentIntentMetadata(freshSession.payment_intent, failMeta);
    return;
  }

  const addressTo = {
    name: meta.shipToName,
    street1: meta.shipStreet1,
    city: meta.shipCity,
    state: meta.shipState,
    zip: meta.shipZip,
    country: 'US',
  };

  let purchased = null;
  try {
    if (meta.shippoRateId) {
      purchased = await purchaseShippoLabel(meta.shippoRateId);
      if (!purchased) {
        console.warn(`Order ${session.id}: original quoted rate could not be purchased (likely expired) — getting a fresh rate instead.`);
      }
    }
    if (!purchased) {
      const freshRateId = await getFreshShippoRate(pkg, addressTo);
      if (freshRateId) {
        purchased = await purchaseShippoLabel(freshRateId);
      }
    }
  } catch (err) {
    console.error(`⚠️ Order ${session.id}: label purchase error — ${err.message}`);
  }

  if (purchased) {
    console.log(`✅ Label purchased for order ${session.id} — tracking ${purchased.trackingNumber}, label: ${purchased.labelUrl}`);
    const successMeta = {
      ...meta,
      labelPurchased: 'true',
      trackingNumber: purchased.trackingNumber || '',
      trackingUrl: purchased.trackingUrlProvider || '',
      labelUrl: purchased.labelUrl || '',
    };
    try {
      await stripe.checkout.sessions.update(session.id, { metadata: successMeta });
    } catch (err) {
      console.error(`Order ${session.id}: label was purchased but updating Stripe metadata failed (${err.message}) — check Shippo directly for the label/tracking.`);
    }
    await syncPaymentIntentMetadata(freshSession.payment_intent, successMeta);
  } else {
    console.error(`⚠️ MANUAL ACTION NEEDED — Order ${session.id}: could not auto-purchase a label. Ship to: ${meta.shipToName}, ${addressTo.street1}, ${addressTo.city}, ${addressTo.state} ${addressTo.zip}. Please buy the label manually in Shippo.`);
    const failMeta = { ...meta, labelPurchased: 'false', labelError: 'Auto-purchase failed — buy manually in Shippo.' };
    try {
      await stripe.checkout.sessions.update(session.id, { metadata: failMeta });
    } catch (err) {
      console.error(`Order ${session.id}: also failed to record the label-purchase failure in Stripe metadata (${err.message}).`);
    }
    await syncPaymentIntentMetadata(freshSession.payment_intent, failMeta);
  }
}

// Mirrors metadata onto the underlying PaymentIntent, not just the Checkout
// Session. Stripe's dashboard "Payments" list shows the PaymentIntent/Charge,
// which has its own separate metadata field from the Checkout Session — so
// without this, order details (address, tracking, etc.) wouldn't show up on
// the page a person naturally lands on when clicking into a payment.
async function syncPaymentIntentMetadata(paymentIntentId, metadata) {
  if (!paymentIntentId) return;
  try {
    await stripe.paymentIntents.update(paymentIntentId, { metadata });
  } catch (err) {
    console.error(`Failed to mirror metadata onto PaymentIntent ${paymentIntentId}: ${err.message}`);
  }
}

// Attempts to purchase a Shippo shipping label for a given rate. Returns
// null (rather than throwing) if the purchase didn't succeed, so the caller
// can fall back to getting a fresh rate instead.
async function purchaseShippoLabel(rateId) {
  try {
    const resp = await fetch('https://api.goshippo.com/transactions/', {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${process.env.SHIPPO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rate: rateId, label_file_type: 'PDF', async: false }),
    });
    const data = await resp.json();
    if (data.status === 'SUCCESS') {
      return {
        trackingNumber: data.tracking_number,
        trackingUrlProvider: data.tracking_url_provider,
        labelUrl: data.label_url,
      };
    }
    console.warn('Shippo transaction not successful:', data.status, JSON.stringify(data.messages || ''));
    return null;
  } catch (err) {
    console.error('purchaseShippoLabel error:', err.message);
    return null;
  }
}

// Gets a fresh rate quote (used when the original quoted rate has expired or
// otherwise can't be purchased) and returns the cheapest rate's id.
async function getFreshShippoRate(pkg, addressTo) {
  try {
    const resp = await fetch('https://api.goshippo.com/shipments/', {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${process.env.SHIPPO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        address_from: SHIPPO_FROM_ADDRESS,
        address_to: addressTo,
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
    if (rates.length === 0) return null;
    const cheapest = rates.reduce((a, b) => parseFloat(a.amount) < parseFloat(b.amount) ? a : b);
    return cheapest.object_id;
  } catch (err) {
    console.error('getFreshShippoRate error:', err.message);
    return null;
  }
}

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
  'complete-set': { length: 48, width: 31.25, height: 8.5, weight: 60 },
  'extra-bags': { length: 6, width: 6, height: 2, weight: 2.5 },
};

// ─── Preorder products ───────────────────────────────────────────────────────
// Products currently out of stock but still purchasable as a preorder (full
// price charged now). For these, we must NOT auto-purchase a Shippo label on
// checkout completion — there's no physical item to ship yet. The order still
// goes through normally in Stripe; the shipping address is kept in metadata
// so a label can be bought manually once stock is available.
const PREORDER_PRODUCTS = new Set(['complete-set']);

// ─── Live stock tracking (Stripe as source of truth) ─────────────────────────
// Rather than keep our own counter (which wouldn't survive a server restart
// on Render's ephemeral filesystem), stock is computed by asking Stripe how
// many successful payments exist for the current "batch." STOCK_BATCH is a
// simple version tag — bump it in your environment variables whenever a new
// batch of stock comes in, and old sales won't count against the new batch.
//
// To restock later: update COMPLETE_SET_STOCK_LIMIT and/or
// COMPLETE_SET_STOCK_BATCH in your environment variables (on Render: Settings
// → Environment) and redeploy. No code changes needed.
const STOCK_CONFIG = {
  'complete-set': {
    limit: parseInt(process.env.COMPLETE_SET_STOCK_LIMIT || '1', 10),
    batch: process.env.COMPLETE_SET_STOCK_BATCH || '1',
  },
};

// Counts succeeded payments for a product's current stock batch via Stripe's
// Search API. Note: Stripe Search has a short indexing delay (usually well
// under a minute) — under normal preorder volume this is a non-issue, but it
// means two purchases within the same second or two could theoretically both
// see stock as "available" in a race. Fine at small batch sizes; worth
// knowing about if this ever needs to scale to high-concurrency drops.
async function getSoldCount(product) {
  const cfg = STOCK_CONFIG[product];
  if (!cfg) return 0;
  try {
    const result = await stripe.paymentIntents.search({
      query: `status:"succeeded" AND metadata["product"]:"${product}" AND metadata["stockBatch"]:"${cfg.batch}"`,
      limit: 100,
    });
    return result.data.length;
  } catch (err) {
    console.error(`getSoldCount error for ${product}:`, err.message);
    // Fail closed (treat as sold out) rather than risk overselling if Stripe
    // Search is unreachable — better a customer sees "out of stock" briefly
    // than we sell a set we don't have.
    return cfg.limit;
  }
}

async function getStockStatus(product) {
  const cfg = STOCK_CONFIG[product];
  if (!cfg) return null;
  const sold = await getSoldCount(product);
  return { limit: cfg.limit, sold, available: Math.max(0, cfg.limit - sold) };
}

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
            rateId: cheapest.object_id,
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
// ─── Live stock status (read-only, used by the front-end to show/hide the
// preorder button and display remaining count) ───────────────────────────────
app.get('/stock/:product', async (req, res) => {
  try {
    const product = req.params.product;
    if (!STOCK_CONFIG[product]) {
      return res.status(404).json({ error: `No stock tracking configured for "${product}".` });
    }
    const stock = await getStockStatus(product);
    res.json(stock);
  } catch (err) {
    console.error('Stock status error:', err.message);
    res.status(500).json({ error: 'Could not check stock right now.' });
  }
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const product = req.body.product;
    const priceId = PRICE_MAP[product];

    if (!priceId) {
      return res.status(400).json({
        error: `Unknown or unconfigured product: "${product}". Check STRIPE_PRICE_* in your .env.`,
      });
    }

    if (STOCK_CONFIG[product]) {
      const stock = await getStockStatus(product);
      if (!stock || stock.available <= 0) {
        return res.status(409).json({
          error: 'Sorry, this item just sold out. Check back once more stock is available.',
        });
      }
    }

    const deliveryMethod = req.body.deliveryMethod === 'local' ? 'local' : 'standard';
    const isPreorder = PREORDER_PRODUCTS.has(product);

    const sessionConfig = {
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.DOMAIN}/success.html?product=${encodeURIComponent(product)}&preorder=${isPreorder}`,
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
        product,
        preorder: String(isPreorder),
        stockBatch: (STOCK_CONFIG[product] && STOCK_CONFIG[product].batch) || '',
        shipToName: addr.name,
        localAddress: `${addr.street1}, ${addr.city}, ${addr.state} ${addr.zip}`,
        shipStreet1: addr.street1,
        shipCity: addr.city,
        shipState: addr.state,
        shipZip: addr.zip,
      };
    } else {
      // Standard shipping. There is no "skip" path anymore — a valid quote
      // (from a specific, already-collected, and where possible Shippo-
      // validated address) is required. We use that exact address and never
      // fall back to letting Stripe collect one on its own, so there's no
      // second, unverified address field and no way to bypass verification
      // by omitting a quoteId.
      const quote = req.body.quoteId ? getValidQuote(req.body.quoteId, product) : null;
      if (!quote || !quote.meta || !quote.meta.address) {
        return res.status(400).json({
          error: 'A verified shipping address is required. Please get a shipping quote first.',
        });
      }

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
        product,
        preorder: String(isPreorder),
        stockBatch: (STOCK_CONFIG[product] && STOCK_CONFIG[product].batch) || '',
        shipToName: addr.name,
        shipToAddress: `${addr.street1}, ${addr.city}, ${addr.state} ${addr.zip}`,
        shipStreet1: addr.street1,
        shipCity: addr.city,
        shipState: addr.state,
        shipZip: addr.zip,
        shippingLive: String(!!(quote.meta && quote.meta.live)),
        carrier: (quote.meta && quote.meta.carrier) || '',
        service: (quote.meta && quote.meta.service) || '',
        shippoRateId: (quote.meta && quote.meta.rateId) || '',
        labelPurchased: 'false',
      };
    }

    // Mirror the same metadata onto the resulting PaymentIntent, not just the
    // Checkout Session — Stripe's dashboard "Payments" list shows the
    // PaymentIntent/Charge, which otherwise wouldn't have this data at all.
    sessionConfig.payment_intent_data = { metadata: sessionConfig.metadata };

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
