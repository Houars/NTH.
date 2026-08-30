# NTH v0.4.4 — Evidence Verification Fix

The v0.4.3 test exposed a new class of problem: retrieval improved, but the
answer could still overstate or misread the snippets.

Examples from the test:
- NVIDIA: official sources ranked first, but NTH still answered only "RTX 50 Series".
- Samsung: NTH asserted exact phone names that were not clearly supported by the visible evidence.
- RTX 5090 price: it mixed a German price-history result with an extreme US news price.
- RTX 6090 rumors: the answer said early 2027 while the top source title said 2028 at the earliest.

v0.4.4 fixes the SYNTHESIS layer.

## Search improvements

More intent-specific queries now run in parallel:
- current product: original + official/exact-model + exact-name search
- price: original + retail-price + comparison search
- news: original + official-news search
- rumor: original + two leak/report searches

All remain local SearXNG requests with the same 6-second request timeout.

## Source tiers

NTH now distinguishes:
- official first-party
- major news authority
- specialist tech source
- price tracker
- retailer
- reference
- community
- aggregator

Ranking changes by intent.

## Evidence verifier

For risky web intents (current products, news, prices, rumors), NTH performs a
small SECOND LOCAL GEMMA PASS.

This is different from the old failed knowledge verifier: it does not ask Gemma
to verify from memory. It gives Gemma the actual web evidence and asks it to
remove or correct any unsupported statement.

The verifier is forbidden to add outside knowledge.

## Hard rules

Current product:
- rumors do not count as released
- exact model requires explicit evidence
- if only the series is proven, say exact model cannot be verified

Price:
- do not use an extreme news headline as normal market price
- prefer retailer/price-tracker evidence
- use a range when several current values differ
- if snippets do not contain enough current price evidence, say so

News:
- prefer dated, directly relevant stories
- remove tangential stories

Rumors:
- preserve disagreement
- conflicting dates/specs must be stated as conflicting

## Install

Keep:
`src-tauri/icons/icon.ico`

Extract over:
`C:\Users\Schatten\Documents\NTH APP`

Then:

```powershell
cd "$HOME\Documents\NTH APP"
npm install
npm run tauri dev
```

## Re-test

```text
what is the newest NVIDIA GPU?
what is the newest Samsung phone?
how old is Dwayne Johnson?
latest NVIDIA news
what is the current price of an RTX 5090?
what are the latest RTX 6090 rumors?
```

Note: risky WEB requests are intentionally a little slower because they now get
a short evidence-verification pass after drafting.

## Frozen core

Gemma 4 12B Q4
NTH Policy v2
think: false
temperature: 0
no LoRA
