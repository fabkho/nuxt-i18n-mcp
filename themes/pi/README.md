# the-i18n-kit chrome for pi

Translation coverage in the editor border, where you already look:

```
╭─ 3m 0s ──────────────────────────── $0.42 - claude-opus-5 - high - 47%/1.0M ─╮
│ > translate the missing spanish keys                                          │
╰─ main * ─────────────────────────────────── 🌐 4 missing ─ the-i18n-kit ─╯
```

## Why a wrapper

Editor chrome in pi belongs to whichever extension owns the editor component,
and its metadata set is closed — there is no slot to ask for. So this wraps the
installed editor instead of replacing it: the component renders exactly as
before, and the label is placed into the rule of the bottom border afterwards,
consuming spare width rather than adding any.

That makes it surgery on someone else's output, so it is written to fail by
doing nothing. No custom editor, no border, a frame it does not recognise, or a
line too narrow to spare the width — and the editor renders untouched.

## Install

```bash
pi install npm:@the-i18n-kit/pi-theme
```

Requires `@the-i18n-kit/pi`, which is where the coverage figure comes from.
`I18N_KIT_BORDER=off` disables the label.

## What it shows

| | |
|---|---|
| `🌐 4 missing` | Keys the reference locale has and others do not |
| `🌐 ✓` | Nothing missing |
| `🌐 ?` | The last read failed, so the number is unknown |

The widget in `@the-i18n-kit/pi` reports change and withdraws; this reports
state and stays. Neither duplicates the other.
