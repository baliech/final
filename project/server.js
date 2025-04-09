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

    if (!email || !name) {
      return res.status(400).json({ error: 'Email and name are required' });
    }

    const customer = await stripe.customers.create({
      email,
      name,
      metadata: { signup_date: new Date().toISOString() }
    });

    const linkTokenResponse = await plaidClient.linkTokenCreate({
      user: {
        client_user_id: `${customer.id}-${Date.now()}`,
        email_address: email,
        legal_name: name
      },
      client_name: '🎉bitonpath',
      products: ['auth'],
      country_codes: ['US'],
      language: 'en',
      account_filters: {
        depository: {
          account_subtypes: ['checking', 'savings']
        }
      }
    });

    res.json({
      status: 'link_token_created',
      linkToken: linkTokenResponse.data.link_token,
      customerId: customer.id
    });
  } catch (error) {
    console.error('Plaid link initiation error:', error);
    res.status(500).json({ 
      error: 'Failed to initiate Plaid link',
      details: error.message 
    });
  }
});

app.post('/api/complete-subscription', async (req, res) => {
  try {
    const { customerId, publicToken, accountId } = req.body;

    if (!customerId || !publicToken || !accountId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Exchange public token for access token
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken
    });

    // Get processor token
    const processorResponse = await plaidClient.processorStripeBankAccountTokenCreate({
      access_token: exchangeResponse.data.access_token,
      account_id: accountId,
    });

    // Retrieve customer details
    const customer = await stripe.customers.retrieve(customerId);

    // Correct approach: Create payment method using the token directly
    const paymentMethod = await stripe.paymentMethods.create({
      type: 'us_bank_account',
      billing_details: {
        name: customer.name,
        email: customer.email
      },
      // This is the correct way to use the processor token
      bank_account: processorResponse.data.stripe_bank_account_token
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
        payment_method_options: {
          us_bank_account: {
            verification_method: 'instant'
          }
        }
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
    console.error('Subscription error:', {
      message: error.message,
      code: error.code,
      type: error.type,
      raw: error.raw
    });
    res.status(500).json({ 
      error: 'Failed to complete subscription',
      details: error.message,
      stripeError: error.raw?.message
    });
  }
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
