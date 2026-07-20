# Real Challenges Diary

> Fill this in DURING the build, with issues that actually happened while
> running the benchmark against real Dutch invoices. Do not
> invent entries — an empty diary is better than a fabricated one.
> Dutch invoices are a genuinely good source of real edge cases: different
> layouts per vendor, handwritten amounts, glare on photographed paper,
> DD-MM-YYYY dates.

## CHALLENGE 1

- **What we assumed:**
- **What actually happened:** (exact wrong output observed)
- **The fix:** (exact prompt or preprocessing change made)

## CHALLENGE 2

- **What we assumed:**
- **What actually happened:**
- **The fix:**

---

### Already known before the first live run (found in code review, not yet observed live)

1. Qwen-VL wraps JSON answers in markdown code fences — raw `JSON.parse`
   crashed. Fixed with a fence-stripping parser (`cleanJson` in
   `src/qwenClient.ts`) applied to every structured response.
2. Dutch invoices print dates as DD-MM-YYYY; ambiguous dates (e.g. 05-03)
   risk being read as MM-DD. The extraction prompt now explicitly instructs
   conversion from DD-MM-YYYY to ISO. Verify against real invoices in the
   benchmark and record any remaining misreads above.
