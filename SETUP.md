# AI Events India — Setup Guide

## Step 1: Get your API keys (all free tiers)

| Service | Sign up | What you get |
|---|---|---|
| [Tavily](https://tavily.com) | Free | 1000 searches/month |
| [Anthropic](https://console.anthropic.com) | Pay-as-you-go (~$0.25 per full scrape run) | Claude Haiku for extraction |
| [Supabase](https://supabase.com) | Free | Postgres database |

## Step 2: Set up Supabase

1. Create a new Supabase project
2. Go to SQL Editor → paste the contents of `backend/schema.sql` → Run

## Step 3: Configure environment

```bash
cd backend
cp .env.example .env
# Fill in your keys in .env
```

## Step 4: Install and run locally

```bash
cd backend
pip install -r requirements.txt

# Test the scraper manually first
python scraper.py

# Start the API server
uvicorn main:app --reload --port 8000
```

Then open `frontend/index.html` in your browser (or use Live Server in VS Code).

## Step 5: Deploy to cloud

### Backend → Render
1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your GitHub repo, set root directory to `backend/`
4. Add all environment variables from `.env`
5. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`

### Frontend → Netlify
1. Go to [netlify.com](https://netlify.com) → Add new site → Import from GitHub
2. Set publish directory to `frontend/`
3. Update `netlify.toml` with your Render URL
4. Update `API_BASE` in `frontend/app.js` to your Render URL

### Scheduled scraping → GitHub Actions
1. In your GitHub repo → Settings → Secrets → Add:
   - `TAVILY_API_KEY`
   - `ANTHROPIC_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
2. The scraper runs automatically every day at 7 AM IST
3. You can also trigger it manually from the GitHub Actions tab

## File structure

```
├── backend/
│   ├── main.py          # FastAPI app (API endpoints)
│   ├── scraper.py       # Tavily search + Claude event extraction
│   ├── database.py      # Supabase client + queries
│   ├── models.py        # Pydantic data models
│   ├── schema.sql       # Run once in Supabase SQL editor
│   └── requirements.txt
├── frontend/
│   ├── index.html       # Web UI
│   ├── styles.css       # Dark theme styles
│   ├── app.js           # Frontend logic
│   └── netlify.toml     # Netlify config + API proxy
└── .github/
    └── workflows/
        └── scrape.yml   # Daily scraping cron job
```
