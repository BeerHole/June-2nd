// Run this ONCE to create your BeerHole product and price in Stripe.
// It will print the Price ID — copy it into your .env as STRIPE_PRICE_ID.
//
// Usage: node setup-stripe.js

require('dotenv').config();
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

async function setupProduct() {
  console.log('Creating BeerHole product in Stripe...\n');

  const product = await stripe.products.create({
    name: 'BeerHole Game Set',
    description: 'The ultimate backyard party game — BeerPong meets Cornhole.',
    default_price_data: {
      currency: 'usd',
      unit_amount: 2000, // $20.00 — update this to your actual price
    },
  });

  console.log('✅ Product created:', product.id);
  console.log('✅ Price ID:       ', product.default_price);
  console.log('\nAdd this line to your .env file:');
  console.log(`STRIPE_PRICE_ID=${product.default_price}`);
}

setupProduct().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
