# iPad Bridge Setup (shared Apple Reminders → the wall)

Apple's *shared* reminder lists can't be read off-device (CalDAV can't see them).
So a dedicated, always-on iPad acts as the go-between: it reads your Reminders and
pushes them to the wall app, and pulls the wall's edits and applies them back.

**The app's address** (where the iPad sends data):
- Testing against your PC now: `http://10.0.0.202:3000`
- Later, on the Pi: `http://<pi-ip>:3000` (we'll swap this in)

The server must be running with `LIST_MODE=bridge` (already set in your `.env`).

We build this in **three stages** — get each working before moving on:
1. **Push** — iPad → wall (display your lists). *Do this first.*
2. **Apply** — wall → iPad (write your wall edits back to Reminders).
3. **Loop + keep-alive** — run it continuously on the dedicated iPad.

---

## Stage 1 — "Push Lists to Wall" (display)

Create a new Shortcut named **Push Lists to Wall**. The logic:

> For each list, grab the to-buy reminders' names, join them with new lines, and
> POST that text to the wall. No JSON, no dictionaries — 3 actions per list.

Replace `PI` below with your Pi's address, e.g. `http://192.168.1.50:3000`.

**Shopping:**
1. **Find Reminders** → *List is `Shopping`*, and *Is Completed is `Off`* (only to-buy items).
2. **Combine Text** → input = the Find Reminders result, separator = **New Lines**.
3. **Get Contents of URL** →
   - URL: `PI/api/bridge/push-list/Shopping`
   - Method: **POST**
   - Request Body: **Text** = the Combined Text from step 2

**Costco:** repeat the same three actions with `Costco` (and the URL `.../push-list/Costco`).

That's it — six actions total.

### Test Stage 1
1. On the iPad, run **Push Lists to Wall** once.
2. Look at the wall (or open `PI/api/list/Shopping` in a browser): your real
   Shopping and Costco items should appear. 🎉

If not, screenshot the Shortcut and tell me what you see — we'll debug together.

---

## Stage 2 — "Apply Wall Edits" (write-back)

Uses two **plain-text** endpoints per list (newline-separated names), which are the
most reliable format for Shortcuts — each item is unambiguously text:
`GET /api/bridge/adds/<list>` and `GET /api/bridge/removes/<list>` (both drain).

Create a Shortcut named **Apply Wall Edits**. Replace `PI` with your Pi address.

**Shopping — additions:**
1. **Get Contents of URL** → GET `PI/api/bridge/adds/Shopping`
2. **If** [Contents of URL] **has any value**:
   - **Split Text** → (Contents of URL) by **New Lines**
   - **Repeat with Each** (Split Text) → **Add New Reminder** (Repeat Item) to **Shopping**
   - *(End Repeat / End If)*

**Shopping — removals:**
3. **Get Contents of URL** → GET `PI/api/bridge/removes/Shopping`
4. **If** [Contents of URL] **has any value**:
   - **Split Text** → by **New Lines**
   - **Repeat with Each** → **Find Reminders** (List is **Shopping**, Name is **Repeat Item**) → **Remove Reminders**

**Costco:** repeat both blocks with `Costco` and the `.../adds/Costco` + `.../removes/Costco` URLs.

Key point: **Repeat Item comes from Split Text**, so it's plain text — that's what
makes "Add New Reminder" accept it as the title. The **If … has any value** guards
skip empty runs cleanly.

**Behavior note:** checking an item off at the wall **removes** it from Reminders
(the "got it, cross it off" model) — Shortcuts adds and removes reliably but has no
solid "mark complete" action.

---

## Stage 3 — Run it continuously

Create a Shortcut named **Sync Loop**:

1. **Repeat** `1000` times:
   - **Run Shortcut** → `Apply Wall Edits`
   - **Run Shortcut** → `Push Lists to Wall`
   - **Wait** `120` seconds
   *(End Repeat)*

This gives ~2-minute two-way sync. Then make the iPad a good appliance:

- **Settings → Display & Brightness → Auto-Lock → Never**
- Keep it **on the charger**.
- Start **Sync Loop**, then turn on **Guided Access** (triple-click side/home button)
  so it stays on that Shortcut and nothing interrupts it.
- **Auto-restart after reboots:** Shortcuts app → **Automation** → **＋** →
  **Time of Day** (e.g., 5:00 AM, "Run Immediately") → **Run `Sync Loop`**. (The loop
  runs ~1.5 days before finishing; the daily automation relaunches it.)

---

## Handy checks
- `GET http://<addr>:3000/api/bridge/status` → shows last push time + pending edits.
- The wall's **Lists** tab shows whatever the iPad last pushed.
- Increase/decrease the `Wait` in Sync Loop to trade freshness vs. battery/heat.
