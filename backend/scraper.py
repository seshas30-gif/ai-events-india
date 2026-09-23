import os
import json
import logging
from datetime import datetime
from tavily import TavilyClient
from exa_py import Exa
from google import genai
from groq import Groq
from models import Event, ScrapeResult
from database import get_client, upsert_event

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# Overridable via env in case a model id gets deprecated/renamed.
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")

# Domain-specific query sets. Kept within Tavily's free 1000-searches/month
# budget (~33/day): AI (20/day) + Product (13/day) = 33/day.
AI_QUERIES = [
    "AI conference India 2026",
    "artificial intelligence summit India 2026",
    "machine learning conference India 2026",
    "GenAI conference India 2026",
    "data science summit India 2026",
    "AI workshop India 2026",
    "deep learning conference India 2026",
    "AI hackathon India 2026",
    "NASSCOM AI events 2026",
    "Analytics India Magazine conference 2026",
    "NLP conference India 2026",
    "computer vision conference India 2026",
    # Hyderabad-focused queries
    "AI conference Hyderabad 2026",
    "machine learning meetup Hyderabad 2026",
    "data science summit Hyderabad 2026",
    "GenAI workshop Hyderabad 2026",
    "tech conference Hyderabad HITEC City 2026",
    "T-Hub AI events Hyderabad 2026",
    "AI summit Hyderabad Telangana 2026",
    "NASSCOM Hyderabad AI meetup 2026",
    # Broader "builder village"-style events that don't badge themselves as
    # strict AI conferences but run real frontier-tech/AI programming (e.g.
    # Edge City India) — narrow AI-only queries miss these entirely.
    "frontier tech popup village India 2026",
    "builder residency India 2026",
]

PRODUCT_QUERIES = [
    "product management conference India 2026",
    "product management summit India 2026",
    "product management meetup India 2026",
    "product management workshop India 2026",
    "product led growth conference India 2026",
    "ProductTank India 2026",
    "product management hackathon India 2026",
    "product strategy summit India 2026",
    "product management community event India 2026",
    # Hyderabad-focused queries
    "product management meetup Hyderabad 2026",
    "product management conference Hyderabad 2026",
    "ProductTank Hyderabad 2026",
    "product management summit Hyderabad Telangana 2026",
]

# Trimmed to Hyderabad only (was Hyderabad + Bangalore) to cut the Tavily
# overage further — this is on top of an already-over-free-tier AI+Product
# budget.
TECH_QUERIES = [
    "tech conference Hyderabad 2026",
    "tech hackathon Hyderabad 2026",
    "developer meetup Hyderabad 2026",
]

# Same trimmed Hyderabad-only scoping as TECH_QUERIES.
STARTUP_QUERIES = [
    "startup summit Hyderabad 2026",
    "startup pitch event Hyderabad 2026",
    "founder meetup Hyderabad 2026",
]

# category -> (queries, human label for the extraction prompt, topics to match,
# which search provider to use). AI/Product stay on Tavily (established,
# already dialed in); Tech/Startup run on Exa instead of adding to Tavily's
# already-over-budget usage — Exa's free tier (~$10/month credits, ~1400
# searches) comfortably covers their much smaller query count.
CATEGORIES = {
    "ai": {
        "queries": AI_QUERIES,
        "label": "AI/ML/Data Science",
        "topics": "AI, ML, Data Science, GenAI, LLM, NLP, Computer Vision, Robotics",
        "search_provider": "tavily",
    },
    "product": {
        "queries": PRODUCT_QUERIES,
        "label": "Product Management",
        "topics": "Product Management, Product Development, Product Strategy, Product Execution, Product-Led Growth, UX/Product Design",
        "search_provider": "tavily",
    },
    "tech": {
        "queries": TECH_QUERIES,
        "label": "general Tech",
        "topics": (
            "software engineering, web development, cybersecurity, cloud computing, DevOps, "
            "blockchain/Web3, mobile development, gaming/game development, hardware, IoT, robotics, "
            "open source, or general hackathons/tech meetups — but NOT primarily AI/ML/Data Science "
            "events and NOT primarily Product Management events (those are already covered elsewhere, "
            "skip them here to avoid duplicates)"
        ),
        "search_provider": "exa",
    },
    "startup": {
        "queries": STARTUP_QUERIES,
        "label": "Startup",
        "topics": (
            "startup funding announcements, pitch competitions/demo days, founder meetups, startup "
            "summits, incubator/accelerator programs, venture capital/investor events, entrepreneurship "
            "— but NOT primarily AI/ML, Product Management, or general Tech events (those are already "
            "covered elsewhere, skip them here to avoid duplicates)"
        ),
        "search_provider": "exa",
    },
}

EXTRACTION_PROMPT = """You are extracting structured {label} event information from web search results.

Search results:
{results}

Extract all distinct {label} events happening in India. For each event return a JSON array.
Each item must have these fields (use null if unknown):
- name: full event name (string)
- event_type: one of "conference", "meetup", "workshop", "hackathon", "summit", "webinar", "other"
- start_date: ISO date string YYYY-MM-DD or null
- end_date: ISO date string YYYY-MM-DD or null
- city: city name (string or null)
- state: Indian state name (string or null)
- venue: venue/location name (string or null)
- description: 1-2 sentence summary (string or null)
- url: the event's own official website or landing page (string or null)
- organizer: organizing body name (string or null)
- is_free: true/false/null
- registration_url: direct registration link if different from url (string or null)

Rules:
- Only include events IN INDIA
- Only include events related to {topics}
- Skip past events (before today: {today})
- If you can't confirm it's in India, skip it
- For "url", prefer the event's own official site/registration page. If a search result is a news article, blog post, or social media post *about* the event rather than the event's own page, only use that link if no official site appears anywhere in the results — never prefer a news/social link over an official one when both are present.
- Return ONLY a valid JSON array, no other text

JSON array:"""


def search_events(query: str, tavily: TavilyClient) -> list[dict]:
    try:
        response = tavily.search(
            query=query,
            search_depth="advanced",
            max_results=10,
            include_answer=False,
        )
        return response.get("results", [])
    except Exception as e:
        log.error(f"Tavily search failed for '{query}': {e}")
        return []


def search_events_exa(query: str, exa: Exa) -> list[dict]:
    """Same shape as search_events() (title/url/content dicts) so
    extract_events() doesn't need to know which provider ran the search."""
    try:
        response = exa.search(query, num_results=10, contents={"text": True})
        return [
            {"title": r.title or "", "url": r.url or "", "content": (r.text or "")[:800]}
            for r in response.results
        ]
    except Exception as e:
        log.error(f"Exa search failed for '{query}': {e}")
        return []


def _call_gemini(prompt: str, gemini: genai.Client) -> str:
    response = gemini.models.generate_content(model=GEMINI_MODEL, contents=prompt)
    return response.text


def _call_groq(prompt: str, groq: Groq) -> str:
    response = groq.chat.completions.create(
        model=GROQ_MODEL,
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.choices[0].message.content


def extract_events(results: list[dict], query: str, category: str, gemini: genai.Client, groq: Groq) -> list[Event]:
    if not results:
        return []

    results_text = "\n\n".join(
        f"Title: {r.get('title', '')}\nURL: {r.get('url', '')}\nContent: {r.get('content', '')[:800]}"
        for r in results
    )

    config = CATEGORIES[category]
    prompt = EXTRACTION_PROMPT.format(
        results=results_text,
        today=datetime.now().date().isoformat(),
        label=config["label"],
        topics=config["topics"],
    )

    try:
        raw = _call_gemini(prompt, gemini)
    except Exception as e:
        log.warning(f"Gemini extraction failed for '{query}' ({e}); falling back to Groq")
        try:
            raw = _call_groq(prompt, groq)
        except Exception as e2:
            log.error(f"Groq fallback also failed for '{query}': {e2}")
            return []

    try:
        raw = raw.strip()

        # Strip markdown code block if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]

        events_data = json.loads(raw)
        events = []
        for item in events_data:
            try:
                event = Event(
                    name=item.get("name", ""),
                    event_type=item.get("event_type"),
                    start_date=item.get("start_date"),
                    end_date=item.get("end_date"),
                    city=item.get("city"),
                    state=item.get("state"),
                    venue=item.get("venue"),
                    description=item.get("description"),
                    url=item.get("url"),
                    organizer=item.get("organizer"),
                    is_free=item.get("is_free"),
                    registration_url=item.get("registration_url"),
                    source_query=query,
                    category=category,
                )
                if event.name and event.url:
                    events.append(event)
            except Exception as e:
                log.warning(f"Skipping malformed event: {e}")
        return events

    except json.JSONDecodeError as e:
        log.error(f"Model returned invalid JSON for query '{query}': {e}")
        return []
    except Exception as e:
        log.error(f"Event parsing failed for query '{query}': {e}")
        return []


def run_scrape(categories: list[str] = None) -> ScrapeResult:
    tavily = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])
    exa = Exa(api_key=os.environ["EXA_API_KEY"])
    gemini = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    groq = Groq(api_key=os.environ["GROQ_API_KEY"])
    db = get_client()

    categories = categories or list(CATEGORIES.keys())
    all_events: list[Event] = []
    new_count = 0
    dup_count = 0

    for category in categories:
        provider = CATEGORIES[category]["search_provider"]
        for query in CATEGORIES[category]["queries"]:
            log.info(f"[{category}/{provider}] Searching: {query}")
            results = search_events_exa(query, exa) if provider == "exa" else search_events(query, tavily)
            events = extract_events(results, query, category, gemini, groq)
            log.info(f"  Found {len(events)} events from '{query}'")

            for event in events:
                is_new, _ = upsert_event(db, event)
                if is_new:
                    new_count += 1
                    all_events.append(event)
                else:
                    dup_count += 1

    log.info(f"Scrape complete — {new_count} new, {dup_count} duplicates skipped")

    return ScrapeResult(
        total_found=new_count + dup_count,
        new_events=new_count,
        duplicate_events=dup_count,
        events=all_events,
    )


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    result = run_scrape()
    print(f"\nDone: {result.new_events} new events added, {result.duplicate_events} duplicates skipped")
    for e in result.events:
        print(f"  [{e.event_type}] {e.name} — {e.start_date} — {e.city}")
