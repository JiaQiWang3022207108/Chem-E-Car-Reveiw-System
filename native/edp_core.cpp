// Portable C++17 review primitives. No allocator, OS calls or hidden state.
// The same source runs in native tests and in the website's WASM runtime.
extern "C" {
int expected_pdf_count(int round) {
  return round < 1 || round > 5 ? -1 : (round == 1 ? 3 : 4);
}

// Bits: invalid round, count, non-PDF, Chinese, English, supplement, MOC.
// Registration spreadsheets are separated by the adapter BEFORE calling.
unsigned package_issues(int round, int count, int chinese, int english,
                        int supplement, int moc, int invalid) {
  if (expected_pdf_count(round) < 0) return 1;
  unsigned issues = count == expected_pdf_count(round) ? 0 : 2;
  if (invalid) issues |= 4;
  if (chinese != 1) issues |= 8;
  if (english != 1) issues |= 16;
  if (supplement != 1) issues |= 32;
  if (moc != (round == 1 ? 0 : 1)) issues |= 64;
  return issues;
}

// An explicit violation takes precedence; missing evidence is NEVER a pass.
// 0=passed, 1=failed, 2=needs_human.
int review_status(int failures, int blocking_unknown, int total) {
  if (failures > 0) return 1;
  return total <= 0 || blocking_unknown > 0 ? 2 : 0;
}

// Unit conversion and evidence extraction stay in the adapter. Compare only
// confirmed numerical facts in the SAME unit, not arbitrary text guesses.
// op: <, <=, ==, >=, >. -1 means no usable comparison.
int compare_metric(int op, double actual, double limit) {
  constexpr double largest = 1.7976931348623157e308;
  if (!(actual >= -largest && actual <= largest &&
        limit >= -largest && limit <= largest)) return -1;
  switch (op) {
    case 0: return actual < limit;
    case 1: return actual <= limit;
    case 2: return actual == limit;
    case 3: return actual >= limit;
    case 4: return actual > limit;
    default: return -1;
  }
}
}
