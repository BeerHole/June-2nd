// Run this ONCE to create your BeerHole products and prices in Stripe.
// It will print the Price IDs — copy them into your .env file.
//
// Usage: node setup-stripe.js

require('dotenv').config();
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Update names, descriptions, and prices here if they ever change.
const PRODUCTS = [
  {
    key: 'STRIPE_PRICE_COMPLETE_SET',
    name: 'BeerHole Complete Set',
    description: 'Everything you need to play — boards, bags, discs, and carry bag included.',
    unit_amount: 39999, // $399.99
  },
  {
    key: 'STRIPE_PRICE_EXTRA_BAGS',
    name: 'BeerHole Extra Bags',
    description: 'Regulation-sized bean bags built for consistent tossing and outdoor durability.',
    unit_amount: 1999, // $19.99
  },
  {
    key: 'STRIPE_PRICE_MERCH',
    name: 'BeerHole Merch',
    description: 'Rep BeerHole at every party. Premium apparel for people who play hard.',
    unit_amount: 4999, // $49.99
  },
];

async function setupProducts() {
  console.log('Creating BeerHole products in Stripe...\n');

  const results = [];

  for (const p of PRODUCTS) {
    const product = await stripe.products.create({
      name: p.name,
      description: p.description,
      default_price_data: {
        currency: 'usd',
        unit_amount: p.unit_amount,
      },
    });

    console.log(`✅ ${p.name}`);
    console.log(`   Product ID: ${product.id}`);
    console.log(`   Price ID:   ${product.default_price}\n`);

    results.push(`${p.key}=${product.default_price}`);
  }

  console.log('Add these lines to your .env file:\n');
  console.log(results.join('\n'));
}

setupProducts().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
