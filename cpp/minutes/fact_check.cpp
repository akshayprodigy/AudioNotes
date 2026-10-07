// F24: the writer fact check. See fact_check.h for what it is for and what it leaves alone.
//
// Shape: tokenise -> find the numbers -> classify each as a date, a time, an amount or a plain
// number -> find the status verbs and the mood each one is in. The same analysis runs over the
// transcript (to learn what WAS said) and over each sentence the writer produced (to learn what it
// CLAIMS), and a sentence survives only if every claim has a counterpart in what was said.
//
// Everything here is table-driven and rule-based. There is no threshold and no model.
#include "minutes/fact_check.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <set>
#include <unordered_map>
#include <unordered_set>

namespace audionotes {
namespace {

using Key = long long;
Key keyOf(double v) { return static_cast<Key>(std::llround(v * 1000.0)); }

bool isDigit(char c) { return c >= '0' && c <= '9'; }
bool isAlpha(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
bool isSpace(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; }
char lowerChar(char c) { return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c; }
std::string lower(const std::string& s) {
  std::string o = s;
  for (auto& c : o) c = lowerChar(c);
  return o;
}
bool endsWith(const std::string& s, const char* suf) {
  const std::string x(suf);
  return s.size() >= x.size() && s.compare(s.size() - x.size(), x.size(), x) == 0;
}
std::string trimmed(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && isSpace(s[a])) ++a;
  while (b > a && isSpace(s[b - 1])) --b;
  return s.substr(a, b - a);
}

// ------------------------------------------------------------------------------ sentences

bool isAbbreviation(const std::string& line, size_t dot) {
  size_t a = dot;
  while (a > 0 && (isAlpha(line[a - 1]) || line[a - 1] == '.')) --a;
  const std::string w = lower(line.substr(a, dot - a));
  if (w.empty()) return false;
  static const std::unordered_set<std::string> kAbbr = {
      "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "vs", "etc", "inc", "ltd", "st", "approx"};
  if (kAbbr.count(w)) return true;
  if (w.size() == 1) return true;                       // an initial: "J. Smith"
  if (w.find('.') != std::string::npos) return true;    // "p.m", "e.g", "U.S"
  return false;
}

std::vector<std::string> splitLine(const std::string& line) {
  std::vector<std::string> out;
  const size_t n = line.size();
  size_t start = 0;
  for (size_t i = 0; i < n; ++i) {
    const char c = line[i];
    if (c != '.' && c != '!' && c != '?') continue;
    size_t j = i + 1;
    while (j < n && (line[j] == '.' || line[j] == '!' || line[j] == '?' || line[j] == '"' ||
                     line[j] == '\'' || line[j] == ')' || line[j] == ']'))
      ++j;
    const bool endOk = j >= n || isSpace(line[j]);
    if (!endOk) { i = j - 1; continue; }
    if (c == '.' && j == i + 1 && isAbbreviation(line, i)) continue;
    const std::string piece = trimmed(line.substr(start, j - start));
    if (!piece.empty()) out.push_back(piece);
    start = j;
    i = j - 1;
  }
  if (start < n) {
    const std::string piece = trimmed(line.substr(start));
    if (!piece.empty()) out.push_back(piece);
  }
  return out;
}

std::vector<std::string> splitLines(const std::string& s) {
  std::vector<std::string> lines;
  size_t start = 0;
  for (;;) {
    const size_t nl = s.find('\n', start);
    if (nl == std::string::npos) { lines.push_back(s.substr(start)); break; }
    lines.push_back(s.substr(start, nl - start));
    start = nl + 1;
  }
  return lines;
}

// "Planned next: ..." — a template's section name opens its paragraph. It names a section and
// asserts nothing, so its words ("Done since last time") must not be read as claims.
std::string labelPrefix(const std::string& sentence) {
  const size_t colon = sentence.find(':');
  if (colon == std::string::npos || colon == 0 || colon > 31) return "";
  if (colon + 1 < sentence.size() && !isSpace(sentence[colon + 1])) return "";
  if (!isAlpha(sentence[0])) return "";
  for (size_t i = 0; i < colon; ++i) {
    const char c = sentence[i];
    if (!(isAlpha(c) || c == ' ' || c == '&' || c == '/' || c == ',' || c == '\'' || c == '-'))
      return "";
  }
  size_t e = colon + 1;
  while (e < sentence.size() && isSpace(sentence[e])) ++e;
  return sentence.substr(0, e);
}

// ------------------------------------------------------------------------------ tokens

struct Tok {
  std::string w;            // lowercased word; for a digit-form number, its text
  bool num = false;         // digit-form number
  double v = 0;
  std::string suffix;       // glued to a digit number: st nd rd th k am pm
  bool colon = false;       // 3:30
  int hh = 0, mm = 0;
  bool numdate = false;     // 10/03 or 2026-03-10
  int d1 = 0, d2 = 0;
  int sent = 0;
  bool question = false;
  bool brk = false;         // a clause break sits between the previous token and this one
  bool cap = false;         // written with a capital: a name, as far as this check can tell
};

bool isEmDash(const std::string& t, size_t i) {
  return i + 2 < t.size() && static_cast<unsigned char>(t[i]) == 0xE2 &&
         static_cast<unsigned char>(t[i + 1]) == 0x80 &&
         (static_cast<unsigned char>(t[i + 2]) == 0x94 || static_cast<unsigned char>(t[i + 2]) == 0x93);
}

std::string normaliseText(const std::string& s) {
  std::string t;
  t.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    // Curly apostrophes become straight ones so "I’ll" and "I'll" are one token.
    if (c == 0xE2 && i + 2 < s.size() && static_cast<unsigned char>(s[i + 1]) == 0x80 &&
        (static_cast<unsigned char>(s[i + 2]) == 0x99 || static_cast<unsigned char>(s[i + 2]) == 0x98)) {
      t += '\'';
      i += 2;
      continue;
    }
    // "a.m." / "p.m." -> am / pm, so the dots are not mistaken for sentence ends or separators.
    if ((lowerChar(s[i]) == 'a' || lowerChar(s[i]) == 'p') && i + 2 < s.size() && s[i + 1] == '.' &&
        lowerChar(s[i + 2]) == 'm' && (i == 0 || !isAlpha(s[i - 1]))) {
      t += lowerChar(s[i]);
      t += 'm';
      i += 2;
      if (i + 1 < s.size() && s[i + 1] == '.') ++i;
      continue;
    }
    t += s[i];
  }
  return t;
}

void tokenizeInto(const std::string& raw, int sent, bool question, std::vector<Tok>& out) {
  const std::string t = normaliseText(raw);
  const size_t n = t.size();
  bool pendingBrk = false;
  auto push = [&](Tok k) {
    k.sent = sent;
    k.question = question;
    k.brk = pendingBrk;
    pendingBrk = false;
    out.push_back(std::move(k));
  };
  auto pushWord = [&](const std::string& w) {
    Tok k;
    k.w = w;
    push(std::move(k));
  };

  size_t i = 0;
  while (i < n) {
    const unsigned char c = static_cast<unsigned char>(t[i]);
    if (c == '$') { pushWord("usd"); ++i; continue; }
    if (c == '%') { pushWord("percent"); ++i; continue; }
    if (c == 0xE2 && i + 2 < n && static_cast<unsigned char>(t[i + 1]) == 0x82 &&
        static_cast<unsigned char>(t[i + 2]) == 0xAC) { pushWord("eur"); i += 3; continue; }
    if (c == 0xE2 && i + 2 < n && static_cast<unsigned char>(t[i + 1]) == 0x82 &&
        static_cast<unsigned char>(t[i + 2]) == 0xB9) { pushWord("inr"); i += 3; continue; }
    if (c == 0xC2 && i + 1 < n && static_cast<unsigned char>(t[i + 1]) == 0xA3) {
      pushWord("gbp");
      i += 2;
      continue;
    }
    if (isEmDash(t, i)) { pendingBrk = true; i += 3; continue; }
    if (c == ',' || c == ';' || c == ':' || c == '(') { pendingBrk = true; ++i; continue; }

    if (isDigit(static_cast<char>(c))) {
      size_t j = i;
      while (j < n && isDigit(t[j])) ++j;
      const size_t firstRun = j - i;
      bool plain = true;
      while (j + 3 < n && t[j] == ',' && isDigit(t[j + 1]) && isDigit(t[j + 2]) &&
             isDigit(t[j + 3]) && !(j + 4 < n && isDigit(t[j + 4]))) {
        j += 4;
        plain = false;
      }
      if (j + 1 < n && t[j] == '.' && isDigit(t[j + 1])) {
        ++j;
        while (j < n && isDigit(t[j])) ++j;
        plain = false;
      }
      Tok k;
      k.num = true;
      std::string digits;
      for (size_t q = i; q < j; ++q)
        if (t[q] != ',') digits += t[q];
      k.v = std::atof(digits.c_str());
      k.w = digits;

      // A time (3:30) or a numeric date (10/03, 2026-03-10) — only from a plain integer.
      if (plain && firstRun <= 2 && j + 3 <= n && t[j] == ':' && isDigit(t[j + 1]) && isDigit(t[j + 2])) {
        k.colon = true;
        k.hh = std::atoi(digits.c_str());
        k.mm = std::atoi(t.substr(j + 1, 2).c_str());
        j += 3;
      } else if (plain && firstRun <= 2 && j + 1 < n && t[j] == '/' && isDigit(t[j + 1])) {
        size_t q = j + 1;
        while (q < n && isDigit(t[q])) ++q;
        const int a = std::atoi(digits.c_str());
        const int b = std::atoi(t.substr(j + 1, q - j - 1).c_str());
        // 1/2 and 1/4 are fractions; everything else that can be a day and a month is a date.
        if (q - j - 1 <= 2 && a >= 1 && a <= 31 && b >= 1 && b <= 31 && (a <= 12 || b <= 12) &&
            !(a == 1 && b <= 4)) {
          k.numdate = true;
          k.d1 = a;
          k.d2 = b;
          j = q;
          if (j + 1 < n && t[j] == '/' && isDigit(t[j + 1])) {  // a year: swallow it
            ++j;
            while (j < n && isDigit(t[j])) ++j;
          }
        }
      } else if (plain && firstRun == 4 && j + 1 < n && t[j] == '-' && isDigit(t[j + 1])) {
        size_t q = j + 1;
        while (q < n && isDigit(t[q])) ++q;
        if (q - j - 1 <= 2 && q < n && t[q] == '-' && q + 1 < n && isDigit(t[q + 1])) {
          size_t r = q + 1;
          while (r < n && isDigit(t[r])) ++r;
          if (r - q - 1 <= 2) {
            k.numdate = true;
            k.d1 = std::atoi(t.substr(j + 1, q - j - 1).c_str());  // month
            k.d2 = std::atoi(t.substr(q + 1, r - q - 1).c_str());  // day
            j = r;
          }
        }
      }

      size_t s = j;
      while (s < n && isAlpha(t[s])) ++s;
      std::string suffix = lower(t.substr(j, s - j));
      static const std::unordered_set<std::string> kSuffix = {"", "st", "nd", "rd", "th", "k", "am", "pm"};
      if (!kSuffix.count(suffix)) {
        // "3d", "4x", "15fps": not a quantity this check understands. One opaque word.
        size_t e = s;
        while (e < n && (isAlpha(t[e]) || isDigit(t[e]))) ++e;
        pushWord(lower(t.substr(i, e - i)));
        i = e;
        continue;
      }
      k.suffix = suffix;
      push(std::move(k));
      i = s;
      continue;
    }

    if (isAlpha(static_cast<char>(c))) {
      size_t j = i;
      bool hasDigit = false;
      while (j < n && (isAlpha(t[j]) || isDigit(t[j]) ||
                       (t[j] == '\'' && j + 1 < n && isAlpha(t[j + 1])))) {
        if (isDigit(t[j])) hasDigit = true;
        ++j;
      }
      (void)hasDigit;  // "q3", "v2": an opaque word either way
      {
        Tok k;
        k.w = lower(t.substr(i, j - i));
        k.cap = t[i] >= 'A' && t[i] <= 'Z';
        push(std::move(k));
      }
      i = j;
      continue;
    }
    ++i;  // anything else only separates
  }
}

// ------------------------------------------------------------------------------ number words

enum Cat { C_NONE, C_UNIT, C_TEEN, C_TENS, C_HUND, C_SCALE };
struct NW { Cat cat; long long v; };

const std::unordered_map<std::string, NW>& numWords() {
  static const std::unordered_map<std::string, NW> m = {
      {"zero", {C_UNIT, 0}},      {"one", {C_UNIT, 1}},       {"two", {C_UNIT, 2}},
      {"three", {C_UNIT, 3}},     {"four", {C_UNIT, 4}},      {"five", {C_UNIT, 5}},
      {"six", {C_UNIT, 6}},       {"seven", {C_UNIT, 7}},     {"eight", {C_UNIT, 8}},
      {"nine", {C_UNIT, 9}},      {"ten", {C_TEEN, 10}},      {"eleven", {C_TEEN, 11}},
      {"twelve", {C_TEEN, 12}},   {"thirteen", {C_TEEN, 13}}, {"fourteen", {C_TEEN, 14}},
      {"fifteen", {C_TEEN, 15}},  {"sixteen", {C_TEEN, 16}},  {"seventeen", {C_TEEN, 17}},
      {"eighteen", {C_TEEN, 18}}, {"nineteen", {C_TEEN, 19}}, {"twenty", {C_TENS, 20}},
      {"thirty", {C_TENS, 30}},   {"forty", {C_TENS, 40}},    {"fifty", {C_TENS, 50}},
      {"sixty", {C_TENS, 60}},    {"seventy", {C_TENS, 70}},  {"eighty", {C_TENS, 80}},
      {"ninety", {C_TENS, 90}},   {"hundred", {C_HUND, 100}}, {"thousand", {C_SCALE, 1000}},
      {"million", {C_SCALE, 1000000}}, {"billion", {C_SCALE, 1000000000}},
      {"lakh", {C_SCALE, 100000}}, {"lakhs", {C_SCALE, 100000}},
      {"crore", {C_SCALE, 10000000}}, {"crores", {C_SCALE, 10000000}},
  };
  return m;
}

Cat catOf(const std::string& w) {
  const auto& m = numWords();
  auto it = m.find(w);
  return it == m.end() ? C_NONE : it->second.cat;
}

const std::unordered_map<std::string, int>& ordinalWords() {
  static const std::unordered_map<std::string, int> m = {
      {"first", 1},      {"second", 2},     {"third", 3},       {"fourth", 4},     {"fifth", 5},
      {"sixth", 6},      {"seventh", 7},    {"eighth", 8},      {"ninth", 9},      {"tenth", 10},
      {"eleventh", 11},  {"twelfth", 12},   {"thirteenth", 13}, {"fourteenth", 14}, {"fifteenth", 15},
      {"sixteenth", 16}, {"seventeenth", 17}, {"eighteenth", 18}, {"nineteenth", 19},
      {"twentieth", 20}, {"thirtieth", 30},
  };
  return m;
}

struct Group {
  long long v = 0;
  bool plain = true;   // no hundred / thousand word: a bare pair of digits-worth
  size_t first = 0, last = 0;
  bool onlyTens = false;
};

// Standard English number grammar with one extension: a group that cannot take the next word
// closes and a new one starts, which is how "four ninety nine" becomes [4][99].
std::vector<Group> parseRun(const std::vector<Tok>& t, size_t b, size_t e) {
  std::vector<Group> gs;
  long long total = 0, cur = 0;
  int st = 0;  // 0 none, 1 unit, 2 teen, 3 tens, 4 tens+unit, 5 after hundred, 6 hundred+part
  bool plain = true, any = false, onlyTens = true;
  size_t gb = b, last = b;
  auto flush = [&]() {
    if (!any) return;
    Group g;
    g.v = total + cur;
    g.plain = plain;
    g.first = gb;
    g.last = last;
    g.onlyTens = onlyTens && st == 3;
    gs.push_back(g);
    total = cur = 0;
    st = 0;
    plain = true;
    any = false;
    onlyTens = true;
  };
  auto place = [&](Cat cat, long long v, size_t k) -> bool {
    switch (cat) {
      case C_UNIT:
        if (st == 0) { cur += v; st = 1; }
        else if (st == 5) { cur += v; st = 6; }
        else if (st == 3) { cur += v; st = 4; }
        else return false;
        break;
      case C_TEEN:
        if (st == 0) { cur += v; st = 2; }
        else if (st == 5) { cur += v; st = 6; }
        else return false;
        break;
      case C_TENS:
        if (st == 0) { cur += v; st = 3; }
        else if (st == 5) { cur += v; st = 3; }
        else return false;
        break;
      case C_HUND:
        if (st == 1 || st == 2 || st == 3 || st == 4) { cur *= 100; st = 5; plain = false; }
        else if (st == 0 && cur == 0) { cur = 100; st = 5; plain = false; }
        else return false;
        break;
      case C_SCALE:
        if (!any && total == 0 && cur == 0) cur = 1;
        if (cur == 0 && total == 0) return false;
        total += cur * v;
        cur = 0;
        st = 0;
        plain = false;
        break;
      case C_NONE:
        return false;
    }
    if (!any) gb = k;
    any = true;
    if (cat != C_TENS) onlyTens = false;
    last = k;
    return true;
  };
  for (size_t k = b; k < e; ++k) {
    const std::string& w = t[k].w;
    if (w == "and") continue;
    const auto& nw = numWords().at(w);
    if (!place(nw.cat, nw.v, k)) {
      flush();
      place(nw.cat, nw.v, k);
    }
  }
  flush();
  return gs;
}

struct Mention {
  size_t b = 0, e = 0;        // tokens [b, e)
  std::vector<Key> keys;      // what it can mean
  std::vector<Key> halves;    // a colloquial pair's two parts — kept for the transcript side only
  bool digit = false, ordinal = false, pair = false;
  int g1 = 0, g2 = 0;
  bool colon = false;
  int hh = 0, mm = 0;
  bool numdate = false;
  int d1 = 0, d2 = 0;
  std::string suffix;
  bool consumed = false;
};

bool isMultiplier(const std::string& w, double* mult) {
  static const std::unordered_map<std::string, double> m = {
      {"hundred", 100},        {"thousand", 1000},      {"million", 1000000}, {"billion", 1000000000},
      {"lakh", 100000},        {"lakhs", 100000},       {"crore", 10000000},  {"crores", 10000000}};
  auto it = m.find(w);
  if (it == m.end()) return false;
  *mult = it->second;
  return true;
}

std::vector<Mention> extractMentions(const std::vector<Tok>& t) {
  std::vector<Mention> out;
  const size_t n = t.size();
  size_t i = 0;
  while (i < n) {
    const Tok& k = t[i];
    if (k.numdate) {
      Mention m;
      m.b = i; m.e = i + 1; m.numdate = true; m.d1 = k.d1; m.d2 = k.d2;
      out.push_back(m);
      ++i;
      continue;
    }
    if (k.num) {
      Mention m;
      m.b = i; m.e = i + 1; m.digit = true; m.suffix = k.suffix;
      if (k.colon) {
        m.colon = true; m.hh = k.hh; m.mm = k.mm;
        out.push_back(m);
        ++i;
        continue;
      }
      double v = k.v;
      if (k.suffix == "k") v *= 1000;
      m.ordinal = (k.suffix == "st" || k.suffix == "nd" || k.suffix == "rd" || k.suffix == "th");
      double mult = 1;
      if (!m.ordinal && i + 1 < n && !t[i + 1].brk && t[i + 1].sent == k.sent && !t[i + 1].num &&
          isMultiplier(t[i + 1].w, &mult)) {
        v *= mult;
        m.e = i + 2;
      }
      m.keys = {keyOf(v)};
      out.push_back(m);
      i = m.e;
      continue;
    }
    const Cat c = catOf(k.w);
    if (c != C_NONE) {
      // Collect the run of number words, never across a clause break ("ten, twenty, thirty").
      size_t j = i;
      while (j < n && !t[j].num && t[j].sent == k.sent) {
        if (j > i && t[j].brk) break;
        const Cat cj = catOf(t[j].w);
        if (cj != C_NONE) { ++j; continue; }
        if (t[j].w == "and" && j > i && j + 1 < n && !t[j + 1].brk) {
          const Cat prev = catOf(t[j - 1].w);
          const Cat next = catOf(t[j + 1].w);
          if ((prev == C_HUND || prev == C_SCALE) && (next == C_UNIT || next == C_TEEN || next == C_TENS)) {
            ++j;
            continue;
          }
        }
        break;
      }
      std::vector<Group> gs = parseRun(t, i, j);
      size_t end = j;

      // "twenty first" / "thirty first": the last group is a tens word and an ordinal unit follows.
      if (!gs.empty() && gs.back().onlyTens && end < n && !t[end].brk) {
        auto it = ordinalWords().find(t[end].w);
        if (it != ordinalWords().end() && it->second >= 1 && it->second <= 9) {
          Mention m;
          m.b = gs.back().first; m.e = end + 1; m.ordinal = true;
          m.keys = {keyOf(static_cast<double>(gs.back().v + it->second))};
          gs.pop_back();
          for (const auto& g : gs) {
            Mention gm;
            gm.b = g.first; gm.e = g.last + 1; gm.keys = {keyOf(static_cast<double>(g.v))};
            out.push_back(gm);
          }
          out.push_back(m);
          i = end + 1;
          continue;
        }
      }
      // "four point nine nine"
      if (gs.size() == 1 && end + 1 < n && t[end].w == "point" && !t[end].brk &&
          catOf(t[end + 1].w) == C_UNIT) {
        double frac = 0, place = 0.1;
        size_t q = end + 1;
        while (q < n && catOf(t[q].w) == C_UNIT && !t[q].brk) {
          frac += place * static_cast<double>(numWords().at(t[q].w).v);
          place /= 10;
          ++q;
        }
        Mention m;
        m.b = gs[0].first; m.e = q;
        m.keys = {keyOf(static_cast<double>(gs[0].v) + frac)};
        out.push_back(m);
        i = q;
        continue;
      }
      if (gs.size() == 2 && gs[0].plain && gs[1].plain && gs[0].v >= 1 && gs[0].v <= 99 &&
          gs[1].v >= 10 && gs[1].v <= 99) {
        Mention m;
        m.b = gs[0].first; m.e = gs[1].last + 1; m.pair = true;
        m.g1 = static_cast<int>(gs[0].v); m.g2 = static_cast<int>(gs[1].v);
        m.keys = {keyOf(static_cast<double>(gs[0].v * 100 + gs[1].v)),
                  keyOf(static_cast<double>(gs[0].v) + static_cast<double>(gs[1].v) / 100.0)};
        m.halves = {keyOf(static_cast<double>(gs[0].v)), keyOf(static_cast<double>(gs[1].v))};
        out.push_back(m);
      } else {
        for (const auto& g : gs) {
          Mention m;
          m.b = g.first; m.e = g.last + 1; m.keys = {keyOf(static_cast<double>(g.v))};
          out.push_back(m);
        }
      }
      i = end;
      continue;
    }
    auto ord = ordinalWords().find(k.w);
    if (ord != ordinalWords().end()) {
      Mention m;
      m.b = i; m.e = i + 1; m.ordinal = true; m.keys = {keyOf(static_cast<double>(ord->second))};
      out.push_back(m);
    }
    ++i;
  }
  return out;
}

// ------------------------------------------------------------------------------ vocab

std::string currencyOf(const std::string& w) {
  static const std::unordered_map<std::string, std::string> m = {
      {"usd", "usd"}, {"dollar", "usd"}, {"dollars", "usd"}, {"buck", "usd"}, {"bucks", "usd"},
      {"eur", "eur"}, {"euro", "eur"},   {"euros", "eur"},
      {"gbp", "gbp"}, {"pound", "gbp"},  {"pounds", "gbp"},
      {"inr", "inr"}, {"rupee", "inr"},  {"rupees", "inr"}, {"rs", "inr"}};
  auto it = m.find(w);
  return it == m.end() ? "" : it->second;
}

std::string depossess(const std::string& w) {
  if (endsWith(w, "'s")) return w.substr(0, w.size() - 2);
  return w;
}

int monthOf(const std::string& w0, bool* ambiguous) {
  const std::string w = depossess(w0);
  static const std::unordered_map<std::string, int> full = {
      {"january", 1}, {"february", 2}, {"march", 3},     {"april", 4},   {"june", 6},
      {"july", 7},    {"august", 8},   {"september", 9}, {"october", 10}, {"november", 11},
      {"december", 12}};
  static const std::unordered_map<std::string, int> loose = {
      {"may", 5},  {"jan", 1}, {"feb", 2}, {"apr", 4}, {"jun", 6}, {"jul", 7},
      {"aug", 8},  {"sep", 9}, {"sept", 9}, {"oct", 10}, {"nov", 11}, {"dec", 12}};
  auto f = full.find(w);
  if (f != full.end()) { *ambiguous = false; return f->second; }
  auto l = loose.find(w);
  if (l != loose.end()) { *ambiguous = true; return l->second; }
  return 0;
}

int weekdayOf(const std::string& w0) {
  const std::string w = depossess(w0);
  static const std::unordered_map<std::string, int> m = {
      {"monday", 1}, {"tuesday", 2}, {"wednesday", 3}, {"thursday", 4},
      {"friday", 5}, {"saturday", 6}, {"sunday", 7}};
  auto it = m.find(w);
  return it == m.end() ? 0 : it->second;
}

bool isUnitWord(const std::string& w) {
  static const std::unordered_set<std::string> u = {
      "percent", "hour", "hours", "hr", "hrs", "minute", "minutes", "min", "mins", "day", "days",
      "week", "weeks", "month", "months", "year", "years", "quarter", "quarters"};
  return u.count(w) > 0;
}

bool isDateWord(const std::string& w0) {
  const std::string w = depossess(w0);
  bool amb = false;
  if (weekdayOf(w) || monthOf(w, &amb)) return true;
  static const std::unordered_set<std::string> d = {
      "next", "tomorrow", "yesterday", "tonight", "week", "weekend", "month", "quarter", "year",
      "later", "earlier", "today"};
  return d.count(w) > 0;
}

// ------------------------------------------------------------------------------ verbs

enum Group_ { G_DONE, G_SENT, G_APPROVED, G_SIGNED, G_PAID, G_LAUNCHED, G_RESOLVED, G_POSTPONED,
              G_CANCELLED, G_COUNT };
struct VF { int group; bool past; };

const std::unordered_map<std::string, VF>& verbForms() {
  static const std::unordered_map<std::string, VF> m = {
      {"done", {G_DONE, true}},       {"finished", {G_DONE, true}},   {"completed", {G_DONE, true}},
      {"finish", {G_DONE, false}},    {"finishes", {G_DONE, false}},  {"finishing", {G_DONE, false}},
      {"complete", {G_DONE, false}},  {"completes", {G_DONE, false}}, {"completing", {G_DONE, false}},
      {"sent", {G_SENT, true}},       {"shipped", {G_SENT, true}},    {"delivered", {G_SENT, true}},
      {"send", {G_SENT, false}},      {"sends", {G_SENT, false}},     {"sending", {G_SENT, false}},
      {"ship", {G_SENT, false}},      {"ships", {G_SENT, false}},     {"shipping", {G_SENT, false}},
      {"deliver", {G_SENT, false}},   {"delivers", {G_SENT, false}},  {"delivering", {G_SENT, false}},
      {"approved", {G_APPROVED, true}}, {"approve", {G_APPROVED, false}},
      {"approves", {G_APPROVED, false}}, {"approving", {G_APPROVED, false}},
      {"signed", {G_SIGNED, true}},   {"sign", {G_SIGNED, false}},    {"signs", {G_SIGNED, false}},
      {"signing", {G_SIGNED, false}},
      {"paid", {G_PAID, true}},       {"pay", {G_PAID, false}},       {"pays", {G_PAID, false}},
      {"paying", {G_PAID, false}},
      {"launched", {G_LAUNCHED, true}}, {"released", {G_LAUNCHED, true}},
      {"launch", {G_LAUNCHED, false}},  {"launches", {G_LAUNCHED, false}},
      {"launching", {G_LAUNCHED, false}}, {"release", {G_LAUNCHED, false}},
      {"releases", {G_LAUNCHED, false}}, {"releasing", {G_LAUNCHED, false}},
      {"resolved", {G_RESOLVED, true}}, {"resolve", {G_RESOLVED, false}},
      {"resolves", {G_RESOLVED, false}}, {"resolving", {G_RESOLVED, false}},
      // Every way of saying a date moved is one family: a writer that turns "pushed back" into
      // "postponed" has said the same thing, and must not lose the sentence for it.
      {"postponed", {G_POSTPONED, true}},   {"rescheduled", {G_POSTPONED, true}},
      {"delayed", {G_POSTPONED, true}},     {"moved", {G_POSTPONED, true}},
      {"pushed", {G_POSTPONED, true}},      {"bumped", {G_POSTPONED, true}},
      {"slipped", {G_POSTPONED, true}},
      {"postpone", {G_POSTPONED, false}},   {"postpones", {G_POSTPONED, false}},
      {"postponing", {G_POSTPONED, false}}, {"reschedule", {G_POSTPONED, false}},
      {"reschedules", {G_POSTPONED, false}}, {"rescheduling", {G_POSTPONED, false}},
      {"delay", {G_POSTPONED, false}},      {"delays", {G_POSTPONED, false}},
      {"delaying", {G_POSTPONED, false}},   {"move", {G_POSTPONED, false}},
      {"moves", {G_POSTPONED, false}},      {"moving", {G_POSTPONED, false}},
      {"push", {G_POSTPONED, false}},       {"pushes", {G_POSTPONED, false}},
      {"pushing", {G_POSTPONED, false}},    {"bump", {G_POSTPONED, false}},
      {"slip", {G_POSTPONED, false}},
      {"cancelled", {G_CANCELLED, true}},   {"canceled", {G_CANCELLED, true}},
      {"cancel", {G_CANCELLED, false}},     {"cancels", {G_CANCELLED, false}},
      {"cancelling", {G_CANCELLED, false}}, {"canceling", {G_CANCELLED, false}},
  };
  return m;
}

// The words a WRITER uses to assert something happened. A subset of the past forms above.
bool isClaimWord(const std::string& w) {
  static const std::unordered_set<std::string> c = {
      "sent", "shipped", "delivered", "completed", "finished", "done", "approved", "signed", "paid",
      "launched", "released", "resolved", "postponed", "rescheduled", "delayed", "cancelled",
      "canceled", "moved"};
  return c.count(w) > 0;
}

enum Mood { M_SUPPORT, M_PROMISE, M_NEG, M_QUESTION };

Mood moodAt(const std::vector<Tok>& t, size_t idx, bool past) {
  bool neg = false, promise = false;
  size_t k = idx;
  for (int steps = 0; k > 0 && steps < 4;) {
    if (t[k].brk) break;
    --k;
    if (t[k].sent != t[idx].sent) break;
    ++steps;
    const std::string& w = t[k].w;
    if (w == "not" || w == "never" || w == "no" || w == "without" || w == "cannot" ||
        endsWith(w, "n't")) {
      neg = true;
      continue;
    }
    static const std::unordered_set<std::string> modal = {
        "will", "shall", "would", "should", "could", "can", "might", "may", "must", "gonna",
        "let's", "lets", "please", "once", "if", "until", "unless", "whether"};
    if (modal.count(w) || endsWith(w, "'ll")) { promise = true; continue; }
    if (w == "going" && k + 1 < t.size() && t[k + 1].w == "to") { promise = true; continue; }
    if (w == "to") {
      // "to send", "to be sent", "to have been signed": an infinitive, so something still ahead.
      bool only = true;
      for (size_t q = k + 1; q < idx; ++q) {
        const std::string& m = t[q].w;
        if (!(m == "be" || m == "been" || m == "get" || m == "getting" || m == "have" || m == "being")) {
          only = false;
          break;
        }
      }
      if (only) promise = true;
    }
  }
  if (neg) return M_NEG;
  if (promise) return M_PROMISE;
  // An imperative opens its sentence: "Send the revised proposal by Friday."
  if (!past && (idx == 0 || t[idx - 1].sent != t[idx].sent)) return M_PROMISE;
  if (t[idx].question) return M_QUESTION;
  return M_SUPPORT;
}

// ------------------------------------------------------------------------------ analysis

enum DType { D_MD, D_MONTH, D_WEEKDAY, D_REL, D_TIME, D_DAY, D_NUMDATE };
struct DateItem {
  DType type = D_MONTH;
  int a = 0, b = 0;
  std::string s;
  std::vector<int> keys;  // D_NUMDATE: both readings
};
struct NumItem {
  std::vector<Key> keys;
  std::string currency;
  bool claim = false;
};
struct VerbOcc {
  int group = 0;
  size_t idx = 0;
  bool past = false;
  Mood mood = M_SUPPORT;
  bool claim = false;
};

struct Analysis {
  std::vector<NumItem> nums;
  std::vector<DateItem> dates;
  std::vector<VerbOcc> verbs;
  std::set<std::string> currencies;
  std::vector<Key> allKeys;       // every value mentioned, incl. a pair's halves
  std::vector<int> timeKeys;      // transcript side: every h:mm that can be read out of it
  std::vector<int> days;          // days of the month named in any form
};

Analysis analyze(const std::vector<Tok>& t, bool transcript) {
  Analysis a;
  const size_t n = t.size();
  std::vector<Mention> ms = extractMentions(t);
  std::vector<int> startAt(n + 1, -1), endAt(n + 1, -1);
  for (size_t i = 0; i < ms.size(); ++i) {
    startAt[ms[i].b] = static_cast<int>(i);
    endAt[ms[i].e - 1] = static_cast<int>(i);
  }

  for (const auto& m : ms) {
    if (m.ordinal) continue;
    for (Key k : m.keys) a.allKeys.push_back(k);
    for (Key k : m.halves) a.allKeys.push_back(k);
    if (transcript && m.pair && m.g1 <= 24 && m.g2 < 60) a.timeKeys.push_back((m.g1 % 12) * 100 + m.g2);
  }

  auto dayOf = [&](const Mention& m, int* day) {
    if (m.keys.size() != 1 || m.pair || m.colon || m.numdate) return false;
    if (m.keys[0] % 1000 != 0) return false;
    const Key d = m.keys[0] / 1000;
    if (d < 1 || d > 31) return false;
    *day = static_cast<int>(d);
    return true;
  };

  // --- dates: month + day, month alone, numeric dates, weekdays, relative phrases
  for (size_t k = 0; k < n; ++k) {
    bool amb = false;
    const int mo = monthOf(t[k].w, &amb);
    if (mo) {
      int day = 0;
      int found = -1;
      // "March 10", "March the tenth"
      size_t r = k + 1;
      if (r < n && t[r].w == "the") ++r;
      if (r < n && !t[r].brk && startAt[r] >= 0 && !ms[startAt[r]].consumed &&
          dayOf(ms[startAt[r]], &day))
        found = startAt[r];
      // "10 March", "the tenth of March"
      if (found < 0 && k > 0) {
        size_t l = k - 1;
        if (t[l].w == "of" && l > 0) --l;
        if (endAt[l] >= 0 && !ms[endAt[l]].consumed && dayOf(ms[endAt[l]], &day) &&
            (l + 1 == k || t[l + 1].w == "of"))
          found = endAt[l];
      }
      if (found >= 0) {
        ms[found].consumed = true;
        DateItem d;
        d.type = D_MD; d.a = mo; d.b = day;
        a.dates.push_back(d);
        a.days.push_back(day);
      } else if (!amb) {
        DateItem d;
        d.type = D_MONTH; d.a = mo;
        a.dates.push_back(d);
      }
      continue;
    }
    if (const int wd = weekdayOf(t[k].w)) {
      DateItem d;
      d.type = D_WEEKDAY; d.a = wd;
      a.dates.push_back(d);
      continue;
    }
    const std::string& w = t[k].w;
    auto rel = [&](const std::string& s) {
      DateItem d;
      d.type = D_REL; d.s = s;
      a.dates.push_back(d);
    };
    static const std::unordered_set<std::string> units = {"week", "month", "quarter", "year", "weekend"};
    if ((w == "next" || w == "following" || w == "coming" || w == "upcoming" || w == "this" ||
         w == "last") && k + 1 < n && units.count(t[k + 1].w)) {
      const std::string lead = (w == "this" || w == "last") ? w : "next";
      rel(lead + " " + t[k + 1].w);
    } else if (w == "tomorrow" || w == "yesterday" || w == "tonight") {
      rel(w);
    } else if (w == "end" && k + 1 < n && t[k + 1].w == "of") {
      size_t q = k + 2;
      if (q < n && t[q].w == "the") ++q;
      static const std::unordered_set<std::string> eu = {"day", "week", "month", "quarter", "year"};
      if (q < n && eu.count(t[q].w)) rel("end " + t[q].w);
    } else if (w == "eod" || w == "eow" || w == "eom" || w == "eoq") {
      rel(w == "eod" ? "end day" : w == "eow" ? "end week" : w == "eom" ? "end month" : "end quarter");
    }
  }

  // --- numeric dates, times, standalone ordinals
  for (auto& m : ms) {
    if (m.consumed) continue;
    if (m.numdate) {
      DateItem d;
      d.type = D_NUMDATE;
      if (m.d1 <= 12) d.keys.push_back(m.d1 * 100 + m.d2);
      if (m.d2 <= 12) d.keys.push_back(m.d2 * 100 + m.d1);
      a.dates.push_back(d);
      m.consumed = true;
      continue;
    }
    if (m.colon) {
      if (m.hh < 24 && m.mm < 60) {
        DateItem d;
        d.type = D_TIME; d.a = m.hh % 12; d.b = m.mm;
        a.dates.push_back(d);
      }
      m.consumed = true;
      continue;
    }
    if (m.ordinal) {
      if (m.digit) {
        int day = 0;
        if (m.keys.size() == 1 && m.keys[0] % 1000 == 0) {
          day = static_cast<int>(m.keys[0] / 1000);
          if (day >= 1 && day <= 31) {
            DateItem d;
            d.type = D_DAY; d.a = day;
            a.dates.push_back(d);
            a.days.push_back(day);
          }
        }
      }
      if (!m.digit && m.keys.size() == 1 && m.keys[0] % 1000 == 0) {
        // A spelled "fifteenth" is not a claim, but it IS the transcript naming a day.
        const Key d = m.keys[0] / 1000;
        if (d >= 1 && d <= 31) a.days.push_back(static_cast<int>(d));
      }
      m.consumed = true;
      continue;
    }
    // Times: "3 pm", "three o'clock", "ten thirty am"
    const bool meridiem = (m.suffix == "am" || m.suffix == "pm") ||
                          (m.e < n && (t[m.e].w == "am" || t[m.e].w == "pm" || t[m.e].w == "o'clock" ||
                                       t[m.e].w == "oclock"));
    if (meridiem) {
      int h = -1, mi = 0;
      if (m.pair) { h = m.g1; mi = m.g2; }
      else if (m.keys.size() == 1 && m.keys[0] % 1000 == 0) { h = static_cast<int>(m.keys[0] / 1000); }
      if (h >= 1 && h <= 12 && mi < 60) {
        DateItem d;
        d.type = D_TIME; d.a = h % 12; d.b = mi;
        a.dates.push_back(d);
        m.consumed = true;
      }
    }
  }

  // --- the remaining mentions are plain numbers, amounts and percentages
  for (auto& m : ms) {
    if (m.consumed || m.ordinal) continue;
    // "Speaker 13": a label the app gave a voice, not a quantity anyone said.
    if (m.b > 0 && (t[m.b - 1].w == "speaker" || t[m.b - 1].w == "speakers")) continue;
    NumItem item;
    item.keys = m.keys;
    if (m.b > 0 && !currencyOf(t[m.b - 1].w).empty() && t[m.b - 1].sent == t[m.b].sent)
      item.currency = currencyOf(t[m.b - 1].w);
    else if (m.e < n && !currencyOf(t[m.e].w).empty() && t[m.e].sent == t[m.b].sent)
      item.currency = currencyOf(t[m.e].w);
    const bool unit = m.e < n && isUnitWord(t[m.e].w) && t[m.e].sent == t[m.b].sent;
    bool big = false;
    for (Key k : m.keys)
      if (k >= 11000 || k % 1000 != 0) big = true;
    item.claim = !item.currency.empty() || unit || big;
    a.nums.push_back(item);
  }

  for (size_t k = 0; k < n; ++k)
    if (!currencyOf(t[k].w).empty()) a.currencies.insert(currencyOf(t[k].w));

  // --- status verbs and the mood each is in
  for (size_t k = 0; k < n; ++k) {
    const std::string w = depossess(t[k].w);
    auto it = verbForms().find(w);
    if (it == verbForms().end()) continue;
    VerbOcc o;
    o.group = it->second.group;
    o.idx = k;
    o.past = it->second.past;
    o.mood = moodAt(t, k, o.past);
    if (!transcript && o.past && isClaimWord(w) && o.mood == M_SUPPORT) {
      o.claim = true;
      static const std::unordered_set<std::string> soft = {"moved", "pushed", "bumped", "slipped"};
      if (soft.count(w)) {
        // "the discussion moved on to pricing" is not a postponement; "was moved to Thursday" is.
        bool dateAfter = false, onAfter = false;
        for (size_t q = k + 1; q < n && q <= k + 6 && t[q].sent == t[k].sent; ++q) {
          if (isDateWord(t[q].w) || t[q].w == "back" || t[q].w == "forward" || t[q].w == "out" ||
              t[q].w == "off")
            dateAfter = true;
          if (q == k + 1 && (t[q].w == "on" || t[q].w == "along" || t[q].w == "ahead" ||
                             t[q].w == "away" || t[q].w == "through" || t[q].w == "onto"))
            onAfter = true;
        }
        bool passive = false;
        for (size_t q = (k >= 2 ? k - 2 : 0); q < k; ++q)
          if (t[q].w == "was" || t[q].w == "were" || t[q].w == "been" || t[q].w == "be" ||
              t[q].w == "is" || t[q].w == "are" || t[q].w == "got")
            passive = true;
        o.claim = !onAfter && (dateAfter || passive);
      }
    }
    a.verbs.push_back(o);
  }
  return a;
}

// ------------------------------------------------------------------------------ the transcript

std::string stemOf(const std::string& w0) {
  std::string w = depossess(w0);
  if (w.size() < 4) return "";
  for (char c : w)
    if (!isAlpha(c)) return "";
  if (w.back() == 's') w.pop_back();
  return w.substr(0, 5);
}

struct Index {
  std::vector<Tok> toks;
  std::vector<std::string> stems;
  std::unordered_set<Key> numKeys;
  std::set<int> mdKeys, months, weekdays, days, timeKeys;
  std::set<std::string> rels, currencies;
  std::vector<std::vector<VerbOcc>> occ;
};

Index buildIndex(const std::string& transcript) {
  Index x;
  x.occ.assign(G_COUNT, {});
  int sent = 0;
  for (const auto& line : splitLines(transcript)) {
    for (const auto& s : splitLine(line)) {
      tokenizeInto(s, sent, !s.empty() && s.back() == '?', x.toks);
      ++sent;
    }
  }
  const Analysis a = analyze(x.toks, /*transcript=*/true);
  for (Key k : a.allKeys) x.numKeys.insert(k);
  for (int d : a.days) x.days.insert(d);
  for (int k : a.timeKeys) x.timeKeys.insert(k);
  x.currencies = a.currencies;
  for (const auto& d : a.dates) {
    switch (d.type) {
      case D_MD: x.mdKeys.insert(d.a * 100 + d.b); x.months.insert(d.a); break;
      case D_MONTH: x.months.insert(d.a); break;
      case D_WEEKDAY: x.weekdays.insert(d.a); break;
      case D_REL: x.rels.insert(d.s); break;
      case D_TIME: x.timeKeys.insert(d.a * 100 + d.b); break;
      case D_DAY: x.days.insert(d.a); break;
      case D_NUMDATE:
        for (int k : d.keys) { x.mdKeys.insert(k); x.months.insert(k / 100); x.days.insert(k % 100); }
        break;
    }
  }
  for (const auto& v : a.verbs) x.occ[static_cast<size_t>(v.group)].push_back(v);
  x.stems.reserve(x.toks.size());
  for (const auto& t : x.toks) x.stems.push_back(stemOf(t.w));
  return x;
}

bool nearSubject(const Index& x, size_t idx, const std::set<std::string>& stems) {
  if (stems.empty()) return true;
  const size_t lo = idx > 15 ? idx - 15 : 0;
  const size_t hi = std::min(x.toks.size(), idx + 16);
  for (size_t k = lo; k < hi; ++k)
    if (!x.stems[k].empty() && stems.count(x.stems[k])) return true;
  return false;
}

// ------------------------------------------------------------------------------ a sentence

enum Fail { F_NUMBER = 1, F_CURRENCY = 2, F_DATE = 4, F_STATUS = 8, F_TENSE = 16 };

const std::unordered_set<std::string>& stopWords() {
  static const std::unordered_set<std::string> s = {
      "that", "this", "with", "from", "were", "been", "have", "has", "had", "will", "would",
      "should", "could", "about", "their", "there", "they", "them", "then", "than", "what", "when",
      "where", "which", "while", "into", "over", "also", "each", "other", "some", "such", "only",
      "just", "more", "most", "very", "here", "these", "those", "next", "last", "once", "said",
      "says", "after", "before", "being", "team", "group", "meeting", "discussed", "discussion",
      "agreed", "decided", "covered", "noted", "mentioned", "participants", "members", "everyone",
      "people", "someone", "speaker", "speakers", "now", "still", "already", "yet", "out", "back"};
  return s;
}

int evaluateSentence(const std::string& sentence, const Index& x) {
  const std::string label = labelPrefix(sentence);
  std::vector<Tok> t;
  tokenizeInto(sentence.substr(label.size()), 0, false, t);
  const Analysis a = analyze(t, /*transcript=*/false);
  int fails = 0;

  for (const auto& n : a.nums) {
    if (!n.claim) continue;
    bool numberOk = false;
    for (Key k : n.keys)
      if (x.numKeys.count(k)) numberOk = true;
    if (!n.currency.empty()) {
      if (!numberOk || !x.currencies.count(n.currency)) fails |= F_CURRENCY;
    } else if (!numberOk) {
      fails |= F_NUMBER;
    }
  }

  for (const auto& d : a.dates) {
    bool ok = false;
    switch (d.type) {
      case D_MD: ok = x.mdKeys.count(d.a * 100 + d.b) > 0; break;
      case D_MONTH: ok = x.months.count(d.a) > 0; break;
      case D_WEEKDAY: ok = x.weekdays.count(d.a) > 0; break;
      case D_REL: ok = x.rels.count(d.s) > 0; break;
      case D_DAY: ok = x.days.count(d.a) > 0 || x.numKeys.count(keyOf(d.a)) > 0; break;
      case D_NUMDATE:
        for (int k : d.keys)
          if (x.mdKeys.count(k)) ok = true;
        break;
      case D_TIME: {
        ok = x.timeKeys.count(d.a * 100 + d.b) > 0;
        if (!ok && d.b == 0) {
          // "meet at three" never says pm; the hour being said at all is what can be checked.
          const int hs = d.a == 0 ? 12 : d.a;
          ok = x.numKeys.count(keyOf(hs)) > 0;
        }
        break;
      }
    }
    if (!ok) fails |= F_DATE;
  }

  // The subject of the sentence: the content words around the verb. A completion verb is only
  // supported by the same verb said about something the writer's sentence is also about.
  std::set<std::string> subject;
  for (const auto& tok : t) {
    // A capitalised word is a name (Priya, Ravi) — who did it, not what it was done to, and the
    // transcript has no reason to carry it: the speaker labels were never part of it.
    if (tok.num || tok.cap || tok.w.size() < 4) continue;
    if (stopWords().count(tok.w) || verbForms().count(depossess(tok.w)) || catOf(tok.w) != C_NONE ||
        !currencyOf(tok.w).empty() || isDateWord(tok.w))
      continue;
    const std::string s = stemOf(tok.w);
    if (!s.empty()) subject.insert(s);
  }
  for (const auto& v : a.verbs) {
    if (!v.claim) continue;
    bool support = false, promise = false;
    for (const auto& o : x.occ[static_cast<size_t>(v.group)]) {
      if (!nearSubject(x, o.idx, subject)) continue;
      if (o.mood == M_SUPPORT) support = true;
      else if (o.mood == M_PROMISE) promise = true;
    }
    if (support) continue;
    fails |= promise ? F_TENSE : F_STATUS;
  }
  return fails;
}

}  // namespace

// ------------------------------------------------------------------------------ public

std::vector<std::string> splitSentences(const std::string& text) {
  std::vector<std::string> out;
  for (const auto& line : splitLines(text))
    for (auto& s : splitLine(line)) out.push_back(std::move(s));
  return out;
}

std::vector<std::vector<double>> spokenNumberCandidates(const std::string& text) {
  std::vector<Tok> t;
  tokenizeInto(text, 0, false, t);
  std::vector<std::vector<double>> out;
  for (const auto& m : extractMentions(t)) {
    if (m.keys.empty()) continue;
    std::vector<double> c;
    for (Key k : m.keys) c.push_back(static_cast<double>(k) / 1000.0);
    out.push_back(std::move(c));
  }
  return out;
}

FactCheck checkWriterFacts(const std::string& written, const std::string& transcript) {
  FactCheck out;
  out.text = written;
  if (trimmed(written).empty()) return out;

  const Index x = buildIndex(transcript);

  struct Piece { std::string text; bool keep; };
  std::vector<std::vector<Piece>> lines;
  int mask = 0;
  for (const auto& line : splitLines(written)) {
    std::vector<Piece> ps;
    for (const auto& s : splitLine(line)) {
      const int f = evaluateSentence(s, x);
      if (f) { ++out.dropped; mask |= f; }
      ps.push_back({s, f == 0});
    }
    lines.push_back(std::move(ps));
  }
  if (out.dropped == 0) return out;  // untouched, byte for byte

  std::vector<std::string> rebuilt;
  for (size_t li = 0; li < lines.size(); ++li) {
    const auto& ps = lines[li];
    if (ps.empty()) { rebuilt.push_back(""); continue; }  // a blank line stays a blank line
    std::string line;
    std::string carriedLabel;
    for (size_t i = 0; i < ps.size(); ++i) {
      if (!ps[i].keep) {
        if (i == 0) carriedLabel = labelPrefix(ps[i].text);
        continue;
      }
      std::string s = ps[i].text;
      if (!carriedLabel.empty() && labelPrefix(s).empty()) s = carriedLabel + s;
      carriedLabel.clear();
      if (!line.empty()) line += ' ';
      line += s;
    }
    if (!line.empty()) rebuilt.push_back(line);
  }
  std::string joined;
  int newlines = 0;
  for (size_t i = 0; i < rebuilt.size(); ++i) {
    if (i) joined += '\n';
    joined += rebuilt[i];
  }
  std::string collapsed;
  for (char c : joined) {
    if (c == '\n') { if (++newlines > 2) continue; }
    else newlines = 0;
    collapsed += c;
  }
  out.text = trimmed(collapsed);

  if (mask & F_NUMBER) out.classes.push_back("number");
  if (mask & F_CURRENCY) out.classes.push_back("currency");
  if (mask & F_DATE) out.classes.push_back("date");
  if (mask & F_STATUS) out.classes.push_back("status");
  if (mask & F_TENSE) out.classes.push_back("tense");
  return out;
}

}  // namespace audionotes
