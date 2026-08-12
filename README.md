# Deepfun Indexer

Watches Launchpad + PoolManager on Base mainnet and keeps Supabase
updated with real, computed on-chain stats (price, market cap,
liquidity, volume, holder count).

## Deploy to Railway

1. Push this folder to a new GitHub repo
2. Go to railway.app, sign up free
3. New Project -> Deploy from GitHub repo -> select this repo
4. Railway auto-detects Node.js and runs `npm start`
5. Done - it runs continuously, polling every 30 seconds

## Environment variables (optional overrides)

- ALCHEMY_URL
- SUPABASE_URL
- SUPABASE_KEY

Defaults are already filled in with your real values if you don't set these.
