require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

// Configure Plaid
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Routes
app.post('/api/initiate-plaid-link', async (req, res) => {
  try {
    const { email, name } = req.body;

    // Create Stripe customer
    const customer = await stripe.customers.create({
      email,
      name
    });

    // Create Plaid link token
    const linkTokenResponse = await plaidClient.linkTokenCreate({
      user: {
        client_user_id: `${customer.id}-${email.replace(/[^a-zA-Z0-9]/g, "")}`,
      },
      client_name: 'Your App Name',
      products: ['auth'],
      country_codes: ['US'],
      language: 'en',
    });

    res.json({
      status: 'link_token_created',
      linkToken: linkTokenResponse.data.link_token,
      customerId: customer.id,
      message: 'Use this link_token to initialize Plaid Link in your frontend'
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/complete-subscription', async (req, res) => {
  try {
    const { customerId, publicToken, accountId } = req.body;

    // Exchange public token for access token
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken
    });

    // Get processor token
    const processorResponse = await plaidClient.processorStripeBankAccountTokenCreate({
      access_token: exchangeResponse.data.access_token,
      account_id: accountId,
    });

    // Create payment method
    const paymentMethod = await stripe.paymentMethods.create({
      type: 'us_bank_account',
      us_bank_account: {
        bank_account_token: processorResponse.data.stripe_bank_account_token,
      },
    });

    // Attach payment method to customer
    await stripe.paymentMethods.attach(paymentMethod.id, {
      customer: customerId,
    });

    // Set as default payment method
    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethod.id,
      },
    });

    // Create subscription
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: process.env.STRIPE_PRICE_ID }],
      payment_settings: {
        payment_method_types: ['us_bank_account'],
      },
      expand: ['latest_invoice.payment_intent'],
    });

    res.json({
      status: 'success',
      subscriptionId: subscription.id,
      paymentMethodId: paymentMethod.id,
      customerId: customerId
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});