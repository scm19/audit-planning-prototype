---
title: "Rollout plan: Single Audit Risk Brief"
updated: 2026-10-21
tags: [single-audit, pilot, rollout]
---

# Rollout plan: Single Audit Risk Brief

> [!summary] The approach
> **Observe expert managers → improve the brief across three live plans → check what changed → expand in waves.**

## 1. Three sessions with expert managers

The practice lead picks the **strongest planners** across program types. With firm and manager approval, record each session's full screen, clicks, audio, and live transcript.

| Session | What we do together |
| --- | --- |
| **1 · Baseline** | Ask what slows planning or weakens confidence. Observe a normal live plan, time research through senior handoff, and save the manager's priorities. Then show the unedited brief and ask what they would reject or add. |
| **2 · First iteration** | Fix the biggest issues, then plan a different live audit with the brief. Observe where it helps or creates work; ask which original blockers remain. |
| **3 · Refined experience** | Fix the next issues, then plan a third audit together. Time the work, ask the manager to rate the unedited leads, and repeat the opening questions. |

Between sessions, review the recording, fix the top two blockers, rerun the case, and show what changed. Expert corrections guide reviewed changes; they do not automatically retrain the model.

## 2. Collect data for each planning session

1. **Primary — effort to a usable handoff**
   - Observe minutes from research start to handoff, by planning stage and including work outside the app. Count prompts exchanged with the agent, manager revisions, and extra source checks needed to produce the handoff.
2. **Score every output**
   - Have expert managers score each unedited agent brief and final handoff for quality. Record where they disagree with the output and why; use those judgments in the evaluation set.
3. **Supporting — senior rework after handoff**
   - Capture follow-up questions and requested edits from email or review comments; count exchanges until the senior accepts the handoff.
4. **Build an evaluation set**
   - Save the inputs available at planning time, expert Include / Investigate / Set aside decisions, corrections, reasons, sources, and scores. Use some cases to improve the brief; hold others back to check new versions. Clicks alone are not labels.
5. **Diagnose friction**
   - Keep the session recording, click trail, transcript, and full agent conversation. Trace each prompt–response pair: exact input/output, retrieved sources, tool calls, prompt/model version, timing, and errors in firm-approved storage.

## 3. Assess impact by planning stage

- **Ask after each session:** What is the top blocker in each stage? Rate severity **1 = none, 5 = major**.
- **Observe during each session:** Minutes per stage, including work outside the app. Compare baseline → first tool session → refined session; note case complexity.

| Stage | What should improve across sessions |
| --- | --- |
| **Generate the initial assessment** | Faster path to a usable shortlist. Unedited leads better match the expert-reviewed eval cases: relevant priorities, supported sources, fewer omissions. |
| **Inspect evidence and decide in the app** | Less time and friction opening sources, challenging leads, and marking Include / Investigate / Set aside. Recordings and interaction traces show where the app slows them. |
| **Prepare the senior handoff** | Less time to a usable note and early requests. Senior or partner needs no extra clarification or rework. |

## 4. Decide and roll out in gates

**Decision after the expert sessions**

- **Full brief:** Blockers and time fall across planning; unedited agent leads align with expert eval cases; seniors accept the handoffs without extra work.
- **Evidence layer only:** Source-linked history makes evidence review faster and more trustworthy, but agent leads still miss expert judgment. Release the evidence view without generated priorities; keep calibrating the agent with experts.
- **Iterate:** Early use takes longer or one stage stalls, while plans remain sound. Fix that stage and retest with experts.
- **Pause:** After repeated iterations, planning is still materially slower and managers consistently distrust the result. Pause use and expansion while we find the cause.
- **End the pilot:** If expert retesting after the pause shows no credible path to restoring speed and trust in any version of the tool.

**If we expand**

1. **Train with a live planning session.** An expert manager confirms the engagement context (organization, audit year, approved draft programs, and unknowns), inspects sources, makes decisions, and sends the senior handoff. If the agent is enabled, show how to challenge its leads. Keep partner sign-off.
2. **First gate: roughly one-third of managers.** Start on their next real audits. Review stage times, output scores, prompt/revision counts, and flags weekly. Fix new issues before widening.
3. **Full rollout of the selected mode:** Bring in the rest when the first wave shows the same quality and time gains. Keep one-click feedback and return to live sessions wherever a stage stalls. Track whether saved time becomes more completed plans.
