# Screen fixtures (F6.0b)

Plain-text dumps of the real `claude` 2.1.312 TUI, rendered with `@xterm/headless` (see docs/spikes/F6b.md).

- The viewport is 120 columns x 40 rows. Each file lists the rows top to bottom; **trailing blank rows are trimmed**, so the last row of the screen is not always row 39. Row indexes are 0-based viewport rows.
- The **last line is harness metadata, not screen content**: `--cursor y=<viewport row> x=<column> bracketedPaste=<bool> exited=<null|{...}>`. `y` is a 0-based viewport row.
- Anonymized: paths -> `/tmp/proj`, plan -> `Claude <Plan>`, session id -> zeros, connector resources -> `example-server`.
- The input prompt is `❯` followed by U+00A0 (non-breaking space); match with `\s`.
- Synthetic (derived by hand from real captures, not captured as such): `07b-mode-accept-edits` (footer text observed in the raw log), `02g-idle-weekly-notice` (a notice drawn at row 35, column 52; real text `You've used N% of your weekly limit · resets <time> (<timezone>)`, numbers and zone replaced) `11-idle-numbered-list-in-output` and `11b-idle-anchor-text-in-output` (negative cases: idle screens whose model output, directly above the visible input box and inside the 20-row window, contains a numbered list and a line with a dialog anchor text, `Do you want to pick one?` / `Ready to code?`; both must classify as `idle`, because an anchor never opens the dialog gate while a valid input box is visible).

## Expected state per fixture (oracle for the F6.3 classifier test)

States: `idle`, `working`, `overlay`, `input-pending`, `dialog:<kind>` (`permission`, `plan`, `review`, `question`, `model`, `trust`), `exited`, `unknown`. Rules: docs/spikes/F6b.md section 11. Parse the table with `^\| `([^`]+)` \| (\S+) \|$`.

| fixture | state |
|---|---|
| `01-trust.txt` | dialog:trust |
| `01b-idle-fresh-auto-default.txt` | idle |
| `02-idle.txt` | idle |
| `02b-working.txt` | working |
| `02d-working-streaming.txt` | working |
| `02e-working-streaming-text.txt` | working |
| `02f-after-interrupt.txt` | idle |
| `02g-idle-weekly-notice.txt` | idle |
| `03a-paste-multiline.txt` | input-pending |
| `03b-queued.txt` | working |
| `03c-newline-backslash.txt` | input-pending |
| `04b-permission-touch.txt` | dialog:permission |
| `04c-after-no.txt` | idle |
| `04e-after-yes.txt` | idle |
| `04f-permission-edit.txt` | dialog:permission |
| `05a-askuser.txt` | dialog:question |
| `05b-askuser-other.txt` | dialog:question |
| `05c-askuser-after.txt` | idle |
| `05d-askuser-multi.txt` | dialog:question |
| `05e-askuser-tab2.txt` | dialog:question |
| `05f-askuser-review.txt` | dialog:review |
| `05g-askuser-esc.txt` | idle |
| `06a-plan-approval.txt` | dialog:plan |
| `06b-plan-feedback.txt` | dialog:plan |
| `06c-plan-esc.txt` | idle |
| `07-mode-plan.txt` | idle |
| `07b-mode-accept-edits.txt` | idle |
| `08a-model-picker.txt` | dialog:model |
| `08b-model-esc.txt` | idle |
| `08c-model-arg.txt` | idle |
| `08e-compact-working.txt` | working |
| `08f-compact-done.txt` | idle |
| `08g-clear.txt` | idle |
| `09-slash.txt` | overlay |
| `09b-slash-esc.txt` | input-pending |
| `09c-at.txt` | overlay |
| `10a-help-shortcuts.txt` | overlay |
| `10b-exit.txt` | exited |
| `10c-ctrlc.txt` | idle |
| `11-idle-numbered-list-in-output.txt` | idle |
| `11b-idle-anchor-text-in-output.txt` | idle |
