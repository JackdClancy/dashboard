// Shared finance categorisation taxonomy (added 2026-08-18).
//
// The old approach keyword-matched the *merchant name* ("woolworths", "bar",
// "bp") and dropped everything else into Other — 54% of spend by dollar value.
// Two things were wrong with that:
//
//   1. Akahu already tells us what kind of establishment each merchant is, in
//      `transaction.category.name` (NZFCC — a controlled vocabulary, e.g.
//      "Supermarkets and grocery stores", "Bars, pubs, nightclubs", "Fuel
//      stations"). The app was throwing that field away. Matching on it is far
//      more reliable than matching on merchant names, because it's a fixed
//      list rather than free text.
//   2. Substring matching without word boundaries mis-files money. 'bar'
//      matched "Chiwahwah Mexican Cantina Bar" (a restaurant), 'bus' matches
//      "business", 'bp' matches any description containing those two letters.
//      Being confidently wrong is worse than being unrecognised.
//
// So: map the controlled vocabulary, keep hand-written rules to the tiny set
// of personal strings Akahu can't know about, and let the AI tier in
// sync-finances.mjs handle the long tail merchant-by-merchant.

// Jack's fixed buckets. 'Other' is the explicit "no home for this" bucket —
// it is NOT the same as unresolved (which stays out of the rules table
// entirely so it surfaces in the app's review queue).
export const CATEGORIES = [
  'Rent', 'Groceries', 'Transport', 'Entertainment',
  'Alcohol', 'Subscriptions', 'Food', 'Other',
];

// ── Akahu NZFCC category.name → bucket ────────────────────────────
// Only high-confidence mappings live here. Anything absent falls through to
// the AI tier, which classifies the category name once and caches the answer
// as an `akahu_category` rule — so this table completes itself over time
// rather than needing to be exhaustive up front.
export const AKAHU_CATEGORY_MAP = {
  // Groceries
  'Supermarkets and grocery stores': 'Groceries',
  'Fruit and vegetable retailing': 'Groceries',
  'Fresh meat, fish and poultry retailing': 'Groceries',
  'Bread and cake retailing': 'Groceries',
  'Specialised food retailing': 'Groceries',
  // Food out
  'Cafes and restaurants': 'Food',
  'Fast food stores': 'Food',
  'Takeaway food services': 'Food',
  'Catering services': 'Food',
  // Alcohol
  'Bars, pubs, nightclubs': 'Alcohol',
  'Liquor stores': 'Alcohol',
  'Beer, wine and spirits retailing': 'Alcohol',
  // Transport
  'Fuel stations': 'Transport',
  'Taxi, rideshare, and on-demand transport services': 'Transport',
  'Parking services': 'Transport',
  'Public transport': 'Transport',
  'Bus transport': 'Transport',
  'Rail transport': 'Transport',
  'Air transport': 'Transport',
  'Automotive repair and maintenance': 'Transport',
  'Motor vehicle parts retailing': 'Transport',
  // Entertainment
  'Motion picture exhibition': 'Entertainment',
  'Performing arts operation': 'Entertainment',
  'Sports and physical recreation venues': 'Entertainment',
  'Amusement parks and centres': 'Entertainment',
  'Museum operation': 'Entertainment',
  'Zoological and botanical gardens operation': 'Entertainment',
  'Gambling activities': 'Entertainment',
  // Subscriptions
  'Business software and cloud services': 'Subscriptions',
  'Internet publishing and broadcasting': 'Subscriptions',
  'Telecommunications services': 'Subscriptions',
  'Streaming services': 'Subscriptions',
  // Rent
  'Residential property operators': 'Rent',
  'Real estate services': 'Rent',
};

// Fallback patterns over the NZFCC category name, for vocabulary entries not
// in the table above. Safe to pattern-match here (unlike merchant names)
// because it's a controlled vocabulary — but still word-boundary anchored so
// "Barber shops" can't read as a bar. Keeps the system useful when the
// `claude` CLI is unavailable.
const AKAHU_CATEGORY_PATTERNS = [
  [/\b(supermarket|grocer|greengrocer)/i, 'Groceries'],
  [/\b(cafe|restaurant|takeaway|fast food|food court|caterer)/i, 'Food'],
  [/\b(bars|pubs|nightclub|liquor|brewer|winer|distiller)/i, 'Alcohol'],
  [/\b(fuel|petrol|service station|taxi|rideshare|parking|car park|airline|air transport|freight|bus |rail )/i, 'Transport'],
  [/\b(cinema|movie|theatre|gambling|amusement|recreation|museum|gallery)/i, 'Entertainment'],
  [/\b(software|cloud services|telecommunication|streaming|internet publishing)/i, 'Subscriptions'],
  [/\b(residential property|real estate|property operator)/i, 'Rent'],
];

export function categoryFromAkahu(akahuCategoryName) {
  if (!akahuCategoryName) return null;
  const exact = AKAHU_CATEGORY_MAP[akahuCategoryName];
  if (exact) return exact;
  for (const [re, cat] of AKAHU_CATEGORY_PATTERNS) {
    if (re.test(akahuCategoryName)) return cat;
  }
  return null;
}

// ── House rules ───────────────────────────────────────────────────
// Deliberately tiny: only personal strings that no external lookup could ever
// resolve. Every pattern is word-boundary anchored — do NOT add bare
// substrings here, that's what caused the original mis-filing.
const HOUSE_RULES = [
  [/\bflat account\b/i, 'Rent'],
  [/\brent\b/i, 'Rent'],
  [/\blandlord\b/i, 'Rent'],
];

export function categoryFromHouseRule(text) {
  if (!text) return null;
  for (const [re, cat] of HOUSE_RULES) if (re.test(text)) return cat;
  return null;
}

// ── Merchant key normalisation ────────────────────────────────────
// Must stay identical to normaliseKey() in finances.js — the browser looks
// rules up by the same key the bridge writes them under. (Same
// duplicate-the-helper convention the pages use for fmtDMY.)
export function normaliseKey(raw) {
  return String(raw || '')
    .toLowerCase()
    // Strip card numbers and transaction references (long digit runs) wherever
    // they appear — they rotate per transaction, so leaving them in gives the
    // same shop a different key every visit. Deliberately NOT "truncate from
    // the first long number", because bank descriptions put the useful part
    // after the card number: "WITHDRAWAL 556806696324 The Cafe 2 C 1212142138".
    // Runs of 4 or fewer digits are kept — they're usually store numbers.
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/\b(eftpos|visa purchase|card|ref|xx+\d*)\b/g, ' ')
    .replace(/[^a-z0-9&' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The display name for a transaction's counterparty: prefer Akahu's canonical
// merchant record, fall back to the raw bank description.
export function merchantLabel(t) {
  return (t.merchant?.name || t.description || '').trim() || 'Unknown';
}
