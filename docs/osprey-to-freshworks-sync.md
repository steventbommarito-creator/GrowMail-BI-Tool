# Osprey → Freshworks Live Sync — System Reference

How records are created and kept up to date in Freshworks (Freshsales CRM) from
Osprey (the Gordon & Lance order platform, `osprey.onebrand.io` /
`api.onebrand.io`) by the scheduled cron jobs in this repo.

- **Deals** are created and status/amount-updated from Osprey **orders**.
- **Leads** (contacts with lifecycle "Lead") are created from Osprey **new-user signups**.
- **Accounts** are **matched** to orders but **never created** by these jobs.
- **Owners** are assigned at creation time only, by the rules in §6.

> Scope: this document covers only the *recurring* cron pipelines. One-off bulk
> imports (SFDC opportunities, missing leads, open tasks, address backfills) are
> separate and documented in memory/commit history, not here.

---

## 1. Pipeline at a glance

```
                    ┌─────────────────────────────────────────────┐
   Osprey           │  Gordon & Lance finance report (orders CSV)  │
 (onebrand.io)      │  api/v1/users (new signups)                  │
                    └───────────────┬───────────────┬─────────────┘
                                    │               │
                 scrapeOsprey.js    │               │  osprey-lead-sync.js
                 (via run.js)       ▼               ▼  (own Playwright login)
                          ┌──────────────────┐  ┌──────────────────┐
              Supabase    │ osprey_mail_drops│  │ (users API, live)│
                          └────────┬─────────┘  └────────┬─────────┘
                                   │                     │
              osprey-deal-sync.js  ▼                     ▼
                          ┌──────────────────┐  ┌──────────────────┐
              Freshworks  │      DEALS       │  │  LEADS (contacts)│
                          │  + account match │  │  lifecycle=Lead  │
                          └──────────────────┘  └──────────────────┘
              State: osprey_deal_sync            State: osprey_lead_sync
```

Two independent Freshworks-writing jobs (**Deal Sync**, **Lead Sync**) plus the
**BI Scraper** that refreshes raw Osprey/USPS data on its own cadence.

---

## 2. Cron schedule

All GitHub Actions crons are **UTC (no daylight-saving)**. Times below are the
intended EST clock; in summer (EDT) they fire one hour later.

| Workflow | File | Schedule (cron UTC) | Clock (EST) | What it does |
|---|---|---|---|---|
| **Osprey Deal Sync** | `osprey-deal-sync.yml` | `0 2,4,12-23 * * *` | hourly 7a–6p, + 9p, 11p | Scrapes the finance report fresh, then syncs orders → deals |
| **Osprey Lead Sync** | `osprey-lead-sync.yml` | `0 2,4,12-23 * * *` | hourly 7a–6p, + 9p, 11p | Scrapes new signups → creates leads |
| **BI Scraper** | `scrape.yml` | `0 5,15,17,19,21 * * *` | 12a, 10a, 12p, 2p, 4p | Refreshes `osprey_mail_drops` + USPS (raw data, no CRM writes) |

Deal Sync and Lead Sync run on the **same trigger times**. Each is
`concurrency`-guarded (`cancel-in-progress: false`) so overlapping runs queue
rather than collide. Deal Sync **scrapes its own fresh copy** of the finance
report before syncing (it does not wait on the BI Scraper), so a deal reflects
order state as of that run.

---

## 3. Data sources

### 3.1 Orders → `osprey_mail_drops` (feeds Deal Sync)
`scrapeOsprey.js` logs into Osprey, opens the **Gordon & Lance finance report**
(`/reports/gordon-lance-finance-report?filter_id=6077`), downloads the segment
CSV, and loads it into the `osprey_mail_drops` Supabase table (orchestrated by
`run.js`). Deal Sync then collapses that table to **one record per `order_id`**
(keeping the earliest drop date) and reads these order-level fields:

`order_id, order_status, order_amount, customer_id, customer_name, seller,
web_id, product_category, drop_est_date`.

### 3.2 Signups → users API (feeds Lead Sync)
`osprey-lead-sync.js` runs its **own** Playwright login, captures the API token,
and pages `api.onebrand.io/api/v1/users` newest-first. It does **not** use
`osprey_mail_drops`.

---

## 4. Deal Sync — orders → Freshworks deals

Script: `crm-import/osprey-deal-sync.js`. One deal per Osprey `order_id`.

### 4.1 Create / update / skip decision
State table `osprey_deal_sync` (keyed by `order_id`) records every order already
turned into a deal, so runs are cheap and resumable:

| Condition | Action |
|---|---|
| `order_id` **not seen before** & status ≠ INCOMPLETE | **Create** a new deal (POST /deals), record state |
| `order_id` **seen**, and **stage or amount changed** | **Update** that deal's `deal_stage_id` + `amount` only (PUT /deals) |
| `order_id` seen, nothing changed | **Skip** (no API call) |
| status = **INCOMPLETE** | **Excluded** — no deal created; any existing deal is left untouched |

Updates deliberately touch **only stage and amount** — never the owner, name, or
custom fields — so manual owner corrections in Freshworks are preserved.

### 4.2 Order status → deal stage
Freshworks has three collapsed stages. The mapping (`stageForStatus`):

| Bucket | Osprey statuses | Deal stage | Stage ID |
|---|---|---|---|
| **Excluded** | `INCOMPLETE` | *(no deal)* | — |
| **Lost** | `CANCELED`, `VOID` | Lost | `127003582560` |
| **Quoted** | `QUOTE` | Quoted | `127003582554` |
| **Won** | **everything else** (default) | Won | `127003582559` |

"Everything else → Won" covers all the active production/fulfillment statuses.
As of the latest data these Won-by-default statuses include: `COMPLETE`,
`DMM [ACTIVE]`, `PAYMENT REQUIRED - INTERNAL`, `DIGITAL READY`, `LIMBO`,
`ACTIVE RUN`, `PAYMENT REQUIRED`, `OUTSOURCED`, `DAL [SUBMITTED]`,
`DMM [STAGING]`, `DIGITAL [STAGING]`, `DAL [STAGING]`, `DESIGN [PROOF]`,
`PREPRESS [PROOF]`, `PREPRESS [REUPLOAD]`, `DESIGN`, `WAREHOUSE [KSCOPE]`,
`QC APPROVAL`, `GRAPHICS [WIP]`, `INCOMING [APPROVED]`, `DESIGN [REUPLOAD]`,
`DESIGN PROOF QC`, `OUTSOURCED [STAGING]`.

> **Watch item:** any status not explicitly `QUOTE`/`CANCELED`/`VOID`/`COMPLETE`
> maps to **Won** silently. The job logs these as "statuses treated as WON by
> default" at the end of each run — review that list if a new Osprey status
> should really be Quoted or Lost.

### 4.3 Deal field mapping
| Freshworks field | Source | Notes |
|---|---|---|
| `name` | `"{customer_name} – {product_category} (#{order_id})"` | truncated to 255 |
| `amount` | `order_amount` | 0 if missing |
| `deal_pipeline_id` | fixed `127000511262` | |
| `deal_stage_id` | status mapping (§4.2) | |
| `expected_close` | earliest `drop_est_date` | if present |
| `owner_id` | owner rules (§6) | set at create only |
| `sales_account_id` | matched account (§5) | omitted if no match |
| `cf_order_number` | `order_id` | integer; drives the `cf_order_link` formula |
| `cf_webid` | `web_id` | integer |
| `cf_sf_oppty_id` | `"{customer_id}-{order_id}"` | de-facto unique key (contains order id) |

---

## 5. Accounts

**These cron jobs never create accounts.** Deal Sync only *matches* the order's
`customer_name` to an existing Freshworks Sales Account via
`POST /filtered_search/sales_account` (exact-name preferred, else first hit),
caches the result per run, and sets `sales_account_id` on the deal when found.
No match → the deal is created **without** an account link. Account creation and
address enrichment happen through separate one-off imports, not this pipeline.

---

## 6. Owner assignment (deals)

Applied **only when a deal is created** (never on update). Resolution order —
*"seller wins, account fills gaps"*:

1. **Osprey `seller` → Freshworks user**, matched by display name (case-insensitive), through the alias table:
   | Osprey seller | Freshworks user |
   |---|---|
   | `Danielle Dennis` | Dani Dennis *(FW renamed the user; long form maps to current)* |
   | `Stephanie Hanna` | Stephanie Grabowski |
   | *(all others)* | matched literally by name |
2. **If the seller does not resolve** (blank, a departed rep, or a placeholder like `Default OBOPP`): use the **matched account's owner** (if it's a real, non-CS owner).
3. **Still nothing:** use the **most common non-CS owner among that account's contacts**.
4. **Final fallback:** **Customer Service** (`CS_OWNER_ID 127000558289`).

Each run reports how many creates drew their owner from the account/contacts vs.
fell through to the CS default.

### Known gap (not auto-fixed)
The owner rules above are **go-forward only**. A one-time audit (2026-07-24)
found **1,146 of 2,331 existing sync-created deals on Customer Service**, mostly
from the previously-stale Dani alias (~395) and Stephanie Hanna (54), plus
departed reps (Randall Eyermann 155, Kristal Kinkead 54, Bruce MacIntyre 44,
Dawnavan Emerson 40, …) and legitimate generics (`Default OBOPP` 375, blank 16).
Backfilling those existing deals is a separate, not-yet-run task.

---

## 7. Lead Sync — new signups → Freshworks leads

Script: `crm-import/osprey-lead-sync.js`. A Freshworks "lead" here is a
**contact** with lifecycle stage **Lead**.

### 7.1 Which signups
Reads `api.onebrand.io/api/v1/users` newest-first. A **watermark** (highest
processed `user_id`, in `osprey_lead_sync`) means:
- **First run** seeds users created in the last `LEAD_SEED_DAYS` (default **30**).
- **Later runs** process only `user_id`s above the watermark — genuine new signups.
- Processed oldest-first so an interrupted run resumes cleanly.

### 7.2 Dedupe
Before creating, each email is checked with `GET /lookup?f=email&entities=contact`.
If it already exists in Freshworks, the signup is recorded as `exists` and
**skipped** — never duplicated. Invalid/blank emails are recorded `no_email`.

### 7.3 Lead field mapping
| Freshworks field | Source | Notes |
|---|---|---|
| `first_name` | user first name / name | "Unknown" if blank |
| `last_name` | user last name | |
| `emails` | signup email (primary) | dedupe key |
| `lifecycle_stage_id` | fixed **Lead** `128081818855` | |
| `contact_status_id` | fixed **New** `127004203345` | |
| `lead_source_id` | **Account No Order** `127007286667` | **only** if the AMP account is < 7 days old at run time |
| `mobile_number` | `user_phone` | if present |
| `job_title` | `company` | contacts have no plain company field |
| `owner_id` | *(not set)* | see below |

**Owner:** Lead Sync does **not** assign an owner. New leads are created without
`owner_id`, so they take Freshworks' default (unassigned / round-robin per FW
settings) rather than a rep or CS. This is different from Deal Sync.

`--backfill` mode (manual) stamps the `Account No Order` source onto
already-created leads whose AMP account is < 7 days old.

---

## 8. Fixed ID reference

| Thing | ID |
|---|---|
| Deal pipeline | `127000511262` |
| Stage — Quoted | `127003582554` |
| Stage — Won | `127003582559` |
| Stage — Lost | `127003582560` |
| Owner — Customer Service (default) | `127000558289` |
| Lifecycle — Lead | `128081818855` |
| Contact status — New | `127004203345` |
| Lead source — Account No Order | `127007286667` |

Deal custom fields written: `cf_order_number`, `cf_webid`, `cf_sf_oppty_id`
(plus `cf_order_link`, a Freshworks **formula** field that builds
`https://osprey.onebrand.io/orders/<order#>` from `cf_order_number`).

---

## 9. Rate limiting & safety

- All Freshworks calls go through `crm-import/common.js` `fs()`: paced under the
  account cap (default **1,900/hr**), auto-retry on 429/5xx with `retry-after`.
- Jobs are **resumable** via their state tables; a killed run resumes without
  duplicating.
- `INCOMPLETE` orders never produce a deal; existing deals are only ever updated
  for **stage/amount**, protecting manual edits (owner, links, notes).

---

## 10. Known limitations / open items

1. **Existing CS-owned deals (1,146)** — not backfilled (§6).
2. **Departed-rep routing** — sellers with no FW user fall to account/contact
   owner then CS; there is no departed-rep → successor map (e.g. Randall
   Eyermann → David Waldman) beyond what the account owner supplies.
3. **New Osprey statuses default to Won** — silent unless the end-of-run log is
   reviewed (§4.2).
4. **Leads have no owner** — by design today; revisit if leads should route to a
   rep or CS (§7.3).
5. **Accounts are never auto-created** — orders for an unmatched customer get a
   deal with no account link (§5).
