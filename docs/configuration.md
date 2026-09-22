# Configuration

`~/.config/jev-blindspot/env`, one `KEY=VALUE` per line. Environment variables
take precedence. The panel's settings dialog edits the brain and gate model
keys in this file and applies them to the running daemon; every other key
needs a daemon restart (`jev-blindspot stop`, then the next prompt).


| key                                         | default         | meaning                                                                                         |
| ------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| `TYPESAFE_API_KEY`                          |                 | gate key (required)                                                                             |
| `JEV_MODEL`                                 | `jev-1.13.0`    | pinned jev version; `jev-latest` changes under you                                              |
| `JEV_PORT`                                  | `7461`          | daemon port                                                                                     |
| `JEV_BIND_EXTRA`                            |                 | comma-separated extra bind addresses (LAN, Tailscale)                                           |
| `JEV_ALLOWED_HOSTS`                         |                 | extra `Host` header values to accept                                                            |
| `JEV_TOKEN`                                 |                 | access token: `Authorization: Bearer`, `?t=`, or a `jev_token` cookie                           |
| `JEV_IDLE_MINUTES`                          | `30`            | idle shutdown                                                                                   |
| `JEV_WORTH_MIN` / `JEV_WORTH_MIN_HIGH_RISK` | `0.65` / `0.45` | `worth_checking` threshold; the lower one applies at high risk                                  |
| `JEV_RISK_HIGH`                             | `3.5`           | risk from which the lower threshold applies                                                     |
| `JEV_GAP_MIN`                               | `0.70`          | a gap flag becomes a chip at or above this; it never affects the decision                       |
| `JEV_GATE_TIMEOUT_MS`                       | `2000`          | gate timeout                                                                                    |
| `JEV_GATE_FALLBACK`                         | `skip`          | `brain` runs the brain even when the gate is down                                               |
| `JEV_BRAIN`                                 | `auto`          | which brain runs: `auto` follows the agent the prompt came from; `claude` or `codex` forces one |
| `JEV_BRAIN_MODEL`                           | `sonnet`        | model alias passed to `claude -p`                                                               |
| `JEV_BRAIN_CODEX_MODEL`                     | `gpt-5.6-luna`  | model passed to `codex exec -m`                                                                 |
| `JEV_BRAIN_CODEX_REASONING`                 | `low`           | `model_reasoning_effort` for the Codex brain                                                    |
| `JEV_BRAIN_CLAUDE_EFFORT`                   | `low`           | `--effort` for the Claude brain (`low`, `medium`, `high`)                                       |
| `JEV_BRAIN_TIMEOUT_MS`                      | `90000`         | brain wall-clock limit                                                                          |


## Tuning the threshold

The threshold was set against a small set of prompts. Yours will differ. Run
`jev-blindspot gate "<prompt>"` on a few of your own, then move
`JEV_WORTH_MIN` until the quiet and analyze decisions match what you would
want. `test/fixtures/prompts.example.json` shows the fixture format for
`jev-blindspot fixtures`, which reports every mismatch between the expected
and the actual decision.

## Per-shell switches

- `JEV_BLINDSPOT_DISABLE=1`: the hook exits at once, nothing is sent.
- `JEV_FAKE=1`: the daemon replaces the gate and the brain with stubs.
- `JEV_BLINDSPOT_DEBUG=1`: the hook writes the first 120 characters of each prompt to `~/.local/state/jev-blindspot/hook.log`; off by default so the log holds no prompt text.
