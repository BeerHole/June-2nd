require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const path = require('path');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
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

// ─── JSON parsing for all other routes ───────────────────────────────────────
app.use(express.json());

// ─── Serve static site files ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ─── Create Checkout Session ──────────────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      mode: 'payment',
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
