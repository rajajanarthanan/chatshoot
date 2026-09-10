# Challenges and caveats (why personal-first)

1. **Four render stacks** without a single pixel owner → ops and quality hell; SaaS must pick primary compositor and treat others as workers.
2. **Live “streaming edits”** from Blender/Replicate is expensive; shipping fake progress or Remotion-prop updates is the only sane default — overselling “live cinematic stream” creates chargebacks.
3. **“Last change” replay** needs a real timeline diff model; without it the feature is marketing.
4. **Web crawl → commercial video** is a copyright/lawsuit magnet; SaaS cannot ship Firecrawl-as-stock without a cleared-rights path.
5. **Unbounded agent retry loops** + Replicate + TTS will burn tenant wallets and your margin; hard caps + human escalation required.
6. **Face/persona consistency** across series episodes is unsolved at consumer quality; promising “same face every time” without LoRA/3D identity pipeline is false advertising.
7. **Long-form / full movie** failure rate and cost scale nonlinearly past ~60s of coherent narrative; SaaS pricing and SLAs break if “web series” is the default SKU.
8. **Credits reserve + settle** needs append-only ledger, partial failure refund policy, and concurrent-job locking — easy to get wrong and lose trust.
9. **Embedding every asset + notes** has real retention/cost and deletion obligations (GDPR); tenant churn leaves orphan vectors/storage.
10. **Politicians / likeness / election ads** — regulated in many jurisdictions; brand-safety and consent of depicted persons.
11. **Illiterate / vernacular users** — STT is easy; turning messy speech into a shootable, feasible plan is the hard product; English-only brain first is honest, multi-lingua creative is not a checkbox.
12. **GPU workers** (Blender) cannot live on Vercel request lifecycles; SaaS needs a real queue + GPU fleet or managed job APIs — different cost model than chat hosting.
13. **Capability catalog drift** — Planner lies when Replicate models vanish; SaaS needs versioned catalog + kill switches.
14. **Moat risk** — chat UX alone is copyable; durable moat is templates + capability graph + vertical workflows, not “we have an agent.”
15. **COGS opacity** — if credit price is not ≥ measured API+render cost + margin + failure waste, the company dies scaling usage.

## Bridge when returning to SaaS

Reuse from personal studio: Remotion/Blender/Replicate workers, plan gate, hybrid memory, capability catalog, spend event shape. Replace pass-through spend with wallet+credits+margin; add auth, tenancy, consent/legal, crawl policy, refunds, and hard agent budget caps. Do **not** fork the render pipeline — wrap it.
