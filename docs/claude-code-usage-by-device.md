# Which laptop is using up my Claude limit?

**Short answer:** Claude does not tell you this on its own. There is no
"per laptop" screen anywhere. But you can still work it out. Here is how.

---

## 1. The limit is one shared pot

You have **one** limit for your whole account.

Every laptop drinks from the same pot. So does the Claude website, the
desktop app, and Cowork.

There is no separate limit for each laptop. So there is no built-in
per-laptop number to look at.

---

## 2. You CAN see which laptops are logged in

Do this:

1. Open the Claude website.
2. Click your initials at the bottom left.
3. Go to **Settings**, then **Account**.
4. Scroll down to **Active sessions**.

This shows every device that is logged in to your account. You can log
any of them out from here.

But note: it only shows **who is logged in**. It does **not** show how
much each one used.

---

## 3. Claude does not use your MAC address

Anthropic does not collect your laptop's MAC address.

Each laptop does keep two random ID numbers in a file called
`~/.claude.json`:

- `machineID`
- `userID`

To see them, run this on each laptop:

```bash
python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude.json'))); print('machineID =', d.get('machineID')); print('userID    =', d.get('userID'))"
```

These IDs are random. They are **not** linked to any usage report you can
read. So they help you tell your laptops apart, and nothing more.

---

## 4. The easy trick: `/usage` only counts THIS laptop

This is the most useful thing to know.

In Claude Code, type:

```
/usage
```

Then press `w` to switch to the last 7 days.

- The **bars at the top** are for your whole account. All laptops together.
- The **list below the bars** is for **that one laptop only**. Work done on
  other laptops is not counted there.

So the trick is:

1. Run `/usage` on laptop A. Write down what you see.
2. Run `/usage` on laptop B. Write down what you see.
3. Compare them. Now you know which laptop does more.

The numbers are rough, not exact. But they are good enough to see which
laptop is the heavy one.

---

## 5. The proper way: put a name tag on each laptop

If you want real numbers, turn on **telemetry**. Telemetry just means
Claude Code sends usage numbers to a place you choose.

The key part: you give each laptop a **different name tag**. Then every
number arrives with the laptop's name on it.

On laptop A, add this to your shell setup file (`~/.zshrc` or
`~/.bashrc`):

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=https://your-collector:4318
export OTEL_RESOURCE_ATTRIBUTES="device=macbook_pro_work"
```

On laptop B, use the same lines but change the last one:

```bash
export OTEL_RESOURCE_ATTRIBUTES="device=macbook_air_home"
```

Rules for the name tag:

- No spaces. Use `_` instead.
- Keep it short and clear.

### What you get back

Each number now carries the laptop's name:

| Number | What it tells you |
| --- | --- |
| `claude_code.token.usage` | How much was used |
| `claude_code.cost.usage` | Rough cost in dollars |
| `claude_code.lines_of_code.count` | Lines of code written or deleted |
| `claude_code.commit.count` | How many commits were made |
| `claude_code.pull_request.count` | How many pull requests were made |
| `claude_code.active_time.total` | How long it was actually working |
| `claude_code.session.count` | How many times it was started |

The last few answer the other half of the question: **what work did each
laptop actually produce.**

### One warning

These are **token** and **dollar** numbers. Your weekly limit is not a
plain count of tokens. Different models cost different amounts, and
re-used context is cheap.

So read it as a **share**, like "laptop A is about 70% of my usage".
Do not read it as an exact slice of the weekly bar.

---

## 6. The no-setup option

Every laptop already saves a full record of past chats here:

```
~/.claude/projects/**/*.jsonl
```

Each line holds the token counts for one step. A small script can add
them up per day and per project.

Good points:

- No server to set up.
- It works on **old** chats. Telemetry only starts counting from the day
  you turn it on.

Bad point: you have to run the script on each laptop by hand and compare
the results yourself.

---

## Summary

| What you want | Can you get it? | How |
| --- | --- | --- |
| See which laptops are logged in | Yes | Website → Settings → Account → Active sessions |
| See MAC address of each laptop | No | Anthropic never collects it |
| See a per-laptop split, built in | No | The limit is one shared pot |
| Rough per-laptop split | Yes | Run `/usage`, press `w`, on each laptop |
| Exact per-laptop split | Yes | Telemetry with a `device=` name tag |
| Per-laptop split of old usage | Yes | Add up the `.jsonl` chat files |

---

## Sources

- [Manage costs effectively](https://code.claude.com/docs/en/costs)
- [Monitoring usage (OpenTelemetry)](https://code.claude.com/docs/en/monitoring-usage)
- [Managing your active sessions](https://support.claude.com/en/articles/13124001-managing-your-active-sessions)
