-- Run this in your Supabase SQL editor to set up the database

CREATE TABLE IF NOT EXISTS events (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
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
    status TEXT DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'ongoing', 'past'))
);

-- Index for fast filtering
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_city ON events(city);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_start_date ON events(start_date);
CREATE INDEX IF NOT EXISTS idx_events_is_new ON events(is_new);

-- Auto-update status based on dates
CREATE OR REPLACE FUNCTION update_event_status()
RETURNS void AS $$
BEGIN
    UPDATE events SET status = 'past'    WHERE end_date < CURRENT_DATE AND status != 'past';
    UPDATE events SET status = 'ongoing' WHERE start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE AND status != 'ongoing';
    UPDATE events SET status = 'upcoming' WHERE start_date > CURRENT_DATE AND status != 'upcoming';
END;
$$ LANGUAGE plpgsql;
