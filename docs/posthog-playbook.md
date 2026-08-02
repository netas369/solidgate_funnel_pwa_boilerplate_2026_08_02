# PostHog Playbook

This app already sends PostHog events from the frontend once analytics consent is accepted.

## Env vars

Set these in `.env.local`:

```env
NEXT_PUBLIC_POSTHOG_KEY="your_project_token"
NEXT_PUBLIC_POSTHOG_HOST="https://eu.i.posthog.com"
```

Restart the app after changing env vars.

## Events already sent by the app

Core quiz funnel events:

- `quiz_started`
- `step_completed`
- `lead_captured`
- `lead_capture_error`
- `quiz_completed`

Exit intent events:

- `exit_intent_shown`
- `exit_intent_dismissed`
- `exit_intent_email_captured`

Built-in PostHog events already used:

- `$pageview`
- page leave events via `capture_pageleave: true`

Useful properties already attached:

- `session_id`
- `step_id`
- `step_number`
- `trigger`
- `has_email`

## Recommended funnel to create

Create a funnel in PostHog named `Quiz Funnel`.

Suggested steps:

1. `quiz_started`
2. `step_completed` filtered to `step_number = 6`
3. `step_completed` filtered to `step_number = 14`
4. `lead_captured`
5. `quiz_completed`

This gives you a practical milestone funnel without creating 26 separate steps.

If you want a stricter full-step view, create a second funnel using `step_completed` and break down by `step_number`.

## Recommended dashboard

Create a dashboard named `Quiz Funnel Overview` with these insights:

1. Trends: `$pageview`
   Filter to quiz URLs if needed.

2. Trends: `quiz_started`

3. Trends: `lead_captured`

4. Trends: `quiz_completed`

5. Funnel: `Quiz Funnel`

6. Trends: `step_completed`
   Breakdown by `step_number`
   This is your drop-off chart.

7. Trends: `exit_intent_shown`

8. Trends: `exit_intent_email_captured`

## Step number map

Important milestone steps in the current quiz:

- `1`: `001_hook`
- `2`: `002_age`
- `3`: `004_past_attempts`
- `4`: `005_failure_reason`
- `5`: `006b_professional_referral`
- `6`: `006_root_cause`
- `7`: `007_dynamic_info_1`
- `8`: `008_time_of_day`
- `9`: `009_cravings`
- `10`: `010_food_relationship`
- `11`: `011a_comfort_branch` or `011b_reward_branch`
- `12`: `012_physical_impact`
- `13`: `013_emotional_impact`
- `14`: `014_dynamic_info_2`
- `15`: `003_metrics`
- `16`: `003b_weight_journey`
- `17`: `015_activity`
- `18`: `016_belief`
- `19`: `017_past_mindset`
- `20`: `018a_mindset_branch` or `018b_mindset_branch`
- `21`: `019_future_pace`
- `22`: `020_time_commitment`
- `23`: `021_labor_illusion`
- `24`: `022_email_capture`
- `25`: `023_health_analysis`
- `26`: `024_weight_prediction`

## Autocapture guidance

PostHog web autocapture is enabled by default in the JavaScript web SDK.

For this app, the safest approach is:

- keep custom events for the real funnel
- use autocapture as supplemental debugging data
- do not rebuild your main funnel from autocaptured click events

Good next check inside PostHog:

- confirm Autocapture is enabled
- exclude sensitive pages if your team wants stricter capture scope
- use autocapture mainly for click/form exploration, not core reporting

## Session recordings

Session recordings are optional and useful for debugging drop-off.

Recommended approach:

- enable them only if the team wants replay data
- note: there is no cookie banner — trackers run for everyone by owner decision (see GDPR-COMPLIANCE.md)
- start by reviewing a few sessions where `quiz_started` happened but `lead_captured` did not

## Feature flags

Feature flags are optional and not required for analytics.

Good first flags if you want them later:

- new quiz copy variant
- alternate email capture copy
- different offer page layout
- exit intent modal variant

Use flags for experiments, not for basic event collection.

## What not to do

- Do not add the raw HTML PostHog snippet on top of the existing SDK setup.
- Do not depend only on autocapture for your quiz funnel.
- Do not test analytics before accepting analytics consent, or PostHog may stay empty.
