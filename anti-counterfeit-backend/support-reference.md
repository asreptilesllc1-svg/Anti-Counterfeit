# ProductAuth — Support Reference

Internal use only. Answers here are grounded in exactly how the code actually works — not aspirational. If something changes in the code, update this doc.

---

## Billing & Subscriptions

**"How does billing work?"**
Monthly subscription, billed in advance via Stripe. Plans: Free ($0, 5 products lifetime), Starter ($19/mo, 50 products/mo), Growth ($49/mo, 250/mo), Business ($149/mo, 1,500/mo). Each tier includes everything in the tier below it.

**"What happens if my payment fails?"**
Nothing breaks immediately. Stripe automatically retries a failed payment for about 2-3 weeks before giving up. During that window, the account keeps full access to its current plan — we deliberately don't lock anyone out for a temporary card issue. The dashboard shows a "past due" notice prompting them to update their card, but nothing stops working.

**"What happens if I cancel?"**
Cancellation takes effect at the end of the current billing period (standard — you don't lose something you already paid for mid-period). Once the subscription actually ends, the account automatically downgrades to the Free plan — not locked out, just back to 5-product limits. All previously generated QR codes keep working regardless of billing status (see "QR permanence" below).

**"Can I switch plans anytime?"**
Yes — Billing tab in the dashboard, switch to any plan anytime, immediate Stripe checkout for the new plan.

**"Do you offer refunds?"**
[Not yet decided — need your actual policy here before launch. Recommend deciding this explicitly rather than improvising in the moment with a real customer.]

---

## QR Code Permanence — the most important thing to get right when answering

**"Will my QR codes stop working if I cancel/stop paying/years pass?"**
No, not from anything related to billing — this is a real, verified guarantee, not marketing language:
- Tokens are cryptographically signed with **no expiration date** — verified in the code, not just claimed.
- Verification (`/verify-token`) never checks billing status, subscription status, or account active/inactive status — only whether the signature is valid and whether *you* (the account owner) manually deactivated that specific product.
- The only thing that can ever stop a specific code from verifying is **you deliberately deactivating that one product** (e.g., a recall) — never a billing event, never automatically, never platform-wide.

**Important — how to phrase this to a customer:** say verification is independent of billing/subscription status, exactly as above — plan limits only affect *creating new* codes, never existing ones. **Don't tell a customer "nothing could ever possibly stop it, no matter what"** — that's an unconditional promise no business can actually make (infrastructure failures, the business itself ending, force majeure events are all real possibilities, however unlikely). The Terms of Service already states this correctly with the appropriate "for as long as the Service remains operational" qualifier — if a customer pushes on this specifically, point them to the Terms rather than personally guaranteeing something broader in an email or chat.

**"What if I lose access to my account?"**
Already-printed codes keep working regardless — they don't depend on the account existing at all. Losing the account means you can't generate *new* codes or manage the old ones, but everything already printed keeps verifying.

---

## Risk Detection / Clone Flags

**"What does 'high risk' mean on a product?"**
It's a background signal shown only in your dashboard — customers scanning the product never see it. It's based entirely on **where** a code has been scanned from, never how many times:
- **Burst signal**: the same code scanned from 3+ different cities within 24 hours (physically impossible for one item — shipping doesn't move that fast)
- **Lifetime spread signal**: the same code scanned from 11+ different cities over its whole life (8-10 = medium)

**Scan volume alone never triggers a flag.** Someone showing their item off to 100 people in one city stays "low risk" — it's genuinely about geographic spread, not popularity.

**"Does a high-risk flag block the QR code from working?"**
No. Never. The product still shows "Authentic" to whoever scans it regardless of risk level. Risk is purely informational, for you to investigate if you want to — it's not an automatic enforcement action.

---

## Data & Privacy

**"Who owns my product data/branding?"**
The customer does. We store it only to run the service (e.g., showing their logo on their own verify pages) — never sold, never shown to other customers, never repurposed.

**"Can I get my data out?"**
Yes, anytime, any plan, no restriction — Export buttons in the dashboard, JSON or a spreadsheet-friendly format.

**"What do you track when someone scans a code?"**
Timestamp, approximate city/country (from IP address — not precise GPS), device/browser info. Used only for the clone-detection signals above. Full detail in the public Privacy Policy.

---

## Security

**"How secure is this really?"**
- Every QR token is signed with RS256 (asymmetric cryptography) — can't be forged without the private signing key, which never leaves our server infrastructure.
- Every customer's data is isolated at the database query level — verified account-by-account, not just assumed.
- Passwords are hashed with scrypt, never stored in plaintext.

**"Can another customer see my products?"**
No — structurally impossible given how queries are scoped, not just a permissions setting that could be misconfigured.

---

## Common Troubleshooting

**"My QR code won't scan."**
Most common cause: printed too small. Recommend minimum 1 inch / 2.5cm. Codes use high error-correction (survive ~30% damage/dirt/wear), but there's a physical minimum size for any scanner to resolve the pattern at all.

**"I didn't get my verification/reset email."**
Check spam folder first (common on first-send before a domain builds sender reputation). If it's genuinely missing, check Brevo's own logs for delivery status before assuming it's a bug on our end.

**"The site seems slow / down."**
Check Render isn't cold-starting (if still on a free/low tier, the first request after idle time can take 10-30 seconds). If this happens often, it's worth upgrading the hosting tier — a real customer experiencing this looks like the site is broken.

---

*Last updated: alongside the multi-tenant SaaS rebuild, July 2026. Keep this in sync with actual code changes — an inaccurate support doc is worse than no doc.*
