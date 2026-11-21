-- Run this in your Supabase SQL editor to set up the database

CREATE TABLE IF NOT EXISTS events (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'ai' CHECK (category IN ('ai', 'product', 'tech', 'startup')),
    event_type TEXT CHECK (event_type IN ('conference', 'meetup', 'workshop', 'hackathon', 'summit', 'webinar', 'other')),
    start_date DATE,
    end_date DATE,
    city TEXT,
    state TEXT,
    venue TEXT,
    description TEXT,
    url TEXT UNIQUE,
    organizer TEXT,
    is_free BOOLEAN,
    registration_url TEXT,
    source_query TEXT,
    discovered_at TIMESTAMPTZ DEFAULT NOW(),
    is_new BOOLEAN DEFAULT TRUE,
    status TEXT DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'ongoing', 'past')),
    -- P0 columns (deadlines / mode / price / quality score)
    registration_deadline DATE,
    cfp_deadline DATE,
    mode TEXT CHECK (mode IN ('in_person', 'online', 'hybrid')),
    price_inr INTEGER,
    quality_score INTEGER
);

-- Index for fast filtering
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_city ON events(city);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_start_date ON events(start_date);
CREATE INDEX IF NOT EXISTS idx_events_is_new ON events(is_new);

-- Migration for an already-existing table (fresh installs already get this
-- column from the CREATE TABLE above — this is a no-op for those).
ALTER TABLE events ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'ai' CHECK (category IN ('ai', 'product', 'tech', 'startup'));

-- Migration to widen the category CHECK constraint on a table that already
-- had a narrower version (relies on Postgres's default unnamed-constraint
-- naming convention: events_category_check).
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_category_check;
ALTER TABLE events ADD CONSTRAINT events_category_check CHECK (category IN ('ai', 'product', 'tech', 'startup'));

-- P0 migration for an already-existing table. Safe to re-run. The API also
-- works before this runs: scores are computed on read (backend/scoring.py)
-- and the scraper retries inserts without the new columns if they are absent.
ALTER TABLE events ADD COLUMN IF NOT EXISTS registration_deadline DATE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS cfp_deadline DATE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS mode TEXT CHECK (mode IN ('in_person', 'online', 'hybrid'));
ALTER TABLE events ADD COLUMN IF NOT EXISTS price_inr INTEGER;
ALTER TABLE events ADD COLUMN IF NOT EXISTS quality_score INTEGER;
CREATE INDEX IF NOT EXISTS idx_events_mode ON events(mode);
CREATE INDEX IF NOT EXISTS idx_events_quality_score ON events(quality_score);
CREATE INDEX IF NOT EXISTS idx_events_reg_deadline ON events(registration_deadline);

-- Auto-update status based on dates.
-- end_date is frequently NULL (single-day events) — comparisons against a NULL
-- end_date are never true, so we fall back to start_date via COALESCE, otherwise
-- those events get stuck at their insert-time default status forever.
CREATE OR REPLACE FUNCTION update_event_status()
RETURNS void AS $$
BEGIN
    UPDATE events SET status = 'past'
        WHERE COALESCE(end_date, start_date) < CURRENT_DATE AND status != 'past';
    UPDATE events SET status = 'ongoing'
        WHERE start_date <= CURRENT_DATE AND COALESCE(end_date, start_date) >= CURRENT_DATE AND status != 'ongoing';
    UPDATE events SET status = 'upcoming'
        WHERE start_date > CURRENT_DATE AND status != 'upcoming';
END;
$$ LANGUAGE plpgsql;
