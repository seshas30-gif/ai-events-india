"""P0 scoring / stats / view-filter tests. Run: python -m unittest test_p0_scoring -v"""
import unittest
from datetime import date, timedelta

from scoring import compute_quality_score, compute_stats, passes_view, score_parts, sort_events

TODAY = date(2026, 11, 21)


def ev(**kw):
    base = {
        "name": "X", "url": "https://example.com/e", "start_date": "2026-12-01",
        "city": "Bengaluru", "venue": "BIEC", "description": "An event.",
        "organizer": "NASSCOM", "registration_url": "https://example.com/reg",
        "is_free": True, "price_inr": 0, "status": "upcoming", "is_new": False,
        "discovered_at": "2026-11-20T07:00:00+00:00",
        "registration_deadline": None, "cfp_deadline": None,
    }
    base.update(kw)
    return base


class TestScoring(unittest.TestCase):
    def test_complete_free_official_event_scores_high(self):
        self.assertGreaterEqual(compute_quality_score(ev(), organizer_count=5), 85)

    def test_sparse_blog_event_scores_low(self):
        sparse = ev(
            url="https://medium.com/@x/some-ai-expo", city=None, venue=None,
            description=None, organizer=None, registration_url=None,
            is_free=None, price_inr=None,
        )
        self.assertLess(compute_quality_score(sparse, organizer_count=0), 40)

    def test_parts_sum_to_score_and_respect_maxima(self):
        parts = score_parts(ev(), organizer_count=2)
        self.assertEqual(sum(parts.values()), compute_quality_score(ev(), organizer_count=2))
        self.assertLessEqual(parts["completeness"], 30)
        self.assertLessEqual(parts["source_trust"], 25)
        self.assertLessEqual(parts["organizer"], 25)
        self.assertLessEqual(parts["price_clarity"], 20)

    def test_known_price_beats_unknown_price(self):
        known = compute_quality_score(ev(is_free=False, price_inr=4999), 1)
        unknown = compute_quality_score(ev(is_free=None, price_inr=None), 1)
        self.assertGreater(known, unknown)


class TestViewsAndSort(unittest.TestCase):
    def test_closing_view_includes_reg_and_cfp_within_7d(self):
        soon = (TODAY + timedelta(days=3)).isoformat()
        later = (TODAY + timedelta(days=20)).isoformat()
        self.assertTrue(passes_view(ev(registration_deadline=soon), "closing", TODAY))
        self.assertTrue(passes_view(ev(cfp_deadline=soon), "closing", TODAY))
        self.assertFalse(passes_view(ev(registration_deadline=later), "closing", TODAY))
        self.assertFalse(passes_view(ev(), "closing", TODAY))

    def test_week_and_new_views(self):
        self.assertTrue(passes_view(ev(start_date=(TODAY + timedelta(days=2)).isoformat()), "week", TODAY))
        self.assertFalse(passes_view(ev(start_date=(TODAY + timedelta(days=9)).isoformat()), "week", TODAY))
        self.assertTrue(passes_view(ev(discovered_at="2026-11-19T07:00:00+00:00"), "new", TODAY))
        self.assertFalse(passes_view(ev(discovered_at="2026-11-01T07:00:00+00:00"), "new", TODAY))

    def test_score_sort_puts_highest_first_closing_sort_puts_soonest_first(self):
        a = ev(name="A", quality_score=50, registration_deadline="2026-11-22")
        b = ev(name="B", quality_score=95, registration_deadline="2026-12-10")
        self.assertEqual(sort_events([a, b], "score", TODAY)[0]["name"], "B")
        self.assertEqual(sort_events([a, b], "closing", TODAY)[0]["name"], "A")


class TestStats(unittest.TestCase):
    def test_extended_stats(self):
        rows = [
            ev(name="A", registration_deadline="2026-11-23", start_date="2026-11-25"),
            ev(name="B", city="Pune", start_date="2026-12-20", discovered_at="2026-10-01T07:00:00+00:00"),
            ev(name="C", status="past", city="Pune"),
        ]
        s = compute_stats(rows, TODAY)
        self.assertEqual(s["total"], 3)
        self.assertEqual(s["upcoming"], 2)
        self.assertEqual(s["closing_7d"], 1)
        self.assertEqual(s["starting_7d"], 1)
        self.assertEqual(s["new_7d"], 2)  # A + C discovered 2026-11-20
        self.assertEqual(s["cities"], 2)
        self.assertEqual(s["open_now"], 2)  # past event excluded


if __name__ == "__main__":
    unittest.main()
