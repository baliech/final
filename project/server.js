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
    const { customerId, publicToken, accountId, accountType = 'checking' } = req.body;
    if (!customerId || !publicToken || !accountId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Exchange public token for access token
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken
    });
    
    const accessToken = exchangeResponse.data.access_token;
    
    // Get account information to determine if checking or savings
    const accountsResponse = await plaidClient.accountsGet({
      access_token: accessToken
    });
    
    // Find the selected account
    const selectedAccount = accountsResponse.data.accounts.find(account => account.account_id === accountId);
    
    // If no account found or not a depository account, use the provided account type or default to checking
    const accountSubtype = selectedAccount && 
                          selectedAccount.type === 'depository' && 
                          selectedAccount.subtype ? 
                          selectedAccount.subtype : accountType;
    
    // Get processor token
    const processorResponse = await plaidClient.processorStripeBankAccountTokenCreate({
      access_token: accessToken,
      account_id: accountId,
    });
    
    // Create a bank account token with explicit account type
    const bankAccountToken = processorResponse.data.stripe_bank_account_token;
    
    // Retrieve customer to pass metadata about account type
    const customer = await stripe.customers.retrieve(customerId);
    
    // Create the bank account source with explicit account type when possible
    const bankAccount = await stripe.customers.createSource(customerId, {
      source: bankAccountToken,
      metadata: {
        account_type: accountSubtype,
        plaid_account_id: accountId
      }
    });
    
    // Set as default source
    await stripe.customers.update(customerId, {
      default_source: bankAccount.id
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
      sourceId: bankAccount.id,
      customerId: customerId,
      accountType: accountSubtype // Return the account type that was used
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
