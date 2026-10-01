# Gmail Sender Labels

Automatically labels every email in your Gmail Inbox by who sent it — and flags senders who might be faking it.

```
Senders/
├── amazon.com            ← companies, grouped by domain
├── github.com
├── jane.doe@gmail.com    ← people on personal providers, one label each
└── _unverified           ← failed Gmail's sender checks: the "From" may be forged
```

The labels mirror your Inbox. Archive an email and its sender label disappears; move it back and the label returns. So the `Senders` tree is always a live, grouped view of what's in your Inbox right now — and nothing more.

## Why trust it

- **It runs inside your own Google account**, as an Apps Script project you own. No server, no third party, no outbound network calls — your email never leaves Google.
- **It asks for the least it can.** Two permissions, pinned in [`appsscript.json`](appsscript.json): read and change labels on your mail (`gmail.modify`), and run itself on a timer (`script.scriptapp`). It can't send email or delete it.
- **It's one file you can read.** [`Code.gs`](Code.gs) is about 380 lines with no dependencies. Please read it before you give it access to your mailbox — that's good practice for any script like this.

## Install (about 5 minutes)

1. Go to [script.google.com](https://script.google.com) → **New project**. Name it *Gmail Sender Labels*.
2. **Services** (the **+** in the left sidebar) → **Gmail API** → **Add**.
3. **Project Settings** (gear icon) → tick **Show "appsscript.json" manifest file in editor**.
4. Back in the editor, replace the contents of `appsscript.json` with [this repo's version](appsscript.json), and the contents of `Code.gs` with [`Code.gs`](Code.gs). Save.
5. Pick `setup` in the function dropdown at the top → **Run**.
6. Approve the permissions. Google will show **"Google hasn't verified this app"** — that's expected, because *you* are the developer of your own copy. Click **Advanced → Go to Gmail Sender Labels (unsafe)** → **Allow**.

That's it. `setup()` labels your Inbox and installs a trigger that keeps it up to date every 5 minutes. Watch progress under **Executions** in the left sidebar.

**Big Inbox?** The first pass works through it in chunks, saving progress as it goes. Free Gmail accounts get about 90 minutes of automatic run time per day, so an Inbox of tens of thousands of emails may take into the next day to finish. It picks up where it left off — nothing to do.

### Prefer the command line?

With [clasp](https://github.com/google/clasp): `clasp create --type standalone --title "Gmail Sender Labels"`, then `clasp push`, then run `setup` from the editor once to approve permissions.

## Settings

Edit `CONFIG` at the top of `Code.gs`, then run `rescan()` to apply changes to emails already in your Inbox.

| Setting | Default | What it does |
|---|---|---|
| `ROOT_LABEL` | `Senders` | The parent label everything goes under. |
| `VERIFY_SENDERS` | `true` | Send unauthenticated mail to `_unverified` instead of trusting its "From". |
| `GROUP_BY_ORG_DOMAIN` | `true` | `email.amazon.com` and `amazon.com` share one label. |
| `PERSONAL_DOMAINS` | gmail.com, outlook.com, … | Domains where each person gets their own label. |
| `MULTI_PART_SUFFIXES` | co.uk, com.au, … | Country suffixes like `co.uk`, so `shop.co.uk` isn't grouped as `co.uk`. Add yours if it's missing. |
| `TRIGGER_MINUTES` | `5` | How often it checks for changes (1, 5, 10, 15 or 30). |
| `UNITS_PER_SECOND` | `100` | How fast it calls Gmail. Gmail allows about 250 per second per user; lower this if you see "Quota exceeded" warnings. |

## Commands

Run any of these from the function dropdown:

- `setup()` — install, or re-install the trigger. Safe to run again; progress is kept.
- `status()` — print where it's up to (scanning, or following changes).
- `rescan()` — re-check every email in the Inbox, e.g. after changing settings.
- `uninstall()` — remove the trigger and every `Senders` label. **Your emails are not touched** — deleting a Gmail label only removes the tag. Then delete the project and remove its access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## How it works

1. **First run:** it notes Gmail's current change counter (the *history ID*), then labels every email in your Inbox.
2. **After that:** every few minutes it asks Gmail *"what changed since the counter?"* using the [History API](https://developers.google.com/workspace/gmail/api/guides/sync) — new mail, or emails moved in or out of the Inbox — and fixes only those. Because the counter was noted *before* the first scan, anything that happened during the scan is caught too.
3. **For each changed email** it asks one question — *is it in the Inbox right now?* — and makes the labels match: the right sender label if yes, none if no. Running this twice changes nothing, which is what makes it safe to retry and resume.
4. **If Gmail forgets the counter** (it keeps about a week of history), it rescans the Inbox, as Google recommends.

### Sender verification

Anyone can write any address in an email's "From" line. Without a check, a phishing email claiming to be `service@paypal.com` would be filed neatly under `Senders/paypal.com`, looking more legitimate than it is.

So the script reads the verdict Gmail itself records when mail arrives (the `Authentication-Results` header — Gmail's DMARC and DKIM checks). The sender label is only used if Gmail confirmed the email really came from that domain. Two details make this hard to fool:

- Only Gmail's own verdict counts — the topmost `mx.google.com` result. A sender can add fake verdict headers, but they sit below Gmail's.
- The address comes from the *last* `<…>` in the From line, so a display name like `"security@paypal.com" <attacker@example.net>` is filed under `example.net`.

Mail you sent yourself is trusted. Everything else that fails goes to `_unverified`.

## Known limits

- **Mailing lists and forwarding** often break the sender checks, so some genuine mail lands in `_unverified`. Set `VERIFY_SENDERS` to `false` if that's too noisy.
- **Domain grouping is approximate.** It uses the last two parts of a domain (three for suffixes in `MULTI_PART_SUFFIXES`), not the full public-suffix list.
- **Gmail allows up to 10,000 labels per account.** One per company domain is fine for nearly everyone; if you're close, turn off per-person labels by emptying `PERSONAL_DOMAINS`.
- **Empty labels stay.** When a sender's last email leaves the Inbox, its label is kept (empty) so it can be reused straight away. `uninstall()` removes them all.
- **After a rescan caused by expired history**, emails archived during the gap may keep their old sender label.

## FAQ

**Does it read my emails?** It reads two headers per email — `From` and Gmail's `Authentication-Results` — never the subject or body. Nothing is stored except a progress marker in the project's own settings.

**Will it mess up my existing labels?** No. It only ever adds or removes labels under `Senders/`. If you already have a label there (say `Senders/Amazon.com`), it reuses it.

**Does it work with Google Workspace accounts?** Yes, and Workspace gets more daily run time, so the first scan is quicker.

**Can I use a different label name?** Change `ROOT_LABEL` before the first run. If you change it later, run `uninstall()` first so the old labels are cleaned up.

## License

[MIT](LICENSE)
